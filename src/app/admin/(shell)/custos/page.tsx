/**
 * /admin/custos — PR-045 · D-096
 *
 * Dashboard de custos estimados por provider externo. Operador solo
 * usa pra detectar drift e picos antes de receber a fatura mensal.
 *
 * Diferença vs `/admin/financeiro`:
 *   - `/admin/financeiro` → faturamento (receita).
 *   - `/admin/custos`     → despesas (provider externo).
 *
 * Diferença vs `/admin/observabilidade`:
 *   - `/admin/observabilidade` → métricas operacionais (TTM, fulfill).
 *   - `/admin/custos`          → métricas financeiras de despesa.
 *
 * Componentes:
 *   1. Resumo do mês (total, delta vs mês anterior, anomalias detectadas)
 *   2. Rollup por provider (mês corrente, delta, anomalia inline)
 *   3. Série diária dos últimos 30 dias com sparkline por provider
 *   4. Rates atualmente em uso (env vars)
 *   5. Disclaimer sobre estimativas
 *
 * Snapshot — sem auto-refresh. Operador recarrega quando precisar.
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { formatDateBR } from "@/lib/datetime-br";
import {
  centsToBRL,
  loadCostDashboard,
  type AnomalyDetection,
  type CostDashboardReport,
  type CostDashboardSeries,
  type Provider,
  type ProviderRollup,
} from "@/lib/cost-snapshots";

const log = logger.with({ route: "/admin/custos" });

export const dynamic = "force-dynamic";

const PROVIDER_LABELS: Record<Provider, string> = {
  asaas: "Asaas (pagamentos)",
  whatsapp: "WhatsApp (Meta)",
  daily: "Daily.co (vídeo)",
  vercel: "Vercel (hosting)",
  supabase: "Supabase (DB + auth)",
};

const PROVIDER_COLORS: Record<Provider, string> = {
  asaas: "#7C9885", // sage-600 ish
  whatsapp: "#3B82AC", // indigo-500 ish
  daily: "#A86C4D", // terracotta-700 ish
  vercel: "#444444", // ink-700
  supabase: "#9B7EBD", // purple
};

export default async function CustosPage() {
  const supabase = getSupabaseAdmin();

  let report: CostDashboardReport;
  try {
    report = await loadCostDashboard(supabase, { windowDays: 30 });
  } catch (e) {
    log.error("loadCostDashboard failed", { err: e });
    return (
      <div>
        <h1 className="font-serif text-[1.85rem] sm:text-[2.2rem] leading-tight text-ink-800 mb-3">
          Custos
        </h1>
        <div className="rounded-xl border border-terracotta-200 bg-terracotta-50/60 px-5 py-6 text-terracotta-800">
          Falha ao carregar relatório. Veja{" "}
          <a className="underline" href="/admin/errors">
            /admin/errors
          </a>{" "}
          ou{" "}
          <a className="underline" href="/admin/crons">
            /admin/crons
          </a>{" "}
          (job <code>cost_snapshot</code>).
        </div>
      </div>
    );
  }

  const totalDeltaPct =
    report.previousMonthTotalCents === 0
      ? null
      : Math.round(
          ((report.currentMonthTotalCents - report.previousMonthTotalCents) /
            report.previousMonthTotalCents) *
            100
        );
  const anomalies = report.byProvider.filter((p) => p.anomaly.isAnomaly);
  const today = new Date();

  return (
    <div>
      <header className="mb-6">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Custos estimados
        </p>
        <h1 className="font-serif text-[1.85rem] sm:text-[2.2rem] leading-tight text-ink-800">
          Despesas por provider
        </h1>
        <p className="text-ink-500 text-sm mt-1.5 max-w-2xl">
          Estimativas computadas diariamente pelo cron{" "}
          <a
            href="/admin/crons"
            className="underline decoration-ink-300 hover:decoration-ink-600"
          >
            cost_snapshot
          </a>{" "}
          a partir de uso interno (mensagens, transações, salas Daily, etc.) ×
          rates configuradas em env. Não substitui a fatura real do provider —
          é early-warning.
        </p>
        {report.freshnessSeconds !== null && (
          <p className="text-xs text-ink-400 mt-2">
            Snapshot mais recente:{" "}
            <span className="font-medium text-ink-600">
              {formatFreshness(report.freshnessSeconds)}
            </span>
            . Última atualização em{" "}
            {formatDateBR(today, {
              day: "2-digit",
              month: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })}
            .
          </p>
        )}
      </header>

      {/* ── Resumo do mês ───────────────────────────────────────────── */}
      <section className="mb-8">
        <h2 className="font-serif text-[1.4rem] text-ink-800 mb-3">
          Resumo do mês
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <SummaryCard
            label="Mês corrente"
            value={centsToBRL(report.currentMonthTotalCents)}
            hint={monthLabel(report.todayDate, 0)}
            tone="ink"
          />
          <SummaryCard
            label="Mês anterior"
            value={centsToBRL(report.previousMonthTotalCents)}
            hint={monthLabel(report.todayDate, -1)}
            tone="ink"
          />
          <SummaryCard
            label="Variação vs mês anterior"
            value={formatDelta(totalDeltaPct)}
            hint={
              totalDeltaPct === null
                ? "Sem histórico do mês anterior"
                : "% de mudança no total"
            }
            tone={toneForDelta(totalDeltaPct, 25, 50)}
          />
          <SummaryCard
            label="Picos detectados"
            value={String(anomalies.length)}
            hint={
              anomalies.length === 0
                ? "Nada anômalo nos últimos dias"
                : anomalies.map((a) => PROVIDER_LABELS[a.provider]).join(", ")
            }
            tone={anomalies.length > 0 ? "terracotta" : "sage"}
          />
        </div>
      </section>

      {/* ── Rollup por provider ─────────────────────────────────────── */}
      <section className="mb-8">
        <h2 className="font-serif text-[1.4rem] text-ink-800 mb-3">
          Por provider
        </h2>
        <div className="overflow-x-auto rounded-xl border border-ink-100 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-cream-50 text-ink-500 text-xs uppercase tracking-wider">
              <tr>
                <th className="px-5 py-3 text-left font-medium">Provider</th>
                <th className="px-5 py-3 text-right font-medium">
                  Mês corrente
                </th>
                <th className="px-5 py-3 text-right font-medium">
                  Mês anterior
                </th>
                <th className="px-5 py-3 text-right font-medium">Variação</th>
                <th className="px-5 py-3 text-right font-medium">
                  Sparkline 30d
                </th>
                <th className="px-5 py-3 text-right font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {report.byProvider.map((row) => (
                <ProviderRow
                  key={row.provider}
                  row={row}
                  series={report.series}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Série diária total ──────────────────────────────────────── */}
      <section className="mb-8">
        <h2 className="font-serif text-[1.4rem] text-ink-800 mb-3">
          Série diária — últimos 30 dias
        </h2>
        <p className="text-sm text-ink-500 mb-3">
          Total agregado por dia (todos providers). Gaps representam dias sem
          snapshot — possível indicação de falha do cron, conferir{" "}
          <a
            href="/admin/crons"
            className="underline decoration-ink-300 hover:decoration-ink-600"
          >
            /admin/crons
          </a>
          .
        </p>
        <div className="rounded-xl border border-ink-100 bg-white p-5">
          <DailyTotalChart series={report.series} />
        </div>
      </section>

      {/* ── Rates atuais ────────────────────────────────────────────── */}
      <section className="mb-2">
        <h2 className="font-serif text-[1.4rem] text-ink-800 mb-3">
          Rates em uso
        </h2>
        <p className="text-sm text-ink-500 mb-3 max-w-2xl">
          Os números acima são proxy. Quando a fatura real chegar e divergir,
          ajuste as variáveis de ambiente (Vercel → Settings → Environment
          Variables) e o próximo snapshot do cron já reflete.
        </p>
        <div className="rounded-xl border border-ink-100 bg-cream-50/40 p-5">
          <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 text-sm">
            <RateRow
              label="WhatsApp"
              env="WA_COST_CENTS_PER_MESSAGE"
              valueCents={report.ratesSnapshot.wa_cents_per_message}
              suffix="por mensagem"
            />
            <RateRow
              label="Asaas (fee fixo)"
              env="ASAAS_FEE_FIXED_CENTS"
              valueCents={report.ratesSnapshot.asaas_fee_fixed_cents}
              suffix="por transação"
            />
            <RateRow
              label="Asaas (fee %)"
              env="ASAAS_FEE_PCT_BPS"
              valuePctBps={report.ratesSnapshot.asaas_fee_pct_bps}
              suffix="sobre o gross"
            />
            <RateRow
              label="Daily.co"
              env="DAILY_COST_CENTS_PER_MINUTE"
              valueCents={report.ratesSnapshot.daily_cents_per_minute}
              suffix="por minuto"
            />
            <RateRow
              label="Vercel"
              env="VERCEL_MONTHLY_CENTS"
              valueCents={report.ratesSnapshot.vercel_monthly_cents}
              suffix="por mês (rateado)"
            />
            <RateRow
              label="Supabase"
              env="SUPABASE_MONTHLY_CENTS"
              valueCents={report.ratesSnapshot.supabase_monthly_cents}
              suffix="por mês (rateado)"
            />
          </dl>
        </div>
      </section>

      <footer className="mt-8 text-xs text-ink-400">
        <p>
          Estimativas em centavos BRL. Drift de ±20% comparado a fatura real é
          esperado (FX, IOF, mudança de plano comercial). Quando a fatura
          chegar, atualize as rates pra fechar o ciclo.
        </p>
      </footer>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Componentes
