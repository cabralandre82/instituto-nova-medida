/**
 * /admin/financeiro — Dashboard financeiro unificado (D-045 · 3.F).
 *
 * Consolida em uma tela as 4 perguntas que o operador solo faz sempre:
 *
 *   1. Quanto entrou este mês? (MTD receita, delta vs. mesmo período
 *      do mês anterior, série diária 30d).
 *   2. Quanto saiu? (payouts confirmed no mês, refunds processados).
 *   3. O que está preso? (payouts draft/approved, refunds pendentes).
 *   4. De onde vem a receita? (breakdown por plano).
 *
 * O cruzamento contábil (antes nesta rota) virou
 * `/admin/financeiro/conciliacao`, linkado no topo.
 */

import Link from "next/link";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  loadFinancialDashboard,
  type DailyPoint,
  type FinancialDashboard,
  type PlanBreakdownRow,
} from "@/lib/financial-dashboard";
import { formatCurrencyBRL, formatDateBR, formatTimeBR } from "@/lib/datetime-br";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ────────────────────────────────────────────────────────────────────────
// Helpers de formatação
// ────────────────────────────────────────────────────────────────────────

function brl(cents: number): string {
  return formatCurrencyBRL(cents);
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function monthLabel(iso: string): string {
  return formatDateBR(iso, { month: "long", year: "numeric" }).toLowerCase();
}

function dayLabel(iso: string): string {
  return formatDateBR(`${iso}T12:00:00.000Z`, {
    day: "2-digit",
    month: "2-digit",
  });
}

// ────────────────────────────────────────────────────────────────────────
// Sparkline SVG inline — zero dependência, responsivo
// ────────────────────────────────────────────────────────────────────────

function Sparkline({
  series,
  height = 48,
}: {
  series: DailyPoint[];
  height?: number;
}) {
  if (series.length < 2) {
    return (
      <div className="text-xs text-ink-400">Dados insuficientes pra plotar.</div>
    );
  }
  const max = Math.max(...series.map((p) => p.totalCents), 1);
  const w = 100; // viewBox x (escala com width:100%)
  const points = series
    .map((p, i) => {
      const x = (i / (series.length - 1)) * w;
      const y = height - (p.totalCents / max) * (height - 4) - 2;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  const areaPoints = `0,${height} ${points} ${w},${height}`;
  return (
    <svg
      viewBox={`0 0 ${w} ${height}`}
      preserveAspectRatio="none"
      width="100%"
      height={height}
      aria-hidden="true"
    >
      <polygon points={areaPoints} fill="currentColor" opacity={0.1} />
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.2}
      />
    </svg>
  );
}

// ────────────────────────────────────────────────────────────────────────
// UI helpers
// ────────────────────────────────────────────────────────────────────────

function DeltaBadge({ pct }: { pct: number | null }) {
  if (pct === null) {
    return (
      <span className="text-xs text-ink-500">sem base pra comparar</span>
    );
  }
  const positive = pct >= 0;
  const cls = positive
    ? "text-sage-700 bg-sage-50 border-sage-200"
    : "text-terracotta-700 bg-terracotta-50 border-terracotta-200";
  return (
    <span
      className={`inline-flex items-center text-[0.72rem] font-medium px-2 py-0.5 rounded-full border ${cls}`}
    >
      {positive ? "↑" : "↓"} {Math.abs(pct)}% vs. mesmo período do mês anterior
    </span>
  );
}

function Card({
  label,
  value,
  hint,
  tone,
  children,
}: {
  label: string;
  value: string;
  hint?: string;
  tone: "sage" | "terracotta" | "ink" | "cream";
  children?: React.ReactNode;
}) {
  const toneClasses = {
    sage: "border-sage-200 bg-sage-50 text-sage-800",
    terracotta: "border-terracotta-200 bg-terracotta-50 text-terracotta-700",
    ink: "border-ink-100 bg-white text-ink-800",
    cream: "border-cream-300 bg-cream-100 text-ink-800",
  }[tone];
  return (
    <div className={`rounded-2xl border p-5 ${toneClasses}`}>
      <p className="text-[0.72rem] uppercase tracking-[0.14em] text-ink-500 font-medium mb-2">
        {label}
      </p>
      <p className="font-serif text-[1.6rem] leading-none">{value}</p>
      {hint && <p className="mt-2 text-xs text-ink-500">{hint}</p>}
      {children}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Seções
// ────────────────────────────────────────────────────────────────────────

function RevenueHero({ d }: { d: FinancialDashboard }) {
  return (
    <section className="rounded-2xl border border-ink-100 bg-white p-6 mb-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3 mb-2">
        <div>
          <p className="text-[0.72rem] uppercase tracking-[0.14em] text-ink-500 font-medium">
            Receita MTD · {monthLabel(d.window.currentMonthStart)}
          </p>
          <p className="font-serif text-[2.2rem] leading-none text-ink-900 mt-1">
            {brl(d.revenue.mtd.totalCents)}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <DeltaBadge pct={d.revenue.deltaPct} />
            <span className="text-xs text-ink-500">
              · {d.revenue.mtd.count} pagamento{d.revenue.mtd.count === 1 ? "" : "s"}
            </span>
          </div>
        </div>
        <div className="text-right">
          <p className="text-xs text-ink-500 mb-1">
            Últimos {d.window.rangeDays} dias
          </p>
          <div className="w-44 sm:w-64 text-sage-700">
            <Sparkline series={d.dailySeries} />
          </div>
          <p className="text-[0.68rem] text-ink-400 mt-1">
            {dayLabel(d.window.seriesStart)} → {dayLabel(d.dailySeries[d.dailySeries.length - 1]?.date ?? d.window.seriesStart)}
          </p>
        </div>
      </div>
    </section>
  );
}

function CashFlow({ d }: { d: FinancialDashboard }) {
  const net = d.outflow.netMtd;
  const netTone: "sage" | "terracotta" = net >= 0 ? "sage" : "terracotta";
  return (
    <section className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
      <Card
        label="Saída: repasses médicas (MTD)"
        value={brl(d.outflow.payoutsMtd.totalCents)}
        hint={`${d.outflow.payoutsMtd.count} payout${d.outflow.payoutsMtd.count === 1 ? "" : "s"} confirmado${d.outflow.payoutsMtd.count === 1 ? "" : "s"}`}
        tone="ink"
      />
      <Card
        label="Refunds processados (MTD)"
        value={String(d.outflow.refundsMtd.count)}
        hint={
          d.outflow.refundsMtd.count === 0
            ? "nenhum refund neste mês"
            : "valor depende do payment original"
        }
        tone="ink"
      />
      <Card
        label={net >= 0 ? "Líquido (MTD)" : "Déficit (MTD)"}
        value={brl(net)}
        hint={
          net >= 0
            ? "receita − repasses confirmadas"
            : "saídas excedem receita no mês"
        }
        tone={netTone}
      />
    </section>
  );
}

function PendingBlock({ d }: { d: FinancialDashboard }) {
  const anyPending =
    d.pending.payoutsDraft.count > 0 ||
    d.pending.payoutsApproved.count > 0 ||
    d.pending.refundsRequired.count > 0;

  return (
    <section className="mb-6">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="font-serif text-[1.3rem] text-ink-800">Pendências financeiras</h2>
        {!anyPending && (
          <span className="text-xs text-sage-700">nada a resolver agora</span>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card
          label="Payouts em draft"
          value={brl(d.pending.payoutsDraft.totalCents)}
          hint={`${d.pending.payoutsDraft.count} lote${d.pending.payoutsDraft.count === 1 ? "" : "s"} aguardando revisão`}
          tone={d.pending.payoutsDraft.count > 0 ? "cream" : "ink"}
        >
          {d.pending.payoutsDraft.count > 0 && (
            <Link
              href="/admin/payouts"
              className="mt-3 inline-flex text-xs font-medium text-ink-700 hover:text-ink-900 underline underline-offset-2"
            >
              Revisar →
            </Link>
          )}
        </Card>
        <Card
          label="Payouts aprovados"
          value={brl(d.pending.payoutsApproved.totalCents)}
          hint={`${d.pending.payoutsApproved.count} aguardando PIX`}
          tone={d.pending.payoutsApproved.count > 0 ? "cream" : "ink"}
        >
          {d.pending.payoutsApproved.count > 0 && (
            <Link
              href="/admin/payouts?status=approved"
              className="mt-3 inline-flex text-xs font-medium text-ink-700 hover:text-ink-900 underline underline-offset-2"
            >
              Enviar PIX →
            </Link>
          )}
        </Card>
        <Card
          label="Refunds pendentes"
          value={String(d.pending.refundsRequired.count)}
          hint={
            d.pending.refundsRequired.count === 0
              ? "tudo processado"
              : "no-show gerou direito a estorno"
          }
          tone={d.pending.refundsRequired.count > 0 ? "terracotta" : "ink"}
        >
          {d.pending.refundsRequired.count > 0 && (
            <Link
              href="/admin/refunds"
              className="mt-3 inline-flex text-xs font-medium text-terracotta-700 hover:text-terracotta-900 underline underline-offset-2"
            >
              Processar →
            </Link>
          )}
        </Card>
      </div>
    </section>
  );
}

function PlanBreakdown({ rows }: { rows: PlanBreakdownRow[] }) {
  if (rows.length === 0) {
    return (
      <section className="mb-6 rounded-2xl border border-ink-100 bg-white p-6">
        <h2 className="font-serif text-[1.3rem] text-ink-800 mb-1">Receita por plano</h2>
        <p className="text-sm text-ink-500">
          Nenhum pagamento confirmado este mês ainda.
        </p>
      </section>
    );
  }

  return (
    <section className="mb-6 rounded-2xl border border-ink-100 bg-white overflow-hidden">
      <div className="px-5 py-4 border-b border-ink-100">
        <h2 className="font-serif text-[1.3rem] text-ink-800">Receita por plano (MTD)</h2>
      </div>
      <ul className="divide-y divide-ink-100">
        {rows.map((r) => (
          <li
            key={r.planId ?? `__no_plan__`}
            className="px-5 py-3 flex items-center gap-4"
          >
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-ink-800 truncate">
                {r.planName}
              </p>
              <div className="mt-1 h-1.5 rounded-full bg-ink-50 overflow-hidden">
                <div
                  className="h-full bg-sage-500"
                  style={{ width: `${Math.max(2, r.share * 100).toFixed(1)}%` }}
                />
              </div>
            </div>
            <div className="text-right shrink-0">
              <p className="font-mono text-sm text-ink-800">
                {brl(r.totalCents)}
              </p>
              <p className="text-[0.72rem] text-ink-500">
                {r.count} · {pct(r.share)}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Page
// ────────────────────────────────────────────────────────────────────────

export default async function FinanceiroPage() {
  const supabase = getSupabaseAdmin();
  const dashboard = await loadFinancialDashboard(supabase);

  return (
    <div>
      <header className="mb-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
              Financeiro
            </p>
            <h1 className="font-serif text-[1.85rem] sm:text-[2.2rem] leading-tight text-ink-800">
              Visão do mês
            </h1>
          </div>
          <Link
            href="/admin/financeiro/conciliacao"
            className="inline-flex items-center text-sm font-medium text-ink-700 hover:text-ink-900 underline underline-offset-2"
          >
            Rodar conciliação contábil →
          </Link>
        </div>
        <p className="mt-2 text-ink-500 max-w-2xl">
          Receita confirmada, saídas, pendências e mix de planos —
          atualizado a cada request (snapshot de {formatTimeBR(dashboard.generatedAt)}).
        </p>
      </header>

      <RevenueHero d={dashboard} />
      <CashFlow d={dashboard} />
      <PendingBlock d={dashboard} />
      <PlanBreakdown rows={dashboard.revenue.byPlan} />
    </div>
  );
}
