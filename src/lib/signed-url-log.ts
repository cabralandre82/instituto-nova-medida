/**
 * src/lib/signed-url-log.ts — PR-055 · D-066 · finding 17.4
 *
 * Helper único de escrita pra `document_access_log`. Toda rota que
 * EMITE uma signed URL de Supabase Storage (ou devolve uma URL
 * legada externa) pra um documento financeiro deve chamar
 * `logSignedUrlIssued` / `logExternalUrlReturned` imediatamente
 * depois — isso atende à recomendação do finding 17.4 (LGPD
 * Art. 37 + financeiro).
 *
 * Por que helper dedicado:
 *
 *   1. **Política única de falha.** failSoft como o `patient_access_log`
 *      — se o INSERT do log falhar, a rota ainda devolve a URL. Privar
 *      o médico/admin de baixar seu documento porque o audit log está
 *      offline é pior que perder visibilidade por alguns minutos.
 *   2. **Shape consistente.** Cada call-site só precisa passar o par
 *      `{ actor, resource }`; o helper padroniza o resto.
 *   3. **Testabilidade.** Um teste unitário cobre os 4 call-sites
 *      (duas rotas de proof, duas de billing-document).
 *
 * Modelo de ameaça (recap D-066):
 *
 *   - Signed URLs de Storage têm TTL = 60s mas NÃO são auditadas pelo
 *     Supabase ao nível aplicativo. Quem recebe pode compartilhar
 *     dentro da janela. Este helper NÃO resolve o compartilhamento;
 *     resolve "quem solicitou" — shortlist pra forense.
 *   - Audit do 17.4 sugere também (a) proxy de download (sem expor URL)
 *     e (b) TTL curtíssimo (já temos 60s). Proxy fica como PR-055-B.
 *
 * Garantia operacional:
 *
 *   - Nunca lança exception. Nunca bloqueia o caller.
 *   - Loga via `logger` em caso de falha do INSERT — aparece no sink
 *     externo quando D-057 ganhar drain (PR-043).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "./logger";

const log = logger.with({ mod: "signed-url-log" });

// ────────────────────────────────────────────────────────────────────────
// Tipos
// ────────────────────────────────────────────────────────────────────────

export type DocumentActorKind = "admin" | "doctor" | "system";
export type DocumentResourceType = "payout_proof" | "billing_document";
export type DocumentAccessAction =
  | "signed_url_issued"
  | "external_url_returned";

export type SignedUrlLogActor = {
  kind: DocumentActorKind;
  /** UUID do auth.users. Obrigatório pra 'admin' e 'doctor'. */
  userId: string | null;
  /** Email snapshot do actor (pode ser pseudo-email 'system:job-name'). */
  email: string | null;
};

export type SignedUrlLogResource = {
  type: DocumentResourceType;
  /** UUID do doctor_payouts (chave do contexto). */
  id: string;
  /** UUID da médica (denormalizado pra queries rápidas). */
  doctorId: string | null;
  /**
   * Para action=signed_url_issued: o storage_path usado na assinatura.
   * Para action=external_url_returned: a URL externa completa (não é
   * PII direta — é uma URL público-assinada que já vai ao cliente).
   */
  storagePath: string;
};

export type SignedUrlLogContext = {
  route: string | null;
  ip: string | null;
  userAgent: string | null;
};

export type LogSignedUrlInput = {
  actor: SignedUrlLogActor;
  resource: SignedUrlLogResource;
  context: SignedUrlLogContext;
  /** Default: 'signed_url_issued'. */
  action?: DocumentAccessAction;
  /**
   * ISO string do expires da URL (tipicamente now()+60s). Ignorado
   * quando action='external_url_returned'. Se ausente em
   * 'signed_url_issued', grava NULL com warn (URL foi emitida sem
   * TTL rastreado — anomalia operacional).
   */
  signedUrlExpiresAt?: string | null;
  metadata?: Record<string, unknown>;
};

