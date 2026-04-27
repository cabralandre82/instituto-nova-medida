/**
 * Doctor presence — real-time online/offline state da médica.
 *
 * PR-075-B · D-087. Suporta:
 *
 *   - Heartbeat: a UI da médica em /medico/plantao chama
 *     /api/medico/presence/heartbeat a cada 30s; este módulo
 *     refresca `last_heartbeat_at` sem alterar status.
 *
 *   - Toggle manual: médica clica "estou de plantão" / "sair";
 *     /api/medico/presence/status muda status (online | busy | offline).
 *
 *   - Auto-offline: cron `stale-presence` (60s) roda
 *     `sweepStalePresence()` aqui, marcando como offline qualquer
 *     médica que não pingou em STALE_THRESHOLD_SECONDS.
 *
 * Schema invariants (espelhados na migration via CHECK):
 *   - status='offline' ↔ online_since IS NULL.
 *   - status='online'|'busy' ↔ online_since IS NOT NULL.
 *
 * O que esta lib NÃO faz:
 *   - Não notifica via WhatsApp. Notificação de "médica voltou
 *     online" mora no cron de plantão (PR-077/PR-081).
 *   - Não sincroniza com `appointments.status='in_progress'`. A
 *     transição online→busy quando entra em consulta é
 *     responsabilidade de quem inicia a consulta (PR-079/PR-080).
 *   - Não persiste histórico. UMA linha por médica, sobrescrita.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase";
import { logger } from "./logger";

const log = logger.with({ mod: "doctor-presence" });

/**
 * Tempo (em segundos) sem heartbeat antes do cron forçar offline.
 *
 * Trade-off:
 *   - Muito curto (30s) → ruído alto: blip de rede de 1s já apaga
 *     a médica.
 *   - Muito longo (300s) → médica sai sem avisar e fica "online
 *     fantasma" por 5min, paciente on-demand entra em fila vazia.
 *
 * 120s = 4× o intervalo de heartbeat (30s). Tolera 2 pings perdidos
 * antes de marcar offline. É a janela que permite conexão Wi-Fi
 * trocando de banda sem reset, e ainda dá garantia de no máximo 2min
 * de "fantasma" pro paciente.
 */
export const STALE_PRESENCE_THRESHOLD_SECONDS = 120;

/**
 * Intervalo recomendado entre heartbeats da UI da médica. A UI vai
 * chamar com este período (em ms = SECONDS * 1000).
 */
export const PRESENCE_HEARTBEAT_INTERVAL_SECONDS = 30;

/**
 * Default sweep batch limit pro cron stale-presence. Sized
 * generosamente — em produção é improvável passar de 1 médica por
 * sweep até PR-046 (multi-médica). Mas o limit existe pra prevenir
 * DDoS interno se algo der errado.
 */
export const DEFAULT_STALE_SWEEP_LIMIT = 100;
export const MIN_STALE_SWEEP_LIMIT = 1;
export const MAX_STALE_SWEEP_LIMIT = 1000;

export type PresenceStatus = "online" | "busy" | "offline";
export type PresenceSource = "manual" | "auto_offline";

