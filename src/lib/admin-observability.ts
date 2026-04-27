/**
 * src/lib/admin-observability.ts — PR-082 · D-094
 *
 * Métricas operacionais agregadas pra `/admin/observabilidade`.
 * Diferença vs `/admin/plantao` (D-090) e `/admin/crons` (D-059):
 *
 *   - `/admin/plantao`     → SNAPSHOT operacional ("quem está online
 *                            agora? que requests pending? settlements
 *                            recentes?"). Visão de minutos.
 *
 *   - `/admin/crons`       → TENDÊNCIA de saúde dos jobs ("este cron
 *                            está degradando? success rate semana vs
 *                            anterior?"). Visão de horas/dias.
 *
 *   - `/admin/observabilidade` (PR-082) → MÉTRICAS DE PRODUTO sobre
 *                            on-demand e plantão ("TTM p95? taxa de
 *                            match? cobertura média?"). Visão de
 *                            semanas/meses.
 *
 * Princípios
 * ──────────
 *   - **Helpers puros, IO no orquestrador**. computePercentiles,
 *     computeMatchRate, bucketCoverage, computeOnDemandStats etc. são
 *     funções puras testáveis sem mock de Supabase.
 *
 *   - **Janelas configuráveis**. 24h / 7d / 30d / 90d via parâmetro,
 *     pra operador comparar curto vs longo prazo.
 *
 *   - **Sem PII em métricas**. Agregados não vazam paciente/médica
 *     individual. Breakdown por médica usa display_name fallback
 *     pra full_name (já validado em outros panels).
 *
 *   - **Defesa a NaN/Infinity**. Inputs ruins (data inválida,
 *     duração negativa, count zero) viram null em vez de propagar
 *     NaN pelo render.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "./logger";

const log = logger.with({ mod: "admin-observability" });

// ────────────────────────────────────────────────────────────────────
// Constantes
// ────────────────────────────────────────────────────────────────────

/** Janelas suportadas pelo seletor da UI. Em horas pra cálculo unif. */
export const OBSERVABILITY_WINDOW_HOURS = {
  "24h": 24,
  "7d": 7 * 24,
  "30d": 30 * 24,
  "90d": 90 * 24,
} as const;

export type ObservabilityWindow = keyof typeof OBSERVABILITY_WINDOW_HOURS;

export const OBSERVABILITY_WINDOWS: readonly ObservabilityWindow[] = [
  "24h",
  "7d",
  "30d",
  "90d",
] as const;

export const DEFAULT_OBSERVABILITY_WINDOW: ObservabilityWindow = "7d";

/** Buckets do histograma de cobertura de plantão (em %). */
export const COVERAGE_BUCKETS = [
  { label: "0-25%", min: 0, max: 0.25 },
  { label: "25-50%", min: 0.25, max: 0.5 },
  { label: "50-75%", min: 0.5, max: 0.75 },
  { label: "75-100%", min: 0.75, max: 1.0001 }, // inclusivo no 100%
] as const;

/** Limite defensivo de leitura — nenhuma janela de observabilidade
 * legítima precisa de mais. Em produção 1-2 médicas, ≤ 5k requests
 * por mês é generoso. */
export const MAX_ROWS_PER_QUERY = 10_000;

// ────────────────────────────────────────────────────────────────────
// Tipos
// ────────────────────────────────────────────────────────────────────

export type PercentileSummary = {
  count: number;
  /** Em segundos, arredondado pra inteiro. null se count=0. */
  p50: number | null;
  p95: number | null;
  p99: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
};

export type OnDemandStats = {
  windowHours: number;
  total: number;
  byOutcome: {
    accepted: number;
    cancelled: number;
    expired: number;
    /** ainda pending dentro da janela (não terminado). */
    pending: number;
  };
  /** accepted / (accepted + cancelled + expired). null se 0. */
  matchRate: number | null;
  /** Time-to-match: accepted_at − created_at, em segundos. */
  timeToMatch: PercentileSummary;
  /** Tempo total que requests não-aceitos esperaram (cancelados/expirados). */
  timeToAbandon: PercentileSummary;
  /** Snapshot atual da fila pending. */
  pendingNow: {
    count: number;
    oldestAgeSeconds: number | null;
  };
};

