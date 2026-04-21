/**
 * src/lib/cron-dashboard.ts — PR-040 · D-059
 *
 * Agregações temporais sobre `cron_runs` para o dashboard
 * `/admin/crons`. Complementa `system-health.ts` (que é "o último run
 * está ok?") entregando a **tendência** — últimos 30 dias, duração
 * p50/p95, taxa de erro semana-atual vs anterior, histórico visível.
 *
 * Separação de responsabilidades:
 *
 *   - `fetchCronRunsWindow(supabase, days)`  → IO único (uma query).
 *     Retorna linhas cruas. Isolado pra que a agregação seja testável
 *     sem mock de Supabase.
 *   - `buildCronDashboard(rows, opts)`       → PURA. Recebe linhas, devolve
 *     o report completo. Todos os testes batem aqui.
 *   - `loadCronDashboard(supabase, days)`    → orquestra os dois (conveniência
 *     pra a page).
 *
 * Decisões:
 *
 *   - Runs em status `running` não contam em `success_rate` nem em
 *     `avg_duration_ms` — seriam ruído. Contadas separadamente em
 *     `running_count` pra o operador ver se há cron travado.
 *   - Runs anciãs em `running` (≥ 2h) são marcadas como `stuck` — é
 *     sinal de handler que crashou sem chegar ao `finishCronRun`.
 *   - Semana-vs-semana usa janela de 7 dias cheios (inclui hoje).
 *   - Timezone: buckets são por dia UTC do `started_at` — compatível
 *     com Vercel cron. Se quisermos reportar em fuso BR no futuro,
 *     fazemos conversão na borda (`datetime-br`); por ora UTC mantém
 *     a representação estável e sem surpresas de DST.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "./logger";

const log = logger.with({ mod: "cron-dashboard" });

/**
 * Limite de tempo em status `running` antes de marcarmos como
 * "travado" (crashou sem finishCronRun). 2h é generoso — nenhum dos
 * nossos crons atuais leva mais que uns 30s.
 */
const STUCK_THRESHOLD_MS = 2 * 60 * 60 * 1000;

export type CronRunStatus = "running" | "ok" | "error";

/**
 * Linha bruta do `cron_runs` como retornada pela query. Mantemos
 * separada do tipo em `cron-runs.ts` pra desacoplar — a lib de
 * dashboard só depende deste shape mínimo.
 */
export type CronRunRow = {
  id: string;
  job: string;
  started_at: string; // ISO UTC
  finished_at: string | null;
  status: CronRunStatus;
  duration_ms: number | null;
  error_message: string | null;
};

export type DailyBucket = {
  /** Formato YYYY-MM-DD (UTC). */
  date: string;
  total: number;
  ok: number;
  error: number;
  running: number;
};

export type DurationStats = {
  /** Média aritmética em ms, só sobre runs concluídos (ok ou error). */
  avg_ms: number | null;
  p50_ms: number | null;
  p95_ms: number | null;
  max_ms: number | null;
};

export type WeekDelta = {
  current: {
    total: number;
    ok: number;
    error: number;
    success_rate: number | null;
  };
  previous: {
    total: number;
    ok: number;
    error: number;
    success_rate: number | null;
  };
  /**
   * Variação relativa em pontos percentuais da `success_rate` da
   * semana atual em relação à anterior. `null` se alguma das duas
   * não tem amostra suficiente (< 1 run).
   */
  success_rate_delta_pp: number | null;
};