export type PresenceRow = {
  doctor_id: string;
  status: PresenceStatus;
  last_heartbeat_at: string;
  online_since: string | null;
  source: PresenceSource;
  client_meta: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type ClientMetaInput = {
  ua?: string | null;
  app_version?: string | null;
  ip_hash?: string | null;
};

/**
 * Sanitiza `clientMeta` antes de gravar. Mantém só as chaves
 * conhecidas e clamp em tamanho — defesa em profundidade contra
 * o CHECK constraint (4096 bytes) da migration.
 */
function sanitizeClientMeta(meta: ClientMetaInput | null | undefined): Record<string, unknown> {
  if (!meta) return {};
  const out: Record<string, unknown> = {};
  if (typeof meta.ua === "string") out.ua = meta.ua.slice(0, 500);
  if (typeof meta.app_version === "string") {
    out.app_version = meta.app_version.slice(0, 64);
  }
  if (typeof meta.ip_hash === "string") {
    out.ip_hash = meta.ip_hash.slice(0, 128);
  }
  return out;
}

/**
 * Heartbeat: refresca `last_heartbeat_at` sem mudar status.
 *
 * Idempotente; chamada em loop pela UI a cada 30s.
 */
export async function recordHeartbeat(
  doctorId: string,
  meta?: ClientMetaInput
): Promise<{ ok: true; row: PresenceRow } | { ok: false; error: string }> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("presence_heartbeat", {
    p_doctor_id: doctorId,
    p_client_meta: sanitizeClientMeta(meta),
  });
  if (error) {
    log.error("recordHeartbeat", { doctor_id: doctorId, err: error.message });
    return { ok: false, error: error.message };
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") {
    return { ok: false, error: "no_row_returned" };
  }
  return { ok: true, row: row as PresenceRow };
}

/**
 * Mudança explícita de status (online/busy/offline).
 *
 * Usar source='auto_offline' apenas quando o cron força a
 * transição — toda mudança originada pela UI da médica passa
 * source='manual'.
 */
export async function setPresenceStatus(
  doctorId: string,
  status: PresenceStatus,
  opts: { source?: PresenceSource; clientMeta?: ClientMetaInput | null } = {}
): Promise<{ ok: true; row: PresenceRow } | { ok: false; error: string }> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("set_presence_status", {
    p_doctor_id: doctorId,
    p_status: status,
    p_source: opts.source ?? "manual",
    p_client_meta:
      opts.clientMeta === null
        ? null
        : sanitizeClientMeta(opts.clientMeta),
  });
  if (error) {
    log.error("setPresenceStatus", {
      doctor_id: doctorId,
      status,
      err: error.message,
    });
    return { ok: false, error: error.message };
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") {
    return { ok: false, error: "no_row_returned" };
  }
  return { ok: true, row: row as PresenceRow };
}

/**
 * Lê o estado atual da presença de uma médica. Retorna `null` se
 * nunca houve heartbeat — semanticamente equivalente a "offline".
 */
export async function getCurrentPresence(
  doctorId: string
): Promise<PresenceRow | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("doctor_presence")
    .select(
      "doctor_id, status, last_heartbeat_at, online_since, source, client_meta, created_at, updated_at"
    )
    .eq("doctor_id", doctorId)
    .maybeSingle();
  if (error) {
    log.error("getCurrentPresence", { doctor_id: doctorId, err: error.message });
    return null;
  }
  return (data as PresenceRow | null) ?? null;
}

/**
 * Lista médicas atualmente `online` (não busy, não offline).
 * Usado pelo fan-out de on-demand requests (PR-079).
 *
 * Filtro adicional: heartbeat dentro da janela fresca. Se a row diz
 * 'online' mas o cron stale ainda não rodou, defendemos via
 * `last_heartbeat_at >= now() - STALE_THRESHOLD`.
 */
export async function listOnlineDoctors(opts?: {
  staleThresholdSeconds?: number;
}): Promise<PresenceRow[]> {
  const supabase = getSupabaseAdmin();
  const threshold = Math.max(
    1,
    opts?.staleThresholdSeconds ?? STALE_PRESENCE_THRESHOLD_SECONDS
  );
  const cutoff = new Date(Date.now() - threshold * 1000).toISOString();
  const { data, error } = await supabase
    .from("doctor_presence")
    .select(
      "doctor_id, status, last_heartbeat_at, online_since, source, client_meta, created_at, updated_at"
    )
    .eq("status", "online")
    .gte("last_heartbeat_at", cutoff);
  if (error) {
    log.error("listOnlineDoctors", { err: error.message });
    return [];
  }
  return (data ?? []) as PresenceRow[];
}

/**
 * Report do sweep do cron stale-presence.
 */
