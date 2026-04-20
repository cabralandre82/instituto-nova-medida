/**
 * Helpers compartilhados pelas APIs de payouts.
 * Encapsula validações de transição de estado e operações nos earnings
 * vinculados, mantendo as route handlers enxutas.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type PayoutStatus =
  | "draft"
  | "approved"
  | "pix_sent"
  | "confirmed"
  | "cancelled"
  | "failed";

const ALLOWED_TRANSITIONS: Record<PayoutStatus, PayoutStatus[]> = {
  draft: ["approved", "cancelled"],
  approved: ["pix_sent", "cancelled", "failed"],
  pix_sent: ["confirmed", "failed", "cancelled"],
  confirmed: [],
  cancelled: [],
  failed: ["approved"], // permite retentar após falha
};

export function canTransition(from: PayoutStatus, to: PayoutStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export async function loadPayoutOrFail(
  supabase: SupabaseClient,
  id: string
): Promise<
  | { ok: true; payout: { id: string; status: PayoutStatus; doctor_id: string; reference_period: string; amount_cents: number } }
  | { ok: false; status: number; error: string }
> {
  const { data, error } = await supabase
    .from("doctor_payouts")
    .select("id, status, doctor_id, reference_period, amount_cents")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    return { ok: false, status: 500, error: error.message };
  }
  if (!data) {
    return { ok: false, status: 404, error: "Payout não encontrado" };
  }
  return { ok: true, payout: data as never };
}
