/**
 * src/lib/patient-update-shipping.ts — D-045 · 3.E
 *
 * Paciente pode alterar o endereço operacional do fulfillment entre
 * `paid` e `pharmacy_requested`. Depois da farmácia ser acionada, a
 * etiqueta já foi gerada e qualquer mudança é operação humana do
 * admin (risco de caixa chegar no lugar errado).
 *
 * Diferença crítica vs. aceite:
 *   - `plan_acceptances.shipping_snapshot` é IMUTÁVEL (prova legal
 *     do endereço que o paciente declarou ao aceitar). Não mexemos.
 *   - `fulfillments.shipping_*` é OPERACIONAL (o endereço que a
 *     clínica vai usar pra enviar a caixa). Este sim pode mudar.
 *   - Toda mudança grava linha em `fulfillment_address_changes`
 *     (auditoria com before/after/quem/quando).
 *
 * Regras:
 *   - Status do fulfillment DEVE ser `paid`. Nos outros states:
 *     • `pending_*`: endereço ainda não importa operacionalmente
 *       (a etiqueta só é gerada a partir de `paid`).
 *     • `pharmacy_requested`, `shipped`, `delivered`, `cancelled`:
 *       tarde demais / não faz sentido.
 *   - Ownership check fica no endpoint (antes de chamar esta lib).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  snapshotToFulfillmentPatch,
  validateAddress,
  type AddressInput,
} from "@/lib/patient-address";
import type { FulfillmentStatus } from "@/lib/fulfillments";

export type UpdateShippingResult =
  | {
      ok: true;
      fulfillmentId: string;
      /** Snapshot gravado em `fulfillments.shipping_*` (normalizado). */
      snapshot: ReturnType<typeof snapshotToFulfillmentPatch>;
      /** ID do log de auditoria em `fulfillment_address_changes`. */
      auditId: string | null;
      /** true se before == after. Nenhuma mudança real; ainda assim gravamos log. */
      noChanges: boolean;
    }
  | {
      ok: false;
      code:
        | "not_found"
        | "invalid_status"
        | "invalid_payload"
        | "db_error";
      message: string;
      currentStatus?: FulfillmentStatus;
      /** Erros por campo quando `code === "invalid_payload"`. */
      fieldErrors?: Partial<Record<keyof AddressInput, string>>;
    };

export type UpdateShippingInput = {
  fulfillmentId: string;
  customerId: string;
  actorUserId: string | null;
  source: "patient" | "admin";
  address: AddressInput;
  recipientFallback: string;
  note?: string | null;
  now?: Date;
};

type FulfillmentRow = {
  id: string;
  customer_id: string;
  status: FulfillmentStatus;
  shipping_recipient_name: string | null;
  shipping_zipcode: string | null;
  shipping_street: string | null;
  shipping_number: string | null;
  shipping_complement: string | null;
  shipping_district: string | null;
  shipping_city: string | null;
  shipping_state: string | null;
};

function existingSnapshot(row: FulfillmentRow):
  | {
      shipping_recipient_name: string | null;
      shipping_zipcode: string | null;
      shipping_street: string | null;
      shipping_number: string | null;
      shipping_complement: string | null;
      shipping_district: string | null;
      shipping_city: string | null;
      shipping_state: string | null;
    }
  | null {
  const { shipping_zipcode, shipping_street } = row;
  if (!shipping_zipcode && !shipping_street) return null;
  return {
    shipping_recipient_name: row.shipping_recipient_name,
    shipping_zipcode: row.shipping_zipcode,
    shipping_street: row.shipping_street,
    shipping_number: row.shipping_number,
    shipping_complement: row.shipping_complement,
    shipping_district: row.shipping_district,
    shipping_city: row.shipping_city,
    shipping_state: row.shipping_state,
  };
}

function snapshotsEqual(
  before: ReturnType<typeof existingSnapshot>,
  after: ReturnType<typeof snapshotToFulfillmentPatch>
): boolean {
  if (!before) return false;
  return (
    (before.shipping_recipient_name ?? null) === after.shipping_recipient_name &&
    (before.shipping_zipcode ?? null) === after.shipping_zipcode &&
    (before.shipping_street ?? null) === after.shipping_street &&
    (before.shipping_number ?? null) === after.shipping_number &&
    (before.shipping_complement ?? null) === after.shipping_complement &&
    (before.shipping_district ?? null) === after.shipping_district &&
    (before.shipping_city ?? null) === after.shipping_city &&
    (before.shipping_state ?? null) === after.shipping_state
  );
}