export type FanOutStats = {
  windowHours: number;
  /** Quantos requests tiveram pelo menos 1 dispatch. */
  requestsWithFanOut: number;
  /** Soma de dispatches enviados (status='sent'). */
  totalDispatched: number;
  /** Médicas únicas notificadas. */
  uniqueDoctorsReached: number;
  /** Avg dispatches por request (entre os que tiveram pelo menos 1). */
  avgDispatchesPerRequest: number | null;
  /** Quantos requests não tiveram NENHUMA médica online no momento. */
  requestsWithZeroOnline: number;
  /** % do total — sinaliza problema crônico de cobertura. */
  zeroOnlineRate: number | null;
};

export type CoverageHistogram = Array<{
  label: string;
  count: number;
  pct: number;
}>;

export type DoctorOnCallStats = {
  doctorId: string;
  doctorName: string;
  paid: number;
  noShow: number;
  totalCents: number;
  totalCoverageMinutes: number;
  /** paid / (paid + no_show). null se 0 settlements. */
  fulfillRate: number | null;
};

export type OnCallStats = {
  windowHours: number;
  total: number;
  byOutcome: {
    paid: number;
    noShow: number;
  };
  /** paid / total. null se total=0. */
  fulfillRate: number | null;
  totalPaidCents: number;
  totalCoverageMinutes: number;
  coverage: PercentileSummary;
  histogram: CoverageHistogram;
  byDoctor: DoctorOnCallStats[];
};

export type ObservabilityReport = {
  window: ObservabilityWindow;
  windowHours: number;
  generatedAt: string;
  onDemand: OnDemandStats;
  fanOut: FanOutStats;
  onCall: OnCallStats;
};

// ────────────────────────────────────────────────────────────────────
// Helpers puros
// ────────────────────────────────────────────────────────────────────

/**
 * Computa p50/p95/p99/avg/min/max de uma lista de números (geralmente
 * em segundos). Defesa contra NaN/Infinity/negativos. Retorna
 * `count=0` + nulls se input vazio.
 *
 * Algoritmo de percentil: nearest-rank (clássico, sem interpolação).
 * Pra MVP volume baixo (até ~5k samples) a diferença entre nearest-rank
 * e linear-interpolation é cosmética.
 */
export function computePercentiles(values: readonly number[]): PercentileSummary {
  const sane = values.filter(
    (v) => Number.isFinite(v) && !Number.isNaN(v) && v >= 0
  );
  const n = sane.length;
  if (n === 0) {
    return {
      count: 0,
      p50: null,
      p95: null,
      p99: null,
      avg: null,
      min: null,
      max: null,
    };
  }
  const sorted = [...sane].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  const min = sorted[0] ?? 0;
  const max = sorted[n - 1] ?? 0;
  return {
    count: n,
    p50: percentileFromSorted(sorted, 0.5),
    p95: percentileFromSorted(sorted, 0.95),
    p99: percentileFromSorted(sorted, 0.99),
    avg: Math.round(sum / n),
    min: Math.round(min),
    max: Math.round(max),
  };
}

function percentileFromSorted(sorted: readonly number[], p: number): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  if (n === 1) return Math.round(sorted[0] ?? 0);
  // Nearest-rank: ceil(p × n) entre [1, n], então (-1) pra index.
  const rank = Math.max(1, Math.min(n, Math.ceil(p * n)));
  return Math.round(sorted[rank - 1] ?? 0);
}

/**
 * Match rate = accepted / (accepted + cancelled + expired). Pending
 * NÃO entra no denominador (request ainda em curso, decisão pendente).
 * Retorna null se denominador = 0 (sem dados na janela).
 */
export function computeMatchRate(input: {
  accepted: number;
  cancelled: number;
  expired: number;
}): number | null {
  const denom = input.accepted + input.cancelled + input.expired;
  if (denom <= 0) return null;
  return input.accepted / denom;
}

/**
 * Determina o bucket de cobertura (0-25, 25-50, 50-75, 75-100) pra
 * um ratio em [0, 1]. Defesa contra valores fora do range.
 */
