/**
 * POST /api/admin/payouts/[id]/confirm
 *
 * Marca um payout 'pix_sent' como 'confirmed' (médica recebeu).
 * Ao confirmar, todos os doctor_earnings vinculados viram 'paid'.
 *
 * Após isso, a médica deve emitir NF-e contra o CNPJ do Instituto
 * (registrar em doctor_billing_documents — fluxo Sprint 5).
 */

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { requireAdmin } from "@/lib/auth";
import { canTransition, loadPayoutOrFail } from "@/lib/payouts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * NOTA: a partir da migration 007, o comprovante NÃO é mais enviado por
 * URL externa neste endpoint. O upload acontece em
 * `POST /api/admin/payouts/[id]/proof` ANTES do confirm. O campo
 * `pix_proof_url` aqui só sobrevive para backfill via API/script.
 */
type Body = {
  pix_proof_url?: string;
  notes?: string;
};

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Body;

  const supabase = getSupabaseAdmin();
  const r = await loadPayoutOrFail(supabase, id);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });

  if (!canTransition(r.payout.status, "confirmed")) {
    return NextResponse.json(
      { ok: false, error: `Transição inválida: ${r.payout.status} → confirmed` },
      { status: 409 }
    );
  }

  const now = new Date().toISOString();
  const update: Record<string, unknown> = {
    status: "confirmed",
    confirmed_at: now,
  };
  if (body.pix_proof_url?.trim()) {
    update.pix_proof_url = body.pix_proof_url.trim();
    update.receipt_url = body.pix_proof_url.trim();
  }
  if (body.notes?.trim()) update.notes = body.notes.trim();

  const { error: payoutErr } = await supabase
    .from("doctor_payouts")
    .update(update)
    .eq("id", id);
  if (payoutErr) {
    console.error("[payouts/confirm] payout:", payoutErr);
    return NextResponse.json({ ok: false, error: payoutErr.message }, { status: 500 });
  }

  // Marca todos os earnings vinculados como 'paid'
  const { error: earnErr, count } = await supabase
    .from("doctor_earnings")
    .update({ status: "paid", paid_at: now }, { count: "exact" })
    .eq("payout_id", id);
  if (earnErr) {
    console.error("[payouts/confirm] earnings:", earnErr);
    return NextResponse.json({ ok: false, error: earnErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, earnings_marked_paid: count ?? 0 });
}
