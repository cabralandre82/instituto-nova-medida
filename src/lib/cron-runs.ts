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

export type CronJob =
  | "recalc_earnings_availability"
  | "generate_monthly_payouts"
  | "notify_pending_documents"
  | "auto_deliver_fulfillments"
  | "nudge_reconsulta"
  | "admin_digest"
  | "retention_anonymize";

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
    console.warn("[cron_runs] start falhou:", job, error?.message);
    return null;
  }
  return (data as { id: string }).id;
}

export async function finishCronRun(
  supabase: SupabaseClient,
  id: string | null,
  params: {
    status: "ok" | "error";
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
  const { error } = await supabase
    .from("cron_runs")
    .update({
      status: params.status,
      payload: params.payload ?? null,
      error_message: params.errorMessage ?? null,
      finished_at: finishedAt.toISOString(),
      duration_ms: durationMs,
    })
    .eq("id", id);
  if (error) {
    console.warn("[cron_runs] finish falhou:", id, error.message);
  }
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
    console.warn("[cron_runs] latest failed:", job, error.message);
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
  status: "running" | "ok" | "error";
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
    console.warn("[cron_runs] latest failed:", job, error.message);
    return null;
  }
  return (data as {
    id: string;
    status: "running" | "ok" | "error";
    started_at: string;
    finished_at: string | null;
    duration_ms: number | null;
    payload: Record<string, unknown> | null;
    error_message: string | null;
  } | null);
}
