/**
 * src/lib/fulfillment-transitions.ts — D-044 · onda 2.E
 *
 * Fonte única de verdade pras transições manuais operacionais do
 * fulfillment:
 *
 *   paid                 ──► pharmacy_requested
 *   pharmacy_requested   ──► shipped          (requer tracking_note)
 *   shipped              ──► delivered
 *   qualquer não-terminal ──► cancelled        (requer motivo)
 *
 * Reaproveita `canTransition` de `fulfillments.ts` pra manter a
 * máquina de estados consistente entre webhook (2.D) e painel
 * admin (2.E) e área do paciente (2.F).
 *
 * Propriedades:
 *
 *   - Idempotente: chamar com `to = status atual` devolve sucesso
 *     com `alreadyAtTarget=true` sem duplicar timestamps. Crítico
 *     pra botões que podem ser clicados 2x.
 *
 *   - Race-safe: UPDATE usa `.eq('status', from)` como guard. Se
 *     outro operador avançou entre o SELECT e o UPDATE, o UPDATE
 *     não bate linha e a função devolve `invalid_transition` com
 *     o estado real — o operador vê a UI atualizada sem estragar
 *     nada.
 *
 *   - Audit trail: grava `updated_by_user_id` (quem apertou),
 *     timestamps específicos (`pharmacy_requested_at`, `shipped_at`,
 *     `delivered_at`, `cancelled_at`), `tracking_note` quando
 *     shipped, `cancelled_reason` quando cancelled.
 *
 *   - Pura de I/O WhatsApp: notificação best-effort fica na camada
 *     de transport (endpoint).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { canTransition, type FulfillmentStatus } from "./fulfillments";

// ────────────────────────────────────────────────────────────────────────
// Tipos
// ────────────────────────────────────────────────────────────────────────

export type TransitionActor = "admin" | "patient" | "system";

export type TransitionInput = {
  fulfillmentId: string;
  to: FulfillmentStatus;
  actor: TransitionActor;
  actorUserId: string | null;
  /** Obrigatório quando `to === 'shipped'`. Transportadora + código ou texto livre. */
  trackingNote?: string | null;
  /** Obrigatório quando `to === 'cancelled'`. */
  cancelledReason?: string | null;
  /** Timestamp pra testes (default `new Date()`). */
  now?: Date;
};

export type TransitionSuccess = {
  ok: true;
  fulfillmentId: string;
  from: FulfillmentStatus;
  to: FulfillmentStatus;
  /** true se o fulfillment já estava no `to` alvo quando chamado. */
  alreadyAtTarget: boolean;
};

export type TransitionFailure = {
  ok: false;
  code:
    | "not_found"
    | "invalid_transition"
    | "invalid_payload"
    | "forbidden_actor"
    | "db_error";
  message: string;
  currentStatus?: FulfillmentStatus;
};

export type TransitionResult = TransitionSuccess | TransitionFailure;

// ────────────────────────────────────────────────────────────────────────
// Função principal
// ────────────────────────────────────────────────────────────────────────

/**
 * Executa uma transição no fulfillment.
 *
 * Regras de ator (defense-in-depth; a auth é no endpoint):
 *   - `admin` pode todas as transições exceto iniciar `pending_payment`
 *     → `paid` (isso é só via webhook Asaas).
 *   - `patient` só pode `shipped → delivered` (confirmar recebimento).
 *   - `system` pode todas (uso interno, ex: cron que auto-delivered
 *     depois de N dias sem confirmação — futuro).
 */
