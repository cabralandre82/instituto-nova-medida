/**
 * Processamento de refund pro paciente — lado Instituto.
 *
 * Server-only. Usa service role pra bypassar RLS.
 *
 * CONTEXTO (D-032 + D-033):
 *   - `applyNoShowPolicy()` marca `appointments.refund_required=true`
 *     quando a médica falha ou a sala expira vazia.
 *   - `refund_required` é APENAS a flag: o refund real (devolver dinheiro
 *     pro paciente) é operação humana por ora — admin abre o painel Asaas,
 *     emite o estorno lá, e volta aqui pra registrar.
 *   - Esta lib é o único ponto de entrada pra marcar um refund como
 *     processado. Concentra:
 *       1. Validação de pré-condições (flag seta, não processado antes).
 *       2. Idempotência (guard em `refund_processed_at`).
 *       3. Auditoria (who, how, external ref, notes) — migration 013.
 *
 * FUTURO (Sprint 5 / opção B do backlog):
 *   Quando a gente automatizar via Asaas API, a função
 *   `processRefundViaAsaas()` abaixo sai do status "not implemented" e
 *   passa a chamar `POST /payments/{id}/refund`, registrar
 *   `method='asaas_api'` + `external_ref=refund.id`, e idealmente invalidar
 *   a flag no webhook `PAYMENT_REFUNDED` (idempotente por external_ref).
 *   O schema já foi preparado pra isso — esta lib não precisará mudar de
 *   forma.
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import { refundPayment } from "@/lib/asaas";
import { logger } from "./logger";

const log = logger.with({ mod: "refunds" });

export type RefundMethod = "manual" | "asaas_api";

/**
 * Feature flag do estorno automático via Asaas API.
 *
 * OFF por default — UI segue só com registro manual (fluxo D-033).
 * Admin precisa setar `REFUNDS_VIA_ASAAS=true` explicitamente no env
 * do Vercel pra habilitar.
 *
 * A escolha por default OFF é conservadora: em caso de bug na
 * integração (ex: Asaas retornando erro inesperado e a gente marcando
 * como processado sem ter estornado), o raio é zero — máximo que
 * acontece é o admin ter que marcar manual, status-quo.
 */
export function isAsaasRefundsEnabled(): boolean {
  return process.env.REFUNDS_VIA_ASAAS === "true";
}

export type RefundInput = {
  appointmentId: string;
  method: RefundMethod;
  externalRef?: string | null;
  notes?: string | null;
  /** auth.user.id do admin que acionou. Null se for automação. */
  processedBy?: string | null;
  /**
   * Email do admin no momento do processamento. Gravado em
   * `appointments.refund_processed_by_email` como snapshot
   * imutável (PR-064 · D-072). Sobrevive a eventual delete/anonimização
   * da conta. Quando processado por automação, o caller passa
   * `"system:<job>"` (ex: "system:asaas-webhook") — assim o audit
   * diferencia ações de sistema de ações humanas.
   */
  processedByEmail?: string | null;
};

export type RefundErrorCode =
  | "appointment_not_found"
  | "refund_not_required"
  | "already_processed"
  | "db_error"
  | "asaas_disabled"
  | "asaas_payment_missing"
  | "asaas_api_error"
  | "appointment_no_payment";

export type RefundResult =
  | {
      ok: true;
      appointmentId: string;
      processedAt: string;
      method: RefundMethod;
      alreadyProcessed: boolean;
      externalRef?: string | null;
    }
  | {
      ok: false;
      appointmentId: string;
      code: RefundErrorCode;
      message: string;
      /** Dados da resposta do Asaas quando aplicável (pra debug). */
      asaasStatus?: number | null;
      asaasCode?: string | null;
    };

type AppointmentRefundRow = {
  id: string;
  refund_required: boolean;
  refund_processed_at: string | null;
  refund_processed_method: string | null;
  refund_external_ref: string | null;
};

/**
 * Marca um appointment como refund-processado. Não toca no Asaas — assume
 * que o operador já fez o estorno (ou que uma automação futura chama esta
 * função com `method='asaas_api'` depois de efetivar o estorno).
 *
 * Idempotente: se já foi processado, retorna ok=true com
 * alreadyProcessed=true (sem sobrescrever campos).
 */
