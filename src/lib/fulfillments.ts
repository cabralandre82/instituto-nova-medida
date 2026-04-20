/**
 * Domínio de fulfillment + aceite formal (D-044 · onda 2.A).
 *
 * Este módulo é propositalmente PURO — zero I/O, zero dependência de
 * Supabase. Tudo que depende de banco vive nas rotas/páginas que
 * consomem estas funções. Isso garante que a máquina de estados e
 * o hash do aceite sejam testáveis em isolamento e estáveis no
 * tempo (mudar a regra = quebrar teste = force review).
 *
 * O que mora aqui:
 *   - Tipos TS das tabelas `fulfillments` e `plan_acceptances`.
 *   - `canTransition(from, to)` — fonte da verdade da máquina de
 *     estados. Usado tanto nos endpoints admin quanto no webhook
 *     Asaas pra aceitar/rejeitar transições.
 *   - `nextAllowedStatuses(from)` — pra UI exibir só os botões que
 *     fazem sentido em cada estado.
 *   - `computeAcceptanceHash(input)` — hash determinístico do texto
 *     aceito pelo paciente. Usado pra detectar adulteração posterior
 *     dos registros de `plan_acceptances` (que o trigger SQL também
 *     protege contra UPDATE/DELETE).
 */

import { createHash } from "node:crypto";

// ────────────────────────────────────────────────────────────────────────
// Tipos
// ────────────────────────────────────────────────────────────────────────

export type FulfillmentStatus =
  | "pending_acceptance"
  | "pending_payment"
  | "paid"
  | "pharmacy_requested"
  | "shipped"
  | "delivered"
  | "cancelled";

export type AppointmentPrescriptionStatus = "none" | "prescribed" | "declined";

export type FulfillmentRow = {
  id: string;
  appointment_id: string;
  customer_id: string;
  doctor_id: string;
  plan_id: string;
  payment_id: string | null;
  status: FulfillmentStatus;
  accepted_at: string | null;
  paid_at: string | null;
  pharmacy_requested_at: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  tracking_note: string | null;
  cancelled_reason: string | null;
  updated_by_user_id: string | null;
  created_at: string;
  updated_at: string;
};

export type PlanAcceptanceRow = {
  id: string;
  fulfillment_id: string;
  appointment_id: string;
  customer_id: string;
  plan_id: string;
  accepted_at: string;
  acceptance_text: string;
  acceptance_hash: string;
  user_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
};

// ────────────────────────────────────────────────────────────────────────
// Máquina de estados
// ────────────────────────────────────────────────────────────────────────

/**
 * Transições válidas. Cada chave é o estado origem; cada valor é a
 * lista de estados-destino permitidos.
 *
 * Regras de negócio:
 *   - `pending_acceptance` só avança pra `pending_payment` (após
 *     aceite do paciente) ou `cancelled`.
 *   - `pending_payment` só vira `paid` via webhook Asaas (ou `cancelled`
 *     se paciente não pagar em X dias / refund).
 *   - A partir de `paid`, só operador (admin) avança: `paid` →
 *     `pharmacy_requested` → `shipped` → `delivered`.
 *   - `cancelled` pode acontecer em qualquer etapa pré-`delivered`.
 *   - `delivered` e `cancelled` são terminais.
 */
const TRANSITIONS: Record<FulfillmentStatus, readonly FulfillmentStatus[]> = {
  pending_acceptance: ["pending_payment", "cancelled"],
  pending_payment: ["paid", "cancelled"],
  paid: ["pharmacy_requested", "cancelled"],
  pharmacy_requested: ["shipped", "cancelled"],
  shipped: ["delivered", "cancelled"],
  delivered: [],
  cancelled: [],
};

