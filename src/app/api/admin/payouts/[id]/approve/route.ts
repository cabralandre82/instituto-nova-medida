/**
 * POST /api/admin/payouts/[id]/approve
 *
 * Marca um payout 'draft' como 'approved'. Não toca nos earnings —
 * eles seguem 'available' (vinculados ao payout via payout_id).
 *
 * Etapa intermediária: depois de approved, o admin executa o PIX
 * manualmente no banco e chama /pay com o ID da transação.
 */

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { requireAdmin } from "@/lib/auth";
import { canTransition, loadPayoutOrFail } from "@/lib/payouts";
import {
  getAuditContextFromRequest,
  logAdminAction,
} from "@/lib/admin-audit-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin();
  const { id } = await params;
  const supabase = getSupabaseAdmin();

  const r = await loadPayoutOrFail(supabase, id);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });

  if (!canTransition(r.payout.status, "approved")) {
    return NextResponse.json(
      { ok: false, error: `Transição inválida: ${r.payout.status} → approved` },
      { status: 409 }
    );
  }

  const { error } = await supabase
    .from("doctor_payouts")
    .update({
      status: "approved",
      approved_at: new Date().toISOString(),
      approved_by: admin.id,
    })
    .eq("id", id);
  if (error) {
    console.error("[payouts/approve]", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  await logAdminAction(supabase, {
    actorUserId: admin.id,
    actorEmail: admin.email,
    action: "payout.approve",
    entityType: "payout",
    entityId: id,
    before: { status: r.payout.status },
    after: { status: "approved" },
    metadata: getAuditContextFromRequest(req),
  });

  return NextResponse.json({ ok: true });
}
