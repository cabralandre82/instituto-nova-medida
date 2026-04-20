/**
 * POST /api/admin/payouts/[id]/pay
 *
 * Marca um payout 'approved' como 'pix_sent'. O admin acabou de
 * fazer o PIX manualmente — opcionalmente registra o ID da transação.
 *
 * Próxima transição esperada: /confirm (depois que a médica avisar).
 */

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { requireAdmin } from "@/lib/auth";
import { canTransition, loadPayoutOrFail } from "@/lib/payouts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { pix_transaction_id?: string };

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Body;

  const supabase = getSupabaseAdmin();
  const r = await loadPayoutOrFail(supabase, id);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });

  if (!canTransition(r.payout.status, "pix_sent")) {
    return NextResponse.json(
      { ok: false, error: `Transição inválida: ${r.payout.status} → pix_sent` },
      { status: 409 }
    );
  }

  const now = new Date().toISOString();
  const update: Record<string, unknown> = {
    status: "pix_sent",
    pix_sent_at: now,
    paid_at: now, // mantido em sincronia (legado)
  };
  if (body.pix_transaction_id?.trim()) {
    const tx = body.pix_transaction_id.trim();
    update.pix_transaction_id = tx;
    update.pix_tx_id = tx;
  }

  const { error } = await supabase
    .from("doctor_payouts")
    .update(update)
    .eq("id", id);
  if (error) {
    console.error("[payouts/pay]", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