export type CronJobSummary = {
  job: string;
  total_runs: number;
  ok_count: number;
  error_count: number;
  running_count: number;
  /**
   * Runs em `running` há mais de STUCK_THRESHOLD_MS — sinal de handler
   * que crashou antes do `finishCronRun`.
   */
  stuck_count: number;
  /** Taxa de sucesso considerando runs concluídos (ok + error). */
  success_rate: number | null;
  duration: DurationStats;
  /** Último run conhecido (qualquer status), ou null se o job nunca rodou. */
  last_run: {
    id: string;
    status: CronRunStatus;
    started_at: string;
    finished_at: string | null;
    duration_ms: number | null;
    error_message: string | null;
  } | null;
  /** Mensagem do último run com erro (se houver). */
  last_error_at: string | null;
  last_error_message: string | null;
  /** Buckets diários da janela (do mais antigo ao mais novo). */
  daily: DailyBucket[];
  /** Comparação semana atual vs anterior. */
  week_delta: WeekDelta;
  /** Últimas 20 execuções em ordem decrescente (mais recente primeiro). */
  recent_runs: CronRunRow[];
};

export type CronDashboardReport = {
  /** ISO do momento da geração (pro header da página). */
  generated_at: string;
  /** Janela analisada em dias. */
  window_days: number;
  /** Resumo global agregado. */
  overall: {
    total_runs: number;
    ok_count: number;
    error_count: number;
    running_count: number;
    stuck_count: number;
    success_rate: number | null;
    distinct_jobs: number;
  };
  jobs: CronJobSummary[];
};

// ────────────────────────────────────────────────────────────────────
// Query (isolada pra ser substituível em teste)
// ────────────────────────────────────────────────────────────────────

/**
 * Busca TODAS as linhas de `cron_runs` com `started_at` nos últimos
 * `days` dias. Ordena mais recente primeiro.
 *
 * Por que não agregar no SQL? Volume esperado: 7 jobs × ~1 run/dia ×
 * 30 dias = ~210 linhas. Agregar no Node é trivial, testável sem
 * extensão SQL, e evita lock-in em funções Postgres específicas.
 * Quando o volume dobrar (cron de 1-min ou adição de dezenas de jobs),
 * migramos pra RPC SQL com CTE window function — o boundary está claro.
 */
export async function fetchCronRunsWindow(
  supabase: SupabaseClient,
  days: number
): Promise<CronRunRow[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("cron_runs")
    .select(
      "id, job, started_at, finished_at, status, duration_ms, error_message"
    )
    .gte("started_at", since)
    .order("started_at", { ascending: false })
    .limit(5000);

  if (error) {
    log.error("fetch failed", { err: error.message, days });
    return [];
  }

  return (data ?? []) as CronRunRow[];
}

// ────────────────────────────────────────────────────────────────────
// Agregação pura (tudo testável sem Supabase)
// ────────────────────────────────────────────────────────────────────

export type BuildOptions = {
  /**
   * Janela analisada em dias (ex.: 30). Usado só pra compor o retorno
   * e dimensionar os buckets diários. Runs fora da janela são
   * ignoradas (defesa, caso o caller passe linhas fora de range).
   */
  windowDays: number;
  /**
   * Timestamp "agora" injetável pra testes determinísticos. Default:
   * Date.now().
   */
  now?: number;
  /**
   * Lista de jobs "esperados" — jobs conhecidos pelo sistema mesmo
   * que não tenham rodado na janela aparecem no relatório com
   * contadores zerados. Mantém o dashboard estável mesmo quando um
   * cron específico ficou dias sem executar.
   */
  expectedJobs?: string[];
};

/**
 * Gera o report completo a partir das linhas cruas.
 */