// ──────────────────────────────────────────────────────────────────────

function ProviderRow({
  row,
  series,
}: {
  row: ProviderRollup;
  series: CostDashboardSeries[];
}) {
  const providerSeries = series.map((s) => s.byProvider[row.provider]);
  return (
    <tr>
      <td className="px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: PROVIDER_COLORS[row.provider] }}
            aria-hidden
          />
          <span className="font-medium text-ink-800">
            {PROVIDER_LABELS[row.provider]}
          </span>
        </div>
      </td>
      <td className="px-5 py-4 text-right tabular-nums text-ink-800">
        {centsToBRL(row.currentMonthCents)}
      </td>
      <td className="px-5 py-4 text-right tabular-nums text-ink-500">
        {centsToBRL(row.previousMonthCents)}
      </td>
      <td className="px-5 py-4 text-right tabular-nums">
        <DeltaBadge pct={row.deltaPct} />
      </td>
      <td className="px-5 py-4 text-right">
        <Sparkline
          series={providerSeries}
          color={PROVIDER_COLORS[row.provider]}
        />
      </td>
      <td className="px-5 py-4 text-right">
        <AnomalyBadge anomaly={row.anomaly} />
      </td>
    </tr>
  );
}

function SummaryCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone: "sage" | "amber" | "terracotta" | "ink";
}) {
  const toneClasses = {
    sage: "border-sage-200 bg-sage-50",
    amber: "border-amber-200 bg-amber-50",
    terracotta: "border-terracotta-200 bg-terracotta-50",
    ink: "border-ink-100 bg-white",
  }[tone];
  const valueClasses = {
    sage: "text-sage-800",
    amber: "text-amber-800",
    terracotta: "text-terracotta-700",
    ink: "text-ink-800",
  }[tone];
  return (
    <div className={`rounded-2xl border p-4 ${toneClasses}`}>
      <p className="text-[0.72rem] uppercase tracking-[0.14em] text-ink-500 font-medium mb-2">
        {label}
      </p>
      <p
        className={`font-serif text-[1.55rem] leading-none tabular-nums ${valueClasses}`}
      >
        {value}
      </p>
      <p className="mt-2 text-xs text-ink-500 line-clamp-2">{hint}</p>
    </div>
  );
}

