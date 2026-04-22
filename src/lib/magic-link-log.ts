/**
 * src/lib/magic-link-log.ts — PR-070 · D-078 · finding 17.8
 *
 * Lib canônica pra registrar **emissões e verificações de magic-link**
 * em `magic_link_issued_log`. Endereça o gap onde o Supabase não
 * expõe log aplicativo dessas operações, impossibilitando triagem
 * ("não recebi o link"), forense (quem pediu, quando, por qual IP)
 * e detecção de abuso (enumeração de emails, brute force).
 *
 * Princípios:
 *
 *   1. **LGPD-safe em disco.** Nunca armazena email plaintext.
 *      `hashEmail(email)` devolve SHA-256 hex determinístico (sem
 *      salt), permitindo ao admin reproduzir a consulta dado um email
 *      específico (útil pra "checa se a Alice recebeu link") mas
 *      sem virar base consultável de emails cadastrados. Domínio
 *      armazenado em cleartext pra métrica de provedor (útil pra ver
 *      "Yahoo.com.br está bounçando").
 *
 *   2. **Fail-soft.** INSERT é best-effort. Se falhar, emitimos
 *      `log.error` estruturado mas NUNCA bloqueamos a rota de emissão
 *      — privar o usuário de receber o link porque o audit está
 *      offline é pior que perder uma linha de log.
 *
 *   3. **Ações tipadas.** `MagicLinkAction` cobre os 10 estados
 *      distinguíveis (emitido, silenciado por X razões, rate-limit,
 *      erro do provider, auto-provisionado, verificado, falha na
 *      verificação). Adições futuras exigem batida com o CHECK
 *      constraint do DB — boundary explícito.
 *
 *   4. **Contexto HTTP canônico.** `buildMagicLinkContext(req, route)`
 *      extrai IP/UA/route usando mesma precedência dos outros logs
 *      (x-forwarded-for → x-real-ip). UA truncado 500 (o DB também
 *      limita via CHECK).
 *
 *   5. **Determinístico.** `hashEmail("Alice@YAHOO.COM.BR  ")` =
 *      `hashEmail("alice@yahoo.com.br")`. Trim + lowercase antes do
 *      hash. Testes cobrem essa invariante.
 */

import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "./logger";

const log = logger.with({ mod: "magic-link-log" });

// ────────────────────────────────────────────────────────────────────────
// Tipos
// ────────────────────────────────────────────────────────────────────────

/**
 * Todas as ações registráveis. Sincronizada com o CHECK constraint
 * em `magic_link_issued_log.action` (migration 20260514000000).
 */
export type MagicLinkAction =
  | "issued"
  | "silenced_no_account"
  | "silenced_no_role"
  | "silenced_wrong_scope"
  | "silenced_no_customer"
  | "rate_limited"
  | "provider_error"
  | "auto_provisioned"
  | "verified"
  | "verify_failed";

export type MagicLinkRole = "admin" | "doctor" | "patient" | null;

export type MagicLinkLogContext = {
  route: string;
  ip: string | null;
  userAgent: string | null;
};

export type LogMagicLinkInput = {
  /**
   * Email em plaintext. A lib hasheia internamente. Pode ser `null`
   * pra casos onde o email não está disponível (ex: verify_failed
   * com token inválido — só temos token_hash, não email).
   */
  email: string | null;
  action: MagicLinkAction;
  role?: MagicLinkRole;
  reason?: string | null;
  nextPath?: string | null;
  metadata?: Record<string, unknown>;
  context: MagicLinkLogContext;
};

export type LogMagicLinkResult =
  | { ok: true; id: string }
  | { ok: false; code: "insert_failed"; message: string }
  | { ok: false; code: "missing_email"; message: string };

// ────────────────────────────────────────────────────────────────────────
// Hash e normalização
// ────────────────────────────────────────────────────────────────────────

/**
 * Hash determinístico de email: `SHA-256(email.trim().toLowerCase())`
 * em hex minúsculo (64 chars). Sem salt — queremos reproduzir dado
 * um email específico (ex: admin digita "alice@yahoo.com.br" e
 * busca linhas dessa pessoa). Segurança vs enumeração já é provida
 * pela imutabilidade + RLS deny-all da tabela.
 *
 * Lança se email é vazio pós-trim — dados garbage-in inutilizam a
 * consulta forense; callers devem validar antes.
 */
export function hashEmail(email: string): string {
  if (typeof email !== "string") {
    throw new TypeError("hashEmail: email must be string");
  }
  const norm = email.trim().toLowerCase();
  if (norm.length === 0) {
    throw new Error("hashEmail: email vazio após trim");
  }
  return createHash("sha256").update(norm, "utf8").digest("hex");
}

/**
 * Extrai domínio de um email. Retorna null se email malformado (sem
 * @ ou @ no final). Normaliza pra lowercase e trim. Trunca em 253
 * chars (FQDN máximo). Útil pra métricas de provedor sem PII direta.
 *
 * Ex: `extractEmailDomain("Alice@YAHOO.COM.BR")` → `"yahoo.com.br"`
 */
