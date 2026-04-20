/**
 * Promoção de earnings `pending` → `available`.
 *
 * D-040 · Reimplementação Node da RPC `recalculate_earnings_availability()`
 * (que continua no banco como backup idempotente via pg_cron).
 *
 * Regra de availability (D-022 + COMPENSATION.md):
 *   - Earning SEM payment_id (plantão, ajuste, bônus, clawback):
 *       available_at = earned_at. Promove imediatamente.
 *   - Earning COM payment_id:
 *       available_at = payment.paid_at + janela de risco:
 *         · PIX         → 7 dias
 *         · BOLETO      → 3 dias
 *         · CREDIT_CARD → 30 dias
 *         · UNDEFINED   → 30 dias (pior caso; conservador)
 *       Se payment.paid_at is null, earning continua pending sem data.
 *
 * Idempotência:
 *   Só age em `status='pending'`. Rodar duas vezes em sequência com o
 *   mesmo banco é inócuo (após a primeira as earnings elegíveis já
 *   passaram a `available`).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export const RISK_WINDOW_DAYS = {
  PIX: 7,
  BOLETO: 3,
  CREDIT_CARD: 30,
  UNDEFINED: 30,
} as const;

export type BillingType = keyof typeof RISK_WINDOW_DAYS;

export type AvailabilityResult = {
  ok: true;
  inspected: number;
  scheduledFuture: number; // ganharam available_at mas ainda no futuro
  promoted: number; // status virou 'available' nesta execução
  skippedMissingPaidAt: number; // payment existe mas sem paid_at (ex: refund pendente)
  errors: number;
  errorDetails: string[];
};

type PendingEarningRow = {
  id: string;
  doctor_id: string;
  payment_id: string | null;
  earned_at: string;
  available_at: string | null;
  payments: { paid_at: string | null; billing_type: BillingType | null } | null;
};

function addDays(iso: string, days: number): string {
  const ms = new Date(iso).getTime() + days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

function resolveBillingType(raw: string | null | undefined): BillingType {
  if (raw === "PIX" || raw === "BOLETO" || raw === "CREDIT_CARD") return raw;
  return "UNDEFINED";
}

/**
 * Calcula o available_at alvo para uma earning. Null se o payment
 * ainda não foi pago (mantém pending sem data).
 */
export function computeAvailableAt(
  earning: Pick<PendingEarningRow, "payment_id" | "earned_at" | "payments">
): string | null {
  if (!earning.payment_id) {
    return earning.earned_at;
  }
  const paidAt = earning.payments?.paid_at;
  if (!paidAt) return null;
  const billingType = resolveBillingType(earning.payments?.billing_type);
  const days = RISK_WINDOW_DAYS[billingType];
  return addDays(paidAt, days);
}

export async function recalculateEarningsAvailability(
  supabase: SupabaseClient
): Promise<AvailabilityResult> {
  const result: AvailabilityResult = {
    ok: true,
    inspected: 0,
    scheduledFuture: 0,
    promoted: 0,
    skippedMissingPaidAt: 0,
    errors: 0,
    errorDetails: [],
  };

  const { data, error } = await supabase
    .from("doctor_earnings")
    .select(
      "id, doctor_id, payment_id, earned_at, available_at, payments ( paid_at, billing_type )"
    )
    .eq("status", "pending");

  if (error) {
    result.errors += 1;
    result.errorDetails.push(`select pending: ${error.message}`);
    return result;
  }

  const rows = (data ?? []) as unknown as PendingEarningRow[];
  result.inspected = rows.length;

  const now = Date.now();

  for (const row of rows) {
    const targetAvailableAt = computeAvailableAt(row);

    if (!targetAvailableAt) {
      result.skippedMissingPaidAt += 1;
      continue;
    }

    const reachable = new Date(targetAvailableAt).getTime() <= now;

    // Se já promovível, dá um update só: status + available_at
    if (reachable) {
      const { error: promoteErr } = await supabase
        .from("doctor_earnings")
        .update({
          status: "available",
          available_at: targetAvailableAt,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id)
        .eq("status", "pending"); // guarda corrida

      if (promoteErr) {
        result.errors += 1;
        result.errorDetails.push(`promote ${row.id}: ${promoteErr.message}`);
        continue;
      }
      result.promoted += 1;
      continue;
    }

    // Futuro: só preenche available_at se ainda não estiver correto
    if (row.available_at !== targetAvailableAt) {
      const { error: scheduleErr } = await supabase
        .from("doctor_earnings")
        .update({
          available_at: targetAvailableAt,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id)
        .eq("status", "pending");

      if (scheduleErr) {
        result.errors += 1;
        result.errorDetails.push(
          `schedule ${row.id}: ${scheduleErr.message}`
        );
        continue;
      }
    }
    result.scheduledFuture += 1;
  }

  return result;
}