export async function transitionFulfillment(
  supabase: SupabaseClient,
  input: TransitionInput
): Promise<TransitionResult> {
  // 1) Validações puras
  const target = input.to;

  if (target === "shipped") {
    const note = (input.trackingNote ?? "").trim();
    if (note.length < 3) {
      return {
        ok: false,
        code: "invalid_payload",
        message:
          "Informe a transportadora ou código de rastreio (mínimo 3 caracteres).",
      };
    }
  }
  if (target === "cancelled") {
    const reason = (input.cancelledReason ?? "").trim();
    if (reason.length < 3) {
      return {
        ok: false,
        code: "invalid_payload",
        message: "Informe o motivo do cancelamento (mínimo 3 caracteres).",
      };
    }
  }

  if (input.actor === "patient" && target !== "delivered") {
    return {
      ok: false,
      code: "forbidden_actor",
      message: "Paciente só pode confirmar recebimento.",
    };
  }
  if (input.actor === "admin" && target === "paid") {
    return {
      ok: false,
      code: "forbidden_actor",
      message:
        "Promoção para `paid` é automática via webhook Asaas — admin não aciona.",
    };
  }

  // 2) Carregar estado atual
  const ffRes = await supabase
    .from("fulfillments")
    .select("id, status, tracking_note")
    .eq("id", input.fulfillmentId)
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
      message: "Fulfillment não encontrado.",
    };
  }
  const currentStatus = (ffRes.data as { id: string; status: FulfillmentStatus }).status;

  // 3) Idempotência: já está no alvo
  if (currentStatus === target) {
    return {
      ok: true,
      fulfillmentId: input.fulfillmentId,
      from: currentStatus,
      to: target,
      alreadyAtTarget: true,
    };
  }

  // 4) Transição permitida?
  if (!canTransition(currentStatus, target)) {
    return {
      ok: false,
      code: "invalid_transition",
      message: `Transição ${currentStatus} → ${target} não é permitida.`,
      currentStatus,
    };
  }

  // 5) Patch
  const now = (input.now ?? new Date()).toISOString();
  const patch: Record<string, unknown> = {
    status: target,
    updated_by_user_id: input.actorUserId,
  };

  switch (target) {
    case "pharmacy_requested":
      patch.pharmacy_requested_at = now;
      break;
    case "shipped":
      patch.shipped_at = now;
      patch.tracking_note = (input.trackingNote ?? "").trim();
      break;
    case "delivered":
      patch.delivered_at = now;
      break;
    case "cancelled":
      patch.cancelled_at = now;
      patch.cancelled_reason = (input.cancelledReason ?? "").trim();
      break;
    default:
      // pending_acceptance / pending_payment / paid: não caem aqui
      // porque validações anteriores barraram.
      break;
  }

  // 6) UPDATE race-safe
  const upd = await supabase
    .from("fulfillments")
    .update(patch)
    .eq("id", input.fulfillmentId)
    .eq("status", currentStatus)
    .select("id, status")
    .maybeSingle();

  if (upd.error) {
    return {
      ok: false,
      code: "db_error",
      message: `Erro ao atualizar fulfillment: ${upd.error.message}`,
    };
  }
  if (!upd.data) {
    // Outro worker mudou o estado entre nosso select e update.
    // Tratamos como invalid_transition — a UI recarrega e decide.
    return {
      ok: false,
      code: "invalid_transition",
      message:
        "Estado mudou durante a operação (outro operador). Recarregue a página.",
      currentStatus,
    };
  }

  return {
    ok: true,
    fulfillmentId: input.fulfillmentId,
    from: currentStatus,
    to: target,
    alreadyAtTarget: false,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Labels humanos (pro UI)
// ────────────────────────────────────────────────────────────────────────

export function labelForFulfillmentStatus(status: FulfillmentStatus): string {
  const map: Record<FulfillmentStatus, string> = {
    pending_acceptance: "Aguardando aceite",
    pending_payment: "Aguardando pagamento",
    paid: "Pago · fila pra farmácia",
    pharmacy_requested: "Receita na farmácia",
    shipped: "Despachado",
    delivered: "Entregue",
    cancelled: "Cancelado",
  };
  return map[status];
}

export function labelForTransitionButton(to: FulfillmentStatus): string {
  const map: Record<FulfillmentStatus, string> = {
    pending_acceptance: "—",
    pending_payment: "—",
    paid: "—",
    pharmacy_requested: "Enviar receita à farmácia",
    shipped: "Marcar como despachado",
    delivered: "Marcar como entregue",
    cancelled: "Cancelar",
  };
  return map[to];
}