export function extractEmailDomain(email: string): string | null {
  if (typeof email !== "string") return null;
  const norm = email.trim().toLowerCase();
  const at = norm.lastIndexOf("@");
  if (at <= 0 || at >= norm.length - 1) return null;
  const dom = norm.slice(at + 1);
  if (dom.length > 253) return dom.slice(0, 253);
  return dom;
}

// ────────────────────────────────────────────────────────────────────────
// Extração de contexto HTTP (mesma convenção de signed-url-log /
// patient-access-log; mantido standalone pra evitar dep cruzada).
// ────────────────────────────────────────────────────────────────────────

export function buildMagicLinkContext(
  req: Request,
  route: string
): MagicLinkLogContext {
  const headers = req.headers;
  const forwardedFor = headers.get("x-forwarded-for") ?? "";
  const firstIp = forwardedFor.split(",")[0]?.trim() || null;
  const realIp = headers.get("x-real-ip") || null;
  const userAgent = headers.get("user-agent") || null;
  return {
    ip: firstIp || realIp,
    userAgent: userAgent ? userAgent.slice(0, 500) : null,
    route,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Sanitização de metadata
// ────────────────────────────────────────────────────────────────────────

function sanitizeMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!metadata) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (v === undefined) continue;
    if (typeof v === "string" && v.length > 2048) {
      out[k] = `${v.slice(0, 2048)}…[truncated]`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────
// Logging
// ────────────────────────────────────────────────────────────────────────

/**
 * Grava 1 linha no `magic_link_issued_log`. Fail-soft — nunca lança
 * exception. Retorna result discriminado pra testes.
 *
 * Regras:
 *   - `email` null é aceito somente pra actions onde faz sentido:
 *     `verify_failed` (token inválido, não sabemos quem) e
 *     `rate_limited` (payload pode não ter email válido ainda).
 *     Para qualquer outra action, retorna `{ok:false, missing_email}`
 *     sem inserir — caller tem bug a corrigir.
 *   - Truncamentos defensivos: reason 500, UA 500 (no context).
 *     Domínio 253 via extractEmailDomain.
 */
export async function logMagicLinkEvent(
  supabase: SupabaseClient,
  input: LogMagicLinkInput
): Promise<LogMagicLinkResult> {
  const { action, context } = input;
  let emailHash: string | null = null;
  let emailDomain: string | null = null;

  if (input.email) {
    try {
      emailHash = hashEmail(input.email);
      emailDomain = extractEmailDomain(input.email);
    } catch (err) {
      log.warn("hashEmail falhou (email garbage)", {
        action,
        route: context.route,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Actions que permitem email ausente (sem hash):
  const emailOptional =
    action === "verify_failed" || action === "rate_limited";
  if (!emailHash && !emailOptional) {
    const msg = `logMagicLinkEvent: email obrigatório pra action='${action}'`;
    log.warn(msg, { action, route: context.route });
    return { ok: false, code: "missing_email", message: msg };
  }

  const reason = input.reason
    ? input.reason.length > 500
      ? `${input.reason.slice(0, 500)}`
      : input.reason
    : null;

  try {
    // Se email_hash for null mas o CHECK exige not null, fazemos
    // inserir apenas quando temos hash. Pro caso de verify_failed/
    // rate_limited sem email, deixamos hash como uma string fixa
    // "anon-<action>" hasheada? Não — preserver a intenção: linhas
    // sem email usam hash "null" lógico. Mas o CHECK do DB é
    // not null + regex hex. Solução: pro verify_failed/rate_limited
    // sem email, gravamos hash SHA-256 da string "unknown:<action>:
    // <iso-minute>" pra preservar formato e permitir agrupar. Trade-
    // off aceito: ligeiramente quebra a invariante "hash = SHA-256
    // do email", documentamos em D-078.
    const effectiveHash = emailHash
      ? emailHash
      : createHash("sha256")
          .update(`unknown:${action}:${new Date().toISOString().slice(0, 16)}`, "utf8")
          .digest("hex");

    const { data, error } = await supabase
      .from("magic_link_issued_log")
      .insert({
        email_hash: effectiveHash,
        email_domain: emailDomain,
        role: input.role ?? null,
        action,
        reason,
        route: context.route.slice(0, 200),
        ip: context.ip,
        user_agent: context.userAgent,
        next_path: input.nextPath ? input.nextPath.slice(0, 500) : null,
        metadata: sanitizeMetadata(input.metadata),
      })
      .select("id")
      .single();

    if (error) {
      log.error("logMagicLinkEvent · insert falhou", {
        action,
        route: context.route,
        err: error.message,
      });
      return { ok: false, code: "insert_failed", message: error.message };
    }

    return { ok: true, id: data.id as string };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("logMagicLinkEvent · exception", {
      action,
      route: context.route,
      err: msg,
    });
    return { ok: false, code: "insert_failed", message: msg };
  }
}
