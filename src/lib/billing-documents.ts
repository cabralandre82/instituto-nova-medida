/**
 * Helpers de documentos fiscais (NF-e) armazenados no bucket privado
 * `billing-documents` (criado na migration 015).
 *
 * Espelho deliberado de `payout-proofs.ts`:
 *   - Bucket separado pra permitir retention policies diferentes
 *     (NF-e tem exigência fiscal de 5 anos, comprovante PIX de 5 anos
 *     também, mas a responsabilidade difere — NF é responsabilidade
 *     da médica; comprovante é do instituto).
 *   - Service role only: bucket nunca é tocado direto do client.
 *
 * Convenção de path: `billing/{payout_id}/{timestamp}-{slug}.{ext}`
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "./logger";

const log = logger.with({ mod: "billing-documents" });

export const BUCKET = "billing-documents";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export const ALLOWED_MIMES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/xml",
  "text/xml",
]);

/** Mapeamento mimetype → extensão canônica aceita pelo bucket. */
const MIME_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "application/xml": "xml",
  "text/xml": "xml",
};

/**
 * Storage paths do bucket sempre começam com "billing/".
 */
export function isStoragePath(value: string | null | undefined): value is string {
  if (!value) return false;
  return value.startsWith("billing/");
}

export function slugifyFilename(input: string): string {
  const ascii = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\.[^.]+$/, "");
  const safe = ascii.replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return (safe || "nota-fiscal").slice(0, 40);
}

export function buildStoragePath(opts: {
  payoutId: string;
  originalName: string;
  mime: string;
  now?: Date;
}): string {
  const ts = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, "").slice(0, 15);
  const ext = MIME_EXT[opts.mime] ?? "bin";
  const slug = slugifyFilename(opts.originalName);
  return `billing/${opts.payoutId}/${ts}-${slug}.${ext}`;
}

export async function createSignedUrl(
  client: SupabaseClient,
  storagePath: string,
  expiresInSeconds = 60
): Promise<string | null> {
  const { data, error } = await client.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, expiresInSeconds, { download: false });
  if (error || !data?.signedUrl) {
    log.error("createSignedUrl", { err: error });
    return null;
  }
  return data.signedUrl;
}

export async function removeFromStorage(
  storagePath: string
): Promise<{ ok: boolean; error?: string }> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.storage.from(BUCKET).remove([storagePath]);
  if (error) {
    if ((error as { statusCode?: string }).statusCode === "404") return { ok: true };
    log.error("remove", { err: error });
    return { ok: false, error: error.message };
  }
  return { ok: true };
}
