/**
 * Dashboard do painel admin. 4 cards principais + alertas.
 *
 * Métricas vão direto do Supabase via service role (bypassa RLS).
 * Precisão é prioridade — os números mostrados aqui guiam decisões de
 * pagar / não pagar / chamar reunião com médica.
 */

import Link from "next/link";
import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type DashboardData = {
  doctorsActive: number;
  doctorsPending: number;
  payoutsDraft: { count: number; totalCents: number };
  earningsAvailable: { count: number; totalCents: number };
  paymentsThisMonth: { count: number; totalCents: number };
  appointmentsToday: number;
};

async function loadDashboard(): Promise<DashboardData> {
  const supabase = getSupabaseAdmin();
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const tomorrow = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

  const [docsActive, docsPending, payoutsDraft, earningsAvail, paysMonth, appsToday] =
    await Promise.all([
      supabase
        .from("doctors")
        .select("id", { head: true, count: "exact" })
        .eq("status", "active"),
      supabase
        .from("doctors")
        .select("id", { head: true, count: "exact" })
        .in("status", ["invited", "pending"]),
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
    ]);

  const sumCents = (rows: { amount_cents: number }[] | null) =>
    (rows ?? []).reduce((acc, r) => acc + (r.amount_cents ?? 0), 0);

  return {
    doctorsActive: docsActive.count ?? 0,
    doctorsPending: docsPending.count ?? 0,
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
  };
}

function brl(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

export default async function AdminDashboard() {
  const d = await loadDashboard();

  return (
    <div>
      <header className="mb-8">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Visão geral
        </p>
        <h1 className="font-serif text-[2rem] sm:text-[2.4rem] leading-tight text-ink-800">
          Bom dia, operador.
        </h1>
        <p className="mt-2 text-ink-500">
          {new Date().toLocaleDateString("pt-BR", {
            weekday: "long",
            day: "numeric",
            month: "long",
          })}
        </p>
      </header>

      <section className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-10">
        <Card
          label="Médicas ativas"
          value={String(d.doctorsActive)}
          hint={d.doctorsPending > 0 ? `+${d.doctorsPending} aguardando ativação` : "todas operacionais"}
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
          tone="ink"
        />
        <Card
          label="A pagar (saldo das médicas)"
          value={brl(d.earningsAvailable.totalCents)}
          hint={`${d.earningsAvailable.count} earning${d.earningsAvailable.count === 1 ? "" : "s"} disponíve${d.earningsAvailable.count === 1 ? "l" : "is"}`}
          tone="ink"
        />
      </section>

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
            Próximos passos
          </h2>
          <ul className="space-y-3 text-ink-600">
            {d.doctorsActive === 0 && (
              <li className="flex items-start gap-3">
                <span className="mt-1 h-2 w-2 rounded-full bg-terracotta-500 flex-shrink-0" />
                <span>
                  Cadastre a primeira médica em{" "}
                  <Link href="/admin/doctors/new" className="text-sage-700 hover:underline">
                    Médicas → Nova
                  </Link>
                  .
                </span>
              </li>
            )}
            {d.payoutsDraft.count > 0 && (
              <li className="flex items-start gap-3">
                <span className="mt-1 h-2 w-2 rounded-full bg-terracotta-500 flex-shrink-0" />
                <span>
                  Revisar e aprovar{" "}
                  <Link href="/admin/payouts" className="text-sage-700 hover:underline">
                    {d.payoutsDraft.count} repasse{d.payoutsDraft.count === 1 ? "" : "s"}
                  </Link>{" "}
                  ({brl(d.payoutsDraft.totalCents)}).
                </span>
              </li>
            )}
            {d.doctorsActive > 0 && d.payoutsDraft.count === 0 && (
              <li className="flex items-start gap-3">
                <span className="mt-1 h-2 w-2 rounded-full bg-sage-500 flex-shrink-0" />
                <span>Tudo em dia. 🌿</span>
              </li>
            )}
          </ul>
        </div>
      </section>
    </div>
  );
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
