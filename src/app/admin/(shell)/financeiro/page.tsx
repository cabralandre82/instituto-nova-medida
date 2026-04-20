/**
 * /admin/financeiro — Dashboard de conciliação (D-037).
 *
 * Roda os checks de reconciliação on-demand (no request) e agrupa por
 * categoria, ordenando CRÍTICO primeiro. Cada item tem:
 *   - headline
 *   - detalhes estruturados (ids, valores, idade)
 *   - hint de ação pro admin
 *
 * Recomendação operacional: acessar toda sexta antes de fechar o mês
 * e sempre que o dashboard principal mostrar o alerta "N críticas".
 *
 * Sem cron automático nesta versão — Sprint 5 pode adicionar se o
 * volume justificar.
 */

import { runReconciliation, KIND_LABELS } from "@/lib/reconciliation";
import type { DiscrepancyKind } from "@/lib/reconciliation";

export const dynamic = "force-dynamic";

function brl(cents: number | null | undefined): string {
  if (cents == null || typeof cents !== "number") return "—";
  return (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isIso(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)
  );
}

function renderDetailValue(key: string, value: string | number | null) {
  if (value === null || value === "") return <span className="text-ink-400">—</span>;

  if (
    typeof value === "number" &&
    (key.endsWith("_cents") || key === "diff_cents")
  ) {
    const formatted = brl(value);
    const isNeg = value < 0;
    return (
      <span
        className={`font-mono ${
          isNeg ? "text-terracotta-700" : "text-ink-800"
        }`}
      >
        {formatted}
      </span>
    );
  }

  if (isIso(value)) {
    return <span className="font-mono text-ink-700">{fmtDateTime(value)}</span>;
  }

  return (
    <span className="font-mono text-ink-700 break-all">{String(value)}</span>
  );
}

function detailLabel(key: string): string {
  const map: Record<string, string> = {
    doctor_id: "Médica (id)",
    doctor_name: "Médica",
    payment_id: "Payment",
    payment_amount_cents: "Valor pago",
    clawback_sum_cents: "Clawback atual",
    policy_applied_at: "Policy aplicada",
    reference_period: "Competência",
    amount_cents: "Valor",
    payout_amount_cents: "Valor do payout",
    earnings_sum_cents: "Soma das earnings",
    diff_cents: "Diferença",
    payout_earnings_count: "Earnings (registrado)",
    actual_earnings_count: "Earnings (real)",
    payout_status: "Status payout",
    unpaid_earnings_count: "Earnings não-pagas",
    paid_at: "Pago em",
    scheduled_at: "Agendado",
    ended_at: "Terminou",
    earned_at: "Ganho em",
    available_at: "Disponível em",
    days_open: "Dias aberto",
    cancelled_reason: "Motivo",
    description: "Descrição",
    type: "Tipo",
    status: "Status",
  };
  return map[key] ?? key;
}

