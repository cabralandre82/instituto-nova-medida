/**
 * POST /api/admin/payouts/[id]/cancel
 *
 * Cancela um payout (se ainda não confirmado). Os earnings vinculados
 * são desvinculados (payout_id = NULL) e voltam para status 'available' —
 * próximo ciclo (cron mensal) os reagrupa em novo payout.
 *
 * Não permite cancelar payout 'confirmed' (já pago — clawback é via earning).
 */

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { requireAdmin } from "@/lib/auth";
import { canTransition, loadPayoutOrFail } from "@/lib/payouts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { reason?: string };

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Body;

  const supabase = getSupabaseAdmin();
  const r = await loadPayoutOrFail(supabase, id);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });

  if (!canTransition(r.payout.status, "cancelled")) {
    return NextResponse.json(
      { ok: false, error: `Transição inválida: ${r.payout.status} → cancelled` },
      { status: 409 }
    );
  }

  const reason = body.reason?.trim() ?? "Cancelado pelo admin";

  const { error: payoutErr } = await supabase
    .from("doctor_payouts")
    .update({
      status: "cancelled",
      cancelled_reason: reason.slice(0, 200),
    })
    .eq("id", id);
  if (payoutErr) {
    console.error("[payouts/cancel] payout:", payoutErr);
    return NextResponse.json({ ok: false, error: payoutErr.message }, { status: 500 });
  }

  // Desvincula earnings → voltam pra available e entram no próximo lote
  const { error: earnErr, count } = await supabase
    .from("doctor_earnings")
    .update(
      { payout_id: null, status: "available" },
      { count: "exact" }
    )
    .eq("payout_id", id)
    .eq("status", "in_payout");
  if (earnErr) {
    console.error("[payouts/cancel] earnings:", earnErr);
    return NextResponse.json({ ok: false, error: earnErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, earnings_unlinked: count ?? 0 });
}