export function buildCronDashboard(
  rows: CronRunRow[],
  opts: BuildOptions
): CronDashboardReport {
  const now = opts.now ?? Date.now();
  const windowDays = opts.windowDays;
  const windowStart = now - windowDays * 24 * 60 * 60 * 1000;

  // Filtra defensivamente (caller pode passar linhas de outras janelas).
  const inWindow = rows.filter(
    (r) => new Date(r.started_at).getTime() >= windowStart
  );

  const jobNames = new Set<string>(opts.expectedJobs ?? []);
  for (const r of inWindow) jobNames.add(r.job);

  const jobs: CronJobSummary[] = [];
  for (const job of jobNames) {
    const jobRows = inWindow.filter((r) => r.job === job);
    jobs.push(buildJobSummary(job, jobRows, { now, windowDays }));
  }

  // Ordena: jobs com erro recente primeiro, depois por volume.
  jobs.sort((a, b) => {
    const aHasErr = a.last_error_at ? 1 : 0;
    const bHasErr = b.last_error_at ? 1 : 0;
    if (aHasErr !== bHasErr) return bHasErr - aHasErr;
    return b.total_runs - a.total_runs;
  });

  const overall = {
    total_runs: jobs.reduce((s, j) => s + j.total_runs, 0),
    ok_count: jobs.reduce((s, j) => s + j.ok_count, 0),
    error_count: jobs.reduce((s, j) => s + j.error_count, 0),
    running_count: jobs.reduce((s, j) => s + j.running_count, 0),
    stuck_count: jobs.reduce((s, j) => s + j.stuck_count, 0),
    success_rate: computeSuccessRate(
      jobs.reduce((s, j) => s + j.ok_count, 0),
      jobs.reduce((s, j) => s + j.error_count, 0)
    ),
    distinct_jobs: jobs.length,
  };

  return {
    generated_at: new Date(now).toISOString(),
    window_days: windowDays,
    overall,
    jobs,
  };
}

function buildJobSummary(
  job: string,
  rows: CronRunRow[],
  ctx: { now: number; windowDays: number }
): CronJobSummary {
  const ok_count = rows.filter((r) => r.status === "ok").length;
  const error_count = rows.filter((r) => r.status === "error").length;
  const running_count = rows.filter((r) => r.status === "running").length;
  const stuck_count = rows.filter((r) => isStuck(r, ctx.now)).length;

  const durations = rows
    .filter((r) => r.status !== "running" && typeof r.duration_ms === "number")
    .map((r) => r.duration_ms as number)
    .sort((a, b) => a - b);

  const duration: DurationStats = {
    avg_ms: avg(durations),
    p50_ms: percentile(durations, 0.5),
    p95_ms: percentile(durations, 0.95),
    max_ms: durations.length > 0 ? durations[durations.length - 1] : null,
  };

  const daily = buildDailyBuckets(rows, ctx);
  const week_delta = buildWeekDelta(rows, ctx.now);

  // Rows vêm ordenadas desc do fetch, mas reordenamos defensivamente
  // pra consumir seguro mesmo se o caller passar fora de ordem.
  const sortedDesc = [...rows].sort(
    (a, b) =>
      new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
  );

  const last_run = sortedDesc[0]
    ? {
        id: sortedDesc[0].id,
        status: sortedDesc[0].status,
        started_at: sortedDesc[0].started_at,
        finished_at: sortedDesc[0].finished_at,
        duration_ms: sortedDesc[0].duration_ms,
        error_message: sortedDesc[0].error_message,
      }
    : null;

  const last_err = sortedDesc.find((r) => r.status === "error");
  const last_error_at = last_err?.started_at ?? null;
  const last_error_message = last_err?.error_message ?? null;

  return {
    job,
    total_runs: rows.length,
    ok_count,
    error_count,
    running_count,
    stuck_count,
    success_rate: computeSuccessRate(ok_count, error_count),
    duration,
    last_run,
    last_error_at,
    last_error_message,
    daily,
    week_delta,
    recent_runs: sortedDesc.slice(0, 20),
  };
}

function isStuck(r: CronRunRow, nowMs: number): boolean {
  if (r.status !== "running") return false;
  const age = nowMs - new Date(r.started_at).getTime();
  return age >= STUCK_THRESHOLD_MS;
}

/**
 * Gera um bucket por dia UTC, do mais antigo ao mais novo. Dias sem
 * runs ficam zerados — é importante pra a sparkline não "colapsar"
 * o eixo e dar sensação errada de cadência.
 */
