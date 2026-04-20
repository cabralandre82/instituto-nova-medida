/**
 * Dashboard do painel admin — home do operador solo (D-045 · 3.A).
 *
 * Organização da tela (de cima pra baixo):
 *   1. Header com saudação + data.
 *   2. **Inbox**: ações pendentes ordenadas por urgência (overdue →
 *      due_soon), com SLA e idade do item mais antigo. É o primeiro
 *      que o admin vê ao abrir o painel — tudo que precisa ser feito
 *      hoje está aqui.
 *   3. Métricas financeiras (receita do mês, saldo das médicas, repasses).
 *   4. Health do cron Daily (reconciliação).
 *   5. Agenda do dia.
 *
 * A inbox consome `loadAdminInbox` de `src/lib/admin-inbox.ts` — fonte
 * única que a onda 3.D reaproveitará pra enviar rollup matinal por WA.
 */

import Link from "next/link";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  listDoctorReliabilityOverview,
  RELIABILITY_SOFT_WARN,
} from "@/lib/reliability";
import { getReconciliationCounts } from "@/lib/reconciliation";
import {
  loadAdminInbox,
  formatAge,
  type InboxItem,
  type AdminInbox,
} from "@/lib/admin-inbox";

export const dynamic = "force-dynamic";

type DashboardData = {
  doctorsActive: number;
  payoutsDraft: { count: number; totalCents: number };
  earningsAvailable: { count: number; totalCents: number };
  paymentsThisMonth: { count: number; totalCents: number };
  appointmentsToday: number;
  reconciledLast24hBySource: Record<string, number>;
  reconcileStuck: number;
  reliabilityPaused: number;
  reliabilitySoftWarn: number;
  reconciliationCritical: number;
  reconciliationWarning: number;
  inbox: AdminInbox;
};

async function loadDashboard(): Promise<DashboardData> {
  const supabase = getSupabaseAdmin();
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const tomorrow = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

  const stuckCutoff = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [
    docsActive,
    payoutsDraft,
    earningsAvail,
    paysMonth,
    appsToday,
    reconcileStuck,
    reconciledRecent,
    reliabilityOverview,
    reconciliation,
    inbox,
  ] = await Promise.all([
    supabase
      .from("doctors")
      .select("id", { head: true, count: "exact" })
      .eq("status", "active"),
    supabase
      .from("doctor_payouts")
      .select("amount_cents", { count: "exact" })
      .eq("status", "draft"),
    supabase
      .from("doctor_earnings")
      .select("amount_cents", { count: "exact" })
      .eq("status", "available"),
    supabase
      .from("payments")
      .select("amount_cents", { count: "exact" })
      .in("status", ["RECEIVED", "CONFIRMED"])
      .gte("created_at", monthStart.toISOString()),
    supabase
      .from("appointments")
      .select("id", { head: true, count: "exact" })
      .gte("scheduled_at", todayStart.toISOString())
      .lt("scheduled_at", tomorrow.toISOString()),
    supabase
      .from("appointments")
      .select("id", { head: true, count: "exact" })
      .in("status", ["scheduled", "confirmed", "in_progress"])
      .not("video_room_name", "is", null)
      .lt("scheduled_at", stuckCutoff.toISOString())
      .is("reconciled_at", null),
    supabase
      .from("appointments")
      .select("reconciled_by_source")
      .gte("reconciled_at", last24h.toISOString())
      .not("reconciled_by_source", "is", null),
    listDoctorReliabilityOverview(),
    getReconciliationCounts(),
    loadAdminInbox(supabase),
  ]);

  const sumCents = (rows: { amount_cents: number }[] | null) =>
    (rows ?? []).reduce((acc, r) => acc + (r.amount_cents ?? 0), 0);

  return {
    doctorsActive: docsActive.count ?? 0,
    payoutsDraft: {
      count: payoutsDraft.count ?? 0,
      totalCents: sumCents(payoutsDraft.data as { amount_cents: number }[] | null),
    },
    earningsAvailable: {
      count: earningsAvail.count ?? 0,
      totalCents: sumCents(earningsAvail.data as { amount_cents: number }[] | null),
    },
    paymentsThisMonth: {
      count: paysMonth.count ?? 0,
      totalCents: sumCents(paysMonth.data as { amount_cents: number }[] | null),
    },
    appointmentsToday: appsToday.count ?? 0,
    reconcileStuck: reconcileStuck.count ?? 0,
    reconciledLast24hBySource: countBySource(
      reconciledRecent.data as { reconciled_by_source: string | null }[] | null
    ),
    reliabilityPaused: reliabilityOverview.filter((r) => r.isPaused).length,
    reliabilitySoftWarn: reliabilityOverview.filter(
      (r) => !r.isPaused && r.isInSoftWarn
    ).length,
    reconciliationCritical: reconciliation.totalCritical,
    reconciliationWarning: reconciliation.totalWarning,
    inbox,
  };
}

