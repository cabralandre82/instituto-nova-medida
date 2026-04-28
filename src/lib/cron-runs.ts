/**
 * Auditoria de execução de crons (D-040).
 *
 * Wrapper leve em volta de `cron_runs` pra que cada execução registre:
 *   - start / finish
 *   - status ('ok' | 'error')
 *   - payload (métricas da execução)
 *   - erro (quando aplicável)
 *
 * Usado pelas rotas `/api/internal/cron/*` e monitorado pelo
 * `system-health.ts` (freshness) e `/admin/health`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { validateSafeJsonbObject } from "./jsonb-schemas";
import { logger } from "./logger";

const log = logger.with({ mod: "cron-runs" });

/**
 * Sanitiza um payload pra `cron_runs.payload` via schema genérico safe.
 * Payload inválido (undefined / Date / circular / muito grande) NÃO
 * derruba o finishCronRun — cron já fez o trabalho e registrar o
 * run é prioridade. Trocamos por um stub rastreável e emitimos warning
 * no logger (que vai pra sink externo via D-057). PR-061 · D-071.
 */
function sanitizeCronPayload(
  payload: Record<string, unknown> | undefined,
  job: string,
  runId: string | null
): Record<string, unknown> | null {
  if (!payload) return null;
  const res = validateSafeJsonbObject(payload, {
    maxDepth: 6,
    maxSerializedChars: 32 * 1024,
    maxStringLength: 8 * 1024,
  });
  if (res.ok) return res.value;

  log.warn("payload rejeitado pelo schema safe, substituindo por stub", {
    job,
    run_id: runId,
    issues: res.issues,
  });
  return {
    _validation_failed: true,
    _job: job,
    _issue_count: res.issues.length,
    _first_issue: res.issues[0] ?? null,
  };
}

export type CronJob =
  | "recalc_earnings_availability"
  | "generate_monthly_payouts"
  | "notify_pending_documents"
  | "auto_deliver_fulfillments"
  | "nudge_reconsulta"
  | "admin_digest"
  | "retention_anonymize"
  | "asaas_events_purge"
  | "expire_appointment_credits"
  | "stale_presence"
  | "doctor_daily_summary"
  | "doctor_on_call_reminder"
  | "expire_on_demand_requests"
  | "monitor_on_call"
  | "cost_snapshot";

export async function startCronRun(
  supabase: SupabaseClient,
  job: CronJob
): Promise<string | null> {
  const { data, error } = await supabase
    .from("cron_runs")
    .insert({ job, status: "running" })
    .select("id")
    .single();
  if (error || !data) {
    log.warn("start falhou", { job, error: error?.message ?? null });
    return null;
  }
  return (data as { id: string }).id;
}

export async function finishCronRun(
  supabase: SupabaseClient,
  id: string | null,
  params: {
    status: "ok" | "error" | "skipped";
    payload?: Record<string, unknown>;
    errorMessage?: string;
    startedAtMs?: number;
  }
): Promise<void> {
  if (!id) return;
  const finishedAt = new Date();
  const durationMs = params.startedAtMs
    ? finishedAt.getTime() - params.startedAtMs
    : null;
  const safePayload = sanitizeCronPayload(params.payload, "cron_runs", id);
  const { error } = await supabase
    .from("cron_runs")
    .update({
      status: params.status,
      payload: safePayload,
      error_message: params.errorMessage ?? null,
      finished_at: finishedAt.toISOString(),
      duration_ms: durationMs,
    })
    .eq("id", id);
  if (error) {
    log.warn("finish falhou", { run_id: id, error: error.message });
  }
}

/**
 * Fecha o run como 'skipped' — usado quando o cron decide não executar
 * (ex.: circuit breaker do provider externo está OPEN). Grava `payload`
 * com o motivo pra auditoria no dashboard `/admin/crons`.
 *
 * Chame DEPOIS de `startCronRun` — mantém a simetria start/finish e
 * registra duração zero (~ms). Não é erro: dashboard e system-health
 * não alertam sobre skipped.
 *
 * PR-050 · D-061.
 */
export async function skipCronRun(
  supabase: SupabaseClient,
  id: string | null,
  params: {
    reason: string;
    details?: Record<string, unknown>;
    startedAtMs?: number;
  }
): Promise<void> {
  return finishCronRun(supabase, id, {
    status: "skipped",
    payload: {
      skip_reason: params.reason,
      ...(params.details ?? {}),
    },
    startedAtMs: params.startedAtMs,
  });
}

/**
 * Última execução bem sucedida de um job (usada pelo system-health).
 */
export async function getLatestSuccessfulRun(
  supabase: SupabaseClient,
  job: CronJob
): Promise<{
  id: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  payload: Record<string, unknown> | null;
} | null> {
  const { data, error } = await supabase
    .from("cron_runs")
    .select("id, started_at, finished_at, duration_ms, payload")
    .eq("job", job)
    .eq("status", "ok")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    log.warn("latest success failed", { job, error: error.message });
    return null;
  }
  return (data as {
    id: string;
    started_at: string;
    finished_at: string | null;
    duration_ms: number | null;
    payload: Record<string, unknown> | null;
  } | null);
}

/**
 * Última execução (qualquer status) — usada pelo admin UI e system-health
 * pra detectar execuções recentes com erro.
 */
export async function getLatestRun(
  supabase: SupabaseClient,
  job: CronJob
): Promise<{
  id: string;
  status: "running" | "ok" | "error" | "skipped";
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  payload: Record<string, unknown> | null;
  error_message: string | null;
} | null> {
  const { data, error } = await supabase
    .from("cron_runs")
    .select(
      "id, status, started_at, finished_at, duration_ms, payload, error_message"
    )
    .eq("job", job)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    log.warn("latest failed", { job, error: error.message });
    return null;
  }
  return (data as {
    id: string;
    status: "running" | "ok" | "error" | "skipped";
    started_at: string;
    finished_at: string | null;
    duration_ms: number | null;
    payload: Record<string, unknown> | null;
    error_message: string | null;
  } | null);
}
