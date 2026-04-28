/**
 * src/lib/cost-snapshots.ts — PR-045 · D-096
 *
 * Computa, persiste e carrega snapshots diários de custo estimado por
 * provider externo. Backbone do dashboard `/admin/custos`.
 *
 * Camadas:
 *   1. Helpers puros (estimateXxxCost, dailyShareOfMonthly, anomaly
 *      detector, formatters) — 100% testáveis, sem IO.
 *   2. Orchestrator `computeDailySnapshot` — bate em tabelas internas
 *      (`appointment_notifications`, `payments`, etc.) e produz array
 *      pronto pra upsert.
 *   3. `upsertSnapshots` — UPSERT idempotente em `cost_snapshots`.
 *   4. `loadCostDashboard` — agrega para a UI: mês corrente, mês
 *      anterior, série diária 30d, detecção de anomalias.
 *
 * Princípios de design:
 *   - Estimativas, não fatura. UI deixa explícito ("estimativa").
 *   - Idempotência: re-rodar pro mesmo dia é OK, atualiza estimated_cents.
 *   - Defensivo: erros parciais (ex.: WA falhou contar) não quebram o
 *     cron — registra `metadata.errors` e segue com os outros providers.
 *   - Sem cache em module scope: rates lidas a cada chamada, env
 *     muda e próxima execução já reflete.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type CostRatesSnapshot,
  snapshotCostRates,
} from "./cost-rates";
import { logger } from "./logger";

const log = logger.with({ mod: "cost-snapshots" });

// ──────────────────────────────────────────────────────────────────────────
// Tipos públicos
// ──────────────────────────────────────────────────────────────────────────

export const PROVIDERS = [
  "asaas",
  "whatsapp",
  "daily",
  "vercel",
  "supabase",
] as const;

export type Provider = (typeof PROVIDERS)[number];

export type NewSnapshot = {
  snapshot_date: string; // YYYY-MM-DD UTC
  provider: Provider;
  units: number;
  unit_label: string;
  estimated_cents: number;
  metadata: Record<string, unknown>;
};

export type CostSnapshotRow = NewSnapshot & {
  id: string;
  computed_at: string;
  created_at: string;
};

// ──────────────────────────────────────────────────────────────────────────
// Helpers puros — formatação e datas
// ──────────────────────────────────────────────────────────────────────────

/**
 * Formata centavos BRL como "R$ 1.234,56".
 *
 * Determinístico (locale forçado), pra UI consistente independente
 * do servidor. Aceita negativo (não esperado em cost_snapshots, mas
 * UI usa pra deltas).
 */
export function centsToBRL(cents: number): string {
  if (!Number.isFinite(cents)) return "R$ —";
  const reais = cents / 100;
  // Intl.NumberFormat usa NBSP (\u00A0) entre "R$" e dígitos. Normalizamos
  // pra espaço normal: simplifica testes determinísticos e copy-paste,
  // sem perda de fidelidade visual.
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
    .format(reais)
    .replace(/\u00A0/g, " ");
}

/**
 * "YYYY-MM-DD" UTC do timestamp ISO (ou Date).
 *
 * Operação puramente de string/getters — não toca timezone do servidor.
 */
export function utcDateStringOf(input: Date | string): string {
  const d = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) {
    throw new Error(`utcDateStringOf: invalid date input: ${String(input)}`);
  }
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Range UTC [start, end) cobrindo o dia inteiro.
 * Útil pra `WHERE created_at >= fromIso AND created_at < toIso`.
 */
export function dateRangeForUtcDay(dateStr: string): {
  fromIso: string;
  toIso: string;
} {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`dateRangeForUtcDay: invalid date format: ${dateStr}`);
  }
  const from = new Date(`${dateStr}T00:00:00.000Z`);
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
}

/** YYYY-MM do timestamp ou date string. */
export function utcMonthStringOf(input: Date | string): string {
  return utcDateStringOf(input).slice(0, 7);
}

