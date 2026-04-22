/**
 * src/lib/patient-access-log.ts — PR-032 · D-051 · Onda 2A
 *
 * Helper único de escrita para `patient_access_log`. Toda rota admin
 * que LER PII de paciente deve chamar `logPatientAccess` — isso
 * atende LGPD Art. 37 (registro de operações) e Art. 46 (medidas de
 * segurança).
 *
 * Por quê uma lib separada e não inline em cada rota:
 *
 *   1. **Política única de falha.** Se o insert no log falhar,
 *      decidimos em um só lugar se bloqueamos a requisição (failHard)
 *      ou seguimos e apenas logamos no console (failSoft). Padrão:
 *      **failSoft** — indisponibilidade do log não pode bloquear o
 *      operador; perder visibilidade é menos ruim do que travar o
 *      atendimento.
 *
 *   2. **Shape consistente.** Cada call site passa `action` pré-
 *      -definido; o helper cuida do campo `metadata` genérico.
 *
 *   3. **Testabilidade.** Testar aqui uma vez cobre todas as rotas.
 *
 * Ação vs. intenção:
 *
 *   - **view** — página admin abriu ficha completa do paciente.
 *   - **export** — admin baixou export LGPD do paciente.
 *   - **anonymize** — admin executou anonimização (acompanha audit
 *     trail em admin_audit_log).
 *   - **search** — admin fez busca com termo; `customerId` pode ser
 *     NULL se não clicou em resultado específico; `metadata.query`
 *     carrega o termo (sem PII duplicada).
 *   - **lgpd_fulfill / lgpd_reject** — processamento de request LGPD
 *     self-service do paciente.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "./logger";

const log = logger.with({ mod: "patient-access-log" });

/**
 * Extrai IP e User-Agent de um Request (API route) ou de `headers()`
 * (Server Component). Aceita qualquer objeto com método `get`.
 *
 * Use em API routes: `getAccessContextFromRequest(req)`
 * Use em Server Components:
 *   const h = await headers();
 *   getAccessContextFromHeaders(h, "/admin/pacientes/abc");
 */
export type HeadersLike = { get: (name: string) => string | null };

export function getAccessContextFromRequest(
  req: Request
): { ip: string | null; userAgent: string | null; route: string | null } {
  const headers = req.headers;
  const forwardedFor = headers.get("x-forwarded-for") ?? "";
  const firstIp = forwardedFor.split(",")[0]?.trim() || null;
  const realIp = headers.get("x-real-ip") || null;
  const userAgent = headers.get("user-agent") || null;
  let route: string | null = null;
  try {
    route = new URL(req.url).pathname;
  } catch {
    route = null;
  }
  return { ip: firstIp || realIp, userAgent, route };
}

export function getAccessContextFromHeaders(
  h: HeadersLike,
  route: string | null
): { ip: string | null; userAgent: string | null; route: string | null } {
  const forwardedFor = h.get("x-forwarded-for") ?? "";
  const firstIp = forwardedFor.split(",")[0]?.trim() || null;
  const realIp = h.get("x-real-ip") || null;
  const userAgent = h.get("user-agent") || null;
  return { ip: firstIp || realIp, userAgent, route };
}

export type PatientAccessAction =
  | "view"
  | "export"
  | "anonymize"
  | "search"
  | "lgpd_fulfill"
  | "lgpd_reject"
  // PR-033-A · D-052 — anonimização automática por política de retenção.
  | "retention_anonymize"
  // PR-054 · D-065 — guard de takeover em upsert de customer.
  | "pii_takeover_blocked"
  | "pii_updated_authenticated"
  | "pii_updated_unauthenticated";

export type LogPatientAccessInput = {
  /**
   * UUID do admin. Obrigatório quando `actorKind='admin'` (default).
   * Quando `actorKind='system'`, deve ser NULL (constraint de binding).
   */
  adminUserId: string | null;
  adminEmail?: string | null;

  /**
   * 'admin' (default): usuário humano via /api/admin/*.
   * 'system': cron/trigger interno (ex.: retention).
   * Adicionado em PR-033-A · D-052.
   */
  actorKind?: "admin" | "system";

  customerId: string | null;
  action: PatientAccessAction;
  reason?: string | null;
  metadata?: Record<string, unknown>;
};

export type LogPatientAccessResult =
  | { ok: true; id: string }
  | { ok: false; code: "insert_failed"; message: string };

export type LogPatientAccessOptions = {
  /**
   * Se true, o INSERT falhar reflete no retorno ok:false. Rota decide
   * bloquear resposta. Padrão `false` (failSoft).
   */
  failHard?: boolean;
};

function sanitizeMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!metadata) return {};
  // Proteção simples: remove strings com mais de 2KB pra não bloatear
  // linha. Se o operador passar acidentalmente dump de objeto grande,
  // limitamos proativamente. Não tenta detectar PII — responsabilidade
  // do caller passar só campos seguros.
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

export async function logPatientAccess(
  supabase: SupabaseClient,
  input: LogPatientAccessInput,
  options: LogPatientAccessOptions = {}
): Promise<LogPatientAccessResult> {
  const actorKind = input.actorKind ?? "admin";
  // Early validation pra erro inteligível antes do constraint do banco.
  if (actorKind === "admin" && !input.adminUserId) {
    const msg =
      "logPatientAccess: actorKind='admin' exige adminUserId. Use actorKind='system' em crons.";
    log.error(msg, { action: input.action });
    if (options.failHard) return { ok: false, code: "insert_failed", message: msg };
    return { ok: false, code: "insert_failed", message: msg };
  }
  if (actorKind === "system" && input.adminUserId) {
    const msg =
      "logPatientAccess: actorKind='system' não pode ter adminUserId (constraint de binding).";
    log.error(msg, { action: input.action });
    if (options.failHard) return { ok: false, code: "insert_failed", message: msg };
    return { ok: false, code: "insert_failed", message: msg };
  }

  const row = {
    admin_user_id: input.adminUserId,
    admin_email: input.adminEmail ?? null,
    actor_kind: actorKind,
    customer_id: input.customerId,
    action: input.action,
    reason: input.reason ?? null,
    metadata: sanitizeMetadata(input.metadata),
  };

  const { data, error } = await supabase
    .from("patient_access_log")
    .insert(row)
    .select("id")
    .single();

  if (error || !data) {
    const message = error?.message ?? "insert returned no row";
    if (options.failHard) {
      return { ok: false, code: "insert_failed", message };
    }
    // failSoft: log estruturado pra investigação, devolve erro mas
    // caller pode ignorar. Nunca lançamos exception aqui.
    log.error("insert falhou (failSoft)", {
      action: input.action,
      customer_id: input.customerId,
      error: message,
    });
    return { ok: false, code: "insert_failed", message };
  }

  return { ok: true, id: (data as { id: string }).id };
}
