/**
 * POST /api/admin/payouts/[id]/billing-document/validate
 *
 * Admin valida (ou desvalida, com `?unvalidate=1`) a NF-e anexada a um
 * payout. Valida apenas: marca `validated_at` e `validated_by` (notes
 * opcional via body JSON). É mutação explícita — exigimos POST com
 * body pra evitar cliques acidentais.
 *
 * Idempotente: revalidar não atualiza `validated_at` se já estava
 * validado (mantém o original). Permite sobrescrever `validation_notes`.
 */

import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/admin/payouts/[id]/billing-document/validate" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: RouteParams) {
  const admin = await requireAdmin();
  const { id: payoutId } = await params;
  const unvalidate = req.nextUrl.searchParams.get("unvalidate") === "1";

  let body: { validation_notes?: string } = {};
  try {
    body = (await req.json()) as { validation_notes?: string };
  } catch {
    // Body opcional — se não veio JSON, seguimos sem notes
  }

  const supabase = getSupabaseAdmin();

  const { data: doc, error: loadErr } = await supabase
    .from("doctor_billing_documents")
    .select("id, validated_at")
    .eq("payout_id", payoutId)
    .maybeSingle();

  if (loadErr) {
    log.error("load", { err: loadErr, payout_id: payoutId });
    return NextResponse.json(
      { ok: false, error: "load_failed" },
      { status: 500 }
    );
  }
  if (!doc) {
    return NextResponse.json(
      {
        ok: false,
        error: "no_document",
        message: "Nenhum documento fiscal neste payout.",
      },
      { status: 404 }
    );
  }

  const row = doc as { id: string; validated_at: string | null };

  const notes = typeof body.validation_notes === "string"
    ? body.validation_notes.trim() || null
    : null;

  const update: Record<string, unknown> = {
    validation_notes: notes,
  };

  if (unvalidate) {
    update.validated_at = null;
    update.validated_by = null;
  } else {
    // Se já validado, preserva o timestamp original (auditoria) mas
    // permite sobrescrever notes/validator.
    update.validated_at = row.validated_at ?? new Date().toISOString();
    update.validated_by = admin.id;
  }

  const { error: updErr } = await supabase
    .from("doctor_billing_documents")
    .update(update)
    .eq("id", row.id);
  if (updErr) {
    log.error("update", { err: updErr, payout_id: payoutId });
    return NextResponse.json(
      { ok: false, error: "db_update_failed", message: updErr.message },
      { status: 500 }
    );
  }

  log.info(unvalidate ? "unvalidated" : "validated", {
    admin_email: admin.email,
    payout_id: payoutId,
  });
  return NextResponse.json({
    ok: true,
    validated: !unvalidate,
    validated_at: update.validated_at ?? null,
  });
}
