/**
 * /api/medico/payouts/[id]/billing-document
 *
 *   POST   — médica sobe NF-e (multipart/form-data):
 *              - file: PDF/XML/imagem (≤ 5 MB)
 *              - document_number (opcional): número/série
 *              - issued_at (opcional, ISO): data de emissão
 *              - document_amount_cents (opcional): valor conferido
 *            valida ownership do payout; bloqueia se já existe documento
 *            validado (troca só antes da validação); grava no bucket
 *            privado `billing-documents`; cria/atualiza linha em
 *            `doctor_billing_documents` (UNIQUE por payout).
 *
 *   GET    — médica pega signed URL (60s) do próprio documento.
 *
 *   DELETE — médica remove o próprio documento ENQUANTO não validado.
 *            Após validated_at, só admin remove.
 *
 * Autorização: `requireDoctor()` + checagem de `doctor_id` no payout.
 * Serviço de storage nunca é exposto direto ao cliente.
 */

import { NextResponse } from "next/server";
import { requireDoctor } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  ALLOWED_MIMES,
  BUCKET,
  MAX_UPLOAD_BYTES,
  buildStoragePath,
  createSignedUrl,
  isStoragePath,
  removeFromStorage,
} from "@/lib/billing-documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

type PayoutCtx = {
  id: string;
  doctor_id: string;
  status: string;
};

type DocumentCtx = {
  id: string;
  payout_id: string;
  document_url: string;
  validated_at: string | null;
};

async function loadPayout(payoutId: string, doctorId: string): Promise<
  | { ok: true; payout: PayoutCtx; document: DocumentCtx | null }
  | { ok: false; status: number; error: string }
> {
  const supabase = getSupabaseAdmin();
  const { data: payout, error } = await supabase
    .from("doctor_payouts")
    .select("id, doctor_id, status")
    .eq("id", payoutId)
    .maybeSingle();
  if (error) {
    console.error("[medico/billing-document] load payout:", error);
    return { ok: false, status: 500, error: "load_failed" };
  }
  if (!payout) return { ok: false, status: 404, error: "payout_not_found" };
  if ((payout as PayoutCtx).doctor_id !== doctorId) {
    return { ok: false, status: 403, error: "forbidden" };
  }

  const { data: doc } = await supabase
    .from("doctor_billing_documents")
    .select("id, payout_id, document_url, validated_at")
    .eq("payout_id", payoutId)
    .maybeSingle();

  return {
    ok: true,
    payout: payout as PayoutCtx,
    document: (doc as DocumentCtx | null) ?? null,
  };
}