export type LogSignedUrlResult =
  | { ok: true; id: string }
  | { ok: false; code: "insert_failed"; message: string };

// ────────────────────────────────────────────────────────────────────────
// Extração de contexto HTTP (padrão da plataforma — ecoa patient-access-log)
// ────────────────────────────────────────────────────────────────────────

/**
 * Extrai ip, user-agent e rota de uma Request (API route). Precedência
 * de IP: `x-forwarded-for` (primeiro hop) → `x-real-ip`. Coerente com
 * `getAccessContextFromRequest` em patient-access-log (mantido
 * separado pra não criar dependência cruzada de módulos de domínio
 * diferente).
 */
export function buildSignedUrlContext(
  req: Request,
  route: string
): SignedUrlLogContext {
  const headers = req.headers;
  const forwardedFor = headers.get("x-forwarded-for") ?? "";
  const firstIp = forwardedFor.split(",")[0]?.trim() || null;
  const realIp = headers.get("x-real-ip") || null;
  const userAgent = headers.get("user-agent") || null;
  return {
    ip: firstIp || realIp,
    userAgent,
    route,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Logging
// ────────────────────────────────────────────────────────────────────────

function sanitizeMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!metadata) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (typeof v === "string" && v.length > 2048) {
      out[k] = v.slice(0, 2048) + "…[truncated]";
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Grava 1 linha no document_access_log. failSoft — nunca lança.
 */
export async function logSignedUrlIssued(
  supabase: SupabaseClient,
  input: LogSignedUrlInput
): Promise<LogSignedUrlResult> {
  const action = input.action ?? "signed_url_issued";

  // Binding actor_kind ↔ actor_user_id (espelha o constraint do DB).
  if (
    (input.actor.kind === "admin" || input.actor.kind === "doctor") &&
    !input.actor.userId
  ) {
    const msg =
      `logSignedUrlIssued: actor.kind='${input.actor.kind}' exige actor.userId`;
    log.error(msg, {
      resource: input.resource.type,
      resource_id: input.resource.id,
    });
    return { ok: false, code: "insert_failed", message: msg };
  }
  if (input.actor.kind === "system" && input.actor.userId) {
    const msg =
      "logSignedUrlIssued: actor.kind='system' não pode ter actor.userId";
    log.error(msg, {
      resource: input.resource.type,
      resource_id: input.resource.id,
    });
    return { ok: false, code: "insert_failed", message: msg };
  }

  // expires_at só faz sentido em signed_url_issued.
  const expiresAt =
    action === "signed_url_issued"
      ? (input.signedUrlExpiresAt ?? null)
      : null;

  if (action === "signed_url_issued" && !expiresAt) {
    // Não-bloqueante: URL foi emitida sem TTL rastreado. Loga pra
    // investigação, continua o INSERT com NULL.
    log.warn("signed_url_issued sem expires_at — grava NULL", {
      resource: input.resource.type,
      resource_id: input.resource.id,
    });
  }

  const row = {
    actor_user_id: input.actor.userId,
    actor_email: input.actor.email,
    actor_kind: input.actor.kind,
    resource_type: input.resource.type,
    resource_id: input.resource.id,
    doctor_id: input.resource.doctorId,
    storage_path: input.resource.storagePath,
    signed_url_expires_at: expiresAt,
    action,
    ip: input.context.ip,
    user_agent: input.context.userAgent,
    route: input.context.route,
    metadata: sanitizeMetadata(input.metadata),
  };

  const { data, error } = await supabase
    .from("document_access_log")
    .insert(row)
    .select("id")
    .single();

  if (error || !data) {
    const message = error?.message ?? "insert returned no row";
    log.error("insert falhou (failSoft)", {
      action,
      resource: input.resource.type,
      resource_id: input.resource.id,
      err: message,
    });
    return { ok: false, code: "insert_failed", message };
  }

  return { ok: true, id: (data as { id: string }).id };
}
