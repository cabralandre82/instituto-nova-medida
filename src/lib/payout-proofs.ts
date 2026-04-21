/**
 * Helpers de comprovantes de PIX armazenados no bucket privado
 * `payouts-proofs` (criado em migration 007).
 *
 * Server-only. NUNCA expõe `supabase.storage` diretamente ao client —
 * todas as operações passam por API routes (multipart upload, signed
 * URL de 60s, delete restrito a admin).
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "./logger";

const log = logger.with({ mod: "payout-proofs" });

export const BUCKET = "payouts-proofs";

/** Limite lógico de upload, validado no handler (≤ bucket cap de 10 MB). */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export const ALLOWED_MIMES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

/** Mapeamento mimetype → extensão canônica (apenas o que o bucket aceita). */
const MIME_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/**
 * Decide se um valor armazenado em `pix_proof_url` é storage path (preferido)
 * ou URL externa antiga (compat). Storage paths começam com "payouts/".
 */
export function isStoragePath(value: string | null | undefined): value is string {
  if (!value) return false;
  return value.startsWith("payouts/");
}

/**
 * Sanitiza nome de arquivo do usuário para virar parte de path:
 *   - normaliza unicode (remove acentos)
 *   - mantém só [a-z0-9-_]
 *   - encurta para 40 chars
 */
export function slugifyFilename(input: string): string {
  const ascii = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\.[^.]+$/, ""); // remove extensão (vamos forçar pelo mime)
  const safe = ascii.replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return (safe || "comprovante").slice(0, 40);
}

/**
 * Monta o storage path determinístico para um upload.
 * Sempre prefixado por `payouts/{payout_id}/` para facilitar listing/delete em massa.
 */
export function buildStoragePath(opts: {
  payoutId: string;
  originalName: string;
  mime: string;
  now?: Date;
}): string {
  const ts = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, "").slice(0, 15);
  const ext = MIME_EXT[opts.mime] ?? "bin";
  const slug = slugifyFilename(opts.originalName);
  return `payouts/${opts.payoutId}/${ts}-${slug}.${ext}`;
}

/**
 * Cria uma signed URL curta (60s) para download/visualização do comprovante.
 * Falha → retorna `null` e loga (caller decide o status HTTP).
 */
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

/**
 * Apaga o arquivo do bucket. Idempotente: 404 não é erro.
 */
export async function removeFromStorage(storagePath: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.storage.from(BUCKET).remove([storagePath]);
  if (error) {
    if ((error as { statusCode?: string }).statusCode === "404") return { ok: true };
    log.error("remove", { err: error });
    return { ok: false, error: error.message };
  }
  return { ok: true };
}
