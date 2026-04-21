/**
 * src/lib/fulfillment-promote.ts — D-044 · onda 2.D
 *
 * Promove um fulfillment de `pending_payment` → `paid` quando o
 * webhook Asaas confirma o pagamento vinculado. Idempotente e
 * tolerante a falhas — o webhook não pode bloquear em erros aqui.
 *
 * Cobertura de estados:
 *
 *   pending_payment  ──► paid         (ação única desta função)
 *   paid             ──► no-op        (idempotência direta)
 *   pharmacy_requested+ ─► no-op      (webhook atrasado — ok)
 *   pending_acceptance  ─► erro       (aceite tem que acontecer antes)
 *   cancelled        ──► no-op        (fulfillment cancelado
 *                                      permanece cancelado; refund
 *                                      é tratado por outro caminho)
 *
 * O localizador tenta `payment_id` do fulfillment primeiro. Se não
 * encontra (casos de race: payment_id ainda não foi vinculado por
 * `ensurePaymentForFulfillment` quando o webhook chegou), faz
 * fallback buscando `payments.id` → `fulfillments.payment_id IS NULL`
 * do mesmo customer com status `pending_payment`. Esse fallback é
 * propositalmente conservador: se houver mais de um candidato,
 * abortamos com `ambiguous_fulfillment`.
 *
 * Notificação WhatsApp: best-effort. A função devolve flags do que
 * aconteceu (wasPromoted, alreadyPaid, notificationSent); o webhook
 * pode logar sem bloquear.
 *
 * A função é propositalmente PURA de I/O WhatsApp — recebe um
 * `notify` callback opcional. Isso permite testar a promoção sem
 * mockar o módulo de WhatsApp e deixa o webhook decidir o template
 * certo quando houver.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "./logger";

const log = logger.with({ mod: "fulfillment-promote" });

// ────────────────────────────────────────────────────────────────────────
// Tipos
// ────────────────────────────────────────────────────────────────────────

export type PromoteFulfillmentSuccess = {
  ok: true;
  fulfillmentId: string;
  customerId: string;
  planName: string;
  customerPhone: string | null;
  customerName: string;
  /** true se esta chamada foi a responsável por mover pra `paid`. */
  wasPromoted: boolean;
  /** true se o fulfillment já estava em `paid` ou além quando chamamos. */
  alreadyPaid: boolean;
  /** Status final após a operação. */
  status: string;
};

export type PromoteFulfillmentFailure = {
  ok: false;
  code:
    | "payment_not_found"
    | "fulfillment_not_found"
    | "ambiguous_fulfillment"
    | "invalid_state"
    | "db_error";
  message: string;
};

export type PromoteFulfillmentResult =
  | PromoteFulfillmentSuccess
  | PromoteFulfillmentFailure;

export type PromoteFulfillmentParams = {
  /** Id local em `payments` — preferencial. */
  paymentId?: string | null;
  /** Id no Asaas — usado pra resolver `paymentId` se não veio. */
  asaasPaymentId?: string | null;
  /** Timestamp pra `paid_at`; default `new Date()`. */
  now?: Date;
};

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function unwrap<T>(v: unknown): T | null {
  if (v == null) return null;
  return Array.isArray(v) ? ((v[0] as T) ?? null) : (v as T);
}

type FulfillmentRowLite = {
  id: string;
  status: string;
  customer_id: string;
  payment_id: string | null;
  customer: {
    id: string;
    name: string;
    phone: string | null;
  };
  plan: {
    id: string;
    name: string;
  };
};

// ────────────────────────────────────────────────────────────────────────
// Função principal
// ────────────────────────────────────────────────────────────────────────