function parseIssuedAt(raw: FormDataEntryValue | null): string | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function parseAmountCents(raw: FormDataEntryValue | null): number | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export async function POST(req: Request, { params }: RouteParams) {
  const { doctorId, user } = await requireDoctor();
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
      {
        ok: false,
        error: "file_missing",
        message: "Envie o arquivo no campo 'file'.",
      },
      { status: 400 }
    );
  }

  if (!ALLOWED_MIMES.has(file.type)) {
    return NextResponse.json(
      {
        ok: false,
        error: "mime_not_allowed",
        message: "Apenas PDF, XML, PNG, JPG ou WEBP são aceitos.",
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

  const ctx = await loadPayout(payoutId, doctorId);
  if (!ctx.ok) {
    return NextResponse.json(
      { ok: false, error: ctx.error },
      { status: ctx.status }
    );
  }

  if (ctx.document?.validated_at) {
    return NextResponse.json(
      {
        ok: false,
        error: "document_already_validated",
        message:
          "NF-e já validada pelo admin. Pra substituir, fale com o operador.",
      },
      { status: 409 }
    );
  }

  const documentNumber = (form.get("document_number") as string | null)?.trim() || null;
  const issuedAt = parseIssuedAt(form.get("issued_at"));
  const documentAmountCents = parseAmountCents(form.get("document_amount_cents"));

  const supabase = getSupabaseAdmin();
  const previousPath = ctx.document && isStoragePath(ctx.document.document_url)
    ? ctx.document.document_url
    : null;

  const newPath = buildStoragePath({
    payoutId,
    originalName: file.name || "nota-fiscal",
    mime: file.type,
  });

  const buffer = Buffer.from(await file.arrayBuffer());
  const { error: uploadErr } = await supabase.storage.from(BUCKET).upload(
    newPath,
    buffer,
    {
      contentType: file.type,
      upsert: false,
      cacheControl: "private, max-age=0",
    }
  );
  if (uploadErr) {
    console.error("[medico/billing-document] upload:", uploadErr);
    return NextResponse.json(
      { ok: false, error: "upload_failed", message: uploadErr.message },
      { status: 500 }
    );
  }

  if (ctx.document) {
    // Substituição: update da linha + limpa validated_* (admin precisa revalidar)
    const { error: updErr } = await supabase
      .from("doctor_billing_documents")
      .update({
        document_url: newPath,
        document_number: documentNumber,
        document_amount_cents: documentAmountCents,
        issued_at: issuedAt,
        uploaded_at: new Date().toISOString(),
        uploaded_by: user.id,
        validated_at: null,
        validated_by: null,
        validation_notes: null,
      })
      .eq("id", ctx.document.id);
    if (updErr) {
      await supabase.storage.from(BUCKET).remove([newPath]);
      console.error("[medico/billing-document] update:", updErr);
      return NextResponse.json(
        { ok: false, error: "db_update_failed", message: updErr.message },
        { status: 500 }
      );
    }
  } else {
    // Primeira upload: insert. UNIQUE(payout_id) protege corrida.
    const { error: insErr } = await supabase.from("doctor_billing_documents").insert({
      payout_id: payoutId,
      doctor_id: doctorId,
      document_url: newPath,
      document_number: documentNumber,
      document_amount_cents: documentAmountCents,
      issued_at: issuedAt,
      uploaded_by: user.id,
    });
    if (insErr) {
      await supabase.storage.from(BUCKET).remove([newPath]);
      // 23505 → corrida: outra upload chegou entre o load e o insert.
      const code = (insErr as unknown as { code?: string }).code;
      const status = code === "23505" ? 409 : 500;
      console.error("[medico/billing-document] insert:", insErr);
      return NextResponse.json(
        { ok: false, error: "db_insert_failed", message: insErr.message },
        { status }
      );
    }
  }

  // Cleanup do arquivo antigo (best-effort)
  if (previousPath && previousPath !== newPath) {
    await removeFromStorage(previousPath);
  }

  console.log(
    `[medico/billing-document] uploaded by doctor=${doctorId} payout=${payoutId} path=${newPath}`
  );
  return NextResponse.json({ ok: true, path: newPath });
}

export async function GET(_req: Request, { params }: RouteParams) {
  const { doctorId } = await requireDoctor();
  const { id: payoutId } = await params;

  const ctx = await loadPayout(payoutId, doctorId);
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
        message: "NF-e ainda não enviada.",
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
  const { doctorId } = await requireDoctor();
  const { id: payoutId } = await params;

  const ctx = await loadPayout(payoutId, doctorId);
  if (!ctx.ok) {
    return NextResponse.json(
      { ok: false, error: ctx.error },
      { status: ctx.status }
    );
  }
  if (!ctx.document) {
    return NextResponse.json({ ok: true, already: "absent" });
  }
  if (ctx.document.validated_at) {
    return NextResponse.json(
      {
        ok: false,
        error: "document_already_validated",
        message: "NF já validada. Para remover, fale com o operador.",
      },
      { status: 409 }
    );
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
    console.error("[medico/billing-document] delete row:", delErr);
    return NextResponse.json(
      { ok: false, error: "db_delete_failed", message: delErr.message },
      { status: 500 }
    );
  }

  console.log(
    `[medico/billing-document] deleted by doctor=${doctorId} payout=${payoutId}`
  );
  return NextResponse.json({ ok: true });
}