function countBySource(
  rows: { reconciled_by_source: string | null }[] | null
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows ?? []) {
    const key = r.reconciled_by_source ?? "unknown";
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function brl(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function sourceLabel(source: string): string {
  switch (source) {
    case "daily_webhook":
      return "webhook";
    case "daily_cron":
      return "cron";
    case "admin_manual":
      return "admin";
    default:
      return source;
  }
}

export default async function AdminDashboard() {
  const d = await loadDashboard();

  return (
    <div>
      <header className="mb-8">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Inbox do operador
        </p>
        <h1 className="font-serif text-[2rem] sm:text-[2.4rem] leading-tight text-ink-800">
          {greeting()}.
        </h1>
        <p className="mt-2 text-ink-500">
          {new Date().toLocaleDateString("pt-BR", {
            weekday: "long",
            day: "numeric",
            month: "long",
          })}
          {" · "}
          <InboxSummaryInline inbox={d.inbox} />
        </p>
      </header>

      {/* ========== 1. INBOX ========== */}
      <section className="mb-10">
        <InboxSection inbox={d.inbox} />
      </section>

      {/* ========== 2. MÉTRICAS FINANCEIRAS ========== */}
      <section className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-8">
        <Card
          label="Médicas ativas"
          value={String(d.doctorsActive)}
          hint={d.doctorsActive > 0 ? "operacionais" : "cadastre a primeira"}
          href="/admin/doctors"
          tone="sage"
        />
        <Card
          label="Repasses para revisar"
          value={String(d.payoutsDraft.count)}
          hint={d.payoutsDraft.count > 0 ? brl(d.payoutsDraft.totalCents) : "nada pendente"}
          href="/admin/payouts"
          tone={d.payoutsDraft.count > 0 ? "terracotta" : "ink"}
        />
        <Card
          label="Receita do mês"
          value={brl(d.paymentsThisMonth.totalCents)}
          hint={`${d.paymentsThisMonth.count} pagamento${d.paymentsThisMonth.count === 1 ? "" : "s"}`}
          href="/admin/financeiro"
          tone="ink"
        />
        <Card
          label="A pagar (saldo médicas)"
          value={brl(d.earningsAvailable.totalCents)}
          hint={`${d.earningsAvailable.count} earning${d.earningsAvailable.count === 1 ? "" : "s"} disponíve${d.earningsAvailable.count === 1 ? "l" : "is"}`}
          href="/admin/payouts"
          tone="ink"
        />
      </section>

      {/* ========== 3. HEALTH CRON ========== */}
      <section className="rounded-2xl bg-cream-50 border border-ink-100 p-5 mb-6">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <p className="text-[0.72rem] uppercase tracking-[0.14em] text-ink-500 font-medium">
              Reconciliação Daily · últimas 24h
            </p>
            <p className="mt-1 text-sm text-ink-700">
              {Object.keys(d.reconciledLast24hBySource).length === 0 ? (
                <span className="text-ink-500">
                  Nenhum appointment reconciliado ainda — esperado em ambiente
                  sem consultas recentes.
                </span>
              ) : (
                <span>
                  {Object.entries(d.reconciledLast24hBySource)
                    .map(
                      ([source, count]) =>
                        `${count} via ${sourceLabel(source)}`
                    )
                    .join(" · ")}
                </span>
              )}
            </p>
          </div>
          {d.reconcileStuck > 0 ? (
            <div className="rounded-xl bg-terracotta-50 border border-terracotta-200 px-3 py-2 text-sm text-terracotta-700 font-medium">
              {d.reconcileStuck} em atraso (&gt;2h)
            </div>
          ) : (
            <div className="rounded-xl bg-sage-50 border border-sage-200 px-3 py-2 text-sm text-sage-700 font-medium">
              Cron saudável
            </div>
          )}
        </div>
      </section>

      {/* ========== 4. AGENDA DO DIA + ALERTAS LATERAIS ========== */}
      <section className="grid lg:grid-cols-2 gap-6">
        <div className="rounded-2xl bg-white border border-ink-100 p-6">
          <h2 className="font-serif text-[1.25rem] text-ink-800 mb-4">
            Hoje na agenda
          </h2>
          {d.appointmentsToday > 0 ? (
            <p className="text-ink-600">
              <strong className="text-ink-800 text-2xl mr-2">
                {d.appointmentsToday}
              </strong>
              consulta{d.appointmentsToday === 1 ? "" : "s"} agendada
              {d.appointmentsToday === 1 ? "" : "s"} para hoje.
            </p>
          ) : (
            <p className="text-ink-500">
              Sem consultas marcadas para hoje. Agendamentos abrem quando
              ao menos uma médica configurar a agenda.
            </p>
          )}
        </div>

        <div className="rounded-2xl bg-white border border-ink-100 p-6">
          <h2 className="font-serif text-[1.25rem] text-ink-800 mb-4">
            Sinalizações complementares
          </h2>
          <ul className="space-y-3 text-ink-600 text-sm">
            {d.reliabilityPaused > 0 && (
              <li className="flex items-start gap-3">
                <span className="mt-1 h-2 w-2 rounded-full bg-terracotta-500 flex-shrink-0" />
                <span>
                  <strong className="text-ink-800">{d.reliabilityPaused}</strong>{" "}
                  médica{d.reliabilityPaused === 1 ? "" : "s"} pausada
                  {d.reliabilityPaused === 1 ? "" : "s"} por confiabilidade.{" "}
                  <Link
                    href="/admin/reliability"
                    className="text-sage-700 hover:underline"
                  >
                    Rever
                  </Link>
                </span>
              </li>
            )}
            {d.reliabilitySoftWarn > 0 && (
              <li className="flex items-start gap-3">
                <span className="mt-1 h-2 w-2 rounded-full bg-terracotta-300 flex-shrink-0" />
                <span>
                  {d.reliabilitySoftWarn} médica{d.reliabilitySoftWarn === 1 ? "" : "s"} em alerta ({RELIABILITY_SOFT_WARN}+ eventos/30d).{" "}
                  <Link
                    href="/admin/reliability"
                    className="text-sage-700 hover:underline"
                  >
                    Acompanhar
                  </Link>
                </span>
              </li>
            )}
            {d.reconciliationCritical > 0 && (
              <li className="flex items-start gap-3">
                <span className="mt-1 h-2 w-2 rounded-full bg-terracotta-500 flex-shrink-0" />
                <span>
                  <strong className="text-ink-800">
                    {d.reconciliationCritical}
                  </strong>{" "}
                  divergência{d.reconciliationCritical === 1 ? "" : "s"}{" "}
                  crítica{d.reconciliationCritical === 1 ? "" : "s"} financeira
                  {d.reconciliationCritical === 1 ? "" : "s"}.{" "}
                  <Link
                    href="/admin/financeiro"
                    className="text-sage-700 hover:underline"
                  >
                    Investigar
                  </Link>
                </span>
              </li>
            )}
            {d.reconciliationWarning > 0 && (
              <li className="flex items-start gap-3">
                <span className="mt-1 h-2 w-2 rounded-full bg-terracotta-300 flex-shrink-0" />
                <span>
                  {d.reconciliationWarning} warning
                  {d.reconciliationWarning === 1 ? "" : "s"} de conciliação.{" "}
                  <Link
                    href="/admin/financeiro"
                    className="text-sage-700 hover:underline"
                  >
                    Revisar
                  </Link>
                </span>
              </li>
            )}
            {d.reliabilityPaused === 0 &&
              d.reliabilitySoftWarn === 0 &&
              d.reconciliationCritical === 0 &&
              d.reconciliationWarning === 0 && (
                <li className="text-ink-500">
                  Nenhuma sinalização complementar no momento.
                </li>
              )}
          </ul>
        </div>
      </section>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Componentes
// ────────────────────────────────────────────────────────────────────────

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Bom dia, operador";
  if (h < 18) return "Boa tarde, operador";
  return "Boa noite, operador";
}

function InboxSummaryInline({ inbox }: { inbox: AdminInbox }) {
  if (inbox.counts.total === 0) {
    return <span className="text-sage-700">inbox zerada 🌿</span>;
  }
  const parts: string[] = [];
  if (inbox.counts.overdue > 0) {
    parts.push(`${inbox.counts.overdue} urgente${inbox.counts.overdue === 1 ? "" : "s"}`);
  }
  if (inbox.counts.dueSoon > 0) {
    parts.push(`${inbox.counts.dueSoon} em atenção`);
  }
  return <span>{parts.join(" · ")}</span>;
}

function InboxSection({ inbox }: { inbox: AdminInbox }) {
  if (inbox.items.length === 0) {
    return (
      <div className="rounded-2xl border border-sage-200 bg-sage-50 p-8 text-center">
        <p className="font-serif text-[1.4rem] text-sage-800 mb-1">
          Tudo em dia por aqui.
        </p>
        <p className="text-sm text-sage-700">
          Nenhuma ação pendente no momento. Gerado{" "}
          {new Date(inbox.generatedAt).toLocaleTimeString("pt-BR", {
            hour: "2-digit",
            minute: "2-digit",
          })}
          .
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {inbox.items.map((item) => (
        <InboxCard key={item.id} item={item} />
      ))}
    </div>
  );
}

function InboxCard({ item }: { item: InboxItem }) {
  const isOverdue = item.urgency === "overdue";

  const borderClass = isOverdue
    ? "border-terracotta-300"
    : "border-ink-200";
  const bgClass = isOverdue ? "bg-terracotta-50" : "bg-cream-100";
  const dotClass = isOverdue ? "bg-terracotta-500" : "bg-terracotta-300";
  const countClass = isOverdue
    ? "text-terracotta-700 bg-terracotta-100"
    : "text-ink-700 bg-ink-100";

  return (
    <Link
      href={item.href}
      className={`block rounded-2xl border ${borderClass} ${bgClass} p-5 transition-colors hover:border-ink-400`}
    >
      <div className="flex items-start gap-4">
        <span className={`mt-2 h-2.5 w-2.5 rounded-full ${dotClass} flex-shrink-0`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <h3 className="font-serif text-[1.15rem] text-ink-800 leading-tight">
              {item.title}
            </h3>
            <span
              className={`text-[0.78rem] font-medium px-2 py-0.5 rounded-full ${countClass} flex-shrink-0`}
            >
              {item.count}
            </span>
          </div>
          <p className="mt-1 text-sm text-ink-600">{item.description}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.78rem] text-ink-500">
            {item.oldestAgeHours != null && (
              <span className="font-medium text-ink-700">
                mais antigo {formatAge(item.oldestAgeHours)}
              </span>
            )}
            {item.slaHours != null && (
              <span>SLA {formatSla(item.slaHours)}</span>
            )}
            <span className="text-sage-700">abrir →</span>
          </div>
        </div>
      </div>
    </Link>
  );
}

function formatSla(hours: number): string {
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days === 1 ? "1 dia" : `${days} dias`;
}

function Card({
  label,
  value,
  hint,
  href,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  href?: string;
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

  const inner = (
    <>
      <p className="text-[0.78rem] uppercase tracking-[0.14em] text-ink-500 font-medium mb-2">
        {label}
      </p>
      <p className={`font-serif text-[2rem] leading-none ${valueClasses}`}>{value}</p>
      <p className="mt-2 text-sm text-ink-500">{hint}</p>
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        className={`block rounded-2xl border p-5 transition-colors hover:border-ink-300 ${toneClasses}`}
      >
        {inner}
      </Link>
    );
  }
  return <div className={`rounded-2xl border p-5 ${toneClasses}`}>{inner}</div>;
}
