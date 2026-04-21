/**
 * src/lib/financial-dashboard.ts — D-045 · 3.F
 *
 * Dashboard financeiro unificado pro operador solo. Agrega em uma
 * chamada:
 *
 *   - **Receita MTD** (payments CONFIRMED/RECEIVED do mês corrente),
 *     count, breakdown por plano.
 *   - **Receita do mês anterior** (mesma janela do mês passado) pra
 *     comparação %.
 *   - **Série diária** dos últimos `rangeDays` (default 30) pra
 *     sparkline — cobre tanto mês corrente quanto começo do anterior.
 *   - **Saídas MTD** (payouts `confirmed` no mês, refunds processados).
 *   - **Pendências** com custo financeiro (payouts draft/approved,
 *     refunds ainda não processados).
 *
 * Princípios:
 *   - Lib PURA de lógica; só I/O é Supabase.
 *   - Todos os números em centavos (evita float drift).
 *   - Toda contagem usa status canônico existente — NÃO inventamos
 *     novos estados.
 *   - Performance: busca tudo em paralelo com `Promise.all`, cap
 *     razoável em queries que poderiam explodir (sumários agregados
 *     do lado do app, não no banco — é barato por volumes realistas).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// ────────────────────────────────────────────────────────────────────────
// Tipos
// ────────────────────────────────────────────────────────────────────────

export type Bucket = {
  count: number;
  totalCents: number;
};

export type PlanBreakdownRow = {
  planId: string | null;
  planName: string;
  count: number;
  totalCents: number;
  /** Participação no total da janela, 0-1. */
  share: number;
};

export type DailyPoint = {
  /** ISO `YYYY-MM-DD` no fuso UTC (simplifica comparação; exibição converte). */
  date: string;
  count: number;
  totalCents: number;
};

export type FinancialDashboard = {
  generatedAt: string;
  window: {
    /** Primeiro instante do mês corrente (UTC). */
    currentMonthStart: string;
    /** Primeiro instante do mês anterior (UTC). */
    priorMonthStart: string;
    /** Início da série diária (= now - rangeDays, UTC). */
    seriesStart: string;
    rangeDays: number;
  };
  revenue: {
    mtd: Bucket;
    priorSamePeriod: Bucket;
    /** Delta % de `mtd` vs. `priorSamePeriod`. `null` quando prior=0. */
    deltaPct: number | null;
    byPlan: PlanBreakdownRow[];
  };
  outflow: {
    payoutsMtd: Bucket;
    refundsMtd: Bucket;
    /** Receita MTD - saídas MTD. Pode ser negativo. */
    netMtd: number;
  };
  pending: {
    refundsRequired: Bucket;
    payoutsDraft: Bucket;
    payoutsApproved: Bucket;
  };
  /** Série diária (exatamente `rangeDays` pontos, zero-filled). */
  dailySeries: DailyPoint[];
};

export type LoadFinancialDashboardOptions = {
  now?: Date;
  rangeDays?: number;
};

// ────────────────────────────────────────────────────────────────────────
// Helpers puros
// ────────────────────────────────────────────────────────────────────────

