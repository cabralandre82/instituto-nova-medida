/**
 * /api/admin/payouts/[id]/proof
 *
 *   POST   — admin sobe um arquivo (multipart/form-data, campo "file")
 *            valida tipo (PDF/PNG/JPG/WEBP) + tamanho (≤ 5 MB)
 *            grava no bucket privado `payouts-proofs` em path determinístico
 *            atualiza `doctor_payouts.pix_proof_url` (e `receipt_url` legado)
 *
 *   GET    — admin pega signed URL (60s) pro arquivo armazenado
 *            (médica usa a outra rota: /api/medico/payouts/[id]/proof)
 *
 *   DELETE — admin remove o arquivo do bucket E limpa as colunas no DB
 *
 * Toda autorização vive aqui (requireAdmin) — bucket fica 100% privado
 * e só é tocado via service role server-side.
 */

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  ALLOWED_MIMES,
  BUCKET,
  MAX_UPLOAD_BYTES,
  buildStoragePath,
  createSignedUrl,
  isStoragePath,
  removeFromStorage,
} from "@/lib/payout-proofs";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/admin/payouts/[id]/proof" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

async function loadPayoutPath(payoutId: string): Promise<
  | { ok: true; storagePath: string | null; rawValue: string | null }
  | { ok: false; status: number; error: string }
> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("doctor_payouts")
    .select("id, pix_proof_url")
    .eq("id", payoutId)
    .maybeSingle();
  if (error) {
    log.error("load", { err: error, payout_id: payoutId });
    return { ok: false, status: 500, error: error.message };
  }
  if (!data) return { ok: false, status: 404, error: "payout_not_found" };
  const raw = (data.pix_proof_url as string | null) ?? null;
  return { ok: true, storagePath: isStoragePath(raw) ? raw : null, rawValue: raw };
}

export async function POST(req: Request, { params }: RouteParams) {
  const admin = await requireAdmin();
  const { id: payoutId } = await params;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { ok: false, error: "multipart_invalid" },
      { status: 400 }
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { ok: false, error: "file_missing", message: "Envie o arquivo no campo 'file'." },
      { status: 400 }
    );
  }

  if (!ALLOWED_MIMES.has(file.type)) {
    return NextResponse.json(
      {
        ok: false,
        error: "mime_not_allowed",
        message: "Apenas PDF, PNG, JPG ou WEBP são aceitos.",
      },
      { status: 415 }
    );
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      {
        ok: false,
        error: "file_too_large",
        message: `Tamanho máximo: ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`,
      },
      { status: 413 }
    );
  }

  const supabase = getSupabaseAdmin();

  // Confirma que o payout existe e captura o path antigo (pra limpeza posterior)
  const current = await loadPayoutPath(payoutId);
  if (!current.ok) {
    return NextResponse.json(
      { ok: false, error: current.error },
      { status: current.status }
    );
  }
  const previousPath = current.storagePath;

  const newPath = buildStoragePath({
    payoutId,
    originalName: file.name || "comprovante",
    mime: file.type,
  });

  const buffer = Buffer.from(await file.arrayBuffer());

  const { error: uploadErr } = await supabase.storage.from(BUCKET).upload(newPath, buffer, {
    contentType: file.type,
    upsert: false,
    cacheControl: "private, max-age=0",
  });
  if (uploadErr) {
    log.error("upload", { err: uploadErr, payout_id: payoutId });
    return NextResponse.json(
      { ok: false, error: "upload_failed", message: uploadErr.message },
      { status: 500 }
    );
  }

  const { error: updErr } = await supabase
    .from("doctor_payouts")
    .update({
      pix_proof_url: newPath,
      receipt_url: newPath,
      updated_at: new Date().toISOString(),
    })
    .eq("id", payoutId);
  if (updErr) {
    log.error("update payout", { err: updErr, payout_id: payoutId });
    // Best-effort cleanup: tira o arquivo recém-subido pra não ficar órfão
    await supabase.storage.from(BUCKET).remove([newPath]);
    return NextResponse.json(
      { ok: false, error: "db_update_failed", message: updErr.message },
      { status: 500 }
    );
  }

  // Remove o arquivo antigo SE era um storage path (não toca em URLs externas)
  if (previousPath && previousPath !== newPath) {
    await removeFromStorage(previousPath);
  }

  log.info("uploaded", {
    admin_email: admin.email,
    payout_id: payoutId,
    path: newPath,
  });

  return NextResponse.json({ ok: true, path: newPath });
}

export async function GET(_req: Request, { params }: RouteParams) {
  await requireAdmin();
  const { id: payoutId } = await params;

  const current = await loadPayoutPath(payoutId);
  if (!current.ok) {
    return NextResponse.json(
      { ok: false, error: current.error },
      { status: current.status }
    );
  }

  // Se é URL externa (legacy), devolve direto
  if (current.rawValue && !current.storagePath) {
    return NextResponse.json({ ok: true, url: current.rawValue, source: "external" });
  }

  if (!current.storagePath) {
    return NextResponse.json(
      { ok: false, error: "no_proof", message: "Comprovante ainda não anexado." },
      { status: 404 }
    );
  }

  const supabase = getSupabaseAdmin();
  const url = await createSignedUrl(supabase, current.storagePath, 60);
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

  const current = await loadPayoutPath(payoutId);
  if (!current.ok) {
    return NextResponse.json(
      { ok: false, error: current.error },
      { status: current.status }
    );
  }

  if (current.storagePath) {
    const r = await removeFromStorage(current.storagePath);
    if (!r.ok) {
      return NextResponse.json(
        { ok: false, error: "delete_failed", message: r.error },
        { status: 500 }
      );
    }
  }

  const supabase = getSupabaseAdmin();
  const { error: updErr } = await supabase
    .from("doctor_payouts")
    .update({
      pix_proof_url: null,
      receipt_url: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", payoutId);
  if (updErr) {
    log.error("DELETE update", { err: updErr, payout_id: payoutId });
    return NextResponse.json(
      { ok: false, error: "db_update_failed", message: updErr.message },
      { status: 500 }
    );
  }

  log.info("deleted", { admin_email: admin.email, payout_id: payoutId });
  return NextResponse.json({ ok: true });
}