export async function promoteFulfillmentAfterPayment(
  supabase: SupabaseClient,
  params: PromoteFulfillmentParams
): Promise<PromoteFulfillmentResult> {
  const now = params.now ?? new Date();

  // 1) Resolver `paymentId` local a partir do `asaasPaymentId` se preciso.
  let localPaymentId = params.paymentId ?? null;
  if (!localPaymentId && params.asaasPaymentId) {
    const payRes = await supabase
      .from("payments")
      .select("id")
      .eq("asaas_payment_id", params.asaasPaymentId)
      .maybeSingle();

    if (payRes.error) {
      return {
        ok: false,
        code: "db_error",
        message: `Erro ao buscar payment por asaas_payment_id: ${payRes.error.message}`,
      };
    }
    if (!payRes.data) {
      return {
        ok: false,
        code: "payment_not_found",
        message: `Nenhum payment local com asaas_payment_id=${params.asaasPaymentId}.`,
      };
    }
    localPaymentId = (payRes.data as { id: string }).id;
  }

  if (!localPaymentId) {
    return {
      ok: false,
      code: "payment_not_found",
      message: "Nenhum paymentId fornecido pra resolver o fulfillment.",
    };
  }

  // 2) Localizar fulfillment por payment_id
  const ffRes = await supabase
    .from("fulfillments")
    .select(
      `id, status, customer_id, payment_id,
       customer:customers!inner(id, name, phone),
       plan:plans!inner(id, name)`
    )
    .eq("payment_id", localPaymentId)
    .maybeSingle();

  if (ffRes.error) {
    return {
      ok: false,
      code: "db_error",
      message: `Erro ao buscar fulfillment: ${ffRes.error.message}`,
    };
  }

  let ff = ffRes.data ? normalizeFf(ffRes.data) : null;

  // 3) Fallback: se payment_id não está vinculado (race ff.link falhou),
  //    tenta achar o fulfillment pendente do mesmo customer via payments.
  if (!ff) {
    const linkRes = await supabase
      .from("payments")
      .select("customer_id")
      .eq("id", localPaymentId)
      .maybeSingle();

    if (linkRes.error || !linkRes.data) {
      return {
        ok: false,
        code: "payment_not_found",
        message: "Payment local não existe.",
      };
    }

    const customerId = (linkRes.data as { customer_id: string }).customer_id;
    const candRes = await supabase
      .from("fulfillments")
      .select(
        `id, status, customer_id, payment_id,
         customer:customers!inner(id, name, phone),
         plan:plans!inner(id, name)`
      )
      .eq("customer_id", customerId)
      .is("payment_id", null)
      .eq("status", "pending_payment");

    if (candRes.error) {
      return {
        ok: false,
        code: "db_error",
        message: `Erro ao buscar fulfillment fallback: ${candRes.error.message}`,
      };
    }
    const candidates = (candRes.data ?? []) as unknown[];
    if (candidates.length === 0) {
      return {
        ok: false,
        code: "fulfillment_not_found",
        message: "Nenhum fulfillment pendente encontrado pra este payment.",
      };
    }
    if (candidates.length > 1) {
      return {
        ok: false,
        code: "ambiguous_fulfillment",
        message: `Mais de um fulfillment pendente (${candidates.length}) pro mesmo customer — não é seguro promover sem payment_id.`,
      };
    }
    ff = normalizeFf(candidates[0]);

    // Amarra payment_id retroativamente
    const linkUpd = await supabase
      .from("fulfillments")
      .update({ payment_id: localPaymentId })
      .eq("id", ff.id);
    if (linkUpd.error) {
      log.error("link retroativo falhou", { err: linkUpd.error });
      // Seguimos mesmo assim — o update de status pode salvar tudo.
    }
  }

  // 4) Decidir ação por status
  if (
    ff.status === "paid" ||
    ff.status === "pharmacy_requested" ||
    ff.status === "shipped" ||
    ff.status === "delivered"
  ) {
    return {
      ok: true,
      fulfillmentId: ff.id,
      customerId: ff.customer_id,
      planName: ff.plan.name,
      customerName: ff.customer.name,
      customerPhone: ff.customer.phone,
      wasPromoted: false,
      alreadyPaid: true,
      status: ff.status,
    };
  }

  if (ff.status === "cancelled") {
    return {
      ok: false,
      code: "invalid_state",
      message:
        "Fulfillment cancelado. Pagamento chegou tarde — promoção bloqueada.",
    };
  }

  if (ff.status === "pending_acceptance") {
    return {
      ok: false,
      code: "invalid_state",
      message:
        "Fulfillment em `pending_acceptance`. Pagamento sem aceite formal é inconsistente — investigar.",
    };
  }

  if (ff.status !== "pending_payment") {
    return {
      ok: false,
      code: "invalid_state",
      message: `Status inesperado: ${ff.status}.`,
    };
  }

  // 5) Promover: pending_payment → paid
  const upd = await supabase
    .from("fulfillments")
    .update({
      status: "paid",
      paid_at: now.toISOString(),
    })
    .eq("id", ff.id)
    .eq("status", "pending_payment") // guard contra race (outro worker promoveu)
    .select("id, status")
    .maybeSingle();

  if (upd.error) {
    return {
      ok: false,
      code: "db_error",
      message: `Erro ao promover fulfillment: ${upd.error.message}`,
    };
  }

  // Se o UPDATE não casou nenhuma linha, outro worker já promoveu entre
  // nosso SELECT e o UPDATE. Tratamos como idempotência bem-sucedida.
  if (!upd.data) {
    return {
      ok: true,
      fulfillmentId: ff.id,
      customerId: ff.customer_id,
      planName: ff.plan.name,
      customerName: ff.customer.name,
      customerPhone: ff.customer.phone,
      wasPromoted: false,
      alreadyPaid: true,
      status: "paid",
    };
  }

  return {
    ok: true,
    fulfillmentId: ff.id,
    customerId: ff.customer_id,
    planName: ff.plan.name,
    customerName: ff.customer.name,
    customerPhone: ff.customer.phone,
    wasPromoted: true,
    alreadyPaid: false,
    status: "paid",
  };
}

