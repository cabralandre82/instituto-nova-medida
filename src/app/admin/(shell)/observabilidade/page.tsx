/**
 * /admin/observabilidade — PR-082 · D-094
 *
 * Métricas operacionais de produto sobre on-demand e plantão. Diferente
 * de `/admin/plantao` (snapshot operacional) e `/admin/crons` (saúde
 * técnica dos jobs), aqui o foco é:
 *
 *   - **Como o on-demand está performando?**
 *     TTM (time-to-match) p50/p95/avg, taxa de match (accepted /
 *     accepted+cancelled+expired), tempo de abandono, fila pending agora.
 *
 *   - **A fan-out está cobrindo a demanda?**
 *     % de requests sem médica online, dispatches médios por request,
 *     médicas únicas notificadas.
 *
 *   - **Plantão está sendo cumprido?**
 *     Taxa de fulfill (paid / total settlements), histograma de
 *     cobertura, total pago, breakdown por médica.
 *
 * Janela configurável via `?window=7d|30d|90d|24h` (default 7d).
 *
 * Snapshot — sem auto-refresh. Operador recarrega quando quiser.
 * Métricas em tempo real ficam em `/admin/plantao` (snapshot mais
 * curto, refresh manual).
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { formatDateBR } from "@/lib/datetime-br";
import {
  DEFAULT_OBSERVABILITY_WINDOW,
  formatCentsBR,
  formatDurationHuman,
  formatPctFromRatio,
  loadObservabilityReport,
  OBSERVABILITY_WINDOWS,
  type CoverageHistogram,
  type DoctorOnCallStats,
  type FanOutStats,
  type ObservabilityWindow,
  type OnCallStats,
  type OnDemandStats,
  type PercentileSummary,
} from "@/lib/admin-observability";

const log = logger.with({ route: "/admin/observabilidade" });

export const dynamic = "force-dynamic";

const WINDOW_LABELS: Record<ObservabilityWindow, string> = {
  "24h": "24 horas",
  "7d": "7 dias",
  "30d": "30 dias",
  "90d": "90 dias",
};

type SearchParams = { window?: string };

function parseWindow(raw: string | undefined): ObservabilityWindow {
  if (!raw) return DEFAULT_OBSERVABILITY_WINDOW;
  if ((OBSERVABILITY_WINDOWS as readonly string[]).includes(raw)) {
    return raw as ObservabilityWindow;
  }
  return DEFAULT_OBSERVABILITY_WINDOW;
}

export default async function ObservabilidadePage(props: {
  searchParams?: Promise<SearchParams>;
}) {
  const sp = await props.searchParams;
  const window = parseWindow(sp?.window);
  const supabase = getSupabaseAdmin();

  let report;
  try {
    report = await loadObservabilityReport(supabase, { window });
  } catch (e) {
    log.error("loadObservabilityReport failed", { err: e });
    return (
      <div>
        <h1 className="font-serif text-[1.85rem] sm:text-[2.2rem] leading-tight text-ink-800 mb-3">
          Observabilidade
        </h1>
        <div className="rounded-xl border border-terracotta-200 bg-terracotta-50/60 px-5 py-6 text-terracotta-800">
          Falha ao carregar relatório. Veja{" "}
          <a className="underline" href="/admin/errors">
            /admin/errors
          </a>{" "}
          pra mais detalhes.
        </div>
      </div>
    );
  }

  return (
    <div>
      <header className="mb-6">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Observabilidade de produto
        </p>
        <h1 className="font-serif text-[1.85rem] sm:text-[2.2rem] leading-tight text-ink-800">
          On-demand & plantão
        </h1>
        <p className="text-ink-500 text-sm mt-1.5 max-w-2xl">
          Métricas agregadas dos últimos {WINDOW_LABELS[window]}. Snapshot
          de{" "}
          {formatDateBR(report.generatedAt, {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })}
          . Complementa{" "}
          <a
            href="/admin/plantao"
            className="underline decoration-ink-300 hover:decoration-ink-600"
          >
            /admin/plantao
          </a>{" "}
          (snapshot operacional) e{" "}
          <a
            href="/admin/crons"
            className="underline decoration-ink-300 hover:decoration-ink-600"
          >
            /admin/crons
          </a>{" "}
          (saúde técnica).
        </p>

        <div className="mt-4 flex gap-2 text-sm flex-wrap">
          {OBSERVABILITY_WINDOWS.map((w) => (
            <WindowLink
              key={w}
              label={WINDOW_LABELS[w]}
              href={`/admin/observabilidade?window=${w}`}
              active={w === window}
            />
          ))}
        </div>
      </header>

      <OnDemandSection stats={report.onDemand} />
      <FanOutSection stats={report.fanOut} />
      <OnCallSection stats={report.onCall} />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// On-demand
// ────────────────────────────────────────────────────────────────────

function OnDemandSection({ stats }: { stats: OnDemandStats }) {
  const matchTone = toneForRate(stats.matchRate, {
    healthy: 0.7,
    warn: 0.4,
  });

  return (
    <section className="mb-10">
      <h2 className="font-serif text-[1.4rem] text-ink-800 mb-3">
        Atendimento on-demand
      </h2>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-5">
        <SummaryCard
          label="Requests"
          value={String(stats.total)}
          hint={`${stats.byOutcome.accepted} aceitos · ${stats.byOutcome.cancelled} cancelados · ${stats.byOutcome.expired} expirados`}
          tone="ink"
        />
        <SummaryCard
          label="Taxa de match"
          value={formatPctFromRatio(stats.matchRate)}
          hint="aceitos ÷ (aceitos + cancelados + expirados)"
          tone={matchTone}
        />
        <SummaryCard
          label="TTM mediano"
          value={formatDurationHuman(stats.timeToMatch.p50)}
          hint={`p95: ${formatDurationHuman(stats.timeToMatch.p95)} · n=${stats.timeToMatch.count}`}
          tone="ink"
        />
        <SummaryCard
          label="Tempo de abandono"
          value={formatDurationHuman(stats.timeToAbandon.p50)}
          hint={`p95: ${formatDurationHuman(stats.timeToAbandon.p95)} · n=${stats.timeToAbandon.count}`}
          tone="ink"
        />
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <PercentileCard title="Time-to-match (TTM)" stats={stats.timeToMatch} />
        <PercentileCard
          title="Tempo até abandono"
          stats={stats.timeToAbandon}
        />
      </div>

      <div className="mt-5 rounded-xl border border-ink-100 bg-cream-50/50 px-5 py-4 text-sm text-ink-600 flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className="text-ink-500">Fila pending agora:</span>{" "}
          <span className="font-medium text-ink-800">
            {stats.pendingNow.count} request
            {stats.pendingNow.count === 1 ? "" : "s"}
          </span>
          {stats.pendingNow.oldestAgeSeconds != null && (
            <>
              {" · "}
              <span className="text-ink-500">mais antigo há</span>{" "}
              <span className="font-mono text-ink-700">
                {formatDurationHuman(stats.pendingNow.oldestAgeSeconds)}
              </span>
            </>
          )}
        </div>
        <a
          href="/admin/plantao"
          className="text-xs underline decoration-ink-300 hover:decoration-ink-600"
        >
          ver fila no /admin/plantao →
        </a>
      </div>
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────
// Fan-out
// ────────────────────────────────────────────────────────────────────

function FanOutSection({ stats }: { stats: FanOutStats }) {
  // zero-online-rate: invertido — quanto MENOR, melhor.
  const zeroTone = toneForRateInverted(stats.zeroOnlineRate, {
    healthy: 0.1,
    warn: 0.3,
  });

  return (
    <section className="mb-10">
      <h2 className="font-serif text-[1.4rem] text-ink-800 mb-3">
        Cobertura do fan-out
      </h2>
      <p className="text-sm text-ink-500 mb-4 max-w-2xl">
        Mede se as médicas online estão dando conta da demanda. Alta taxa de
        &ldquo;zero online&rdquo; sinaliza inventário insuficiente —
        considerar ampliar plantão ou contratar médica adicional (PR-046).
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <SummaryCard
          label="Requests com fan-out"
          value={String(stats.requestsWithFanOut)}
          hint={`${stats.totalDispatched} dispatches enviados`}
          tone="ink"
        />
        <SummaryCard
          label="Médicas únicas notificadas"
          value={String(stats.uniqueDoctorsReached)}
          hint="sem repetir mesma médica"
          tone="ink"
        />
        <SummaryCard
          label="Dispatches por request"
          value={
            stats.avgDispatchesPerRequest != null
              ? stats.avgDispatchesPerRequest.toFixed(2)
              : "—"
          }
          hint="média entre requests com fan-out"
          tone="ink"
        />
        <SummaryCard
          label="Sem médica online"
          value={formatPctFromRatio(stats.zeroOnlineRate)}
          hint={`${stats.requestsWithZeroOnline} requests sem cobertura`}
          tone={zeroTone}
        />
      </div>
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────
// On-call (plantão)
// ────────────────────────────────────────────────────────────────────

function OnCallSection({ stats }: { stats: OnCallStats }) {
  const fulfillTone = toneForRate(stats.fulfillRate, {
    healthy: 0.85,
    warn: 0.6,
  });

  return (
    <section className="mb-10">
      <h2 className="font-serif text-[1.4rem] text-ink-800 mb-3">
        Plantão programado
      </h2>
      <p className="text-sm text-ink-500 mb-4 max-w-2xl">
        Cumprimento de blocos <code className="text-ink-700">on_call</code>{" "}
        liquidados pelo cron <code className="text-ink-700">monitor_on_call</code>
        . Cobertura ≥ 50% gera earning proporcional; abaixo disso vira
        no-show.
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-5">
        <SummaryCard
          label="Settlements"
          value={String(stats.total)}
          hint={`${stats.byOutcome.paid} pagos · ${stats.byOutcome.noShow} no-shows`}
          tone="ink"
        />
        <SummaryCard
          label="Taxa de fulfillment"
          value={formatPctFromRatio(stats.fulfillRate)}
          hint="pagos ÷ total"
          tone={fulfillTone}
        />
        <SummaryCard
          label="Total pago"
          value={formatCentsBR(stats.totalPaidCents)}
          hint={`${formatDurationHuman(stats.totalCoverageMinutes * 60)} de plantão`}
          tone="sage"
        />
        <SummaryCard
          label="Cobertura mediana"
          value={
            stats.coverage.p50 != null ? `${stats.coverage.p50}%` : "—"
          }
          hint={
            stats.coverage.p95 != null
              ? `p95: ${stats.coverage.p95}% · n=${stats.coverage.count}`
              : "sem amostras"
          }
          tone="ink"
        />
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <CoverageHistogramCard histogram={stats.histogram} total={stats.total} />
        <DoctorBreakdownCard byDoctor={stats.byDoctor} />
      </div>
    </section>
  );
}

function CoverageHistogramCard({
  histogram,
  total,
}: {
  histogram: CoverageHistogram;
  total: number;
}) {
  const maxCount = Math.max(1, ...histogram.map((b) => b.count));
  return (
    <div className="rounded-xl border border-ink-100 bg-white p-5">
      <p className="text-[0.78rem] uppercase tracking-wider text-ink-500 font-medium mb-1">
        Histograma de cobertura
      </p>
      <p className="text-xs text-ink-400 mb-3">
        Distribuição de cobertura por bloco
      </p>
      {total === 0 ? (
        <p className="text-sm text-ink-500 italic">Sem settlements na janela.</p>
      ) : (
        <ul className="space-y-2">
          {histogram.map((b) => {
            const widthPct = Math.max(2, (b.count / maxCount) * 100);
            const tone =
              b.label === "0-25%" || b.label === "25-50%"
                ? "bg-terracotta-300"
                : b.label === "50-75%"
                  ? "bg-amber-300"
                  : "bg-sage-500";
            return (
              <li key={b.label}>
                <div className="flex items-center justify-between text-xs text-ink-600 mb-1">
                  <span className="font-mono">{b.label}</span>
                  <span className="font-mono text-ink-500">
                    {b.count} · {(b.pct * 100).toFixed(0)}%
                  </span>
                </div>
                <div className="h-3 rounded-full bg-cream-100 overflow-hidden">
                  <div
                    className={`h-full ${tone}`}
                    style={{ width: `${widthPct}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function DoctorBreakdownCard({ byDoctor }: { byDoctor: DoctorOnCallStats[] }) {
  return (
    <div className="rounded-xl border border-ink-100 bg-white p-5">
      <p className="text-[0.78rem] uppercase tracking-wider text-ink-500 font-medium mb-1">
        Por médica
      </p>
      <p className="text-xs text-ink-400 mb-3">
        Ordenado por valor pago descendente
      </p>
      {byDoctor.length === 0 ? (
        <p className="text-sm text-ink-500 italic">
          Nenhuma médica com settlement na janela.
        </p>
      ) : (
        <ul className="divide-y divide-ink-100">
          {byDoctor.map((d) => (
            <li key={d.doctorId} className="py-2.5 first:pt-0 last:pb-0">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-sm text-ink-800 font-medium truncate">
                  {d.doctorName}
                </p>
                <p className="text-sm text-sage-700 font-medium tabular-nums">
                  {formatCentsBR(d.totalCents)}
                </p>
              </div>
              <p className="text-xs text-ink-500 mt-0.5 flex flex-wrap gap-x-2">
                <span>
                  {d.paid} pago{d.paid === 1 ? "" : "s"}
                </span>
                <span className="text-ink-300">·</span>
                <span>
                  {d.noShow} no-show{d.noShow === 1 ? "" : "s"}
                </span>
                <span className="text-ink-300">·</span>
                <span>{formatPctFromRatio(d.fulfillRate)} fulfill</span>
                <span className="text-ink-300">·</span>
                <span>
                  {formatDurationHuman(d.totalCoverageMinutes * 60)} cobertos
                </span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Componentes compartilhados
// ────────────────────────────────────────────────────────────────────

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
      <p className={`font-serif text-[1.55rem] leading-none ${valueClasses}`}>
        {value}
      </p>
      <p className="mt-2 text-xs text-ink-500">{hint}</p>
    </div>
  );
}

function PercentileCard({
  title,
  stats,
}: {
  title: string;
  stats: PercentileSummary;
}) {
  return (
    <div className="rounded-xl border border-ink-100 bg-white p-5">
      <p className="text-[0.78rem] uppercase tracking-wider text-ink-500 font-medium mb-1">
        {title}
      </p>
      <p className="text-xs text-ink-400 mb-3">
        n = {stats.count}{" "}
        {stats.count === 0 ? "(sem amostras na janela)" : ""}
      </p>
      <dl className="grid grid-cols-3 gap-2 text-sm">
        <Stat label="p50" value={formatDurationHuman(stats.p50)} />
        <Stat label="p95" value={formatDurationHuman(stats.p95)} />
        <Stat label="p99" value={formatDurationHuman(stats.p99)} />
        <Stat label="avg" value={formatDurationHuman(stats.avg)} />
        <Stat label="min" value={formatDurationHuman(stats.min)} />
        <Stat label="max" value={formatDurationHuman(stats.max)} />
      </dl>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[0.7rem] uppercase tracking-wider text-ink-400 font-medium">
        {label}
      </dt>
      <dd className="font-mono text-ink-800 mt-0.5">{value}</dd>
    </div>
  );
}

function WindowLink({
  label,
  href,
  active,
}: {
  label: string;
  href: string;
  active: boolean;
}) {
  return (
    <a
      href={href}
      className={
        active
          ? "px-3 py-1.5 rounded-lg bg-ink-800 text-white font-medium"
          : "px-3 py-1.5 rounded-lg border border-ink-200 text-ink-600 hover:bg-cream-100"
      }
    >
      {label}
    </a>
  );
}

function toneForRate(
  rate: number | null,
  thresholds: { healthy: number; warn: number }
): "sage" | "amber" | "terracotta" | "ink" {
  if (rate == null) return "ink";
  if (rate >= thresholds.healthy) return "sage";
  if (rate >= thresholds.warn) return "amber";
  return "terracotta";
}

function toneForRateInverted(
  rate: number | null,
  thresholds: { healthy: number; warn: number }
): "sage" | "amber" | "terracotta" | "ink" {
  // Pra métricas onde MENOR é MELHOR (ex.: % zero-online).
  if (rate == null) return "ink";
  if (rate <= thresholds.healthy) return "sage";
  if (rate <= thresholds.warn) return "amber";
  return "terracotta";
}
