/**
 * /admin/crons — Dashboard temporal de execuções de crons (PR-040 · D-059).
 *
 * Diferença vs `/admin/health`:
 *
 *   - `/admin/health` → "o **último** run está ok?" (snapshot).
 *   - `/admin/crons`  → "**como está a tendência**?" (série temporal,
 *     success rate semana-vs-semana, p95 de duração, últimas 20 runs
 *     por job). Observabilidade ops, não telemetria de produto.
 *
 * Uso esperado:
 *
 *   - Revisão semanal (operador solo): bate o olho, vê se algum cron
 *     degradou em latência ou success rate.
 *   - Durante incidente: acha qual cron começou a falhar e quando.
 *   - Antes de deploy grande: confirma que nada está travado em running.
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import {
  loadCronDashboard,
  type CronJobSummary,
  type CronRunStatus,
  type DailyBucket,
} from "@/lib/cron-dashboard";
import { formatCorrelationSummary } from "@/lib/cron-correlation";
import { formatDateBR } from "@/lib/datetime-br";

export const dynamic = "force-dynamic";

/**
 * Jobs conhecidos pela aplicação — aparecem no dashboard mesmo se
 * não tiverem rodado na janela. Mantido em sync com o type `CronJob`
 * de `src/lib/cron-runs.ts`.
 */
const EXPECTED_JOBS = [
  "recalc_earnings_availability",
  "generate_monthly_payouts",
  "notify_pending_documents",
  "auto_deliver_fulfillments",
  "nudge_reconsulta",
  "admin_digest",
  "retention_anonymize",
  "asaas_events_purge",
  "expire_appointment_credits",
] as const;

const JOB_LABELS: Record<string, string> = {
  recalc_earnings_availability: "Recalcular earnings disponíveis",
  generate_monthly_payouts: "Gerar payouts mensais",
  notify_pending_documents: "Avisar documentos pendentes",
  auto_deliver_fulfillments: "Auto-entregar fulfillments",
  nudge_reconsulta: "Nudge de reconsulta",
  admin_digest: "Digest para o admin",
  retention_anonymize: "Retenção LGPD (anonimizar)",
  asaas_events_purge: "Purge LGPD (asaas_events.payload)",
  expire_appointment_credits: "Expirar créditos de reagendamento",
};

/**
 * Cadência nominal declarada em `vercel.json`. Serve pro operador
 * estimar se "sem runs há 3 dias" é normal (ex.: payouts mensais)
 * ou sintoma de problema. Se mudar `vercel.json`, atualizar aqui.
 */
const JOB_CADENCE: Record<string, string> = {
  recalc_earnings_availability: "a cada 15 min",
  generate_monthly_payouts: "1× por mês",
  notify_pending_documents: "diário",
  auto_deliver_fulfillments: "a cada hora",
  nudge_reconsulta: "diário",
  admin_digest: "diário",
  retention_anonymize: "diário",
  asaas_events_purge: "semanal (dom 05:00 UTC)",
};

const WINDOW_DAYS = 30;

type SearchParams = { days?: string };