export function bucketCoverage(ratio: number): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  for (const b of COVERAGE_BUCKETS) {
    if (clamped >= b.min && clamped < b.max) return b.label;
  }
  // Fallback (não deveria acontecer com clamp acima).
  return COVERAGE_BUCKETS[COVERAGE_BUCKETS.length - 1]?.label ?? "0-25%";
}

/**
 * Constrói o histograma de cobertura (4 buckets) preservando ordem.
 * Cada bucket tem `count` e `pct` (% do total). Sempre retorna os 4
 * buckets mesmo se vazios (UI mostra "0").
 */
export function buildCoverageHistogram(ratios: readonly number[]): CoverageHistogram {
  const total = ratios.length;
  const counts = new Map<string, number>();
  for (const b of COVERAGE_BUCKETS) counts.set(b.label, 0);
  for (const r of ratios) {
    const label = bucketCoverage(r);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return COVERAGE_BUCKETS.map((b) => {
    const count = counts.get(b.label) ?? 0;
    return {
      label: b.label,
      count,
      pct: total > 0 ? count / total : 0,
    };
  });
}

/**
 * Calcula o tempo (em segundos) entre dois ISO timestamps. Retorna
 * null se qualquer um for inválido ou se duração for negativa.
 */
export function computeDurationSeconds(input: {
  startIso: string | null | undefined;
  endIso: string | null | undefined;
}): number | null {
  if (!input.startIso || !input.endIso) return null;
  const start = new Date(input.startIso).getTime();
  const end = new Date(input.endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const delta = (end - start) / 1000;
  if (delta < 0) return null;
  return delta;
}

/**
 * Resolve a janela em ISO range [since, until] absoluto. `until` é
 * sempre `now`; `since` é `now - windowHours`.
 */
export function resolveWindowRange(input: {
  windowHours: number;
  now?: Date;
}): { sinceIso: string; untilIso: string } {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - input.windowHours * 60 * 60 * 1000);
  return { sinceIso: since.toISOString(), untilIso: now.toISOString() };
}

/**
 * Resolve nome de exibição de uma médica com fallback estável.
 */
export function resolveDoctorDisplayName(input: {
  full_name: string | null | undefined;
  display_name: string | null | undefined;
}): string {
  const display = (input.display_name ?? "").trim();
  if (display.length > 0) return display;
  const full = (input.full_name ?? "").trim();
  if (full.length > 0) return full;
  return "Médica";
}

// ────────────────────────────────────────────────────────────────────
// Aggregators puros (recebem rows brutas, retornam stats)
// ────────────────────────────────────────────────────────────────────

export type OnDemandRequestRowForStats = {
  id: string;
  status: "pending" | "accepted" | "cancelled" | "expired";
  created_at: string;
  accepted_at: string | null;
  cancelled_at: string | null;
  expires_at: string | null;
  updated_at: string;
};

export function aggregateOnDemandStats(input: {
  rows: readonly OnDemandRequestRowForStats[];
  windowHours: number;
  now?: Date;
}): OnDemandStats {
  const now = input.now ?? new Date();
  const counts = { accepted: 0, cancelled: 0, expired: 0, pending: 0 };
  const ttmSeconds: number[] = [];
  const abandonSeconds: number[] = [];

  for (const r of input.rows) {
    if (r.status === "accepted") counts.accepted += 1;
    else if (r.status === "cancelled") counts.cancelled += 1;
    else if (r.status === "expired") counts.expired += 1;
    else if (r.status === "pending") counts.pending += 1;

    if (r.status === "accepted") {
      const dur = computeDurationSeconds({
        startIso: r.created_at,
        endIso: r.accepted_at,
      });
      if (dur != null) ttmSeconds.push(dur);
    } else if (r.status === "cancelled") {
      const dur = computeDurationSeconds({
        startIso: r.created_at,
        endIso: r.cancelled_at,
      });
      if (dur != null) abandonSeconds.push(dur);
    } else if (r.status === "expired") {
      // Expired: tempo até `expires_at` (paciente esperou TTL inteiro).
      const dur = computeDurationSeconds({
        startIso: r.created_at,
        endIso: r.expires_at,
      });
      if (dur != null) abandonSeconds.push(dur);
    }
  }

  // Snapshot da fila pending NOW (não restrito à janela).
  const pendingRows = input.rows.filter((r) => r.status === "pending");
  let oldestAgeSeconds: number | null = null;
  for (const p of pendingRows) {
    const age = computeDurationSeconds({
      startIso: p.created_at,
      endIso: now.toISOString(),
    });
    if (age != null && (oldestAgeSeconds == null || age > oldestAgeSeconds)) {
      oldestAgeSeconds = Math.round(age);
    }
  }

  return {
    windowHours: input.windowHours,
    total: input.rows.length,
    byOutcome: counts,
    matchRate: computeMatchRate({
      accepted: counts.accepted,
      cancelled: counts.cancelled,
      expired: counts.expired,
    }),
    timeToMatch: computePercentiles(ttmSeconds),
    timeToAbandon: computePercentiles(abandonSeconds),
    pendingNow: {
      count: pendingRows.length,
      oldestAgeSeconds,
    },
  };
}

export type DispatchRowForStats = {
  request_id: string;
  doctor_id: string;
  dispatch_status: "sent" | "failed" | "skipped";
  doctor_was_online: boolean | null;
};

export function aggregateFanOutStats(input: {
  dispatches: readonly DispatchRowForStats[];
  /** Total de requests na janela (pra calcular zero-online rate). */
  requestsTotal: number;
  windowHours: number;
}): FanOutStats {
  const sentByRequest = new Map<string, number>();
  const uniqueDoctors = new Set<string>();
  let totalDispatched = 0;

  for (const d of input.dispatches) {
    if (d.dispatch_status !== "sent") continue;
    totalDispatched += 1;
    uniqueDoctors.add(d.doctor_id);
    sentByRequest.set(
      d.request_id,
      (sentByRequest.get(d.request_id) ?? 0) + 1
    );
  }

  const requestsWithFanOut = sentByRequest.size;
  const requestsWithZeroOnline = Math.max(
    0,
    input.requestsTotal - requestsWithFanOut
  );

  return {
    windowHours: input.windowHours,
    requestsWithFanOut,
    totalDispatched,
    uniqueDoctorsReached: uniqueDoctors.size,
    avgDispatchesPerRequest:
      requestsWithFanOut > 0
        ? Math.round((totalDispatched / requestsWithFanOut) * 100) / 100
        : null,
    requestsWithZeroOnline,
    zeroOnlineRate:
      input.requestsTotal > 0 ? requestsWithZeroOnline / input.requestsTotal : null,
  };
}

export type SettlementRowForStats = {
  doctor_id: string;
  outcome: "paid" | "no_show";
  coverage_ratio: number;
  coverage_minutes: number;
  amount_cents_snapshot: number | null;
};

export type DoctorRowForStats = {
  id: string;
  full_name: string | null;
  display_name: string | null;
};

export function aggregateOnCallStats(input: {
  settlements: readonly SettlementRowForStats[];
  doctors: readonly DoctorRowForStats[];
  windowHours: number;
}): OnCallStats {
  const counts = { paid: 0, noShow: 0 };
  let totalPaidCents = 0;
  let totalCoverageMinutes = 0;
  const ratios: number[] = [];
  const byDoctorMap = new Map<
    string,
    {
      paid: number;
      noShow: number;
      totalCents: number;
      totalCoverageMinutes: number;
    }
  >();

  for (const s of input.settlements) {
    if (s.outcome === "paid") {
      counts.paid += 1;
      totalPaidCents += s.amount_cents_snapshot ?? 0;
    } else {
      counts.noShow += 1;
    }
    totalCoverageMinutes += s.coverage_minutes;
    ratios.push(s.coverage_ratio);
    const cur = byDoctorMap.get(s.doctor_id) ?? {
      paid: 0,
      noShow: 0,
      totalCents: 0,
      totalCoverageMinutes: 0,
    };
    if (s.outcome === "paid") {
      cur.paid += 1;
      cur.totalCents += s.amount_cents_snapshot ?? 0;
    } else {
      cur.noShow += 1;
    }
    cur.totalCoverageMinutes += s.coverage_minutes;
    byDoctorMap.set(s.doctor_id, cur);
  }

  const doctorById = new Map(input.doctors.map((d) => [d.id, d] as const));
  const byDoctor: DoctorOnCallStats[] = Array.from(byDoctorMap.entries())
    .map(([doctorId, agg]) => {
      const d = doctorById.get(doctorId);
      const totalSettlements = agg.paid + agg.noShow;
      return {
        doctorId,
        doctorName: resolveDoctorDisplayName({
          full_name: d?.full_name ?? null,
          display_name: d?.display_name ?? null,
        }),
        paid: agg.paid,
        noShow: agg.noShow,
        totalCents: agg.totalCents,
        totalCoverageMinutes: agg.totalCoverageMinutes,
        fulfillRate: totalSettlements > 0 ? agg.paid / totalSettlements : null,
      };
    })
    .sort((a, b) => b.totalCents - a.totalCents);

  const total = counts.paid + counts.noShow;
  // Coverage em segundos pra reusar `computePercentiles` (que já
  // arredonda pra int). Convertemos: ratio em [0,1] × 10000 = ‱.
  // Pra histograma de UI mostramos %, mas pra percentil precisamos
  // do número real arredondado em centésimos.
  // Multiplicamos por 10_000 → percentil retorna valor escalonado;
  // dividimos por 100 no consumo final pra ter %.
  const ratiosScaled = ratios.map((r) => r * 10_000);
  const scaled = computePercentiles(ratiosScaled);
  const coverage: PercentileSummary = {
    count: scaled.count,
    p50: scaled.p50 != null ? Math.round(scaled.p50 / 100) : null,
    p95: scaled.p95 != null ? Math.round(scaled.p95 / 100) : null,
    p99: scaled.p99 != null ? Math.round(scaled.p99 / 100) : null,
    avg: scaled.avg != null ? Math.round(scaled.avg / 100) : null,
    min: scaled.min != null ? Math.round(scaled.min / 100) : null,
    max: scaled.max != null ? Math.round(scaled.max / 100) : null,
  };

  return {
    windowHours: input.windowHours,
    total,
    byOutcome: counts,
    fulfillRate: total > 0 ? counts.paid / total : null,
    totalPaidCents,
    totalCoverageMinutes,
    coverage,
    histogram: buildCoverageHistogram(ratios),
    byDoctor,
  };
}

// ────────────────────────────────────────────────────────────────────
// Orquestrador (com IO)
// ────────────────────────────────────────────────────────────────────

/**
 * Carrega TODAS as métricas do dashboard `/admin/observabilidade`
 * em paralelo. Cada subquery tem fail-soft (erro → empty array +
 * log) pra render parcial nunca quebrar.
 */
export async function loadObservabilityReport(
  supabase: SupabaseClient,
  opts: { window: ObservabilityWindow; now?: Date }
): Promise<ObservabilityReport> {
  const now = opts.now ?? new Date();
  const windowHours = OBSERVABILITY_WINDOW_HOURS[opts.window];
  const { sinceIso } = resolveWindowRange({ windowHours, now });

  const [requestsAndPending, dispatches, settlements, doctors] = await Promise.all([
    loadOnDemandRequests(supabase, sinceIso),
    loadDispatches(supabase, sinceIso),
    loadSettlements(supabase, sinceIso),
    loadDoctorsLite(supabase),
  ]);

  const onDemand = aggregateOnDemandStats({
    rows: requestsAndPending,
    windowHours,
    now,
  });
  // Pra fan-out, usamos como denominador o total de requests da
  // janela (incluindo pending), porque "% sem médica online" é
  // métrica útil mesmo enquanto o request está aguardando.
  const fanOut = aggregateFanOutStats({
    dispatches,
    requestsTotal: requestsAndPending.length,
    windowHours,
  });
  const onCall = aggregateOnCallStats({
    settlements,
    doctors,
    windowHours,
  });

  return {
    window: opts.window,
    windowHours,
    generatedAt: now.toISOString(),
    onDemand,
    fanOut,
    onCall,
  };
}

async function loadOnDemandRequests(
  supabase: SupabaseClient,
  sinceIso: string
): Promise<OnDemandRequestRowForStats[]> {
  // Pega TODOS os requests cujo created_at OU pending corrente caia
  // na janela. Pra MVP, simplificação: filtra por created_at >= since
  // (pending de janela mais antiga não conta no aggregate, mas
  // `pendingNow` é separado e olha NOW). UNION com pending atuais
  // independente de janela:
  const { data: windowRows, error: windowErr } = await supabase
    .from("on_demand_requests")
    .select("id, status, created_at, accepted_at, cancelled_at, expires_at, updated_at")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(MAX_ROWS_PER_QUERY);
  if (windowErr) {
    log.error("loadOnDemandRequests window failed", { err: windowErr });
    return [];
  }

  // Pending atuais (caso a janela seja curta e não pegue um pending
  // criado antes).
  const { data: pendingNow, error: pendingErr } = await supabase
    .from("on_demand_requests")
    .select("id, status, created_at, accepted_at, cancelled_at, expires_at, updated_at")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(500);
  if (pendingErr) {
    log.warn("loadOnDemandRequests pending failed", { err: pendingErr });
  }

  const merged = new Map<string, OnDemandRequestRowForStats>();
  for (const r of (windowRows ?? []) as OnDemandRequestRowForStats[]) {
    merged.set(r.id, r);
  }
  for (const r of (pendingNow ?? []) as OnDemandRequestRowForStats[]) {
    if (!merged.has(r.id)) merged.set(r.id, r);
  }
  return Array.from(merged.values());
}

async function loadDispatches(
  supabase: SupabaseClient,
  sinceIso: string
): Promise<DispatchRowForStats[]> {
  const { data, error } = await supabase
    .from("on_demand_request_dispatches")
    .select("request_id, doctor_id, dispatch_status, doctor_was_online")
    .gte("dispatched_at", sinceIso)
    .limit(MAX_ROWS_PER_QUERY);
  if (error) {
    log.error("loadDispatches failed", { err: error });
    return [];
  }
  return (data ?? []) as DispatchRowForStats[];
}

async function loadSettlements(
  supabase: SupabaseClient,
  sinceIso: string
): Promise<SettlementRowForStats[]> {
  const { data, error } = await supabase
    .from("on_call_block_settlements")
    .select("doctor_id, outcome, coverage_ratio, coverage_minutes, amount_cents_snapshot")
    .gte("settled_at", sinceIso)
    .limit(MAX_ROWS_PER_QUERY);
  if (error) {
    log.error("loadSettlements failed", { err: error });
    return [];
  }
  return (data ?? []) as SettlementRowForStats[];
}

async function loadDoctorsLite(
  supabase: SupabaseClient
): Promise<DoctorRowForStats[]> {
  const { data, error } = await supabase
    .from("doctors")
    .select("id, full_name, display_name");
  if (error) {
    log.error("loadDoctorsLite failed", { err: error });
    return [];
  }
  return (data ?? []) as DoctorRowForStats[];
}

// ────────────────────────────────────────────────────────────────────
// Format helpers (UI helpers, mas puros e testáveis)
// ────────────────────────────────────────────────────────────────────

/** Formata segundos em "Xm Ys" / "Xh YmYs" / "—" defensivo. */
export function formatDurationHuman(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const totalMinutes = Math.floor(seconds / 60);
  const remSeconds = Math.round(seconds % 60);
  if (totalMinutes < 60) {
    return remSeconds > 0
      ? `${totalMinutes}m ${remSeconds}s`
      : `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const remMinutes = totalMinutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

/** Formata percentual a partir de uma fração [0, 1]. null → "—". */
export function formatPctFromRatio(ratio: number | null): string {
  if (ratio == null || !Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(1)}%`;
}

/** Formata centavos em "R$ X,YZ". */
export function formatCentsBR(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  return `R$ ${(cents / 100).toFixed(2).replace(".", ",")}`;
}