export type StaleSweepReport = {
  dryRun: boolean;
  candidatesFound: number;
  forcedOffline: number;
  errors: number;
  errorDetails: string[];
  oldestStaleHeartbeatAt: string | null;
  newestStaleHeartbeatAt: string | null;
};

/**
 * Sweep das presenças stale: marca como `offline` qualquer linha em
 * status `online`|`busy` cujo `last_heartbeat_at` é mais velho que
 * STALE_PRESENCE_THRESHOLD_SECONDS.
 *
 * Padrão SELECT→UPDATE em 2 passos (mesma técnica de
 * `sweepExpiredCredits` em PR-073-B). UPDATE inline (não via RPC
 * `set_presence_status`) por dois motivos:
 *
 *   1. Performance: 1 UPDATE em batch vs N RPCs.
 *   2. Testabilidade: usa o `supabase` injetado, não chama
 *      `getSupabaseAdmin()` internamente. Mantém o mesmo shape do
 *      `sweepExpiredCredits` no test fixture.
 *
 * Coerência: ao definir `status='offline'`, também limpamos
 * `online_since=NULL` e marcamos `source='auto_offline'` —
 * casa com o CHECK constraint da tabela e bate com a semântica do
 * RPC. Filtramos `WHERE status IN ('online','busy')` no UPDATE pra
 * evitar regressão sob race condition (médica fez toggle pra
 * 'offline' entre o SELECT e o UPDATE).
 *
 * Idempotente: rodar 2x em sequência produz 0 candidatas no segundo
 * run.
 */
export async function sweepStalePresence(
  supabase: SupabaseClient,
  opts: {
    staleThresholdSeconds?: number;
    limit?: number;
    dryRun?: boolean;
    now?: Date;
  } = {}
): Promise<StaleSweepReport> {
  const threshold = Math.max(
    1,
    opts.staleThresholdSeconds ?? STALE_PRESENCE_THRESHOLD_SECONDS
  );
  const limit = Math.max(
    MIN_STALE_SWEEP_LIMIT,
    Math.min(opts.limit ?? DEFAULT_STALE_SWEEP_LIMIT, MAX_STALE_SWEEP_LIMIT)
  );
  const now = opts.now ?? new Date();
  const cutoffIso = new Date(now.getTime() - threshold * 1000).toISOString();
  const dryRun = Boolean(opts.dryRun);

  const report: StaleSweepReport = {
    dryRun,
    candidatesFound: 0,
    forcedOffline: 0,
    errors: 0,
    errorDetails: [],
    oldestStaleHeartbeatAt: null,
    newestStaleHeartbeatAt: null,
  };

  const { data: candidates, error: selectError } = await supabase
    .from("doctor_presence")
    .select("doctor_id, last_heartbeat_at")
    .in("status", ["online", "busy"])
    .lt("last_heartbeat_at", cutoffIso)
    .order("last_heartbeat_at", { ascending: true })
    .limit(limit);

  if (selectError) {
    report.errors += 1;
    report.errorDetails.push(`select_failed: ${selectError.message}`);
    return report;
  }

  const rows = (candidates ?? []) as Array<{
    doctor_id: string;
    last_heartbeat_at: string;
  }>;
  report.candidatesFound = rows.length;
  if (rows.length === 0) return report;

  report.oldestStaleHeartbeatAt = rows[0].last_heartbeat_at;
  report.newestStaleHeartbeatAt = rows[rows.length - 1].last_heartbeat_at;

  if (dryRun) return report;

  const ids = rows.map((r) => r.doctor_id);

  const { data: updated, error: updateError } = await supabase
    .from("doctor_presence")
    .update({
      status: "offline",
      online_since: null,
      source: "auto_offline",
    })
    .in("doctor_id", ids)
    .in("status", ["online", "busy"])
    .select("doctor_id");

  if (updateError) {
    report.errors += 1;
    report.errorDetails.push(`update_failed: ${updateError.message}`);
    return report;
  }

  report.forcedOffline = (updated ?? []).length;
  return report;
}