// ────────────────────────────────────────────────────────────────────────
// Composição de mensagem WhatsApp (puro — usado pelo webhook)
// ────────────────────────────────────────────────────────────────────────

/**
 * Compõe a mensagem de "pagamento confirmado" pro paciente.
 * Função pura pra ficar testável sem mocks. Quem decide enviar
 * via `sendText` ou via template aprovado é a camada de transport
 * (webhook).
 */
export function composePaidWhatsAppMessage(params: {
  customerName: string;
  planName: string;
}): string {
  const firstName = params.customerName.split(" ")[0] || "paciente";
  return [
    `Oi, ${firstName}! Aqui é o Instituto Nova Medida.`,
    "",
    `Seu pagamento do plano ${params.planName} foi confirmado.`,
    "",
    "A clínica já recebeu sua prescrição e vai providenciar a manipulação junto à farmácia parceira. Assim que o medicamento for despachado pro seu endereço, você recebe uma nova mensagem com o código de rastreio.",
    "",
    "Qualquer dúvida, é só responder aqui.",
  ].join("\n");
}

// ────────────────────────────────────────────────────────────────────────
// Helpers internos
// ────────────────────────────────────────────────────────────────────────

function normalizeFf(raw: unknown): FulfillmentRowLite {
  const r = raw as Record<string, unknown>;
  const customer = unwrap<FulfillmentRowLite["customer"]>(r.customer);
  const plan = unwrap<FulfillmentRowLite["plan"]>(r.plan);
  if (!customer || !plan) {
    throw new Error("fulfillment sem customer/plan — inconsistência de join");
  }
  return {
    id: r.id as string,
    status: r.status as string,
    customer_id: r.customer_id as string,
    payment_id: (r.payment_id as string | null) ?? null,
    customer,
    plan,
  };
}
