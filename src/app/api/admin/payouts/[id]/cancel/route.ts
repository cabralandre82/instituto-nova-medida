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
import {
  getAuditContextFromRequest,
  logAdminAction,
} from "@/lib/admin-audit-log";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/admin/payouts/[id]/cancel" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { reason?: string };

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin();
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
    log.error("payout", { err: payoutErr, payout_id: id });
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
    log.error("earnings", { err: earnErr, payout_id: id });
    return NextResponse.json({ ok: false, error: earnErr.message }, { status: 500 });
  }

  await logAdminAction(supabase, {
    actorUserId: admin.id,
    actorEmail: admin.email,
    action: "payout.cancel",
    entityType: "payout",
    entityId: id,
    before: { status: r.payout.status },
    after: {
      status: "cancelled",
      earnings_unlinked: count ?? 0,
    },
    metadata: {
      ...getAuditContextFromRequest(req),
      reason,
    },
  });

  return NextResponse.json({ ok: true, earnings_unlinked: count ?? 0 });
}