function DeltaBadge({ pct }: { pct: number | null }) {
  if (pct === null) {
    return <span className="text-ink-400 text-sm">—</span>;
  }
  const tone =
    pct >= 50
      ? "bg-terracotta-100 text-terracotta-800"
      : pct >= 25
        ? "bg-amber-100 text-amber-800"
        : pct <= -10
          ? "bg-sage-100 text-sage-800"
          : "bg-ink-100 text-ink-700";
  const arrow = pct > 0 ? "↑" : pct < 0 ? "↓" : "·";
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${tone}`}
    >
      {arrow} {Math.abs(pct)}%
    </span>
  );
}

function AnomalyBadge({ anomaly }: { anomaly: AnomalyDetection }) {
  if (!anomaly.isAnomaly) {
    return (
      <span className="inline-block rounded-full bg-sage-50 text-sage-700 px-2.5 py-0.5 text-xs font-medium">
        ok
      </span>
    );
  }
  const ratioLabel = Number.isFinite(anomaly.ratio)
    ? `${anomaly.ratio.toFixed(1)}× baseline`
    : "novo gasto";
  return (
    <span
      className="inline-block rounded-full bg-terracotta-100 text-terracotta-800 px-2.5 py-0.5 text-xs font-medium"
      title={`latest: ${centsToBRL(anomaly.latestCents)} · baseline: ${centsToBRL(anomaly.baselineCents)}`}
    >
      ⚠ {ratioLabel}
    </span>
  );
}

/**
 * Sparkline SVG mínima (50 × 22 px).
 *
 * - Sem dependência de chart lib.
 * - Renderiza vazio (placeholder) quando série tem 0 ou 1 ponto.
 * - Ponto último em destaque pra chamar atenção pra "agora".
 */
function Sparkline({ series, color }: { series: number[]; color: string }) {
  const W = 80;
  const H = 22;
  if (series.length < 2) {
    return <span className="text-ink-300 text-xs">—</span>;
  }
  const max = Math.max(...series, 1);
  const stepX = W / (series.length - 1);
  const points = series
    .map((v, i) => {
      const x = i * stepX;
      const y = H - (v / max) * (H - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const lastX = (series.length - 1) * stepX;
  const lastY = H - (series[series.length - 1] / max) * (H - 2) - 1;
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="inline-block align-middle"
      aria-label="Tendência dos últimos 30 dias"
    >
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.4}
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity={0.85}
      />
      <circle cx={lastX} cy={lastY} r={1.8} fill={color} />
    </svg>
  );
}

function DailyTotalChart({ series }: { series: CostDashboardSeries[] }) {
  if (series.length === 0) {
    return <p className="text-sm text-ink-500 italic">Sem dados.</p>;
  }
  const W = 720;
  const H = 140;
  const padX = 32;
  const padY = 14;
  const totals = series.map((s) => s.totalCents);
  const max = Math.max(...totals, 1);

  const innerW = W - padX * 2;
  const innerH = H - padY * 2;
  const stepX = series.length > 1 ? innerW / (series.length - 1) : 0;

  const polylinePoints = series
    .map((s, i) => {
      const x = padX + i * stepX;
      const y = padY + innerH - (s.totalCents / max) * innerH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  // Ticks de data — primeiro e último apenas, pra não poluir.
  const firstLabel = formatShortDate(series[0].date);
  const lastLabel = formatShortDate(series[series.length - 1].date);

  return (
    <div className="overflow-x-auto">
      <svg
        width={W}
        height={H + 28}
        viewBox={`0 0 ${W} ${H + 28}`}
        className="block min-w-full"
        role="img"
        aria-label="Custo diário total"
      >
        {/* Linha base */}
        <line
          x1={padX}
          y1={H - padY}
          x2={W - padX}
          y2={H - padY}
          stroke="#E2E2E2"
          strokeWidth={1}
        />
        {/* Eixo Y simplificado: max */}
        <text
          x={padX - 4}
          y={padY + 4}
          textAnchor="end"
          fontSize={10}
          fill="#999"
        >
          {centsToBRL(max)}
        </text>
        <text
          x={padX - 4}
          y={H - padY + 4}
          textAnchor="end"
          fontSize={10}
          fill="#999"
        >
          R$ 0
        </text>
        {/* Polilinha */}
        <polyline
          points={polylinePoints}
          fill="none"
          stroke="#7C9885"
          strokeWidth={1.8}
          strokeLinejoin="round"
        />
        {/* Pontos */}
        {series.map((s, i) => {
          const x = padX + i * stepX;
          const y = padY + innerH - (s.totalCents / max) * innerH;
          return (
            <circle
              key={s.date}
              cx={x}
              cy={y}
              r={2}
              fill="#7C9885"
              opacity={s.totalCents > 0 ? 1 : 0.25}
            >
              <title>
                {formatShortDate(s.date)} — {centsToBRL(s.totalCents)}
              </title>
            </circle>
          );
        })}
        {/* Labels eixo X */}
        <text
          x={padX}
          y={H + 14}
          textAnchor="start"
          fontSize={10}
          fill="#777"
        >
          {firstLabel}
        </text>
        <text
          x={W - padX}
          y={H + 14}
          textAnchor="end"
          fontSize={10}
          fill="#777"
        >
          {lastLabel}
        </text>
      </svg>
    </div>
  );
}

function RateRow({
  label,
  env,
  valueCents,
  valuePctBps,
  suffix,
}: {
  label: string;
  env: string;
  valueCents?: number;
  valuePctBps?: number;
  suffix: string;
}) {
  const display =
    valuePctBps !== undefined
      ? `${(valuePctBps / 100).toFixed(2)}%`
      : valueCents !== undefined
        ? centsToBRL(valueCents)
        : "—";
  return (
    <div>
      <dt className="text-ink-500 text-[0.78rem] uppercase tracking-wider font-medium">
        {label}
      </dt>
      <dd className="mt-1 flex items-baseline gap-2">
        <span className="font-serif text-ink-800 tabular-nums">{display}</span>
        <span className="text-xs text-ink-500">{suffix}</span>
      </dd>
      <p className="text-[0.72rem] text-ink-400 mt-0.5 font-mono">{env}</p>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Helpers locais
// ──────────────────────────────────────────────────────────────────────

function formatFreshness(seconds: number): string {
  if (seconds < 60) return `${seconds}s atrás`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}min atrás`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h atrás`;
  return `${Math.floor(seconds / 86400)} dia(s) atrás`;
}

function formatDelta(pct: number | null): string {
  if (pct === null) return "—";
  const arrow = pct > 0 ? "+" : "";
  return `${arrow}${pct}%`;
}

function toneForDelta(
  pct: number | null,
  warnAt: number,
  alertAt: number
): "sage" | "amber" | "terracotta" | "ink" {
  if (pct === null) return "ink";
  if (pct >= alertAt) return "terracotta";
  if (pct >= warnAt) return "amber";
  if (pct <= -10) return "sage";
  return "ink";
}

function monthLabel(todayDate: string, monthsBack: number): string {
  const [y, m] = todayDate.split("-").map((s) => Number.parseInt(s, 10));
  let year = y;
  let month = m + monthsBack;
  while (month <= 0) {
    month += 12;
    year -= 1;
  }
  while (month > 12) {
    month -= 12;
    year += 1;
  }
  const names = [
    "jan",
    "fev",
    "mar",
    "abr",
    "mai",
    "jun",
    "jul",
    "ago",
    "set",
    "out",
    "nov",
    "dez",
  ];
  return `${names[month - 1]}/${year.toString().slice(2)}`;
}

function formatShortDate(dateStr: string): string {
  const [, m, d] = dateStr.split("-");
  return `${d}/${m}`;
}