/** Número de dias do mês (1=jan...12=dez). */
export function daysInUtcMonth(year: number, month: number): number {
  if (month < 1 || month > 12) {
    throw new Error(`daysInUtcMonth: invalid month ${month}`);
  }
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Mês anterior (year, month) — month é 1-12. */
export function previousMonth(year: number, month: number): {
  year: number;
  month: number;
} {
  if (month < 1 || month > 12) {
    throw new Error(`previousMonth: invalid month ${month}`);
  }
  if (month === 1) return { year: year - 1, month: 12 };
  return { year, month: month - 1 };
}

/** Range UTC [from, to) cobrindo o mês inteiro. */
export function monthRangeUtc(year: number, month: number): {
  fromDate: string;
  toDate: string;
} {
  if (month < 1 || month > 12) {
    throw new Error(`monthRangeUtc: invalid month ${month}`);
  }
  const fromDate = `${year}-${month.toString().padStart(2, "0")}-01`;
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
  const toDate = `${next.y}-${next.m.toString().padStart(2, "0")}-01`;
  return { fromDate, toDate };
}

/**
 * Cota diária de um custo mensal fixo (Vercel/Supabase).
 *
 * Divisão exata por dias-no-mês. Soma de 30 dias dá ≈ valor mensal
 * (com erro de centavo por arredondamento — aceito).
 */
export function dailyShareOfMonthly(
  monthlyCents: number,
  dateStr: string
): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`dailyShareOfMonthly: invalid date: ${dateStr}`);
  }
  const [yStr, mStr] = dateStr.split("-");
  const year = Number.parseInt(yStr, 10);
  const month = Number.parseInt(mStr, 10);
  const days = daysInUtcMonth(year, month);
  return Math.max(0, Math.round(monthlyCents / days));
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers puros — estimativa de custo
// ──────────────────────────────────────────────────────────────────────────

export type AsaasEstimate = {
  totalCents: number;
  breakdown: {
    transactions: number;
    grossCents: number;
    feeFixedCents: number;
    feePctCents: number;
  };
};

/**
 * Custo Asaas = N × fixo + soma_amount × bps / 10000.
 *
 * - `transactions` = nº de payments criados no dia (count).
 * - `grossCents` = soma de `amount_cents` desses payments.
 * - Fee é a soma dos dois componentes.
 */
export function estimateAsaasCostCents(args: {
  transactions: number;
  grossCents: number;
  rates: Pick<
    CostRatesSnapshot,
    "asaas_fee_fixed_cents" | "asaas_fee_pct_bps"
  >;
}): AsaasEstimate {
  const transactions = Math.max(0, Math.floor(args.transactions));
  const grossCents = Math.max(0, Math.floor(args.grossCents));

  const feeFixedCents = transactions * args.rates.asaas_fee_fixed_cents;
  // bps = basis points = 1/10000. Round to nearest cent.
  const feePctCents = Math.round(
    (grossCents * args.rates.asaas_fee_pct_bps) / 10000
  );
  const totalCents = feeFixedCents + feePctCents;

  return {
    totalCents,
    breakdown: {
      transactions,
      grossCents,
      feeFixedCents,
      feePctCents,
    },
  };
}

export type WaEstimate = {
  totalCents: number;
  breakdown: {
    appointment_msgs: number;
    doctor_msgs: number;
    on_demand_msgs: number;
    total_msgs: number;
  };
};

/**
 * Custo WhatsApp = total × cents/msg.
 *
 * Quebra em 3 fontes pra forensics — quando spike, dashboard mostra
 * de onde veio.
 */
export function estimateWaCostCents(args: {
  appointment_msgs: number;
  doctor_msgs: number;
  on_demand_msgs: number;
  rates: Pick<CostRatesSnapshot, "wa_cents_per_message">;
}): WaEstimate {
  const a = Math.max(0, Math.floor(args.appointment_msgs));
  const d = Math.max(0, Math.floor(args.doctor_msgs));
  const o = Math.max(0, Math.floor(args.on_demand_msgs));
  const total = a + d + o;
  return {
    totalCents: total * args.rates.wa_cents_per_message,
    breakdown: {
      appointment_msgs: a,
      doctor_msgs: d,
      on_demand_msgs: o,
      total_msgs: total,
    },
  };
}

export type DailyEstimate = {
  totalCents: number;
  breakdown: {
    rooms: number;
    totalMinutes: number;
    avgMinutesPerRoom: number;
  };
};

/**
 * Custo Daily.co = totalMinutes × cents/min.
 *
 * `totalMinutes` é a soma dos `consultation_minutes` de cada appointment
 * concluído. Não modela multi-participant — assumimos 1 participante
 * (default conservador, operador ajusta env se observar).
 */
