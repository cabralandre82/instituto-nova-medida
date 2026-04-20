/**
 * /admin/pacientes/[id] — D-045 · 3.B
 *
 * Ficha consolidada do paciente pro operador solo. Agrega em uma só
 * tela o que antes exigia abrir /admin/fulfillments, /admin/refunds e
 * consultar appointments manualmente.
 *
 * Organização:
 *   1. Header com nome + contato + vinculo auth + cadastro
 *   2. Métricas resumo (stats) em 4 cards
 *   3. Dados cadastrais + endereço
 *   4. Plano ativo (se houver)
 *   5. Timeline cronológica (mistura appointments + fulfillments +
 *      payments + acceptances). Mais recente primeiro.
 *   6. Tabelas detalhadas (appointments, fulfillments, payments,
 *      acceptances) com links diretos pra respectiva área.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  buildPatientTimeline,
  loadPatientProfile,
  summarizePatient,
  type PatientProfile,
  type TimelineEvent,
  type TimelineEventKind,
} from "@/lib/patient-profile";

export const dynamic = "force-dynamic";

type Params = { id: string };

export default async function AdminPatientProfilePage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { id } = await params;
  const supabase = getSupabaseAdmin();
  const profile = await loadPatientProfile(supabase, id);
  if (!profile) notFound();

  const timeline = buildPatientTimeline(profile);
  const stats = summarizePatient(profile);

  return (
    <div>
      <header className="mb-6">
        <Link
          href="/admin/pacientes"
          className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium hover:text-sage-800 transition-colors inline-flex items-center gap-1"
        >
          ← Pacientes
        </Link>
        <h1 className="font-serif text-[2rem] sm:text-[2.4rem] leading-tight text-ink-800 mt-2">
          {profile.customer.name}
        </h1>
        <p className="mt-2 text-ink-500 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <span>{profile.customer.email}</span>
          <span>{profile.customer.phone}</span>
          <span className="font-mono">{formatCpf(profile.customer.cpf)}</span>
          <span>
            Cadastro{" "}
            {new Date(profile.customer.createdAt).toLocaleDateString("pt-BR")}
          </span>
          {profile.customer.userId ? (
            <span className="text-sage-700">✓ acesso liberado</span>
          ) : (
            <span className="text-ink-400">sem acesso logado</span>
          )}
        </p>
      </header>

      {/* ========== STATS ========== */}
      <section className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-8">
        <StatCard
          label="Total pago (líquido)"
          value={brl(stats.netPaidCents)}
          hint={
            stats.totalRefundedCents > 0
              ? `${brl(stats.totalRefundedCents)} estornado`
              : `${brl(stats.totalPaidCents)} bruto`
          }
        />
        <StatCard
          label="Consultas"
          value={String(stats.appointmentsCount)}
          hint={`${stats.completedAppointmentsCount} finalizada${stats.completedAppointmentsCount === 1 ? "" : "s"}`}
        />
        <StatCard
          label="Plano ativo"
          value={stats.activePlanName ?? "—"}
          hint={stats.activePlanName ? "em curso" : "nenhum no momento"}
        />
        <StatCard
          label="Fulfillments"
          value={String(profile.fulfillments.length)}
          hint={
            profile.fulfillments.length > 0
              ? statusCounts(profile.fulfillments.map((f) => f.status))
              : "nenhum criado"
          }
        />
      </section>

      {/* ========== DADOS + ENDEREÇO ========== */}
      <section className="grid lg:grid-cols-2 gap-6 mb-8">
        <div className="rounded-2xl border border-ink-100 bg-white p-6">
          <h2 className="font-serif text-[1.15rem] text-ink-800 mb-3">
            Dados cadastrais
          </h2>
          <dl className="space-y-2 text-sm">
            <Field label="Nome completo" value={profile.customer.name} />
            <Field label="CPF" value={formatCpf(profile.customer.cpf)} mono />
            <Field label="E-mail" value={profile.customer.email} />
            <Field label="Telefone" value={profile.customer.phone} />
            <Field
              label="Asaas customer"
              value={profile.customer.asaasCustomerId ?? "—"}
              mono
            />
            <Field
              label="Auth user"
              value={
                profile.customer.userId
                  ? `${profile.customer.userId.slice(0, 8)}…`
                  : "não vinculado"
              }
              mono={!!profile.customer.userId}
            />
          </dl>
        </div>
        <div className="rounded-2xl border border-ink-100 bg-white p-6">
          <h2 className="font-serif text-[1.15rem] text-ink-800 mb-3">
            Endereço de entrega cadastrado
          </h2>
          {profile.customer.address.zipcode ? (
            <dl className="space-y-2 text-sm">
              <Field
                label="CEP"
                value={profile.customer.address.zipcode ?? "—"}
                mono
              />
              <Field
                label="Logradouro"
                value={[
                  profile.customer.address.street,
                  profile.customer.address.number,
                ]
                  .filter(Boolean)
                  .join(", ") || "—"}
              />
              {profile.customer.address.complement && (
                <Field
                  label="Complemento"
                  value={profile.customer.address.complement}
                />
              )}
              <Field
                label="Bairro"
                value={profile.customer.address.district ?? "—"}
              />
              <Field
                label="Cidade / UF"
                value={[
                  profile.customer.address.city,
                  profile.customer.address.state,
                ]
                  .filter(Boolean)
                  .join(" / ") || "—"}
              />
            </dl>
          ) : (
            <p className="text-sm text-ink-500">
              Paciente ainda não forneceu endereço (acontece no aceite
              do plano).
            </p>
          )}
        </div>
      </section>

      {/* ========== TIMELINE ========== */}
      <section className="rounded-2xl border border-ink-100 bg-white p-6 mb-8">
        <h2 className="font-serif text-[1.25rem] text-ink-800 mb-4">
          Timeline
        </h2>
        {timeline.length === 0 ? (
          <p className="text-ink-500 text-sm">
            Sem eventos registrados. O paciente ainda não agendou
            consulta ou passou por aceite/pagamento.
          </p>
        ) : (
          <ol className="space-y-4">
            {timeline.map((ev, idx) => (
              <TimelineRow key={`${ev.refId}-${ev.kind}-${idx}`} ev={ev} />
            ))}
          </ol>
        )}
      </section>

      {/* ========== FULFILLMENTS ========== */}
      {profile.fulfillments.length > 0 && (
        <section className="mb-8">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="font-serif text-[1.25rem] text-ink-800">
              Fulfillments ({profile.fulfillments.length})
            </h2>
          </div>
          <div className="rounded-2xl border border-ink-100 bg-white overflow-hidden">
            <table className="w-full">
              <thead className="bg-cream-50 border-b border-ink-100">
                <tr className="text-left text-[0.72rem] uppercase tracking-[0.14em] text-ink-500">
                  <th className="px-4 py-3 font-medium">Plano</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium hidden md:table-cell">
                    Criado
                  </th>
                  <th className="px-4 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {profile.fulfillments.map((f) => (
                  <tr
                    key={f.id}
                    className="border-b border-ink-100 last:border-0"
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-ink-800">
                        {f.planName}
                      </div>
                      {f.planMedication && (
                        <div className="text-xs text-ink-500">
                          {f.planMedication}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <FulfillmentStatusPill status={f.status} />
                    </td>
                    <td className="px-4 py-3 text-sm text-ink-500 hidden md:table-cell">
                      {new Date(f.createdAt).toLocaleDateString("pt-BR")}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/admin/fulfillments/${f.id}`}
                        className="text-sm text-sage-700 hover:underline"
                      >
                        Abrir →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ========== APPOINTMENTS ========== */}
      {profile.appointments.length > 0 && (
        <section className="mb-8">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="font-serif text-[1.25rem] text-ink-800">
              Consultas ({profile.appointments.length})
            </h2>
          </div>
          <div className="rounded-2xl border border-ink-100 bg-white overflow-hidden">
            <table className="w-full">
              <thead className="bg-cream-50 border-b border-ink-100">
                <tr className="text-left text-[0.72rem] uppercase tracking-[0.14em] text-ink-500">
                  <th className="px-4 py-3 font-medium">Data</th>
                  <th className="px-4 py-3 font-medium hidden md:table-cell">
                    Médica
                  </th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium hidden lg:table-cell">
                    Finalizada
                  </th>
                </tr>
              </thead>
              <tbody>
                {profile.appointments.map((a) => (
                  <tr
                    key={a.id}
                    className="border-b border-ink-100 last:border-0 hover:bg-cream-50 transition-colors"
                  >
                    <td className="px-4 py-3 text-sm">
                      <div className="text-ink-800">
                        {new Date(a.scheduledAt).toLocaleDateString("pt-BR")}
                      </div>
                      <div className="text-xs text-ink-500">
                        {new Date(a.scheduledAt).toLocaleTimeString("pt-BR", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-ink-600 hidden md:table-cell">
                      {a.doctorName ?? "—"}
                      {a.doctorCrm && (
                        <div className="text-xs text-ink-400">
                          {a.doctorCrm}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <AppointmentStatusPill
                        status={a.status}
                        refund={a.refundRequired && !a.refundProcessedAt}
                      />
                    </td>
                    <td className="px-4 py-3 text-sm text-ink-500 hidden lg:table-cell">
                      {a.finalizedAt
                        ? new Date(a.finalizedAt).toLocaleDateString("pt-BR")
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ========== PAYMENTS ========== */}
      {profile.payments.length > 0 && (
        <section className="mb-8">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="font-serif text-[1.25rem] text-ink-800">
              Pagamentos ({profile.payments.length})
            </h2>
          </div>
          <div className="rounded-2xl border border-ink-100 bg-white overflow-hidden">
            <table className="w-full">
              <thead className="bg-cream-50 border-b border-ink-100">
                <tr className="text-left text-[0.72rem] uppercase tracking-[0.14em] text-ink-500">
                  <th className="px-4 py-3 font-medium">Plano</th>
                  <th className="px-4 py-3 font-medium">Valor</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium hidden md:table-cell">
                    Criado
                  </th>
                </tr>
              </thead>
              <tbody>
                {profile.payments.map((p) => (
                  <tr
                    key={p.id}
                    className="border-b border-ink-100 last:border-0"
                  >
                    <td className="px-4 py-3 text-sm text-ink-800">
                      {p.planName ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-sm font-medium text-ink-800">
                      {brl(p.amountCents)}
                      <div className="text-xs text-ink-400">
                        {p.billingType}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <PaymentStatusPill status={p.status} />
                    </td>
                    <td className="px-4 py-3 text-sm text-ink-500 hidden md:table-cell">
                      {new Date(p.createdAt).toLocaleDateString("pt-BR")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ========== ACCEPTANCES ========== */}
      {profile.acceptances.length > 0 && (
        <section className="mb-8">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="font-serif text-[1.25rem] text-ink-800">
              Aceites assinados ({profile.acceptances.length})
            </h2>
          </div>
          <div className="rounded-2xl border border-ink-100 bg-white overflow-hidden">
            <table className="w-full">
              <thead className="bg-cream-50 border-b border-ink-100">
                <tr className="text-left text-[0.72rem] uppercase tracking-[0.14em] text-ink-500">
                  <th className="px-4 py-3 font-medium">Plano</th>
                  <th className="px-4 py-3 font-medium">Assinado em</th>
                  <th className="px-4 py-3 font-medium">Versão</th>
                  <th className="px-4 py-3 font-medium">Hash</th>
                </tr>
              </thead>
              <tbody>
                {profile.acceptances.map((a) => (
                  <tr
                    key={a.id}
                    className="border-b border-ink-100 last:border-0"
                  >
                    <td className="px-4 py-3 text-sm text-ink-800">
                      {a.planName ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-sm text-ink-600">
                      {new Date(a.acceptedAt).toLocaleString("pt-BR")}
                    </td>
                    <td className="px-4 py-3 text-sm text-ink-500 font-mono">
                      {a.termsVersion}
                    </td>
                    <td className="px-4 py-3 text-xs text-ink-400 font-mono">
                      {a.contentHash.slice(0, 12)}…
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function brl(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function formatCpf(cpf: string): string {
  const d = cpf.replace(/\D/g, "");
  if (d.length !== 11) return cpf;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

function statusCounts(statuses: string[]): string {
  const counts = new Map<string, number>();
  for (const s of statuses) counts.set(s, (counts.get(s) ?? 0) + 1);
  return Array.from(counts.entries())
    .map(([s, n]) => `${n} ${FULFILLMENT_STATUS_LABEL[s] ?? s}`)
    .join(" · ");
}

const FULFILLMENT_STATUS_LABEL: Record<string, string> = {
  pending_acceptance: "aguardando aceite",
  pending_payment: "aguardando pagamento",
  paid: "pagos",
  pharmacy_requested: "na farmácia",
  shipped: "despachados",
  delivered: "entregues",
  cancelled: "cancelados",
};

// ────────────────────────────────────────────────────────────────────────
// Pills e linhas
// ────────────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-2xl border border-ink-100 bg-white p-5">
      <p className="text-[0.72rem] uppercase tracking-[0.14em] text-ink-500 font-medium mb-2">
        {label}
      </p>
      <p className="font-serif text-[1.6rem] leading-none text-ink-800">
        {value}
      </p>
      <p className="mt-2 text-sm text-ink-500">{hint}</p>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start gap-4">
      <dt className="text-ink-500 w-32 flex-shrink-0">{label}</dt>
      <dd
        className={
          "text-ink-800 min-w-0 break-words " + (mono ? "font-mono text-xs" : "")
        }
      >
        {value}
      </dd>
    </div>
  );
}

function FulfillmentStatusPill({ status }: { status: string }) {
  const tone =
    status === "cancelled"
      ? "bg-ink-100 text-ink-600"
      : status === "delivered"
        ? "bg-sage-100 text-sage-800"
        : status === "shipped"
          ? "bg-sage-50 text-sage-700"
          : status === "paid" || status === "pharmacy_requested"
            ? "bg-terracotta-50 text-terracotta-700"
            : "bg-cream-200 text-ink-700";
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs ${tone}`}>
      {FULFILLMENT_STATUS_LABEL[status] ?? status}
    </span>
  );
}

function AppointmentStatusPill({
  status,
  refund,
}: {
  status: string;
  refund: boolean;
}) {
  const label =
    {
      scheduled: "agendada",
      confirmed: "confirmada",
      in_progress: "em andamento",
      completed: "concluída",
      cancelled: "cancelada",
      no_show: "no-show",
      expired: "expirada",
    }[status] ?? status;
  const tone =
    status === "completed"
      ? "bg-sage-50 text-sage-700"
      : status === "no_show" || status === "cancelled" || status === "expired"
        ? "bg-terracotta-50 text-terracotta-700"
        : "bg-cream-200 text-ink-700";
  return (
    <span className="inline-flex flex-wrap gap-1">
      <span className={`inline-block px-2 py-0.5 rounded-full text-xs ${tone}`}>
        {label}
      </span>
      {refund && (
        <span className="inline-block px-2 py-0.5 rounded-full text-xs bg-terracotta-100 text-terracotta-800">
          refund pendente
        </span>
      )}
    </span>
  );
}

function PaymentStatusPill({ status }: { status: string }) {
  const tone =
    status === "RECEIVED" || status === "CONFIRMED"
      ? "bg-sage-50 text-sage-700"
      : status === "REFUNDED" || status === "OVERDUE"
        ? "bg-terracotta-50 text-terracotta-700"
        : "bg-cream-200 text-ink-700";
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs ${tone}`}>
      {status.toLowerCase()}
    </span>
  );
}

function TimelineRow({ ev }: { ev: TimelineEvent }) {
  const dotClass = TIMELINE_DOT_CLASS[ev.kind] ?? "bg-ink-300";
  return (
    <li className="flex items-start gap-3">
      <span
        className={`mt-1.5 h-2.5 w-2.5 rounded-full flex-shrink-0 ${dotClass}`}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <p className="text-ink-800 font-medium">{ev.title}</p>
          <span className="text-xs text-ink-500 flex-shrink-0">
            {new Date(ev.at).toLocaleString("pt-BR")}
          </span>
        </div>
        {ev.description && (
          <p className="text-sm text-ink-500 mt-0.5">{ev.description}</p>
        )}
      </div>
    </li>
  );
}

const TIMELINE_DOT_CLASS: Record<TimelineEventKind, string> = {
  appointment_scheduled: "bg-sage-300",
  appointment_finalized: "bg-sage-500",
  no_show_policy_applied: "bg-terracotta-400",
  refund_processed: "bg-terracotta-600",
  fulfillment_created: "bg-cream-300",
  fulfillment_accepted: "bg-sage-400",
  fulfillment_paid: "bg-sage-600",
  fulfillment_pharmacy_requested: "bg-terracotta-300",
  fulfillment_shipped: "bg-terracotta-500",
  fulfillment_delivered: "bg-sage-700",
  fulfillment_cancelled: "bg-ink-300",
  payment_created: "bg-cream-300",
  payment_received: "bg-sage-500",
  payment_refunded: "bg-terracotta-500",
  acceptance_signed: "bg-sage-400",
};
