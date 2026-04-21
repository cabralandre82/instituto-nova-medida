/**
 * Dashboard da médica. 4 cards principais focados no que ela precisa
 * decidir agora:
 *   - Consultas hoje (existem? a próxima é quando?)
 *   - Próxima consulta (quem? a que horas?)
 *   - A receber (saldo `available` + `pending` somados)
 *   - Recebido neste mês (pago via payouts confirmados)
 *
 * Tudo via service role, escopado por `doctor_id`. RLS protege em
 * paralelo (Sprint 4.2 vai habilitar policies por role=doctor).
 */

import Link from "next/link";
import { requireDoctor } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { countPendingBillingDocuments } from "@/lib/doctor-finance";
import { getActivePaymentMethod } from "@/lib/doctor-payment-methods";
import {
  formatCurrencyBRL,
  formatDateBR,
  formatTimeBR,
  formatWeekdayLongBR,
} from "@/lib/datetime-br";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type DashboardData = {
  appointmentsToday: number;
  nextAppointment: {
    id: string;
    scheduledAt: string;
    customerName: string | null;
    minutesAway: number;
  } | null;
  pendingCents: number;
  availableCents: number;
  receivedThisMonthCents: number;
  payoutsCount: { draft: number; approved: number; pixSent: number };
  billingDocs: { pendingUpload: number; awaitingValidation: number };
};