export async function markRefundProcessed(
  input: RefundInput
): Promise<RefundResult> {
  const supabase = getSupabaseAdmin();

  const { data: appt, error: loadErr } = await supabase
    .from("appointments")
    .select(
      "id, refund_required, refund_processed_at, refund_processed_method, refund_external_ref"
    )
    .eq("id", input.appointmentId)
    .maybeSingle();

  if (loadErr) {
    log.error("load appointment", { err: loadErr, appointment_id: input.appointmentId });
    return {
      ok: false,
      appointmentId: input.appointmentId,
      code: "db_error",
      message: loadErr.message,
    };
  }
  if (!appt) {
    return {
      ok: false,
      appointmentId: input.appointmentId,
      code: "appointment_not_found",
      message: "Appointment não encontrado.",
    };
  }

  const row = appt as AppointmentRefundRow;

  if (!row.refund_required) {
    return {
      ok: false,
      appointmentId: row.id,
      code: "refund_not_required",
      message:
        "Esse appointment não tem refund_required=true. A política de no-show não marcou direito a estorno.",
    };
  }

  if (row.refund_processed_at) {
    return {
      ok: true,
      appointmentId: row.id,
      processedAt: row.refund_processed_at,
      method: (row.refund_processed_method ?? "manual") as RefundMethod,
      alreadyProcessed: true,
    };
  }

  const now = new Date().toISOString();
  // Snapshot imutável de email (PR-064 · D-072). Trim+lowercase+empty→null.
  const processedByEmailSnapshot =
    typeof input.processedByEmail === "string" &&
    input.processedByEmail.trim().length > 0
      ? input.processedByEmail.trim().toLowerCase()
      : null;
  const { error: upErr } = await supabase
    .from("appointments")
    .update({
      refund_processed_at: now,
      refund_processed_method: input.method,
      refund_external_ref: input.externalRef?.trim() || null,
      refund_processed_notes: input.notes?.trim() || null,
      refund_processed_by: input.processedBy ?? null,
      refund_processed_by_email: processedByEmailSnapshot,
    })
    .eq("id", row.id)
    .is("refund_processed_at", null); // segunda trava de idempotência (race)

  if (upErr) {
    log.error("update appointment", { err: upErr, appointment_id: row.id });
    return {
      ok: false,
      appointmentId: row.id,
      code: "db_error",
      message: upErr.message,
    };
  }

  log.info("processed", {
    appointment_id: row.id,
    method: input.method,
    external_ref: input.externalRef ?? null,
    by: input.processedBy ?? null,
  });

  return {
    ok: true,
    appointmentId: row.id,
    processedAt: now,
    method: input.method,
    alreadyProcessed: false,
    externalRef: input.externalRef?.trim() || null,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Estorno automático via Asaas API (D-034)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Linhas que precisamos pra montar o refund request.
 */
type AppointmentForRefundRow = {
  id: string;
  refund_required: boolean;
  refund_processed_at: string | null;
  payment_id: string | null;
  customer_id: string | null;
  doctor_id: string | null;
  status: string;
  payments: {
    id: string;
    asaas_payment_id: string | null;
    amount_cents: number;
    status: string;
  } | null;
};

/**
 * Estorna a cobrança vinculada ao appointment via Asaas API e marca
 * como processado no nosso lado. Full refund only (pedido explícito do
 * operador — política D-032 assume devolução integral em casos de no-show
 * da médica ou sala expirada).
 *
 * Fluxo:
 *   1. Carregar appointment + payment associado.
 *   2. Validar pré-condições (refund_required, não processado, tem
 *      asaas_payment_id).
 *   3. Chamar `POST /payments/{id}/refund` no Asaas.
 *   4. Em sucesso, marcar via `markRefundProcessed(method='asaas_api')`.
 *      `external_ref` = asaas_payment_id (suficiente pra rastreio no
 *      painel Asaas + dedupe com webhook `PAYMENT_REFUNDED`).
 *   5. Em falha do Asaas, NÃO marcar — devolver erro estruturado pra
 *      UI decidir entre retry ou pivot pro modo manual.
 *
 * Idempotência:
 *   - Guard em `refund_processed_at IS NULL` evita duplo estorno.
 *   - Asaas também rejeita 2º refund com `invalid_action` — cinto +
 *     suspensório.
 */
export async function processRefundViaAsaas(input: {
  appointmentId: string;
  processedBy: string;
  /** Email snapshot do admin (PR-064 · D-072). */
  processedByEmail?: string | null;
}): Promise<RefundResult> {
  if (!isAsaasRefundsEnabled()) {
    return {
      ok: false,
      appointmentId: input.appointmentId,
      code: "asaas_disabled",
      message:
        "Estorno automático via Asaas está desligado (REFUNDS_VIA_ASAAS!='true'). Use method='manual'.",
    };
  }

  const supabase = getSupabaseAdmin();

  const { data: appt, error: loadErr } = await supabase
    .from("appointments")
    .select(
      "id, refund_required, refund_processed_at, payment_id, customer_id, doctor_id, status, payments ( id, asaas_payment_id, amount_cents, status )"
    )
    .eq("id", input.appointmentId)
    .maybeSingle();

  if (loadErr) {
    log.error("asaas load", { err: loadErr, appointment_id: input.appointmentId });
    return {
      ok: false,
      appointmentId: input.appointmentId,
      code: "db_error",
      message: loadErr.message,
    };
  }
  if (!appt) {
    return {
      ok: false,
      appointmentId: input.appointmentId,
      code: "appointment_not_found",
      message: "Appointment não encontrado.",
    };
  }

  const row = appt as unknown as AppointmentForRefundRow;

  if (!row.refund_required) {
    return {
      ok: false,
      appointmentId: row.id,
      code: "refund_not_required",
      message:
        "Appointment não tem refund_required=true. A política de no-show não marcou direito a estorno.",
    };
  }

  if (row.refund_processed_at) {
    return {
      ok: true,
      appointmentId: row.id,
      processedAt: row.refund_processed_at,
      method: "asaas_api",
      alreadyProcessed: true,
    };
  }

  if (!row.payment_id || !row.payments) {
    return {
      ok: false,
      appointmentId: row.id,
      code: "appointment_no_payment",
      message:
        "Appointment sem payment vinculado. Não há o que estornar via Asaas — marque manualmente.",
    };
  }

  const asaasPaymentId = row.payments.asaas_payment_id;
  if (!asaasPaymentId) {
    return {
      ok: false,
      appointmentId: row.id,
      code: "asaas_payment_missing",
      message:
        "Payment vinculado não tem asaas_payment_id. Isso indica que o pagamento não foi efetivado no Asaas — marque manualmente.",
    };
  }

  const asaas = await refundPayment({
    asaasPaymentId,
    description: `Estorno automático · appointment ${row.id} · política de no-show (D-032)`,
  });

  if (!asaas.ok) {
    log.error("asaas refund API falhou", {
      appointment_id: row.id,
      asaas_payment_id: asaasPaymentId,
      status: asaas.status,
      code: asaas.code,
      message: asaas.message,
    });
    return {
      ok: false,
      appointmentId: row.id,
      code: "asaas_api_error",
      message: `Asaas rejeitou o estorno: ${asaas.message}`,
      asaasStatus: asaas.status,
      asaasCode: asaas.code,
    };
  }

  // Asaas aceitou. Agora marcar no nosso lado — se isto falhar, o
  // estorno JÁ rodou no Asaas (dinheiro já saiu). A flag vai ficar
  // dessincronizada e o webhook `PAYMENT_REFUNDED` provavelmente
  // conserta (ele também chama markRefundProcessed). Se não consertar,
  // é trabalho pro admin via SQL — melhor dessincronizar no favor
  // do paciente do que manter a flag dizendo "precisa estornar".
  const mark = await markRefundProcessed({
    appointmentId: row.id,
    method: "asaas_api",
    externalRef: asaasPaymentId,
    notes: `Estorno automático via Asaas API. Status Asaas após request: ${asaas.data.status}.`,
    processedBy: input.processedBy,
    processedByEmail: input.processedByEmail ?? null,
  });

  if (!mark.ok) {
    log.error("asaas CRITICAL: Asaas aceitou mas markRefundProcessed falhou", {
      result: mark,
      appointment_id: row.id,
    });
    return {
      ok: false,
      appointmentId: row.id,
      code: "db_error",
      message: `Asaas estornou com sucesso mas falhou ao registrar internamente: ${mark.message}. Webhook deve reconciliar — monitore.`,
    };
  }

  log.info("asaas estorno concluído", {
    appointment_id: row.id,
    asaas_payment_id: asaasPaymentId,
    asaas_status: asaas.data.status,
    by: input.processedBy,
  });

  return mark;
}
