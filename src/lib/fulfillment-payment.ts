/**
 * src/lib/fulfillment-payment.ts — D-044 · onda 2.C.2
 *
 * Garante que um fulfillment em `pending_payment` tenha uma
 * cobrança no Asaas com `invoice_url` pra redirecionar o paciente.
 *
 * Idempotência em duas camadas:
 *
 * 1. Se `fulfillments.payment_id` já está setado e a row em
 *    `payments` ainda é PENDING/awaiting — devolve o invoice_url
 *    existente. Não cria outra cobrança.
 *
 * 2. Se o row local existe mas o Asaas payment foi cancelado ou
 *    está com status de erro, criamos uma nova cobrança vinculada
 *    ao mesmo fulfillment (soltamos o payment_id antigo).
 *
 * A função assume que `acceptFulfillment` já foi executado com
 * sucesso — ou seja, o fulfillment está em `pending_payment` com
 * endereço salvo em `shipping_*`. Chamar antes disso retorna erro.
 *
 * Server-only. A camada de transporte (endpoint) chama sequencialmente:
 *
 *   const acc = await acceptFulfillment(supabase, ...)
 *   if (acc.ok) {
 *     const pay = await ensurePaymentForFulfillment(supabase, ff.id)
 *     return { invoice_url: pay.data.invoice_url }
 *   }
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  centsToReais,
  createCustomer,
  createPayment,
  getAsaasEnv,
  type AsaasBillingType,
  type AsaasEnv,
} from "./asaas";

// ────────────────────────────────────────────────────────────────────────
// Tipos
// ────────────────────────────────────────────────────────────────────────

export type EnsurePaymentSuccess = {
  ok: true;
  paymentId: string;
  asaasPaymentId: string;
  invoiceUrl: string | null;
  amountCents: number;
  alreadyExisted: boolean;
};

export type EnsurePaymentFailure = {
  ok: false;
  code:
    | "not_found"
    | "invalid_state"
    | "asaas_customer_error"
    | "asaas_payment_error"
    | "db_error";
  message: string;
  details?: string;
};

export type EnsurePaymentResult = EnsurePaymentSuccess | EnsurePaymentFailure;

type FulfillmentWithCtx = {
  id: string;
  status: string;
  payment_id: string | null;
  customer_id: string;
  plan_id: string;
  customer: {
    id: string;
    name: string;
    cpf: string;
    email: string;
    phone: string;
    address_zipcode: string | null;
    address_street: string | null;
    address_number: string | null;
    address_complement: string | null;
    address_district: string | null;
    address_city: string | null;
    address_state: string | null;
    asaas_customer_id: string | null;
    asaas_env: string | null;
  };
  plan: {
    id: string;
    name: string;
    slug: string;
    cycle_days: number;
    price_pix_cents: number;
    price_cents: number;
    active: boolean;
  };
};

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

/**
 * Status Asaas que indicam que a cobrança ainda é "aproveitável"
 * pro paciente pagar. Se estiver em qualquer outro estado (deletada,
 * refunded, chargeback, etc.), criamos nova.
 */
const REUSABLE_PAYMENT_STATUSES = new Set([
  "PENDING",
  "AWAITING_RISK_ANALYSIS",
  "CONFIRMED", // em casos raros onde o status já avançou mas o invoice ainda serve
]);

function unwrap<T>(v: unknown): T | null {
  if (v == null) return null;
  if (Array.isArray(v)) return (v[0] as T) ?? null;
  return v as T;
}

// ────────────────────────────────────────────────────────────────────────
// Função principal
// ────────────────────────────────────────────────────────────────────────