async function loadDashboard(doctorId: string): Promise<DashboardData> {
  const supabase = getSupabaseAdmin();

  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const tomorrow = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [appsToday, nextAppt, earningsRows, payoutsMonth, payoutsLifecycle] =
    await Promise.all([
      supabase
        .from("appointments")
        .select("id", { head: true, count: "exact" })
        .eq("doctor_id", doctorId)
        .gte("scheduled_at", todayStart.toISOString())
        .lt("scheduled_at", tomorrow.toISOString())
        .neq("status", "cancelled"),
      supabase
        .from("appointments")
        .select("id, scheduled_at, customer_id, customers ( name )")
        .eq("doctor_id", doctorId)
        .gte("scheduled_at", now.toISOString())
        .neq("status", "cancelled")
        .order("scheduled_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("doctor_earnings")
        .select("amount_cents, status")
        .eq("doctor_id", doctorId)
        .in("status", ["pending", "available"]),
      supabase
        .from("doctor_payouts")
        .select("amount_cents, confirmed_at")
        .eq("doctor_id", doctorId)
        .eq("status", "confirmed")
        .gte("confirmed_at", monthStart.toISOString()),
      supabase
        .from("doctor_payouts")
        .select("status")
        .eq("doctor_id", doctorId)
        .in("status", ["draft", "approved", "pix_sent"]),
    ]);

  let pendingCents = 0;
  let availableCents = 0;
  for (const row of (earningsRows.data ?? []) as { amount_cents: number; status: string }[]) {
    if (row.status === "pending") pendingCents += row.amount_cents ?? 0;
    if (row.status === "available") availableCents += row.amount_cents ?? 0;
  }

  const receivedThisMonthCents = ((payoutsMonth.data ?? []) as { amount_cents: number }[]).reduce(
    (acc, r) => acc + (r.amount_cents ?? 0),
    0
  );

  const payoutsCount = { draft: 0, approved: 0, pixSent: 0 };
  for (const row of (payoutsLifecycle.data ?? []) as { status: string }[]) {
    if (row.status === "draft") payoutsCount.draft += 1;
    if (row.status === "approved") payoutsCount.approved += 1;
    if (row.status === "pix_sent") payoutsCount.pixSent += 1;
  }

  let nextAppointment: DashboardData["nextAppointment"] = null;
  if (nextAppt.data) {
    const row = nextAppt.data as {
      id: string;
      scheduled_at: string;
      customers: { name: string | null } | { name: string | null }[] | null;
    };
    const customer = Array.isArray(row.customers) ? row.customers[0] : row.customers;
    const minutesAway = Math.round(
      (new Date(row.scheduled_at).getTime() - now.getTime()) / 60000
    );
    nextAppointment = {
      id: row.id,
      scheduledAt: row.scheduled_at,
      customerName: customer?.name ?? null,
      minutesAway,
    };
  }

  const billingDocs = await countPendingBillingDocuments(supabase, doctorId);

  return {
    appointmentsToday: appsToday.count ?? 0,
    nextAppointment,
    pendingCents,
    availableCents,
    receivedThisMonthCents,
    payoutsCount,
    billingDocs,
  };
}

function brl(cents: number): string {
  return formatCurrencyBRL(cents);
}

function formatNextLabel(scheduledAt: string, minutesAway: number): string {
  if (minutesAway <= 60) return `em ${minutesAway} min`;
  const date = new Date(scheduledAt);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const time = formatTimeBR(date);
  if (sameDay) return `hoje às ${time}`;
  const day = formatDateBR(date, { day: "2-digit", month: "short" });
  return `${day} · ${time}`;
}

export default async function DoctorDashboard() {
  const { doctorId } = await requireDoctor();
  const d = await loadDashboard(doctorId);
  const pix = await getActivePaymentMethod(getSupabaseAdmin(), doctorId);

  const greetingHour = new Date().getHours();
  const greeting =
    greetingHour < 12
      ? "Bom dia."
      : greetingHour < 18
      ? "Boa tarde."
      : "Boa noite.";

  return (
    <div>
      <header className="mb-8">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Visão geral
        </p>
        <h1 className="font-serif text-[2rem] sm:text-[2.4rem] leading-tight text-ink-800">
          {greeting}
        </h1>
        <p className="mt-2 text-ink-500">{formatWeekdayLongBR(new Date())}</p>
      </header>

      {!pix && (
        <div className="mb-6 rounded-2xl border border-terracotta-300 bg-terracotta-50 p-4 sm:p-5 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-terracotta-800">
            <strong>Cadastre seu PIX para liberar os repasses.</strong>{" "}
            Sem chave cadastrada, o fechamento mensal não consegue gerar seu
            pagamento automaticamente.
          </p>
          <Link
            href="/medico/perfil/pix"
            className="inline-flex items-center px-3 py-1.5 rounded-lg bg-ink-800 text-white text-sm font-medium hover:bg-ink-900 whitespace-nowrap"
          >
            Cadastrar PIX →
          </Link>
        </div>
      )}

      {d.billingDocs.pendingUpload > 0 && (
        <div className="mb-6 rounded-2xl border border-terracotta-200 bg-terracotta-50 p-4 sm:p-5 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-terracotta-800">
            <strong>
              NF-e pendente em {d.billingDocs.pendingUpload} repasse
              {d.billingDocs.pendingUpload === 1 ? "" : "s"} confirmado
              {d.billingDocs.pendingUpload === 1 ? "" : "s"}.
            </strong>{" "}
            Emita e envie a nota para manter o ciclo fiscal em dia.
          </p>
          <Link
            href="/medico/repasses"
            className="inline-flex items-center px-3 py-1.5 rounded-lg bg-ink-800 text-white text-sm font-medium hover:bg-ink-900 whitespace-nowrap"
          >
            Ver repasses →
          </Link>
        </div>
      )}

      <section className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-10">
        <Card
          label="Consultas hoje"
          value={String(d.appointmentsToday)}
          hint={
            d.appointmentsToday === 0
              ? "agenda livre"
              : d.appointmentsToday === 1
              ? "1 paciente agendado"
              : `${d.appointmentsToday} pacientes agendados`
          }
          href="/medico/agenda"
          tone={d.appointmentsToday > 0 ? "sage" : "ink"}
        />
        <Card
          label="Próxima consulta"
          value={d.nextAppointment ? formatNextLabel(d.nextAppointment.scheduledAt, d.nextAppointment.minutesAway) : "—"}
          hint={
            d.nextAppointment
              ? d.nextAppointment.customerName ?? "paciente sem nome cadastrado"
              : "nenhuma consulta futura"
          }
          href={d.nextAppointment ? "/medico/agenda" : undefined}
          tone={d.nextAppointment && d.nextAppointment.minutesAway <= 30 ? "terracotta" : "ink"}
        />
        <Card
          label="A receber"
          value={brl(d.pendingCents + d.availableCents)}
          hint={
            d.availableCents > 0
              ? `${brl(d.availableCents)} disponível agora`
              : "nada liberado ainda"
          }
          href="/medico/ganhos"
          tone={d.availableCents > 0 ? "sage" : "ink"}
        />
        <Card
          label="Recebido neste mês"
          value={brl(d.receivedThisMonthCents)}
          hint={
            d.payoutsCount.pixSent + d.payoutsCount.approved > 0
              ? `+ ${d.payoutsCount.pixSent + d.payoutsCount.approved} repasse${d.payoutsCount.pixSent + d.payoutsCount.approved === 1 ? "" : "s"} em andamento`
              : "via PIX confirmados"
          }
          href="/medico/repasses"
          tone="ink"
        />
      </section>

      <section className="grid lg:grid-cols-2 gap-6">
        <div className="rounded-2xl bg-white border border-ink-100 p-6">
          <h2 className="font-serif text-[1.25rem] text-ink-800 mb-4">Próxima consulta</h2>
          {d.nextAppointment ? (
            <div>
              <p className="text-ink-800 text-[1.1rem] font-medium">
                {d.nextAppointment.customerName ?? "Paciente"}
              </p>
              <p className="mt-1 text-ink-500">
                {formatNextLabel(d.nextAppointment.scheduledAt, d.nextAppointment.minutesAway)}
              </p>
              <Link
                href="/medico/agenda"
                className="mt-5 inline-block rounded-xl bg-ink-800 hover:bg-ink-900 text-white font-medium px-5 py-2.5 transition-colors"
              >
                Abrir agenda
              </Link>
            </div>
          ) : (
            <p className="text-ink-500">
              Nenhuma consulta futura. Sua agenda fica visível para
              pacientes assim que o operador ativá-la.
            </p>
          )}
        </div>

        <div className="rounded-2xl bg-white border border-ink-100 p-6">
          <h2 className="font-serif text-[1.25rem] text-ink-800 mb-4">Próximos passos</h2>
          <ul className="space-y-3 text-ink-600">
            {d.availableCents > 0 && (
              <li className="flex items-start gap-3">
                <span className="mt-1 h-2 w-2 rounded-full bg-sage-500 flex-shrink-0" />
                <span>
                  <strong className="text-ink-800">{brl(d.availableCents)}</strong>{" "}
                  já liberado para o próximo repasse.{" "}
                  <Link href="/medico/ganhos" className="text-sage-700 hover:underline">
                    Ver detalhes
                  </Link>
                  .
                </span>
              </li>
            )}
            {d.payoutsCount.draft + d.payoutsCount.approved + d.payoutsCount.pixSent > 0 && (
              <li className="flex items-start gap-3">
                <span className="mt-1 h-2 w-2 rounded-full bg-terracotta-500 flex-shrink-0" />
                <span>
                  Você tem repasse em processamento.{" "}
                  <Link href="/medico/repasses" className="text-sage-700 hover:underline">
                    Acompanhar
                  </Link>
                  .
                </span>
              </li>
            )}
            {d.availableCents === 0 &&
              d.payoutsCount.draft + d.payoutsCount.approved + d.payoutsCount.pixSent === 0 &&
              d.appointmentsToday === 0 && (
                <li className="flex items-start gap-3">
                  <span className="mt-1 h-2 w-2 rounded-full bg-sage-500 flex-shrink-0" />
                  <span>Tudo em ordem.</span>
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
      <p className={`font-serif text-[1.7rem] sm:text-[2rem] leading-none ${valueClasses}`}>
        {value}
      </p>
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
