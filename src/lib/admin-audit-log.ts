/**
 * Helper pra emitir entradas em `public.admin_audit_log` (PR-031 / audit [17.1]).
 *
 * Como usar:
 *
 *   import { logAdminAction, getAuditContextFromRequest } from "@/lib/admin-audit-log";
 *
 *   export async function POST(req: NextRequest, { params }) {
 *     const admin = await requireAdmin();
 *     const supabase = getSupabaseAdmin();
 *
 *     // ... fazer a mutação, capturando before/after ...
 *
 *     await logAdminAction(supabase, {
 *       actorUserId: admin.id,
 *       actorEmail: admin.email,
 *       action: "fulfillment.transition",
 *       entityType: "fulfillment",
 *       entityId: fulfillmentId,
 *       before: { status: oldStatus },
 *       after: { status: newStatus },
 *       metadata: { ...getAuditContextFromRequest(req), reason: body.reason },
 *     });
 *   }
 *
 * Regras de ouro:
 *   1. **Não bloqueie o handler** se o insert falhar. Loga erro mas
 *      devolve o resultado da operação original — auditoria é
 *      best-effort. Exceção: operações irreversíveis (anonymize) onde
 *      o admin pode preferir reverter a operação se não conseguir
 *      logar (caller decide via `failHard=true`).
 *   2. **Inclua só o que interessa** em `before`/`after`. Não serialize
 *      a row inteira (polui, pode conter PII desnecessário).
 *   3. **Redact PII sensível** (CPF, cartão) antes de persistir.
 *   4. **action = "entity.verb"** em lowercase com ponto. Facilita
 *      filtros no futuro dashboard de auditoria.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";

export type AdminAuditEntry = {
  actorUserId?: string | null;
  actorEmail?: string | null;

  /**
   * Quem executou. Default 'admin' (usuário humano via rota /api/admin/*).
   * Use 'system' em crons e triggers internos — nesse caso, o check
   * constraint do banco exige `actorUserId === null` e recomenda-se
   * `actorEmail = "system:<job>"` (ex.: `"system:retention"`).
   * PR-033-A · D-052.
   */
  actorKind?: "admin" | "system";

  /** Ex.: "fulfillment.transition", "payout.approve". */
  action: string;

  /** Ex.: "fulfillment", "payout", "customer". */
  entityType?: string | null;

  /** UUID da entidade afetada. */
  entityId?: string | null;

  /**
   * Snapshot relevante antes da mutação. Subset dos campos.
   * Nunca inclua CPF, cartão ou outros dados sensíveis crus.
   */
  before?: unknown;

  /** Snapshot relevante após a mutação. */
  after?: unknown;

  /**
   * Contexto adicional (rota, ip, motivo, notas).
   * Use `getAuditContextFromRequest(req)` pra pegar o contexto HTTP
   * padrão e mergear com os campos específicos.
   */
  metadata?: Record<string, unknown> | null;
};

export type LogAdminActionOptions = {
  /**
   * Se true e o insert falhar, retorna `{ ok: false, error }` em vez de
   * `{ ok: true }`. Útil pra operações irreversíveis onde auditoria é
   * obrigatória (anonymize LGPD, por exemplo).
   */
  failHard?: boolean;
};

export type LogAdminActionResult =
  | { ok: true; id: string | null }
  | { ok: false; error: string };

export async function logAdminAction(
  supabase: SupabaseClient,
  entry: AdminAuditEntry,
  options: LogAdminActionOptions = {}
): Promise<LogAdminActionResult> {
  const actorKind = entry.actorKind ?? "admin";
  // Defesa em profundidade: o check constraint do banco já bloqueia
  // combinações inválidas, mas pegamos aqui antes pra log de erro
  // inteligível em vez de "violates check constraint".
  if (actorKind === "admin" && !entry.actorUserId) {
    const msg =
      "logAdminAction: actorKind='admin' exige actorUserId. Use actorKind='system' para crons/triggers.";
    console.error("[admin-audit-log]", msg, { action: entry.action });
    if (options.failHard) return { ok: false, error: msg };
    return { ok: true, id: null };
  }
  if (actorKind === "system" && entry.actorUserId) {
    const msg =
      "logAdminAction: actorKind='system' não pode ter actorUserId (constraint de binding).";
    console.error("[admin-audit-log]", msg, { action: entry.action });
    if (options.failHard) return { ok: false, error: msg };
    return { ok: true, id: null };
  }

  try {
    const { data, error } = await supabase
      .from("admin_audit_log")
      .insert({
        actor_user_id: entry.actorUserId ?? null,
        actor_email: entry.actorEmail ?? null,
        actor_kind: actorKind,
        action: entry.action,
        entity_type: entry.entityType ?? null,
        entity_id: entry.entityId ?? null,
        before_json: entry.before ?? null,
        after_json: entry.after ?? null,
        metadata: entry.metadata ?? null,
      })
      .select("id")
      .maybeSingle();

    if (error) {
      console.error("[admin-audit-log] insert failed:", {
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        error: error.message,
      });
      if (options.failHard) {
        return { ok: false, error: error.message };
      }
      return { ok: true, id: null };
    }

    return { ok: true, id: (data?.id as string | undefined) ?? null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[admin-audit-log] insert exception:", {
      action: entry.action,
      message,
    });
    if (options.failHard) {
      return { ok: false, error: message };
    }
    return { ok: true, id: null };
  }
}

/**
 * Extrai o contexto HTTP relevante de um NextRequest pra enriquecer
 * `metadata`. Inclui rota, IP (best-effort via `x-forwarded-for`) e
 * user-agent. Nunca logar cookies ou tokens.
 */
export function getAuditContextFromRequest(
  req: NextRequest | Request
): Record<string, unknown> {
  const headers = req.headers;

  const forwardedFor = headers.get("x-forwarded-for") ?? "";
  const firstIp = forwardedFor.split(",")[0]?.trim() || null;
  const realIp = headers.get("x-real-ip") || null;
  const userAgent = headers.get("user-agent") || null;

  let pathname: string | null = null;
  try {
    pathname = new URL(req.url).pathname;
  } catch {
    pathname = null;
  }

  return {
    ip: firstIp || realIp,
    userAgent,
    route: pathname,
  };
}