function buildDailyBuckets(
  rows: CronRunRow[],
  ctx: { now: number; windowDays: number }
): DailyBucket[] {
  const buckets = new Map<string, DailyBucket>();

  // Inicializa todos os dias da janela zerados.
  const startOfWindow = startOfUtcDay(ctx.now - (ctx.windowDays - 1) * 86_400_000);
  for (let i = 0; i < ctx.windowDays; i++) {
    const d = startOfWindow + i * 86_400_000;
    const key = dateKey(d);
    buckets.set(key, { date: key, total: 0, ok: 0, error: 0, running: 0 });
  }

  // Preenche.
  for (const r of rows) {
    const key = dateKey(new Date(r.started_at).getTime());
    const b = buckets.get(key);
    if (!b) continue; // fora da janela — ignora
    b.total += 1;
    if (r.status === "ok") b.ok += 1;
    else if (r.status === "error") b.error += 1;
    else b.running += 1;
  }

  return Array.from(buckets.values()).sort((a, b) =>
    a.date.localeCompare(b.date)
  );
}

function buildWeekDelta(rows: CronRunRow[], nowMs: number): WeekDelta {
  const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
  const startCurrent = nowMs - oneWeekMs;
  const startPrevious = nowMs - 2 * oneWeekMs;

  const current = rows.filter((r) => {
    const ts = new Date(r.started_at).getTime();
    return ts >= startCurrent && ts <= nowMs;
  });
  const previous = rows.filter((r) => {
    const ts = new Date(r.started_at).getTime();
    return ts >= startPrevious && ts < startCurrent;
  });

  const curOk = current.filter((r) => r.status === "ok").length;
  const curErr = current.filter((r) => r.status === "error").length;
  const prevOk = previous.filter((r) => r.status === "ok").length;
  const prevErr = previous.filter((r) => r.status === "error").length;

  const curRate = computeSuccessRate(curOk, curErr);
  const prevRate = computeSuccessRate(prevOk, prevErr);

  const success_rate_delta_pp =
    curRate != null && prevRate != null
      ? Math.round((curRate - prevRate) * 1000) / 10
      : null;

  return {
    current: {
      total: current.length,
      ok: curOk,
      error: curErr,
      success_rate: curRate,
    },
    previous: {
      total: previous.length,
      ok: prevOk,
      error: prevErr,
      success_rate: prevRate,
    },
    success_rate_delta_pp,
  };
}

// ────────────────────────────────────────────────────────────────────
// Helpers matemáticos + datas
// ────────────────────────────────────────────────────────────────────

function computeSuccessRate(ok: number, err: number): number | null {
  const total = ok + err;
  if (total === 0) return null;
  return ok / total;
}

function avg(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return Math.round(xs.reduce((s, x) => s + x, 0) / xs.length);
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  // Método nearest-rank: suficiente pra dashboards ops (não é Prometheus).
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1)
  );
  return sorted[idx];
}

function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function dateKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ────────────────────────────────────────────────────────────────────
// Orquestração (conveniência pro page.tsx)
// ────────────────────────────────────────────────────────────────────

/**
 * Alto-nível: fetch + agregação em uma chamada. Recebe a lista de
 * jobs esperados pro relatório permanecer estável mesmo se um cron
 * não tiver executado na janela.
 */
export async function loadCronDashboard(
  supabase: SupabaseClient,
  opts: { windowDays: number; expectedJobs?: string[] }
): Promise<CronDashboardReport> {
  const rows = await fetchCronRunsWindow(supabase, opts.windowDays);
  return buildCronDashboard(rows, {
    windowDays: opts.windowDays,
    expectedJobs: opts.expectedJobs,
  });
}

// Exporta só pra testes que queiram cobrir os helpers diretamente.
export const __test__ = {
  percentile,
  avg,
  dateKey,
  startOfUtcDay,
  STUCK_THRESHOLD_MS,
};