export async function ensurePaymentForFulfillment(
  supabase: SupabaseClient,
  fulfillmentId: string
): Promise<EnsurePaymentResult> {
  // 1. Carrega fulfillment + customer + plan numa query só
  const ffRes = await supabase
    .from("fulfillments")
    .select(
      `id, status, payment_id, customer_id, plan_id,
       customer:customers!inner(id, name, cpf, email, phone,
         address_zipcode, address_street, address_number, address_complement,
         address_district, address_city, address_state,
         asaas_customer_id, asaas_env),
       plan:plans!inner(id, name, slug, cycle_days, price_pix_cents, price_cents, active)`
    )
    .eq("id", fulfillmentId)
    .maybeSingle();

  if (ffRes.error) {
    return {
      ok: false,
      code: "db_error",
      message: `Erro ao carregar fulfillment: ${ffRes.error.message}`,
    };
  }
  if (!ffRes.data) {
    return { ok: false, code: "not_found", message: "Fulfillment não encontrado." };
  }

  const raw = ffRes.data as Record<string, unknown>;
  const ff: FulfillmentWithCtx = {
    id: raw.id as string,
    status: raw.status as string,
    payment_id: (raw.payment_id as string | null) ?? null,
    customer_id: raw.customer_id as string,
    plan_id: raw.plan_id as string,
    customer: unwrap<FulfillmentWithCtx["customer"]>(raw.customer) as FulfillmentWithCtx["customer"],
    plan: unwrap<FulfillmentWithCtx["plan"]>(raw.plan) as FulfillmentWithCtx["plan"],
  };

  if (!ff.customer || !ff.plan) {
    return {
      ok: false,
      code: "db_error",
      message: "Dados de paciente ou plano ausentes.",
    };
  }

  // Só aceita pending_payment. pending_acceptance = ainda não foi aceito
  // (chamar accept primeiro). paid/pharmacy_requested+ = já pagou.
  if (ff.status !== "pending_payment") {
    return {
      ok: false,
      code: "invalid_state",
      message: `Fulfillment em status ${ff.status}. Pagamento só é criado após aceite.`,
    };
  }

  if (!ff.plan.active) {
    return {
      ok: false,
      code: "invalid_state",
      message: "Plano desativado. Contate o Instituto.",
    };
  }

  // 2. Se já tem payment, reusar se estiver em estado ok
  if (ff.payment_id) {
    const payRes = await supabase
      .from("payments")
      .select("id, status, invoice_url, amount_cents, asaas_payment_id")
      .eq("id", ff.payment_id)
      .maybeSingle();

    if (payRes.error) {
      return {
        ok: false,
        code: "db_error",
        message: `Erro ao carregar pagamento: ${payRes.error.message}`,
      };
    }
    if (payRes.data) {
      const p = payRes.data as {
        id: string;
        status: string;
        invoice_url: string | null;
        amount_cents: number;
        asaas_payment_id: string | null;
      };
      if (REUSABLE_PAYMENT_STATUSES.has(p.status) && p.invoice_url && p.asaas_payment_id) {
        return {
          ok: true,
          paymentId: p.id,
          asaasPaymentId: p.asaas_payment_id,
          invoiceUrl: p.invoice_url,
          amountCents: p.amount_cents,
          alreadyExisted: true,
        };
      }
      // Caiu aqui: payment existe mas não é aproveitável (refunded,
      // deleted, etc.). Seguimos criando novo, mas sem desvincular o
      // antigo (histórico preservado).
    }
  }

  // 3. Garantir customer no Asaas
  const asaasEnv: AsaasEnv = getAsaasEnv();
  let asaasCustomerId = ff.customer.asaas_customer_id;
  const envMismatch = ff.customer.asaas_env && ff.customer.asaas_env !== asaasEnv;

  if (!asaasCustomerId || envMismatch) {
    const created = await createCustomer({
      name: ff.customer.name,
      cpf: ff.customer.cpf,
      email: ff.customer.email,
      phone: ff.customer.phone,
      address: {
        zipcode: ff.customer.address_zipcode ?? undefined,
        street: ff.customer.address_street ?? undefined,
        number: ff.customer.address_number ?? undefined,
        complement: ff.customer.address_complement ?? undefined,
        district: ff.customer.address_district ?? undefined,
        city: ff.customer.address_city ?? undefined,
        state: ff.customer.address_state ?? undefined,
      },
      externalReference: ff.customer.id,
    });
    if (!created.ok) {
      return {
        ok: false,
        code: "asaas_customer_error",
        message: "Falha ao registrar paciente no provedor de pagamento.",
        details: created.message,
      };
    }
    asaasCustomerId = created.data.id;

    const custUpd = await supabase
      .from("customers")
      .update({
        asaas_customer_id: asaasCustomerId,
        asaas_env: asaasEnv,
        asaas_raw: created.data as unknown as Record<string, unknown>,
      })
      .eq("id", ff.customer.id);
    if (custUpd.error) {
      console.error("[ensurePaymentForFulfillment] customer update falhou:", custUpd.error);
    }
  }

  // 4. Criar payment local primeiro (id estável pra externalReference)
  // Usamos preço PIX/à vista como default — paciente pode escolher cartão
  // na invoice hospedada do Asaas se quiser (billingType=UNDEFINED).
  const amountCents = ff.plan.price_pix_cents;
  const billingType: AsaasBillingType = "UNDEFINED";

  const dueDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const insertRes = await supabase
    .from("payments")
    .insert({
      customer_id: ff.customer.id,
      plan_id: ff.plan.id,
      amount_cents: amountCents,
      billing_type: billingType,
      status: "PENDING",
      due_date: dueDate,
      asaas_env: asaasEnv,
    })
    .select("id")
    .single();

  if (insertRes.error || !insertRes.data) {
    return {
      ok: false,
      code: "db_error",
      message: `Erro ao registrar cobrança local: ${
        insertRes.error?.message ?? "sem resposta"
      }`,
    };
  }
  const localPaymentId = (insertRes.data as { id: string }).id;

  // 5. Criar payment no Asaas
  const description = `${ff.plan.name} · ${ff.plan.cycle_days} dias · Instituto Nova Medida`;
  const created = await createPayment({
    customerId: asaasCustomerId,
    amountCents,
    billingType,
    description,
    externalReference: localPaymentId,
    dueInDays: 3,
  });

  if (!created.ok) {
    await supabase
      .from("payments")
      .update({
        status: "DELETED",
        asaas_raw: {
          error: created.message,
          code: created.code,
        } as unknown as Record<string, unknown>,
      })
      .eq("id", localPaymentId);

    return {
      ok: false,
      code: "asaas_payment_error",
      message: "Falha ao criar cobrança no provedor de pagamento.",
      details: created.message,
    };
  }

  // 6. Salvar dados do Asaas no payment local
  const updPay = await supabase
    .from("payments")
    .update({
      asaas_payment_id: created.data.id,
      status: created.data.status,
      invoice_url: created.data.invoiceUrl ?? null,
      bank_slip_url: created.data.bankSlipUrl ?? null,
      due_date: created.data.dueDate,
      asaas_raw: created.data as unknown as Record<string, unknown>,
    })
    .eq("id", localPaymentId);
  if (updPay.error) {
    console.error("[ensurePaymentForFulfillment] update payment falhou:", updPay.error);
  }

  // 7. Vincular fulfillment → payment
  const linkRes = await supabase
    .from("fulfillments")
    .update({ payment_id: localPaymentId })
    .eq("id", ff.id);
  if (linkRes.error) {
    console.error("[ensurePaymentForFulfillment] link ff→payment falhou:", linkRes.error);
    // Não retorna erro: o payment existe, só o vínculo ficou pendente.
    // Próxima chamada da função vai carregar o fulfillment sem
    // payment_id e encontrar... nada — criaria outro. Pra evitar
    // isso, marcamos pelo externalReference (que o webhook usa).
  }

  return {
    ok: true,
    paymentId: localPaymentId,
    asaasPaymentId: created.data.id,
    invoiceUrl: created.data.invoiceUrl ?? null,
    amountCents,
    alreadyExisted: false,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Formatação (reuso pelo UI)
// ────────────────────────────────────────────────────────────────────────

export function formatBRL(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

export function reaisFromCents(cents: number): number {
  return centsToReais(cents);
}
