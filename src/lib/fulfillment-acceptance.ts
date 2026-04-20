/**
 * src/lib/fulfillment-acceptance.ts — D-044 · onda 2.C
 *
 * Fonte única de verdade pro ato do paciente "aceitar formalmente
 * o plano indicado pela médica e informar endereço de entrega".
 *
 * Encapsula:
 *   - validação de ownership (paciente autenticado bate com customer
 *     do fulfillment);
 *   - validação de estado (só aceita `pending_acceptance`);
 *   - validação e normalização de endereço (`patient-address.ts`);
 *   - render do termo jurídico com dados reais (`acceptance-terms.ts`);
 *   - hash determinístico do aceite (`fulfillments.computeAcceptanceHash`);
 *   - persistência idempotente:
 *       (i) upsert de endereço em `customers`,
 *       (ii) INSERT em `plan_acceptances` (imutável por trigger SQL),
 *       (iii) UPDATE de fulfillment: status → pending_payment, snapshot
 *             shipping_*, accepted_at.
 *   - idempotência via `plan_acceptances.fulfillment_id UNIQUE`:
 *     chamada repetida devolve `already_accepted` com o acceptanceId
 *     existente.
 *
 * A função é server-only (SupabaseClient com service_role) mas
 * testável com `createSupabaseMock`.
 *
 * A criação do payment no Asaas fica fora deste módulo (próxima
 * etapa, camada de transporte). Motivo: o aceite tem que ser
 * registrado primeiro; se o Asaas falhar, o fulfillment fica em
 * `pending_payment` sem `payment_id` e o endpoint retenta.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  computeAcceptanceHash,
  type FulfillmentStatus,
  type ShippingSnapshot,
} from "./fulfillments";
import {
  snapshotToCustomerPatch,
  snapshotToFulfillmentPatch,
  validateAddress,
  type AddressInput,
} from "./patient-address";

// ────────────────────────────────────────────────────────────────────────
// Tipos
// ────────────────────────────────────────────────────────────────────────

export type AcceptFulfillmentInput = {
  /**
   * Texto JÁ renderizado com os dados reais (ver
   * `renderAcceptanceTerms`). Não renderizamos aqui pra evitar
   * double-render e porque a tela de oferta precisa exibir
   * exatamente a mesma string que será gravada.
   */
  acceptance_text: string;
  address: AddressInput;
  user_agent?: string | null;
  ip_address?: string | null;
};

export type AcceptFulfillmentSuccess = {
  ok: true;
  fulfillmentId: string;
  acceptanceId: string;
  acceptanceHash: string;
  snapshot: ShippingSnapshot;
  alreadyAccepted: boolean;
  /** Status em que o fulfillment ficou após o aceite. */
  fulfillmentStatus: FulfillmentStatus;
};

export type AcceptFulfillmentFailure = {
  ok: false;
  code:
    | "not_found"
    | "forbidden"
    | "invalid_state"
    | "invalid_address"
    | "invalid_payload"
    | "db_error";
  message: string;
  addressErrors?: Partial<Record<keyof AddressInput, string>>;
};

export type AcceptFulfillmentResult =
  | AcceptFulfillmentSuccess
  | AcceptFulfillmentFailure;

/**
 * Row consolidada que a função precisa carregar pra decidir/gravar.
 * Inclui joins com appointment, plan e customer — numa única query
 * pra reduzir round-trips.
 */
type FulfillmentWithJoins = {
  id: string;
  status: FulfillmentStatus;
  customer_id: string;
  appointment_id: string;
  plan_id: string;
  doctor_id: string;
  appointment: {
    id: string;
    memed_prescription_url: string | null;
    status: string;
  } | null;
  plan: {
    id: string;
    slug: string;
    active: boolean;
  } | null;
  customer: {
    id: string;
    name: string;
    user_id: string | null;
  } | null;
};

// ────────────────────────────────────────────────────────────────────────
// Orquestração principal
// ────────────────────────────────────────────────────────────────────────

/**
 * Registra o aceite formal de um fulfillment.
 *
 * `userId` é opcional porque o MVP ainda aceita acesso via magic-link
 * sem sessão plena; quando presente, é validado contra
 * `customers.user_id`. Se ausente, a checagem fica por conta do
 * caller (rota passa `customer_id` verificado por outro meio — ex:
 * token HMAC). No fluxo final, `userId` virá sempre preenchido.
 */