export async function updateFulfillmentShipping(
  supabase: SupabaseClient,
  input: UpdateShippingInput
): Promise<UpdateShippingResult> {
  // 1) Valida endereço
  const validation = validateAddress(input.address, input.recipientFallback);
  if (!validation.ok) {
    return {
      ok: false,
      code: "invalid_payload",
      message: "Endereço inválido. Verifique os campos destacados.",
      fieldErrors: validation.errors,
    };
  }
  const afterPatch = snapshotToFulfillmentPatch(validation.snapshot);

  // 2) Carrega estado atual (ownership check é no endpoint)
  const ffRes = await supabase
    .from("fulfillments")
    .select(
      "id, customer_id, status, shipping_recipient_name, shipping_zipcode, shipping_street, shipping_number, shipping_complement, shipping_district, shipping_city, shipping_state"
    )
    .eq("id", input.fulfillmentId)
    .maybeSingle();

  if (ffRes.error) {
    return {
      ok: false,
      code: "db_error",
      message: `Erro ao carregar pedido: ${ffRes.error.message}`,
    };
  }
  if (!ffRes.data) {
    return {
      ok: false,
      code: "not_found",
      message: "Pedido não encontrado.",
    };
  }

  const row = ffRes.data as FulfillmentRow;

  if (row.customer_id !== input.customerId) {
    // Redundância de ownership check — endpoint já deveria ter barrado.
    return {
      ok: false,
      code: "not_found",
      message: "Pedido não encontrado.",
    };
  }

  if (row.status !== "paid") {
    return {
      ok: false,
      code: "invalid_status",
      message:
        row.status === "pending_acceptance" || row.status === "pending_payment"
          ? "A indicação ainda não foi paga — o endereço é coletado no aceite."
          : "O pedido já foi enviado pra farmácia. Fale com o Instituto pra ajustar."
          + "",
      currentStatus: row.status,
    };
  }

  // 3) Idempotência: se snapshot igual, não mexemos. Ainda assim
  // registramos audit log (útil pra descobrir "paciente reenviou
  // o mesmo endereço por ansiedade").
  const before = existingSnapshot(row);
  const noChanges = snapshotsEqual(before, afterPatch);

  const now = (input.now ?? new Date()).toISOString();

  if (!noChanges) {
    const upd = await supabase
      .from("fulfillments")
      .update({
        ...afterPatch,
        updated_by_user_id: input.actorUserId,
      })
      .eq("id", input.fulfillmentId)
      .eq("status", "paid")
      .select("id")
      .maybeSingle();

    if (upd.error) {
      return {
        ok: false,
        code: "db_error",
        message: `Erro ao atualizar endereço: ${upd.error.message}`,
      };
    }
    if (!upd.data) {
      // Race: status saiu de 'paid' entre select e update.
      return {
        ok: false,
        code: "invalid_status",
        message:
          "O pedido acabou de ser enviado pra farmácia. Fale com o Instituto.",
      };
    }
  }

  // 4) Audit log (sempre grava — inclusive quando `noChanges`)
  const auditIns = await supabase
    .from("fulfillment_address_changes")
    .insert({
      fulfillment_id: input.fulfillmentId,
      changed_by_user_id: input.actorUserId,
      changed_at: now,
      source: input.source,
      before_snapshot: before,
      after_snapshot: afterPatch,
      note: input.note ?? null,
    })
    .select("id")
    .maybeSingle();

  const auditId =
    auditIns.error || !auditIns.data
      ? null
      : (auditIns.data as { id: string }).id;

  if (auditIns.error) {
    // Log mas não falha: o update já foi feito e o paciente viu sucesso.
    console.warn(
      "[updateFulfillmentShipping] audit insert falhou:",
      auditIns.error.message
    );
  }

  return {
    ok: true,
    fulfillmentId: input.fulfillmentId,
    snapshot: afterPatch,
    auditId,
    noChanges,
  };
}