export function canTransition(
  from: FulfillmentStatus,
  to: FulfillmentStatus
): boolean {
  if (from === to) return false;
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function nextAllowedStatuses(
  from: FulfillmentStatus
): readonly FulfillmentStatus[] {
  return TRANSITIONS[from] ?? [];
}

export function isTerminalStatus(status: FulfillmentStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/**
 * Labels em pt-BR pra exibir em painéis. Mantém a mensagem perto
 * do enum pra não espalhar strings mágicas.
 */
export function fulfillmentStatusLabel(status: FulfillmentStatus): string {
  switch (status) {
    case "pending_acceptance":
      return "Aguardando aceite do paciente";
    case "pending_payment":
      return "Aguardando pagamento";
    case "paid":
      return "Pago · pronto pra encaminhar à farmácia";
    case "pharmacy_requested":
      return "Na farmácia de manipulação";
    case "shipped":
      return "Enviado ao paciente";
    case "delivered":
      return "Entregue";
    case "cancelled":
      return "Cancelado";
  }
}

// ────────────────────────────────────────────────────────────────────────
// Hash de aceite formal (D-044)
// ────────────────────────────────────────────────────────────────────────

export type AcceptanceHashInput = {
  /** Texto COMPLETO exibido ao paciente na tela de aceite. */
  acceptanceText: string;
  /** Slug do plano aceito (estável no tempo, diferente do nome). */
  planSlug: string;
  /** URL da prescrição Memed da consulta (vira "o que foi prescrito"). */
  prescriptionUrl: string;
  /** UUID do appointment — amarra o aceite a uma consulta específica. */
  appointmentId: string;
};

/**
 * Hash determinístico SHA-256 dos campos canonicalizados.
 *
 * Canonicalização: JSON.stringify das chaves em ordem alfabética,
 * com os strings normalizados (trim + normalize NFC). Isso garante
 * que o mesmo input produza sempre o mesmo hash, independente de
 * espaços em volta ou diferenças Unicode.
 *
 * Uso: grava o hash em `plan_acceptances.acceptance_hash`. Depois,
 * auditoria pode re-calcular e comparar — diferença = tampering.
 */
export function computeAcceptanceHash(input: AcceptanceHashInput): string {
  const canonical = JSON.stringify({
    acceptanceText: normalizeText(input.acceptanceText),
    appointmentId: input.appointmentId.trim(),
    planSlug: input.planSlug.trim().toLowerCase(),
    prescriptionUrl: input.prescriptionUrl.trim(),
  });

  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function normalizeText(raw: string): string {
  return raw.normalize("NFC").replace(/\s+/g, " ").trim();
}

// ────────────────────────────────────────────────────────────────────────
// Helpers de mutação (aplicados por quem grava no banco)
// ────────────────────────────────────────────────────────────────────────

/**
 * Dado um destino válido, devolve os campos timestamp que a
 * UPDATE precisa setar (além de `status`). Ex: transição pra
 * `shipped` deve setar `shipped_at = now()`.
 *
 * Retorna um objeto pronto pra spread em uma UPDATE:
 *
 *     const patch = { status: to, ...timestampsForTransition(to, new Date()) };
 *
 * Por que centralizar aqui: evita operador humano esquecer de
 * preencher o timestamp correspondente e criar histórico inconsistente.
 */
export function timestampsForTransition(
  to: FulfillmentStatus,
  at: Date
): Partial<
  Pick<
    FulfillmentRow,
    | "accepted_at"
    | "paid_at"
    | "pharmacy_requested_at"
    | "shipped_at"
    | "delivered_at"
    | "cancelled_at"
  >
> {
  const iso = at.toISOString();
  switch (to) {
    case "pending_payment":
      return { accepted_at: iso };
    case "paid":
      return { paid_at: iso };
    case "pharmacy_requested":
      return { pharmacy_requested_at: iso };
    case "shipped":
      return { shipped_at: iso };
    case "delivered":
      return { delivered_at: iso };
    case "cancelled":
      return { cancelled_at: iso };
    case "pending_acceptance":
      return {};
  }
}