export default async function CronsDashboardPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const days = parseDays(searchParams?.days) ?? WINDOW_DAYS;
  const supabase = getSupabaseAdmin();
  const report = await loadCronDashboard(supabase, {
    windowDays: days,
    expectedJobs: [...EXPECTED_JOBS],
    // PR-069 · D-077 · finding [17.5]: pra cada cron que falhou,
    // anexa resumo de quantos erros de OUTRAS fontes caíram em ±15min.
    // Operador solo vê num lance se foi bug do cron ou incidente
    // sistêmico (Meta/Asaas/Daily fora).
    correlation: true,
    correlationWindowMinutes: 15,
  });

  const jobsWithError = report.jobs.filter((j) => j.error_count > 0).length;
  const jobsStuck = report.overall.stuck_count;

  return (
    <div>
      <header className="mb-6">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Observabilidade
        </p>
        <h1 className="font-serif text-[1.85rem] sm:text-[2.2rem] leading-tight text-ink-800">
          Crons
        </h1>
        <p className="mt-1 text-ink-500 max-w-2xl">
          Tendência das {EXPECTED_JOBS.length} rotinas agendadas nos últimos{" "}
          {report.window_days} dias. Complementa{" "}
          <a
            href="/admin/health"
            className="underline decoration-ink-300 hover:decoration-ink-600"
          >
            /admin/health
          </a>{" "}
          (que mostra só o último estado). Snapshot de{" "}
          {formatDateBR(report.generated_at, {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })}
          .
        </p>

        <div className="mt-3 flex gap-2 text-sm">
          <RangeLink label="7 dias" href="/admin/crons?days=7" active={days === 7} />
          <RangeLink
            label="30 dias"
            href="/admin/crons?days=30"
            active={days === 30}
          />
          <RangeLink
            label="90 dias"
            href="/admin/crons?days=90"
            active={days === 90}
          />
        </div>
      </header>

      {/* Resumo global */}
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        <SummaryCard
          label="Runs na janela"
          value={String(report.overall.total_runs)}
          hint={`${report.overall.distinct_jobs} crons distintos`}
          tone="ink"
        />
        <SummaryCard
          label="Taxa de sucesso"
          value={formatPercent(report.overall.success_rate)}
          hint={`${report.overall.ok_count} ok · ${report.overall.error_count} erros`}
          tone={
            report.overall.success_rate == null
              ? "ink"
              : report.overall.success_rate >= 0.99
                ? "sage"
                : report.overall.success_rate >= 0.9
                  ? "amber"
                  : "terracotta"
          }
        />
        <SummaryCard
          label="Crons com erro"
          value={String(jobsWithError)}
          hint="qualquer erro na janela"
          tone={jobsWithError > 0 ? "terracotta" : "sage"}
        />
        <SummaryCard
          label="Runs travados"
          value={String(jobsStuck)}
          hint="em 'running' há ≥ 2h"
          tone={jobsStuck > 0 ? "terracotta" : "sage"}
        />
      </section>

      {/* Lista de jobs */}
      <section>
        <h2 className="font-serif text-[1.3rem] text-ink-800 mb-4">
          Por cron
        </h2>
        {report.jobs.length === 0 ? (
          <p className="text-ink-500">Sem dados na janela.</p>
        ) : (
          <div className="space-y-5">
            {report.jobs.map((j) => (
              <JobCard key={j.job} job={j} windowDays={report.window_days} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function parseDays(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  if (n < 1 || n > 180) return null;
  return n;
}

// ────────────────────────────────────────────────────────────────────
// Componentes
// ────────────────────────────────────────────────────────────────────

function RangeLink({
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

function JobCard({ job, windowDays }: { job: CronJobSummary; windowDays: number }) {
  const label = JOB_LABELS[job.job] ?? job.job;
  const cadence = JOB_CADENCE[job.job] ?? "—";

  // Tom do card:
  //   - terracotta: último run com erro ou stuck
  //   - amber: teve erro em algum lugar da janela
  //   - ink: nunca rodou
  //   - sage: só ok
  let tone: "sage" | "amber" | "terracotta" | "ink";
  if (job.stuck_count > 0 || job.last_run?.status === "error") tone = "terracotta";
  else if (job.error_count > 0) tone = "amber";
  else if (job.total_runs === 0) tone = "ink";
  else tone = "sage";

  const toneBorder = {
    sage: "border-sage-200",
    amber: "border-amber-200",
    terracotta: "border-terracotta-200",
    ink: "border-ink-100",
  }[tone];

  return (
    <article
      className={`rounded-2xl bg-white border ${toneBorder} overflow-hidden`}
    >
      <header className="px-5 py-4 border-b border-ink-100 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h3 className="font-serif text-[1.15rem] text-ink-800">{label}</h3>
          <p className="text-xs text-ink-500 mt-0.5">
            <code className="text-ink-600">{job.job}</code> · cadência: {cadence}
          </p>
        </div>
        <JobStatusBadge job={job} />
      </header>

      <div className="px-5 py-4 grid grid-cols-2 sm:grid-cols-5 gap-4 text-sm border-b border-ink-100 bg-cream-50/40">
        <Metric label="Runs" value={String(job.total_runs)} />
        <Metric label="Sucesso" value={formatPercent(job.success_rate)} />
        <Metric label="p50 duração" value={formatMs(job.duration.p50_ms)} />
        <Metric label="p95 duração" value={formatMs(job.duration.p95_ms)} />
        <Metric label="Máx duração" value={formatMs(job.duration.max_ms)} />
      </div>

      <div className="px-5 py-4 grid grid-cols-1 md:grid-cols-[1fr_auto] gap-4 items-center border-b border-ink-100">
        <Sparkline daily={job.daily} />
        <WeekDelta job={job} />
      </div>

      {job.last_error_at && (
        <div className="px-5 py-3 bg-terracotta-50/60 border-b border-terracotta-100 text-sm text-terracotta-800">
          <p>
            <span className="font-medium">Último erro:</span>{" "}
            <span className="font-mono text-xs">
              {formatDateBR(job.last_error_at, {
                day: "2-digit",
                month: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
            {job.last_error_message && (
              <>
                {" · "}
                <span className="italic">
                  {truncate(job.last_error_message, 160)}
                </span>
              </>
            )}
          </p>
          {job.last_error_correlation && (
            <CorrelationInline
              at={job.last_error_at}
              correlation={job.last_error_correlation}
            />
          )}
        </div>
      )}

      <details className="group">
        <summary className="px-5 py-3 text-sm text-ink-600 cursor-pointer hover:bg-cream-50 select-none">
          Últimas {Math.min(job.recent_runs.length, 20)} execuções
          <span className="text-ink-400 ml-2 group-open:hidden">▸ expandir</span>
          <span className="text-ink-400 ml-2 hidden group-open:inline">▾ recolher</span>
        </summary>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-cream-50 border-t border-ink-100">
              <tr className="text-left text-[0.72rem] uppercase tracking-[0.12em] text-ink-500 font-medium">
                <th className="px-5 py-2">Início</th>
                <th className="px-5 py-2">Status</th>
                <th className="px-5 py-2 text-right">Duração</th>
                <th className="px-5 py-2">Erro</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {job.recent_runs.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-5 py-4 text-ink-500 italic">
                    Nenhuma execução registrada na janela de {windowDays}d.
                  </td>
                </tr>
              ) : (
                job.recent_runs.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="px-5 py-2 font-mono text-xs text-ink-600">
                      {formatDateBR(r.started_at, {
                        day: "2-digit",
                        month: "2-digit",
                        year: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="px-5 py-2">
                      <StatusChip status={r.status} />
                    </td>
                    <td className="px-5 py-2 text-right font-mono text-xs text-ink-600">
                      {formatMs(r.duration_ms)}
                    </td>
                    <td className="px-5 py-2 text-xs text-ink-500 italic max-w-md">
                      {r.error_message ? truncate(r.error_message, 120) : "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </details>
    </article>
  );
}

function JobStatusBadge({ job }: { job: CronJobSummary }) {
  if (job.stuck_count > 0) {
    return (
      <span className="inline-flex items-center text-xs font-medium px-2.5 py-1 rounded-full bg-terracotta-100 text-terracotta-800 border border-terracotta-300">
        {job.stuck_count} travado{job.stuck_count > 1 ? "s" : ""} (≥2h)
      </span>
    );
  }
  if (job.last_run?.status === "error") {
    return (
      <span className="inline-flex items-center text-xs font-medium px-2.5 py-1 rounded-full bg-terracotta-100 text-terracotta-800 border border-terracotta-300">
        Último falhou
      </span>
    );
  }
  if (job.total_runs === 0) {
    return (
      <span className="inline-flex items-center text-xs font-medium px-2.5 py-1 rounded-full bg-cream-100 text-ink-600 border border-ink-200">
        Sem execuções
      </span>
    );
  }
  if (job.error_count > 0) {
    return (
      <span className="inline-flex items-center text-xs font-medium px-2.5 py-1 rounded-full bg-amber-100 text-amber-800 border border-amber-300">
        {job.error_count} erro{job.error_count > 1 ? "s" : ""} na janela
      </span>
    );
  }
  return (
    <span className="inline-flex items-center text-xs font-medium px-2.5 py-1 rounded-full bg-sage-100 text-sage-800 border border-sage-300">
      Saudável
    </span>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[0.7rem] uppercase tracking-[0.12em] text-ink-500 font-medium mb-1">
        {label}
      </p>
      <p className="font-mono text-ink-800">{value}</p>
    </div>
  );
}

function WeekDelta({ job }: { job: CronJobSummary }) {
  const delta = job.week_delta.success_rate_delta_pp;
  const cur = job.week_delta.current.success_rate;
  const prev = job.week_delta.previous.success_rate;

  let arrow = "·";
  let color = "text-ink-500";
  if (delta != null) {
    if (delta > 0.5) {
      arrow = "▲";
      color = "text-sage-700";
    } else if (delta < -0.5) {
      arrow = "▼";
      color = "text-terracotta-700";
    }
  }

  return (
    <div className="text-right">
      <p className="text-[0.7rem] uppercase tracking-[0.12em] text-ink-500 font-medium">
        Semana vs anterior
      </p>
      <p className="font-mono text-sm text-ink-700 mt-0.5">
        {formatPercent(cur)} <span className="text-ink-400">→</span>{" "}
        {formatPercent(prev)}
      </p>
      <p className={`font-mono text-xs mt-1 ${color}`}>
        {arrow} {delta != null ? `${delta > 0 ? "+" : ""}${delta}pp` : "sem amostra"}
      </p>
    </div>
  );
}

function Sparkline({ daily }: { daily: DailyBucket[] }) {
  const maxTotal = Math.max(1, ...daily.map((d) => d.total));
  return (
    <div>
      <p className="text-[0.7rem] uppercase tracking-[0.12em] text-ink-500 font-medium mb-1.5">
        Histórico diário
      </p>
      <div
        className="flex items-end gap-[2px] h-16 border-b border-ink-100"
        role="img"
        aria-label={`Sparkline ${daily.length} dias`}
      >
        {daily.map((d) => {
          const total = d.ok + d.error;
          const heightPct = total === 0 ? 3 : Math.max(6, (total / maxTotal) * 100);
          const okPct = total === 0 ? 0 : (d.ok / total) * 100;
          return (
            <div
              key={d.date}
              className="flex-1 min-w-[3px] flex flex-col-reverse"
              style={{ height: `${heightPct}%` }}
              title={`${d.date}: ${d.ok} ok, ${d.error} erro, ${d.running} em execução${d.skipped ? `, ${d.skipped} skipped` : ""}`}
            >
              {total > 0 ? (
                <>
                  <div
                    className="bg-sage-500"
                    style={{ height: `${okPct}%`, width: "100%" }}
                  />
                  <div
                    className="bg-terracotta-500"
                    style={{ height: `${100 - okPct}%`, width: "100%" }}
                  />
                </>
              ) : (
                <div className="bg-ink-100 h-full w-full" />
              )}
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[0.65rem] text-ink-400 font-mono mt-1">
        <span>{daily[0]?.date ?? ""}</span>
        <span className="text-ink-500">
          <span className="inline-block w-2 h-2 bg-sage-500 rounded-sm align-middle mr-1" />
          ok
          <span className="inline-block w-2 h-2 bg-terracotta-500 rounded-sm align-middle ml-3 mr-1" />
          erro
        </span>
        <span>{daily[daily.length - 1]?.date ?? ""}</span>
      </div>
    </div>
  );
}

/**
 * PR-069 · D-077 · finding [17.5]. Banner inline dentro do bloco
 * "Último erro" que mostra quantos erros de outras fontes caíram em
 * ±N min, com link direto pra `/admin/errors` filtrado na mesma janela.
 *
 * Design intencional:
 *   - Se `total == 0`, renderiza uma linha "só este cron errou na
 *     janela" — ÚTIL porque confirma que o bug é do próprio cron
 *     (não dependência externa), em vez de deixar o operador em
 *     dúvida "será que a Meta caiu?".
 *   - Se `total > 0`, mostra breakdown legível + link.
 */
function CorrelationInline({
  at,
  correlation,
}: {
  at: string;
  correlation: NonNullable<CronJobSummary["last_error_correlation"]>;
}) {
  const { total, by_source, window_minutes } = correlation;
  const summary = formatCorrelationSummary(by_source);

  if (total === 0) {
    return (
      <p className="mt-1.5 text-xs text-terracotta-700/80">
        ± {window_minutes}min: <span className="font-medium">sem outros erros.</span>{" "}
        <span className="italic">Provável bug deste cron, não dependência externa.</span>
      </p>
    );
  }

  const q = new URLSearchParams();
  q.set("ts", at);
  q.set("w", String(window_minutes));
  const href = `/admin/errors?${q.toString()}`;

  return (
    <p className="mt-1.5 text-xs text-terracotta-800">
      ± {window_minutes}min: <span className="font-medium">{summary}.</span>{" "}
      <a
        href={href}
        className="underline decoration-terracotta-400 hover:decoration-terracotta-700 hover:text-terracotta-900"
      >
        ver correlação →
      </a>
    </p>
  );
}

function StatusChip({ status }: { status: CronRunStatus }) {
  if (status === "ok") {
    return (
      <span className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full bg-sage-100 text-sage-800 border border-sage-300">
        ok
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full bg-terracotta-100 text-terracotta-800 border border-terracotta-300">
        erro
      </span>
    );
  }
  if (status === "skipped") {
    return (
      <span className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full bg-ink-100 text-ink-700 border border-ink-300">
        skipped
      </span>
    );
  }
  return (
    <span className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300">
      running
    </span>
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
  tone: "sage" | "terracotta" | "ink" | "amber";
}) {
  const toneClasses = {
    sage: "border-sage-200 bg-sage-50",
    terracotta: "border-terracotta-200 bg-terracotta-50",
    amber: "border-amber-200 bg-amber-50",
    ink: "border-ink-100 bg-white",
  }[tone];
  const valueClasses = {
    sage: "text-sage-800",
    terracotta: "text-terracotta-700",
    amber: "text-amber-800",
    ink: "text-ink-800",
  }[tone];
  return (
    <div className={`rounded-2xl border p-4 ${toneClasses}`}>
      <p className="text-[0.72rem] uppercase tracking-[0.14em] text-ink-500 font-medium mb-2">
        {label}
      </p>
      <p className={`font-serif text-[1.6rem] leading-none ${valueClasses}`}>
        {value}
      </p>
      <p className="mt-2 text-xs text-ink-500">{hint}</p>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Format helpers
// ────────────────────────────────────────────────────────────────────

function formatPercent(rate: number | null): string {
  if (rate == null) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

function formatMs(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
