/**
 * /admin/health — Saúde do sistema (D-039).
 *
 * Dashboard de observabilidade das integrações e subsistemas. Roda
 * `runHealthCheck` no request (default: sem ping externo, rápido).
 * Operador pode forçar ping real com `?ping=1` pra validar
 * autenticação Asaas/Daily em produção.
 *
 * Complementar ao `/admin/financeiro` (conciliação interna) e
 * `/admin/reliability` (política médica). Este é o "está tudo vivo?"
 * geral.
 *
 * Quando usar:
 *   - Todo login no admin (batida rápida).
 *   - Antes de executar o runbook de prova de fogo (docs/RUNBOOK-E2E.md).
 *   - Durante incidente (fornece o retrato de 9 pontos em ~2s).
 */

import Link from "next/link";
import { runHealthCheck, type HealthStatus } from "@/lib/system-health";

export const dynamic = "force-dynamic";

type SearchParams = { ping?: string };

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const STATUS_STYLES: Record<
  HealthStatus,
  { chip: string; dot: string; label: string }
> = {
  ok: {
    chip: "bg-sage-50 border-sage-200 text-sage-800",
    dot: "bg-sage-500",
    label: "ok",
  },
  warning: {
    chip: "bg-amber-50 border-amber-200 text-amber-800",
    dot: "bg-amber-500",
    label: "warning",
  },
  error: {
    chip: "bg-terracotta-50 border-terracotta-200 text-terracotta-800",
    dot: "bg-terracotta-500",
    label: "error",
  },
  unknown: {
    chip: "bg-cream-100 border-ink-200 text-ink-600",
    dot: "bg-ink-300",
    label: "sem dados",
  },
};

export default async function HealthPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const pingExternal = searchParams?.ping === "1";
  const report = await runHealthCheck({ pingExternal });

  const overall = STATUS_STYLES[report.overall];

  return (
    <div>
      <header className="mb-6">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Observabilidade
        </p>
        <h1 className="font-serif text-[1.85rem] sm:text-[2.2rem] leading-tight text-ink-800">
          Saúde do sistema
        </h1>
        <p className="mt-1 text-ink-500 max-w-2xl">
          9 checks paralelos pra DB, integrações (Asaas, Daily, WhatsApp)
          e conciliação. Snapshot de {fmtDateTime(report.runAt)} em{" "}
          {report.totalMs}ms.{" "}
          {report.pingedExternal ? (
            <span>Com ping externo (HTTP real).</span>
          ) : (
            <span>
              Sem ping externo —{" "}
              <Link
                href="/admin/health?ping=1"
                className="underline hover:text-ink-800"
              >
                rodar com ping
              </Link>
              .
            </span>
          )}
        </p>
      </header>

      {/* Overall */}
      <section
        className={`rounded-2xl border p-5 mb-8 flex items-center justify-between gap-4 ${overall.chip}`}
      >
        <div className="flex items-center gap-3">
          <span
            className={`inline-block w-3 h-3 rounded-full ${overall.dot}`}
            aria-hidden
          />
          <div>
            <p className="font-serif text-[1.4rem] leading-none">
              Status geral: {overall.label}
            </p>
            <p className="text-sm mt-1 opacity-80">
              {report.overall === "ok" &&
                "Todos os subsistemas respondendo normalmente."}
              {report.overall === "warning" &&
                "Algum subsistema com sinal amarelo. Revisar abaixo."}
              {report.overall === "error" &&
                "Ação imediata: subsistema crítico com falha."}
              {report.overall === "unknown" &&
                "Sinal insuficiente em algum subsistema."}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Link
            href="/admin/health"
            className="px-3 py-1.5 rounded-lg bg-white/60 border border-ink-200 text-sm text-ink-700 hover:bg-white"
          >
            Recarregar
          </Link>
          <Link
            href={`/admin/health${pingExternal ? "" : "?ping=1"}`}
            className="px-3 py-1.5 rounded-lg bg-ink-800 text-white text-sm hover:bg-ink-900"
          >
            {pingExternal ? "Sem ping" : "Rodar com ping"}
          </Link>
        </div>
      </section>

      {/* Checks */}
      <section>
        <h2 className="font-serif text-[1.3rem] text-ink-800 mb-4">
          Subsistemas
        </h2>
        <ul className="space-y-3">
          {report.checks.map((check) => {
            const style = STATUS_STYLES[check.status];
            return (
              <li
                key={check.key}
                className={`rounded-2xl border p-4 ${style.chip}`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <span
                      className={`mt-1.5 inline-block w-2.5 h-2.5 rounded-full ${style.dot} shrink-0`}
                      aria-hidden
                    />
                    <div>
                      <h3 className="font-medium text-ink-800 text-[1.02rem]">
                        {check.label}
                      </h3>
                      <p className="text-sm mt-0.5">{check.summary}</p>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <span className="text-[0.72rem] uppercase tracking-wider font-medium">
                      {style.label}
                    </span>
                    <p className="text-[0.7rem] text-ink-500 font-mono mt-1">
                      {check.elapsedMs}ms
                    </p>
                  </div>
                </div>

                {Object.keys(check.details).length > 0 && (
                  <dl className="mt-3 pt-3 border-t border-ink-100/60 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
                    {Object.entries(check.details).map(([k, v]) => (
                      <div
                        key={k}
                        className="flex items-baseline justify-between gap-3 text-xs"
                      >
                        <dt className="text-ink-500 font-medium shrink-0">
                          {k}
                        </dt>
                        <dd className="font-mono text-ink-700 text-right break-all">
                          {formatDetailValue(v)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="mt-8 rounded-2xl border border-ink-100 bg-cream-50 p-5">
        <h2 className="font-serif text-[1.1rem] text-ink-800 mb-2">
          Uso via automação
        </h2>
        <p className="text-sm text-ink-600">
          Pra monitoria externa (UptimeRobot, Better Uptime), configurar
          um HTTP monitor batendo em{" "}
          <code className="bg-white border border-ink-100 rounded px-1.5 py-0.5 text-xs">
            /api/internal/e2e/smoke
          </code>{" "}
          com header{" "}
          <code className="bg-white border border-ink-100 rounded px-1.5 py-0.5 text-xs">
            x-cron-secret: &lt;CRON_SECRET&gt;
          </code>
          . Retorna 200 quando ok/warning, 503 em erro. Ver{" "}
          <code className="bg-white border border-ink-100 rounded px-1.5 py-0.5 text-xs">
            docs/RUNBOOK-E2E.md
          </code>
          .
        </p>
      </section>
    </div>
  );
}

function formatDetailValue(v: string | number | boolean | null): string {
  if (v === null) return "—";
  if (typeof v === "boolean") return v ? "sim" : "não";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    return fmtDateTime(v);
  }
  return String(v);
}