export function estimateDailyCostCents(args: {
  rooms: number;
  totalMinutes: number;
  rates: Pick<CostRatesSnapshot, "daily_cents_per_minute">;
}): DailyEstimate {
  const rooms = Math.max(0, Math.floor(args.rooms));
  const totalMinutes = Math.max(0, Math.floor(args.totalMinutes));
  const avgMinutesPerRoom = rooms > 0 ? Math.round(totalMinutes / rooms) : 0;
  return {
    totalCents: totalMinutes * args.rates.daily_cents_per_minute,
    breakdown: {
      rooms,
      totalMinutes,
      avgMinutesPerRoom,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Detecção de anomalias
// ──────────────────────────────────────────────────────────────────────────

export type AnomalyDetection = {
  isAnomaly: boolean;
  latestCents: number;
  baselineCents: number;
  ratio: number; // 0 quando baseline=0 e latest=0; Infinity quando baseline=0 e latest>0
};

/**
 * Detecta se o último ponto é anômalo (pico) comparado à média móvel
 * dos `windowDays` anteriores (não inclui o último ponto).
 *
 * Regras:
 *   - `series` é ordenada cronologicamente, último é o "hoje".
 *   - Anomalia = latest > baseline × `factor` E latest > `minCentsTrigger`.
 *     `minCentsTrigger` evita falso positivo "0 → 5 centavos = 5x" em
 *     providers de uso baixo.
 *   - Quando série tem menos de `windowDays + 1` pontos, retorna não-
 *     anomalia (não há baseline confiável).
 *   - Quando baseline=0 e latest>0, ratio=Infinity mas só sinalizamos
 *     anomalia se latest > minCentsTrigger.
 *
 * Defaults: factor=2 (custo dobrou), windowDays=7, minCentsTrigger=100
 * (R$ 1,00 — abaixo disso não vale alertar mesmo com pico relativo).
 */
export function detectCostAnomaly(args: {
  series: number[]; // centavos diários, ordem cronológica
  factor?: number;
  windowDays?: number;
  minCentsTrigger?: number;
}): AnomalyDetection {
  const factor = args.factor ?? 2;
  const windowDays = args.windowDays ?? 7;
  const minCentsTrigger = args.minCentsTrigger ?? 100;
  const series = args.series;

  if (series.length < windowDays + 1) {
    const latestCents = series.length > 0 ? series[series.length - 1] : 0;
    return {
      isAnomaly: false,
      latestCents,
      baselineCents: 0,
      ratio: 0,
    };
  }

  const latestCents = series[series.length - 1];
  const window = series.slice(-1 - windowDays, -1); // últimas N antes de hoje
  const sum = window.reduce((acc, n) => acc + (Number.isFinite(n) ? n : 0), 0);
  const baselineCents = Math.round(sum / window.length);

  let ratio: number;
  if (baselineCents === 0) {
    ratio = latestCents === 0 ? 0 : Number.POSITIVE_INFINITY;
  } else {
    ratio = latestCents / baselineCents;
  }

  const isAnomaly =
    latestCents > minCentsTrigger &&
    (baselineCents === 0
      ? latestCents > minCentsTrigger
      : ratio >= factor);

  return { isAnomaly, latestCents, baselineCents, ratio };
}

// ──────────────────────────────────────────────────────────────────────────
// Orchestrator: compute daily snapshot
// ──────────────────────────────────────────────────────────────────────────

/**
 * Compila um snapshot completo (5 providers) pro dia `date`.
 *
 * Retorna array de `NewSnapshot` pronto pra `upsertSnapshots`.
 * Erros parciais (ex.: query do Asaas falhou) ficam em
 * `metadata.error_message` daquele provider, com `units=0` e
 * `estimated_cents=0` — o dashboard sinaliza visualmente.
 */
export async function computeDailySnapshot(
  supabase: SupabaseClient,
  args: { date: string }
): Promise<NewSnapshot[]> {
  const { date } = args;
  const { fromIso, toIso } = dateRangeForUtcDay(date);
  const rates = snapshotCostRates();

  const out: NewSnapshot[] = [];

  // ── WhatsApp ───────────────────────────────────────────────────────
  // 3 fontes de mensagens enviadas com `sent_at` ou `dispatched_at` no dia.
  let waApptCount = 0;
  let waDoctorCount = 0;
  let waOnDemandCount = 0;
  let waError: string | null = null;
  try {
    const [a, d, o] = await Promise.all([
      supabase
        .from("appointment_notifications")
        .select("id", { count: "exact", head: true })
        .gte("sent_at", fromIso)
        .lt("sent_at", toIso)
        .eq("channel", "whatsapp"),
      supabase
        .from("doctor_notifications")
        .select("id", { count: "exact", head: true })
        .gte("sent_at", fromIso)
        .lt("sent_at", toIso),
      supabase
        .from("on_demand_request_dispatches")
        .select("id", { count: "exact", head: true })
        .gte("dispatched_at", fromIso)
        .lt("dispatched_at", toIso)
        .eq("dispatch_status", "sent"),
    ]);

    if (a.error) throw a.error;
    if (d.error) throw d.error;
    if (o.error) throw o.error;

    waApptCount = a.count ?? 0;
    waDoctorCount = d.count ?? 0;
    waOnDemandCount = o.count ?? 0;
  } catch (e) {
    waError = e instanceof Error ? e.message : String(e);
    log.warn("wa snapshot query failed", { date, err: waError });
  }
  const wa = estimateWaCostCents({
    appointment_msgs: waApptCount,
    doctor_msgs: waDoctorCount,
    on_demand_msgs: waOnDemandCount,
    rates,
  });
  out.push({
    snapshot_date: date,
    provider: "whatsapp",
    units: wa.breakdown.total_msgs,
    unit_label: "mensagens",
    estimated_cents: waError ? 0 : wa.totalCents,
    metadata: {
      breakdown: wa.breakdown,
      rate_cents_per_message: rates.wa_cents_per_message,
      ...(waError ? { error_message: waError } : {}),
    },
  });

  // ── Asaas ──────────────────────────────────────────────────────────
  // Conta payments criados no dia (independente do status — fee Asaas
  // é cobrada na criação da cobrança? Não: Asaas só cobra quando paga.
  // Mas amount_cents é o que paga; vamos contar status pago/recebido
  // pra estimativa mais próxima da realidade fee real).
  let asaasTransactions = 0;
  let asaasGrossCents = 0;
  let asaasError: string | null = null;
  try {
    const { data, error } = await supabase
      .from("payments")
      .select("amount_cents,status,paid_at,created_at")
      .gte("created_at", fromIso)
      .lt("created_at", toIso);
    if (error) throw error;
    const rows = (data ?? []) as Array<{
      amount_cents: number;
      status: string;
      paid_at: string | null;
    }>;
    for (const r of rows) {
      if (
        r.status === "RECEIVED" ||
        r.status === "CONFIRMED" ||
        r.status === "RECEIVED_IN_CASH"
      ) {
        asaasTransactions += 1;
        asaasGrossCents += Number(r.amount_cents) || 0;
      }
    }
  } catch (e) {
    asaasError = e instanceof Error ? e.message : String(e);
    log.warn("asaas snapshot query failed", { date, err: asaasError });
  }
  const asaas = estimateAsaasCostCents({
    transactions: asaasTransactions,
    grossCents: asaasGrossCents,
    rates,
  });
  out.push({
    snapshot_date: date,
    provider: "asaas",
    units: asaas.breakdown.transactions,
    unit_label: "transações",
    estimated_cents: asaasError ? 0 : asaas.totalCents,
    metadata: {
      breakdown: asaas.breakdown,
      rate_fee_fixed_cents: rates.asaas_fee_fixed_cents,
      rate_fee_pct_bps: rates.asaas_fee_pct_bps,
      ...(asaasError ? { error_message: asaasError } : {}),
    },
  });

  // ── Daily ──────────────────────────────────────────────────────────
  // Conta appointments concluídas no dia × duração (proxy de
  // minutos consumidos em sala Daily).
  let dailyRooms = 0;
  let dailyTotalMinutes = 0;
  let dailyError: string | null = null;
  try {
    const { data, error } = await supabase
      .from("appointments")
      .select("consultation_minutes,status,scheduled_at")
      .gte("scheduled_at", fromIso)
      .lt("scheduled_at", toIso)
      .eq("status", "completed");
    if (error) throw error;
    const rows = (data ?? []) as Array<{
      consultation_minutes: number | null;
    }>;
    dailyRooms = rows.length;
    for (const r of rows) {
      const mins = Number(r.consultation_minutes);
      dailyTotalMinutes += Number.isFinite(mins) && mins > 0 ? mins : 30;
    }
  } catch (e) {
    dailyError = e instanceof Error ? e.message : String(e);
    log.warn("daily snapshot query failed", { date, err: dailyError });
  }
  const daily = estimateDailyCostCents({
    rooms: dailyRooms,
    totalMinutes: dailyTotalMinutes,
    rates,
  });
  out.push({
    snapshot_date: date,
    provider: "daily",
    units: daily.breakdown.totalMinutes,
    unit_label: "minutos",
    estimated_cents: dailyError ? 0 : daily.totalCents,
    metadata: {
      breakdown: daily.breakdown,
      rate_cents_per_minute: rates.daily_cents_per_minute,
      ...(dailyError ? { error_message: dailyError } : {}),
    },
  });

  // ── Vercel (rateio mensal) ─────────────────────────────────────────
  out.push({
    snapshot_date: date,
    provider: "vercel",
    units: 1,
    unit_label: "dia",
    estimated_cents: dailyShareOfMonthly(rates.vercel_monthly_cents, date),
    metadata: {
      monthly_cents: rates.vercel_monthly_cents,
      note: "rateio do plano mensal fixo",
    },
  });

  // ── Supabase (rateio mensal) ───────────────────────────────────────
  out.push({
    snapshot_date: date,
    provider: "supabase",
    units: 1,
    unit_label: "dia",
    estimated_cents: dailyShareOfMonthly(rates.supabase_monthly_cents, date),
    metadata: {
      monthly_cents: rates.supabase_monthly_cents,
      note: "rateio do plano mensal fixo",
    },
  });

  return out;
}

/**
 * UPSERT idempotente em `cost_snapshots`. Re-runs no mesmo dia
 * sobreescrevem `units`, `estimated_cents`, `metadata` (trigger
 * `cost_snapshots_touch_computed_at` atualiza `computed_at`).
 */
export async function upsertSnapshots(
  supabase: SupabaseClient,
  snapshots: NewSnapshot[]
): Promise<{ inserted: number; updated: number; errors: string[] }> {
  if (snapshots.length === 0) {
    return { inserted: 0, updated: 0, errors: [] };
  }

  const { error, data } = await supabase
    .from("cost_snapshots")
    .upsert(snapshots, { onConflict: "snapshot_date,provider" })
    .select("id, created_at, computed_at");

  if (error) {
    log.error("upsertSnapshots failed", { err: error });
    return { inserted: 0, updated: 0, errors: [error.message] };
  }

  // Heurística (Postgres não diferencia INSERT vs UPDATE em RETURNING):
  // se created_at = computed_at, era insert; caso contrário, update.
  let inserted = 0;
  let updated = 0;
  const rows = (data ?? []) as Array<{
    created_at: string;
    computed_at: string;
  }>;
  for (const r of rows) {
    if (r.created_at === r.computed_at) inserted += 1;
    else updated += 1;
  }
  return { inserted, updated, errors: [] };
}

// ──────────────────────────────────────────────────────────────────────────
// Dashboard loader
// ──────────────────────────────────────────────────────────────────────────

export type ProviderRollup = {
  provider: Provider;
  /** Soma de centavos no mês corrente. */
  currentMonthCents: number;
  /** Soma de centavos no mês anterior (mesmo nº de dias). */
  previousMonthCents: number;
  /** Variação percentual cur vs prev. null quando prev=0. */
  deltaPct: number | null;
  /** Detecção de anomalia no último dia da série. */
  anomaly: AnomalyDetection;
};

export type CostDashboardSeries = {
  /** date YYYY-MM-DD (UTC). Ordenada crescente (mais antigo primeiro). */
  date: string;
  byProvider: Record<Provider, number>;
  totalCents: number;
};

export type CostDashboardReport = {
  /** Janela cobrida pelo loader (em dias). */
  windowDays: number;
  /** YYYY-MM-DD UTC do dia "hoje" usado como referência. */
  todayDate: string;
  /** Totalizador agregado por provider. */
  byProvider: ProviderRollup[];
  /** Série diária pra sparkline. */
  series: CostDashboardSeries[];
  /** Soma do mês corrente, todos providers. */
  currentMonthTotalCents: number;
  /** Soma do mês anterior, todos providers. */
  previousMonthTotalCents: number;
  /** Cota das rates atuais (snapshot pra rodapé da UI). */
  ratesSnapshot: CostRatesSnapshot;
  /** Idade do snapshot mais recente (segundos). null se vazio. */
  freshnessSeconds: number | null;
};

/**
 * Carrega o report inteiro pra UI `/admin/custos`.
 *
 * Janela: últimos `windowDays` (default 30) + mês atual + mês anterior.
 * Computa anomalia por provider sobre a série diária.
 *
 * @param now Override pra testes — defaults `new Date()`.
 */
export async function loadCostDashboard(
  supabase: SupabaseClient,
  args: { windowDays?: number; now?: Date } = {}
): Promise<CostDashboardReport> {
  const windowDays = Math.max(7, args.windowDays ?? 30);
  const now = args.now ?? new Date();
  const todayDate = utcDateStringOf(now);

  const today = new Date(`${todayDate}T00:00:00.000Z`);
  const seriesFromDate = utcDateStringOf(
    new Date(today.getTime() - (windowDays - 1) * 86400000)
  );

  const currentMonthYear = today.getUTCFullYear();
  const currentMonthMonth = today.getUTCMonth() + 1;
  const prev = previousMonth(currentMonthYear, currentMonthMonth);
  const currentMonthRange = monthRangeUtc(currentMonthYear, currentMonthMonth);
  const previousMonthRange = monthRangeUtc(prev.year, prev.month);

  // Carrega tudo o que pode ser relevante (janela ∪ mês atual ∪ mês anterior).
  const earliestDate =
    [seriesFromDate, currentMonthRange.fromDate, previousMonthRange.fromDate]
      .sort()[0];

  const { data, error } = await supabase
    .from("cost_snapshots")
    .select(
      "snapshot_date, provider, units, unit_label, estimated_cents, metadata, computed_at"
    )
    .gte("snapshot_date", earliestDate)
    .lte("snapshot_date", todayDate)
    .order("snapshot_date", { ascending: true });

  if (error) {
    log.error("loadCostDashboard select failed", { err: error });
    throw new Error(`loadCostDashboard: ${error.message}`);
  }

  const rows = (data ?? []) as Array<{
    snapshot_date: string;
    provider: Provider;
    estimated_cents: number;
    computed_at: string;
  }>;

  // Indexa por (date, provider) → cents.
  const byKey = new Map<string, number>();
  let mostRecentComputedAt: string | null = null;
  for (const r of rows) {
    byKey.set(`${r.snapshot_date}|${r.provider}`, r.estimated_cents);
    if (
      mostRecentComputedAt === null ||
      r.computed_at > mostRecentComputedAt
    ) {
      mostRecentComputedAt = r.computed_at;
    }
  }

  // ── Série diária (windowDays) ─────────────────────────────────────
  const series: CostDashboardSeries[] = [];
  for (let i = 0; i < windowDays; i++) {
    const dt = new Date(today.getTime() - (windowDays - 1 - i) * 86400000);
    const dateStr = utcDateStringOf(dt);
    const byProvider: Record<Provider, number> = {
      asaas: 0,
      whatsapp: 0,
      daily: 0,
      vercel: 0,
      supabase: 0,
    };
    let total = 0;
    for (const p of PROVIDERS) {
      const cents = byKey.get(`${dateStr}|${p}`) ?? 0;
      byProvider[p] = cents;
      total += cents;
    }
    series.push({ date: dateStr, byProvider, totalCents: total });
  }

  // ── Rollup por provider ───────────────────────────────────────────
  const byProvider: ProviderRollup[] = PROVIDERS.map((p) => {
    let currentMonthCents = 0;
    let previousMonthCents = 0;
    for (const r of rows) {
      if (r.provider !== p) continue;
      if (
        r.snapshot_date >= currentMonthRange.fromDate &&
        r.snapshot_date < currentMonthRange.toDate
      ) {
        currentMonthCents += r.estimated_cents;
      } else if (
        r.snapshot_date >= previousMonthRange.fromDate &&
        r.snapshot_date < previousMonthRange.toDate
      ) {
        previousMonthCents += r.estimated_cents;
      }
    }
    const deltaPct =
      previousMonthCents === 0
        ? null
        : Math.round(
            ((currentMonthCents - previousMonthCents) / previousMonthCents) *
              100
          );
    const providerSeries = series.map((s) => s.byProvider[p]);
    const anomaly = detectCostAnomaly({ series: providerSeries });
    return {
      provider: p,
      currentMonthCents,
      previousMonthCents,
      deltaPct,
      anomaly,
    };
  });

  const currentMonthTotalCents = byProvider.reduce(
    (acc, r) => acc + r.currentMonthCents,
    0
  );
  const previousMonthTotalCents = byProvider.reduce(
    (acc, r) => acc + r.previousMonthCents,
    0
  );

  let freshnessSeconds: number | null = null;
  if (mostRecentComputedAt) {
    const ms = now.getTime() - new Date(mostRecentComputedAt).getTime();
    freshnessSeconds = Math.max(0, Math.floor(ms / 1000));
  }

  return {
    windowDays,
    todayDate,
    byProvider,
    series,
    currentMonthTotalCents,
    previousMonthTotalCents,
    ratesSnapshot: snapshotCostRates(),
    freshnessSeconds,
  };
}
