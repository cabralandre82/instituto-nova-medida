/**
 * /api/admin/payouts/[id]/billing-document
 *
 *   GET    — admin pega signed URL (60s) pra ver a NF-e.
 *   DELETE — admin remove o documento (inclusive depois de validado,
 *            caso de extorno/correção). Opera com guard-rail:
 *            zera colunas validated_* mesmo se não estava validado.
 *
 * A validação é em rota separada: POST .../validate (mutação explícita).
 */

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  createSignedUrl,
  isStoragePath,
  removeFromStorage,
} from "@/lib/billing-documents";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/admin/payouts/[id]/billing-document" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

type DocumentRow = {
  id: string;
  payout_id: string;
  document_url: string;
  validated_at: string | null;
};

async function loadDocument(payoutId: string): Promise<
  | { ok: true; document: DocumentRow | null }
  | { ok: false; status: number; error: string }
> {
  const supabase = getSupabaseAdmin();
  const { data: payout, error: payoutErr } = await supabase
    .from("doctor_payouts")
    .select("id")
    .eq("id", payoutId)
    .maybeSingle();
  if (payoutErr) {
    log.error("payout load", { err: payoutErr, payout_id: payoutId });
    return { ok: false, status: 500, error: "load_failed" };
  }
  if (!payout) return { ok: false, status: 404, error: "payout_not_found" };

  const { data: doc, error } = await supabase
    .from("doctor_billing_documents")
    .select("id, payout_id, document_url, validated_at")
    .eq("payout_id", payoutId)
    .maybeSingle();

  if (error) {
    log.error("doc load", { err: error, payout_id: payoutId });
    return { ok: false, status: 500, error: "load_failed" };
  }

  return { ok: true, document: (doc as DocumentRow | null) ?? null };
}

export async function GET(_req: Request, { params }: RouteParams) {
  await requireAdmin();
  const { id: payoutId } = await params;

  const ctx = await loadDocument(payoutId);
  if (!ctx.ok) {
    return NextResponse.json(
      { ok: false, error: ctx.error },
      { status: ctx.status }
    );
  }
  if (!ctx.document) {
    return NextResponse.json(
      {
        ok: false,
        error: "no_document",
        message: "Nenhum documento fiscal anexado.",
      },
      { status: 404 }
    );
  }

  if (!isStoragePath(ctx.document.document_url)) {
    return NextResponse.json({
      ok: true,
      url: ctx.document.document_url,
      source: "external",
    });
  }

  const supabase = getSupabaseAdmin();
  const url = await createSignedUrl(supabase, ctx.document.document_url, 60);
  if (!url) {
    return NextResponse.json(
      { ok: false, error: "sign_failed" },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true, url, source: "storage", expiresIn: 60 });
}

export async function DELETE(_req: Request, { params }: RouteParams) {
  const admin = await requireAdmin();
  const { id: payoutId } = await params;

  const ctx = await loadDocument(payoutId);
  if (!ctx.ok) {
    return NextResponse.json(
      { ok: false, error: ctx.error },
      { status: ctx.status }
    );
  }
  if (!ctx.document) {
    return NextResponse.json({ ok: true, already: "absent" });
  }

  const supabase = getSupabaseAdmin();
  if (isStoragePath(ctx.document.document_url)) {
    const r = await removeFromStorage(ctx.document.document_url);
    if (!r.ok) {
      return NextResponse.json(
        { ok: false, error: "delete_storage_failed", message: r.error },
        { status: 500 }
      );
    }
  }

  const { error: delErr } = await supabase
    .from("doctor_billing_documents")
    .delete()
    .eq("id", ctx.document.id);
  if (delErr) {
    log.error("delete", { err: delErr, payout_id: payoutId });
    return NextResponse.json(
      { ok: false, error: "db_delete_failed", message: delErr.message },
      { status: 500 }
    );
  }

  log.info("deleted", { admin_email: admin.email, payout_id: payoutId });
  return NextResponse.json({ ok: true });
}
