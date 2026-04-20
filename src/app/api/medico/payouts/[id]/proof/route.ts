/**
 * GET /api/medico/payouts/[id]/proof
 *
 * Médica solicita signed URL (60s) do comprovante de PIX do PRÓPRIO
 * payout. Bloqueia se o payout não pertence a ela.
 *
 * Não há POST/DELETE aqui — só admin gerencia comprovantes.
 */

import { NextResponse } from "next/server";
import { requireDoctor } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { createSignedUrl, isStoragePath } from "@/lib/payout-proofs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: RouteParams) {
  const { doctorId } = await requireDoctor();
  const { id: payoutId } = await params;

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("doctor_payouts")
    .select("id, doctor_id, pix_proof_url")
    .eq("id", payoutId)
    .maybeSingle();

  if (error) {
    console.error("[medico/payouts/proof] load:", error);
    return NextResponse.json(
      { ok: false, error: "load_failed" },
      { status: 500 }
    );
  }
  if (!data) {
    return NextResponse.json(
      { ok: false, error: "payout_not_found" },
      { status: 404 }
    );
  }
  if (data.doctor_id !== doctorId) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const raw = (data.pix_proof_url as string | null) ?? null;
  if (!raw) {
    return NextResponse.json(
      { ok: false, error: "no_proof", message: "Comprovante ainda não disponível." },
      { status: 404 }
    );
  }

  // URL externa (legado / backfill) → devolve direto
  if (!isStoragePath(raw)) {
    return NextResponse.json({ ok: true, url: raw, source: "external" });
  }

  const url = await createSignedUrl(supabase, raw, 60);
  if (!url) {
    return NextResponse.json({ ok: false, error: "sign_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, url, source: "storage", expiresIn: 60 });
}