export async function acceptFulfillment(
  supabase: SupabaseClient,
  params: {
    fulfillmentId: string;
    userId: string | null;
    customerId?: string | null; // usado quando não há userId (rota via token)
    input: AcceptFulfillmentInput;
    now?: Date;
  }
): Promise<AcceptFulfillmentResult> {
  // 1. Validação de payload básico
  if (
    !params.input.acceptance_text ||
    params.input.acceptance_text.trim().length < 200
  ) {
    return {
      ok: false,
      code: "invalid_payload",
      message:
        "O texto do aceite é inválido. Recarregue a página e tente novamente.",
    };
  }

  // 2. Carrega fulfillment + joins numa query
  const ffRes = await supabase
    .from("fulfillments")
    .select(
      `id, status, customer_id, appointment_id, plan_id, doctor_id,
       appointment:appointments!inner(id, memed_prescription_url, status),
       plan:plans!inner(id, slug, active),
       customer:customers!inner(id, name, user_id)`
    )
    .eq("id", params.fulfillmentId)
    .maybeSingle();

  if (ffRes.error) {
    return {
      ok: false,
      code: "db_error",
      message: `Erro ao carregar fulfillment: ${ffRes.error.message}`,
    };
  }
  if (!ffRes.data) {
    return {
      ok: false,
      code: "not_found",
      message: "Oferta de tratamento não encontrada.",
    };
  }

  // Supabase retorna joins às vezes como array, às vezes como objeto.
  // Normalizamos pra um shape previsível.
  const ff = normalizeFfRow(ffRes.data as Record<string, unknown>);

  // 3. Ownership: ou o user_id bate, ou o customer_id passado bate
  const callerCustomerId = params.customerId ?? null;
  const callerUserId = params.userId ?? null;

  const ownsByUser =
    callerUserId != null &&
    ff.customer != null &&
    ff.customer.user_id === callerUserId;
  const ownsByCustomer =
    callerCustomerId != null && ff.customer_id === callerCustomerId;

  if (!ownsByUser && !ownsByCustomer) {
    return {
      ok: false,
      code: "forbidden",
      message: "Esse tratamento não pertence à sua conta.",
    };
  }

  // 4. Estado: se já aceitou, devolve idempotente; se cancelado, nega
  if (
    ff.status === "cancelled" ||
    ff.status === "delivered" ||
    ff.status === "shipped" ||
    ff.status === "pharmacy_requested"
  ) {
    return {
      ok: false,
      code: "invalid_state",
      message: `Este tratamento não pode mais ser aceito (status atual: ${ff.status}).`,
    };
  }

  if (ff.status !== "pending_acceptance" && ff.status !== "pending_payment" && ff.status !== "paid") {
    // Tipo exaustivo: se chegar aqui é porque alguém adicionou um status novo sem atualizar esta função
    return {
      ok: false,
      code: "invalid_state",
      message: `Status de fulfillment inesperado: ${ff.status}.`,
    };
  }

  // Se já aceito (pending_payment / paid), devolve idempotente.
  if (ff.status === "pending_payment" || ff.status === "paid") {
    const existingRes = await supabase
      .from("plan_acceptances")
      .select("id, acceptance_hash, shipping_snapshot")
      .eq("fulfillment_id", ff.id)
      .maybeSingle();

    if (existingRes.error || !existingRes.data) {
      return {
        ok: false,
        code: "db_error",
        message: "Inconsistência: fulfillment aceito sem registro de aceite.",
      };
    }
    const existing = existingRes.data as {
      id: string;
      acceptance_hash: string;
      shipping_snapshot: ShippingSnapshot | null;
    };
    return {
      ok: true,
      fulfillmentId: ff.id,
      acceptanceId: existing.id,
      acceptanceHash: existing.acceptance_hash,
      snapshot: existing.shipping_snapshot ?? {
        recipient_name: "",
        zipcode: "",
        street: "",
        number: "",
        complement: null,
        district: "",
        city: "",
        state: "",
      },
      alreadyAccepted: true,
      fulfillmentStatus: ff.status,
    };
  }

  // 5. Dados auxiliares obrigatórios
  if (!ff.plan || !ff.customer || !ff.appointment) {
    return {
      ok: false,
      code: "db_error",
      message: "Dados de plano, paciente ou consulta ausentes.",
    };
  }
  if (!ff.plan.active) {
    return {
      ok: false,
      code: "invalid_state",
      message:
        "O plano indicado foi desativado. Entre em contato com o Instituto para reagendar.",
    };
  }
  if (!ff.appointment.memed_prescription_url) {
    return {
      ok: false,
      code: "invalid_state",
      message: "A prescrição desta consulta não está disponível.",
    };
  }

  // 6. Valida e normaliza endereço
  const addrResult = validateAddress(params.input.address, ff.customer.name);
  if (!addrResult.ok) {
    return {
      ok: false,
      code: "invalid_address",
      message: "Endereço de entrega inválido. Corrija os campos destacados.",
      addressErrors: addrResult.errors,
    };
  }
  const shipping = addrResult.snapshot;

  // 7. Hash do aceite
  const acceptanceHash = computeAcceptanceHash({
    acceptanceText: params.input.acceptance_text,
    planSlug: ff.plan.slug,
    prescriptionUrl: ff.appointment.memed_prescription_url,
    appointmentId: ff.appointment_id,
    shipping,
  });

  const now = (params.now ?? new Date()).toISOString();

  // 8. Upsert endereço no customer (cache do "último endereço")
  //    — falha aqui não bloqueia o aceite; é conveniência.
  const customerPatch = snapshotToCustomerPatch(shipping);
  const cUpd = await supabase
    .from("customers")
    .update(customerPatch)
    .eq("id", ff.customer_id);
  if (cUpd.error) {
    // log-and-continue: não aborta aceite por falha em atualização
    // de cache. O snapshot definitivo está no fulfillment.
    console.error("[fulfillment-acceptance] customer update falhou:", cUpd.error);
  }

  // 9. INSERT em plan_acceptances (imutável por trigger)
  //    Race condition: 2 chamadas paralelas. O UNIQUE em
  //    `fulfillment_id` garante que só uma vence; a outra pega
  //    violação e re-lê.
  const accIns = await supabase
    .from("plan_acceptances")
    .insert({
      fulfillment_id: ff.id,
      appointment_id: ff.appointment_id,
      customer_id: ff.customer_id,
      plan_id: ff.plan_id,
      accepted_at: now,
      acceptance_text: params.input.acceptance_text,
      acceptance_hash: acceptanceHash,
      shipping_snapshot: shipping,
      user_id: params.userId,
      ip_address: params.input.ip_address ?? null,
      user_agent: params.input.user_agent ?? null,
    })
    .select("id")
    .single();

  if (accIns.error) {
    // Colisão por unique constraint ⇒ alguém aceitou em paralelo.
    // Tratamos como idempotência bem-sucedida.
    if (accIns.error.code === "23505") {
      const recheck = await supabase
        .from("plan_acceptances")
        .select("id, acceptance_hash")
        .eq("fulfillment_id", ff.id)
        .maybeSingle();
      if (recheck.data) {
        return {
          ok: true,
          fulfillmentId: ff.id,
          acceptanceId: (recheck.data as { id: string }).id,
          acceptanceHash: (recheck.data as { acceptance_hash: string })
            .acceptance_hash,
          snapshot: shipping,
          alreadyAccepted: true,
          fulfillmentStatus: "pending_payment",
        };
      }
    }
    return {
      ok: false,
      code: "db_error",
      message: `Erro ao gravar aceite: ${accIns.error.message}`,
    };
  }

  const acceptanceId = (accIns.data as { id: string }).id;

  // 10. UPDATE do fulfillment: pending_acceptance → pending_payment
  //     + snapshot de endereço + accepted_at
  const ffPatch: Record<string, unknown> = {
    status: "pending_payment" as FulfillmentStatus,
    accepted_at: now,
    updated_by_user_id: params.userId,
    ...snapshotToFulfillmentPatch(shipping),
  };

  const ffUpd = await supabase
    .from("fulfillments")
    .update(ffPatch)
    .eq("id", ff.id);

  if (ffUpd.error) {
    // O aceite já foi gravado (imutável). Não rollback possível.
    // O endpoint pode chamar de novo — a idempotência cobre.
    return {
      ok: false,
      code: "db_error",
      message: `Aceite registrado, mas falhou atualizar fulfillment: ${ffUpd.error.message}. Recarregue a página.`,
    };
  }

  return {
    ok: true,
    fulfillmentId: ff.id,
    acceptanceId,
    acceptanceHash,
    snapshot: shipping,
    alreadyAccepted: false,
    fulfillmentStatus: "pending_payment",
  };
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

/**
 * Supabase JS às vezes devolve relacionamento `!inner` como objeto,
 * às vezes como array com 1 elemento, dependendo da forma do
 * SELECT. Essa função colapsa pra shape único.
 */
function normalizeFfRow(raw: Record<string, unknown>): FulfillmentWithJoins {
  const unwrap = <T>(v: unknown): T | null => {
    if (v == null) return null;
    if (Array.isArray(v)) return (v[0] as T) ?? null;
    return v as T;
  };

  return {
    id: raw.id as string,
    status: raw.status as FulfillmentStatus,
    customer_id: raw.customer_id as string,
    appointment_id: raw.appointment_id as string,
    plan_id: raw.plan_id as string,
    doctor_id: raw.doctor_id as string,
    appointment: unwrap<FulfillmentWithJoins["appointment"]>(raw.appointment),
    plan: unwrap<FulfillmentWithJoins["plan"]>(raw.plan),
    customer: unwrap<FulfillmentWithJoins["customer"]>(raw.customer),
  };
}
