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
import {
  logSignedUrlIssued,
  buildSignedUrlContext,
} from "@/lib/signed-url-log";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/medico/payouts/[id]/proof" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: RouteParams) {
  const { user, doctorId } = await requireDoctor();
  const { id: payoutId } = await params;

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("doctor_payouts")
    .select("id, doctor_id, pix_proof_url")
    .eq("id", payoutId)
    .maybeSingle();

  if (error) {
    log.error("load", { err: error, payout_id: payoutId });
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

  const ctx = buildSignedUrlContext(req, "/api/medico/payouts/[id]/proof");
  const actor = {
    kind: "doctor" as const,
    userId: user.id,
    email: user.email ?? null,
  };

  // URL externa (legado / backfill) → devolve direto, mas audita.
  if (!isStoragePath(raw)) {
    await logSignedUrlIssued(supabase, {
      actor,
      resource: {
        type: "payout_proof",
        id: payoutId,
        doctorId,
        storagePath: raw,
      },
      context: ctx,
      action: "external_url_returned",
    });
    return NextResponse.json({ ok: true, url: raw, source: "external" });
  }

  const TTL = 60;
  const url = await createSignedUrl(supabase, raw, TTL);
  if (!url) {
    return NextResponse.json({ ok: false, error: "sign_failed" }, { status: 500 });
  }

  await logSignedUrlIssued(supabase, {
    actor,
    resource: {
      type: "payout_proof",
      id: payoutId,
      doctorId,
      storagePath: raw,
    },
    context: ctx,
    signedUrlExpiresAt: new Date(Date.now() + TTL * 1000).toISOString(),
    metadata: { ttl_seconds: TTL },
  });

  return NextResponse.json({ ok: true, url, source: "storage", expiresIn: TTL });
}
