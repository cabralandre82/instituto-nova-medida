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

export type RefundMethod = "manual" | "asaas_api";

export type RefundInput = {
  appointmentId: string;
  method: RefundMethod;
  externalRef?: string | null;
  notes?: string | null;
  /** auth.user.id do admin que acionou. Null se for automação. */
  processedBy?: string | null;
};

export type RefundResult =
  | {
      ok: true;
      appointmentId: string;
      processedAt: string;
      method: RefundMethod;
      alreadyProcessed: boolean;
    }
  | {
      ok: false;
      appointmentId: string;
      code:
        | "appointment_not_found"
        | "refund_not_required"
        | "already_processed"
        | "db_error";
      message: string;
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
    console.error("[refunds] load appointment:", loadErr);
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
  const { error: upErr } = await supabase
    .from("appointments")
    .update({
      refund_processed_at: now,
      refund_processed_method: input.method,
      refund_external_ref: input.externalRef?.trim() || null,
      refund_processed_notes: input.notes?.trim() || null,
      refund_processed_by: input.processedBy ?? null,
    })
    .eq("id", row.id)
    .is("refund_processed_at", null); // segunda trava de idempotência (race)

  if (upErr) {
    console.error("[refunds] update appointment:", upErr);
    return {
      ok: false,
      appointmentId: row.id,
      code: "db_error",
      message: upErr.message,
    };
  }

  console.log("[refunds] processed:", {
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
  };
}

/**
 * Placeholder pra Sprint 5 — estorno automático via Asaas API.
 *
 * Quando implementarmos:
 *   1. Carregar appointment + payment_id + asaas_payment_id.
 *   2. Chamar `POST /payments/{asaas_payment_id}/refund` com value (full
 *      ou partial) e description.
 *   3. Em sucesso, chamar `markRefundProcessed()` com
 *      method='asaas_api', external_ref=refund.id, processedBy=admin.id.
 *   4. Em falha, não marcar — retornar erro pro admin decidir entre
 *      re-tentar ou marcar manual.
 *
 * Por ora, a função retorna erro "not_implemented" pra deixar explícito no
 * código que o fluxo existe mas está desligado. O endpoint admin de refund
 * nem expõe essa opção ainda — UI só oferece manual.
 */
export async function processRefundViaAsaas(_input: {
  appointmentId: string;
  processedBy: string;
}): Promise<RefundResult> {
  return {
    ok: false,
    appointmentId: _input.appointmentId,
    code: "db_error",
    message:
      "processRefundViaAsaas() ainda não implementado — Sprint 5. Use markRefundProcessed(method='manual') até lá.",
  };
}
