/**
 * /medico/consultas/[id]/finalizar — D-044 · onda 2.B
 *
 * Tela de fechamento do ato médico. A médica registra anamnese +
 * hipótese + conduta e declara uma de duas decisões:
 *
 *   - "declined"   → apenas avaliação; nenhuma cobrança é criada,
 *                    nenhum fulfillment nasce. A médica ainda
 *                    recebe log do atendimento (sem earning, por
 *                    regra do modelo grátis).
 *   - "prescribed" → seleciona plano + cola a URL Memed da receita.
 *                    Ao submeter, o backend cria o
 *                    fulfillment(pending_acceptance) e o paciente
 *                    passa a ver a oferta na área logada (onda 2.C).
 *
 * Guards server-side:
 *   - `requireDoctor()` — hard-gate de sessão.
 *   - Query filtrada por doctor_id (dupla defesa junto com RLS).
 *   - `finalized_at != null` → mostra tela read-only explicando
 *     que a consulta já foi finalizada e por quem/quando.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { requireDoctor } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { FinalizeForm } from "./FinalizeForm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

type Appointment = {
  id: string;
  doctor_id: string;
  customer_id: string;
  scheduled_at: string;
  status: string;
  finalized_at: string | null;
  prescription_status: "none" | "prescribed" | "declined";
  prescribed_plan_id: string | null;
  memed_prescription_url: string | null;
  memed_prescription_id: string | null;
  anamnese: unknown;
  hipotese: string | null;
  conduta: string | null;
  customers: { name: string | null; email: string | null } | null;
};

type Plan = {
  id: string;
  slug: string;
  name: string;
  medication: string | null;
  cycle_days: number;
  price_pix_cents: number;
};

async function loadData(
  appointmentId: string,
  doctorId: string
): Promise<{ appointment: Appointment | null; plans: Plan[] }> {
  const supabase = getSupabaseAdmin();

  const [apptRes, plansRes] = await Promise.all([
    supabase
      .from("appointments")
      .select(
        "id, doctor_id, customer_id, scheduled_at, status, finalized_at, prescription_status, prescribed_plan_id, memed_prescription_url, memed_prescription_id, anamnese, hipotese, conduta, customers ( name, email )"
      )
      .eq("id", appointmentId)
      .eq("doctor_id", doctorId)
      .maybeSingle(),
    supabase
      .from("plans")
      .select("id, slug, name, medication, cycle_days, price_pix_cents")
      .eq("active", true)
      .order("sort_order", { ascending: true }),
  ]);

  const raw = apptRes.data as
    | (Omit<Appointment, "customers"> & {
        customers: Appointment["customers"] | Appointment["customers"][];
      })
    | null;

  const appointment: Appointment | null = raw
    ? {
        ...raw,
        customers: Array.isArray(raw.customers)
          ? raw.customers[0] ?? null
          : raw.customers,
      }
    : null;

  return {
    appointment,
    plans: (plansRes.data ?? []) as Plan[],
  };
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function brlFromCents(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

export default async function FinalizarConsultaPage({ params }: Params) {
  const { id } = await params;
  const { doctorId } = await requireDoctor();
  const { appointment, plans } = await loadData(id, doctorId);

  if (!appointment) notFound();

  const patientName =
    appointment.customers?.name ?? "Paciente sem nome cadastrado";

  if (appointment.finalized_at) {
    return (
      <div className="max-w-3xl">
        <header className="mb-8">
          <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
            Consulta finalizada
          </p>
          <h1 className="font-serif text-[1.9rem] sm:text-[2.2rem] leading-tight text-ink-800">
            {patientName}
          </h1>
          <p className="mt-1 text-ink-500">
            {fmtDateTime(appointment.scheduled_at)} · finalizada em{" "}
            {fmtDateTime(appointment.finalized_at)}
          </p>
        </header>

        <div className="rounded-2xl border border-ink-100 bg-white p-6 space-y-4">
          <Field label="Decisão">
            {appointment.prescription_status === "prescribed"
              ? "Plano indicado"
              : appointment.prescription_status === "declined"
                ? "Sem indicação clínica"
                : "—"}
          </Field>

          {appointment.hipotese && (
            <Field label="Hipótese">{appointment.hipotese}</Field>
          )}
          {appointment.conduta && (
            <Field label="Conduta">{appointment.conduta}</Field>
          )}

          {appointment.prescription_status === "prescribed" && (
            <>
              <Field label="Plano prescrito">
                {plans.find((p) => p.id === appointment.prescribed_plan_id)
                  ?.name ?? appointment.prescribed_plan_id}
              </Field>
              {appointment.memed_prescription_url && (
                <Field label="Receita Memed">
                  <a
                    href={appointment.memed_prescription_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sage-700 hover:text-sage-900 underline underline-offset-2"
                  >
                    Abrir receita
                  </a>
                </Field>
              )}
            </>
          )}
        </div>

        <div className="mt-6 flex justify-between items-center">
          <Link
            href="/medico/agenda"
            className="text-sm text-ink-600 hover:text-ink-800"
          >
            ← Voltar para agenda
          </Link>
          <p className="text-sm text-ink-500">
            Esta consulta está imutável. Para correções, fale com o operador.
          </p>
        </div>
      </div>
    );
  }

  const isCancelled = [
    "cancelled",
    "cancelled_by_patient",
    "cancelled_by_doctor",
    "cancelled_by_admin",
  ].includes(appointment.status);

  if (isCancelled) {
    return (
      <div className="max-w-2xl">
        <header className="mb-6">
          <h1 className="font-serif text-[1.9rem] text-ink-800">
            Consulta cancelada
          </h1>
        </header>
        <p className="text-ink-600">
          Esta consulta com {patientName} foi cancelada
          ({appointment.status.replace(/_/g, " ")}). Não é mais possível
          finalizar.
        </p>
        <Link
          href="/medico/agenda"
          className="mt-6 inline-block text-sm text-ink-600 hover:text-ink-800"
        >
          ← Voltar para agenda
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <header className="mb-8">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Finalizar consulta
        </p>
        <h1 className="font-serif text-[1.9rem] sm:text-[2.2rem] leading-tight text-ink-800">
          {patientName}
        </h1>
        <p className="mt-1 text-ink-500">
          {fmtDateTime(appointment.scheduled_at)}
          {appointment.customers?.email
            ? ` · ${appointment.customers.email}`
            : ""}
        </p>
      </header>

      <section className="rounded-2xl border border-sage-200 bg-sage-50/50 p-5 mb-8">
        <p className="text-[0.82rem] uppercase tracking-wider text-sage-700 font-medium">
          Como funciona a finalização
        </p>
        <ul className="mt-3 space-y-2 text-[0.94rem] text-ink-700 leading-relaxed">
          <li>
            <strong>Sem indicação</strong>: paciente fica ciente de que a
            avaliação não gerou prescrição e nenhum valor é cobrado.
          </li>
          <li>
            <strong>Com indicação</strong>: selecione o plano e cole a URL
            da receita Memed. O paciente receberá acesso à receita e à
            oferta formal na área dele, onde vai aceitar antes de pagar.
          </li>
          <li>
            Após finalizar, a consulta fica <strong>imutável</strong>. Troque
            o operador se precisar corrigir.
          </li>
        </ul>
      </section>

      <FinalizeForm
        appointmentId={appointment.id}
        plans={plans.map((p) => ({
          id: p.id,
          label: `${p.name}${p.medication ? ` · ${p.medication}` : ""} · ${brlFromCents(p.price_pix_cents)} · ${p.cycle_days}d`,
        }))}
      />
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-[0.78rem] uppercase tracking-wider text-ink-500 font-medium mb-1">
        {label}
      </p>
      <div className="text-ink-800 whitespace-pre-wrap">{children}</div>
    </div>
  );
}