function startOfUtcDay(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function startOfUtcMonth(date: Date): Date {
  const d = startOfUtcDay(date);
  d.setUTCDate(1);
  return d;
}

function addUtcMonths(date: Date, diff: number): Date {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + diff);
  return d;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Delta percentual arredondado pra inteiro. Convenções:
 *   - prior = 0 e current > 0 → null (infinito; UI mostra "novo").
 *   - prior = 0 e current = 0 → null (sem dado pra comparar).
 *   - current < prior → negativo.
 */
export function pctDelta(current: number, prior: number): number | null {
  if (prior === 0) return null;
  return Math.round(((current - prior) / prior) * 100);
}

/**
 * Preenche uma série diária com zeros pros dias sem transação.
 * Inputs: registros já agrupados (mapa date→bucket) + intervalo.
 */
export function fillDailySeries(
  start: Date,
  rangeDays: number,
  byDate: Map<string, Bucket>
): DailyPoint[] {
  const out: DailyPoint[] = [];
  const s = startOfUtcDay(start);
  for (let i = 0; i < rangeDays; i++) {
    const day = new Date(s.getTime() + i * 24 * 60 * 60 * 1000);
    const key = isoDate(day);
    const b = byDate.get(key);
    out.push({
      date: key,
      count: b?.count ?? 0,
      totalCents: b?.totalCents ?? 0,
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────
// Tipos dos rows brutos (PostgREST)
// ────────────────────────────────────────────────────────────────────────

type PaymentRow = {
  amount_cents: number;
  paid_at: string | null;
  created_at: string;
  plan_id: string | null;
  plans: { id: string; name: string } | { id: string; name: string }[] | null;
};

type PayoutRow = {
  amount_cents: number;
  paid_at: string | null;
  status: string;
};

type RefundRow = {
  refund_processed_at: string | null;
  refund_required: boolean | null;
};

// ────────────────────────────────────────────────────────────────────────
// Funções de agregação puras
// ────────────────────────────────────────────────────────────────────────

function normalizePlan(
  plans: PaymentRow["plans"]
): { id: string; name: string } | null {
  if (!plans) return null;
  if (Array.isArray(plans)) return plans[0] ?? null;
  return plans;
}

/**
 * Reduce payments por plano, ordenado desc por total.
 * Exportada pra ser testável em unidade.
 */
export function aggregateByPlan(rows: PaymentRow[]): PlanBreakdownRow[] {
  const map = new Map<string, { planId: string | null; planName: string; count: number; totalCents: number }>();
  let grandTotal = 0;

  for (const r of rows) {
    const plan = normalizePlan(r.plans);
    const key = plan?.id ?? "__no_plan__";
    const name = plan?.name ?? "Sem plano associado";
    const entry = map.get(key) ?? {
      planId: plan?.id ?? null,
      planName: name,
      count: 0,
      totalCents: 0,
    };
    entry.count += 1;
    entry.totalCents += r.amount_cents ?? 0;
    grandTotal += r.amount_cents ?? 0;
    map.set(key, entry);
  }

  const arr = Array.from(map.values()).map((e) => ({
    ...e,
    share: grandTotal === 0 ? 0 : e.totalCents / grandTotal,
  }));

  arr.sort((a, b) => b.totalCents - a.totalCents);
  return arr;
}

/** Reduz uma lista de payments em Bucket (count + total). */
export function bucket(rows: Array<{ amount_cents: number }>): Bucket {
  return rows.reduce<Bucket>(
    (acc, r) => {
      acc.count += 1;
      acc.totalCents += r.amount_cents ?? 0;
      return acc;
    },
    { count: 0, totalCents: 0 }
  );
}

/** Agrupa payments por dia (UTC) usando `paid_at` como referência. */
export function groupByUtcDay(
  rows: Array<{ amount_cents: number; paid_at: string | null }>
): Map<string, Bucket> {
  const out = new Map<string, Bucket>();
  for (const r of rows) {
    if (!r.paid_at) continue;
    const key = r.paid_at.slice(0, 10);
    const cur = out.get(key) ?? { count: 0, totalCents: 0 };
    cur.count += 1;
    cur.totalCents += r.amount_cents ?? 0;
    out.set(key, cur);
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────
// Carregador principal
// ────────────────────────────────────────────────────────────────────────

export async function loadFinancialDashboard(
  supabase: SupabaseClient,
  options: LoadFinancialDashboardOptions = {}
): Promise<FinancialDashboard> {
  const now = options.now ?? new Date();
  const rangeDays = Math.max(7, Math.min(options.rangeDays ?? 30, 180));

  const currentMonthStart = startOfUtcMonth(now);
  const priorMonthStart = addUtcMonths(currentMonthStart, -1);
  const seriesStart = new Date(
    startOfUtcDay(now).getTime() - (rangeDays - 1) * 24 * 60 * 60 * 1000
  );

  // Pra "prior same period", pegamos do início do mês anterior até
  // a mesma posição no mês (ex: hoje dia 15 → mês anterior dia 1 a 15).
  // Isso evita comparar mês completo vs. mês parcial.
  const priorSamePeriodEnd = new Date(priorMonthStart);
  priorSamePeriodEnd.setUTCDate(now.getUTCDate());
  priorSamePeriodEnd.setUTCHours(
    now.getUTCHours(),
    now.getUTCMinutes(),
    now.getUTCSeconds(),
    now.getUTCMilliseconds()
  );

  const [
    paymentsMtdRes,
    paymentsPriorRes,
    paymentsSeriesRes,
    payoutsMtdRes,
    payoutsDraftRes,
    payoutsApprovedRes,
    refundsMtdRes,
    refundsPendingRes,
  ] = await Promise.all([
    supabase
      .from("payments")
      .select("amount_cents, paid_at, created_at, plan_id, plans(id, name)")
      .in("status", ["RECEIVED", "CONFIRMED"])
      .gte("paid_at", currentMonthStart.toISOString())
      .lte("paid_at", now.toISOString()),
    supabase
      .from("payments")
      .select("amount_cents, paid_at, created_at")
      .in("status", ["RECEIVED", "CONFIRMED"])
      .gte("paid_at", priorMonthStart.toISOString())
      .lte("paid_at", priorSamePeriodEnd.toISOString()),
    supabase
      .from("payments")
      .select("amount_cents, paid_at, created_at")
      .in("status", ["RECEIVED", "CONFIRMED"])
      .gte("paid_at", seriesStart.toISOString())
      .lte("paid_at", now.toISOString()),
    supabase
      .from("doctor_payouts")
      .select("amount_cents, paid_at, status")
      .eq("status", "confirmed")
      .gte("paid_at", currentMonthStart.toISOString())
      .lte("paid_at", now.toISOString()),
    supabase
      .from("doctor_payouts")
      .select("amount_cents, status")
      .eq("status", "draft"),
    supabase
      .from("doctor_payouts")
      .select("amount_cents, status")
      .eq("status", "approved"),
    supabase
      .from("appointments")
      .select("id, refund_processed_at, refund_required")
      .eq("refund_required", true)
      .gte("refund_processed_at", currentMonthStart.toISOString())
      .lte("refund_processed_at", now.toISOString()),
    supabase
      .from("appointments")
      .select("id, refund_required, refund_processed_at")
      .eq("refund_required", true)
      .is("refund_processed_at", null),
  ]);

  for (const res of [
    paymentsMtdRes,
    paymentsPriorRes,
    paymentsSeriesRes,
    payoutsMtdRes,
    payoutsDraftRes,
    payoutsApprovedRes,
    refundsMtdRes,
    refundsPendingRes,
  ]) {
    if (res.error) {
      throw new Error(`loadFinancialDashboard: ${res.error.message}`);
    }
  }

  const paymentsMtd = (paymentsMtdRes.data as PaymentRow[] | null) ?? [];
  const paymentsPrior =
    ((paymentsPriorRes.data as unknown) as PaymentRow[] | null) ?? [];
  const paymentsSeries =
    ((paymentsSeriesRes.data as unknown) as PaymentRow[] | null) ?? [];
  const payoutsMtd = (payoutsMtdRes.data as PayoutRow[] | null) ?? [];
  const payoutsDraft = (payoutsDraftRes.data as PayoutRow[] | null) ?? [];
  const payoutsApproved = (payoutsApprovedRes.data as PayoutRow[] | null) ?? [];
  const refundsMtd = (refundsMtdRes.data as RefundRow[] | null) ?? [];
  const refundsPending = (refundsPendingRes.data as RefundRow[] | null) ?? [];

  const mtd = bucket(paymentsMtd);
  const priorSamePeriod = bucket(paymentsPrior);
  const payoutsMtdBucket = bucket(payoutsMtd);
  const payoutsDraftBucket = bucket(payoutsDraft);
  const payoutsApprovedBucket = bucket(payoutsApproved);

  // Refunds: não temos valor canônico por enquanto (deriva do payment
  // da consulta). Representamos só a contagem no count; totalCents=0.
  const refundsMtdBucket: Bucket = {
    count: refundsMtd.length,
    totalCents: 0,
  };
  const refundsPendingBucket: Bucket = {
    count: refundsPending.length,
    totalCents: 0,
  };

  const byDate = groupByUtcDay(paymentsSeries);
  const dailySeries = fillDailySeries(seriesStart, rangeDays, byDate);

  const byPlan = aggregateByPlan(paymentsMtd);

  return {
    generatedAt: now.toISOString(),
    window: {
      currentMonthStart: currentMonthStart.toISOString(),
      priorMonthStart: priorMonthStart.toISOString(),
      seriesStart: seriesStart.toISOString(),
      rangeDays,
    },
    revenue: {
      mtd,
      priorSamePeriod,
      deltaPct: pctDelta(mtd.totalCents, priorSamePeriod.totalCents),
      byPlan,
    },
    outflow: {
      payoutsMtd: payoutsMtdBucket,
      refundsMtd: refundsMtdBucket,
      netMtd: mtd.totalCents - payoutsMtdBucket.totalCents,
    },
    pending: {
      refundsRequired: refundsPendingBucket,
      payoutsDraft: payoutsDraftBucket,
      payoutsApproved: payoutsApprovedBucket,
    },
    dailySeries,
  };
}