export default async function FinanceiroPage() {
  const report = await runReconciliation();

  const bySeverity = {
    critical: report.discrepancies.filter((d) => d.severity === "critical"),
    warning: report.discrepancies.filter((d) => d.severity === "warning"),
  };

  const groupByKind = (list: typeof report.discrepancies) => {
    const map = new Map<DiscrepancyKind, typeof list>();
    for (const d of list) {
      const cur = map.get(d.kind) ?? [];
      cur.push(d);
      map.set(d.kind, cur);
    }
    return map;
  };

  const critGroups = groupByKind(bySeverity.critical);
  const warnGroups = groupByKind(bySeverity.warning);

  const totalIssues = report.totalCritical + report.totalWarning;

  return (
    <div>
      <header className="mb-6">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Financeiro
        </p>
        <h1 className="font-serif text-[1.85rem] sm:text-[2.2rem] leading-tight text-ink-800">
          Conciliação
        </h1>
        <p className="mt-1 text-ink-500 max-w-2xl">
          Cruza payments ↔ earnings ↔ payouts em busca de divergências.
          Roda agora (snapshot de {fmtDateTime(report.runAt)}). Rodar
          toda sexta antes do fechamento mensal é uma boa rotina.
        </p>
      </header>

      {/* Resumo */}
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        <Card
          label="Críticas"
          value={String(report.totalCritical)}
          hint={
            report.totalCritical > 0
              ? "ação imediata"
              : "nada crítico"
          }
          tone={report.totalCritical > 0 ? "terracotta" : "sage"}
        />
        <Card
          label="Warnings"
          value={String(report.totalWarning)}
          hint={
            report.totalWarning > 0
              ? "revisar em breve"
              : "tudo no prazo"
          }
          tone={report.totalWarning > 0 ? "terracotta" : "ink"}
        />
        <Card
          label="Checks rodados"
          value="6"
          hint={
            report.truncated.length > 0
              ? `${report.truncated.length} truncado(s) em 100`
              : "nenhum truncado"
          }
          tone={report.truncated.length > 0 ? "terracotta" : "ink"}
        />
        <Card
          label="Rodado em"
          value={new Date(report.runAt).toLocaleTimeString("pt-BR", {
            hour: "2-digit",
            minute: "2-digit",
          })}
          hint="recarregue a página pra rodar de novo"
          tone="ink"
        />
      </section>

      {totalIssues === 0 ? (
        <section className="rounded-2xl bg-sage-50 border border-sage-200 p-10 text-center">
          <h2 className="font-serif text-[1.4rem] text-sage-800 mb-2">
            Nada pra reconciliar
          </h2>
          <p className="text-sage-700 max-w-md mx-auto">
            Nenhuma divergência detectada entre payments, earnings e
            payouts. Os 6 checks rodaram e tudo bateu. Volte aqui na
            próxima sexta.
          </p>
        </section>
      ) : (
        <>
          {report.totalCritical > 0 && (
            <section className="mb-10">
              <h2 className="font-serif text-[1.3rem] text-terracotta-800 mb-4">
                Críticas ({report.totalCritical})
              </h2>
              <div className="space-y-6">
                {Array.from(critGroups.entries()).map(([kind, items]) => (
                  <DiscrepancyGroup
                    key={kind}
                    kind={kind}
                    items={items}
                    truncated={report.truncated.includes(kind)}
                  />
                ))}
              </div>
            </section>
          )}

          {report.totalWarning > 0 && (
            <section>
              <h2 className="font-serif text-[1.3rem] text-ink-800 mb-4">
                Warnings ({report.totalWarning})
              </h2>
              <div className="space-y-6">
                {Array.from(warnGroups.entries()).map(([kind, items]) => (
                  <DiscrepancyGroup
                    key={kind}
                    kind={kind}
                    items={items}
                    truncated={report.truncated.includes(kind)}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function DiscrepancyGroup({
  kind,
  items,
  truncated,
}: {
  kind: DiscrepancyKind;
  items: Awaited<ReturnType<typeof runReconciliation>>["discrepancies"];
  truncated: boolean;
}) {
  const meta = KIND_LABELS[kind];
  const borderCls =
    meta.severity === "critical"
      ? "border-terracotta-200"
      : "border-ink-200";
  const headerCls =
    meta.severity === "critical"
      ? "bg-terracotta-50 border-b border-terracotta-200"
      : "bg-cream-50 border-b border-ink-100";
  const badgeCls =
    meta.severity === "critical"
      ? "bg-terracotta-100 text-terracotta-800 border-terracotta-300"
      : "bg-cream-100 text-ink-700 border-ink-200";

  return (
    <article className={`rounded-2xl bg-white border ${borderCls} overflow-hidden`}>
      <header className={`px-5 py-3 ${headerCls}`}>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="font-serif text-[1.1rem] text-ink-800">
            {meta.label}
          </h3>
          <span
            className={`inline-flex items-center text-[0.68rem] font-medium uppercase tracking-[0.1em] px-2 py-0.5 rounded-full border ${badgeCls}`}
          >
            {items.length} {items.length === 1 ? "caso" : "casos"}
          </span>
          {truncated && (
            <span className="text-xs text-terracotta-700 font-medium">
              · truncado em 100
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-ink-600">{meta.description}</p>
      </header>

      <ul className="divide-y divide-ink-100">
        {items.map((item, idx) => (
          <li key={`${item.kind}-${item.primaryId}-${idx}`} className="px-5 py-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
              <p className="text-sm text-ink-800 font-medium">
                {item.headline}
              </p>
              <span className="text-[0.7rem] font-mono text-ink-400">
                {fmtDateTime(item.observedAt)}
              </span>
            </div>
            <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-1.5 text-xs mb-3">
              {Object.entries(item.details).map(([k, v]) => (
                <div key={k} className="flex flex-col">
                  <dt className="text-[0.65rem] uppercase tracking-[0.12em] text-ink-400 font-medium">
                    {detailLabel(k)}
                  </dt>
                  <dd>{renderDetailValue(k, v)}</dd>
                </div>
              ))}
              <div className="flex flex-col sm:col-span-2 lg:col-span-1">
                <dt className="text-[0.65rem] uppercase tracking-[0.12em] text-ink-400 font-medium">
                  {item.primaryType}
                </dt>
                <dd className="font-mono text-xs text-ink-500 break-all">
                  {item.primaryId}
                </dd>
              </div>
            </dl>
            <p className="text-xs text-ink-600 bg-cream-50 border border-ink-100 rounded-lg px-3 py-2">
              <span className="font-medium text-ink-800">Ação: </span>
              {item.actionHint}
            </p>
          </li>
        ))}
      </ul>
    </article>
  );
}

function Card({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone: "sage" | "terracotta" | "ink";
}) {
  const toneClasses = {
    sage: "border-sage-200 bg-sage-50",
    terracotta: "border-terracotta-200 bg-terracotta-50",
    ink: "border-ink-100 bg-white",
  }[tone];
  const valueClasses = {
    sage: "text-sage-800",
    terracotta: "text-terracotta-700",
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
