/**
 * /paciente/oferta/[appointment_id] — D-044 · 2.C.2
 *
 * Tela do paciente pra aceitar formalmente o plano indicado pela
 * médica na consulta e informar o endereço de entrega. Após o
 * aceite, redireciona pra invoice Asaas.
 *
 * Contrato de estados (vem da onda 2.C.1):
 *
 *   - fulfillment.status === 'pending_acceptance' → mostra form
 *   - 'pending_payment' → aceite já feito; mostra card "pagamento
 *     pendente" com invoice_url existente.
 *   - 'paid' / 'pharmacy_requested' / 'shipped' / 'delivered' →
 *     redireciona pra `/paciente` (não cabe mais aceite aqui).
 *   - 'cancelled' → mensagem "oferta cancelada, fale com o Instituto".
 *
 * Auth: via `requirePatient()` do layout. O ownership (appointment
 * pertence a esse customer) é validado aqui explicitamente —
 * belt-and-suspenders contra URL forjada.
 */

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requirePatient } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  ACCEPTANCE_TERMS_VERSION,
  formatDoctorCrm,
  renderAcceptanceTerms,
} from "@/lib/acceptance-terms";
import { customerToAddressInput } from "@/lib/patient-address";
import { OfferForm } from "./OfferForm";
import {
  formatCurrencyBRL,
  formatDateBR,
  formatDateTimeBR,
} from "@/lib/datetime-br";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/paciente/oferta/[appointment_id]" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Aceite do plano · Instituto Nova Medida",
  robots: { index: false, follow: false },
};

type Params = { params: Promise<{ appointment_id: string }> };

function brl(cents: number): string {
  return formatCurrencyBRL(cents);
}

export default async function OfferPage({ params }: Params) {
  const { appointment_id: appointmentId } = await params;
  const { customerId } = await requirePatient();
  const supabase = getSupabaseAdmin();

  // 1. Carrega appointment + ownership
  const apptRes = await supabase
    .from("appointments")
    .select(
      `id, customer_id, finalized_at, prescription_status,
       memed_prescription_url, scheduled_at, status,
       doctor:doctors(id, full_name, display_name, crm_number, crm_uf)`
    )
    .eq("id", appointmentId)
    .maybeSingle();

  if (apptRes.error) {
    log.error("erro ao carregar appointment", { err: apptRes.error });
    notFound();
  }
  if (!apptRes.data) notFound();

  const appt = apptRes.data as {
    id: string;
    customer_id: string;
    finalized_at: string | null;
    prescription_status: string;
    memed_prescription_url: string | null;
    scheduled_at: string;
    status: string;
    doctor:
      | {
          id: string;
          full_name: string;
          display_name: string | null;
          crm_number: string;
          crm_uf: string;
        }
      | Array<{
          id: string;
          full_name: string;
          display_name: string | null;
          crm_number: string;
          crm_uf: string;
        }>
      | null;
  };

  if (appt.customer_id !== customerId) {
    notFound();
  }

  if (!appt.finalized_at || appt.prescription_status !== "prescribed") {
    return (
      <EmptyState
        title="Sem plano indicado nesta consulta"
        description="A médica ainda não finalizou a consulta, ou finalizou sem prescrever um plano. Se acha que é um engano, fale com o Instituto."
      />
    );
  }

  // 2. Carrega fulfillment + plan + customer
  const ffRes = await supabase
    .from("fulfillments")
    .select(
      `id, status, payment_id, accepted_at,
       plan:plans!inner(id, slug, name, medication, cycle_days,
         price_pix_cents, price_cents, active),
       payment:payments(id, status, invoice_url, amount_cents)`
    )
    .eq("appointment_id", appt.id)
    .maybeSingle();

  if (ffRes.error) {
    log.error("erro ao carregar fulfillment", { err: ffRes.error });
    return (
      <EmptyState
        title="Erro ao carregar oferta"
        description="Tente recarregar a página. Se o erro persistir, fale com o Instituto."
      />
    );
  }

  if (!ffRes.data) {
    return (
      <EmptyState
        title="Oferta não encontrada"
        description="Não encontramos um plano pendente vinculado a esta consulta."
      />
    );
  }

  const ff = ffRes.data as {
    id: string;
    status: string;
    payment_id: string | null;
    accepted_at: string | null;
    plan:
      | {
          id: string;
          slug: string;
          name: string;
          medication: string | null;
          cycle_days: number;
          price_pix_cents: number;
          price_cents: number;
          active: boolean;
        }
      | Array<unknown>;
    payment:
      | { id: string; status: string; invoice_url: string | null; amount_cents: number }
      | Array<{ id: string; status: string; invoice_url: string | null; amount_cents: number }>
      | null;
  };

  const plan = Array.isArray(ff.plan)
    ? (ff.plan[0] as {
        id: string;
        slug: string;
        name: string;
        medication: string | null;
        cycle_days: number;
        price_pix_cents: number;
        price_cents: number;
        active: boolean;
      })
    : (ff.plan as {
        id: string;
        slug: string;
        name: string;
        medication: string | null;
        cycle_days: number;
        price_pix_cents: number;
        price_cents: number;
        active: boolean;
      });

  const payment = Array.isArray(ff.payment) ? ff.payment[0] : ff.payment;

  // 3. Curto-circuitos por status do fulfillment
  if (ff.status === "cancelled") {
    return (
      <EmptyState
        title="Oferta cancelada"
        description="Esta oferta foi cancelada. Se quiser retomar o tratamento, fale com o Instituto."
      />
    );
  }

  if (ff.status === "pending_payment" && payment?.invoice_url) {
    // Já aceitou; só falta pagar. Mostra card sucinto com CTA pra invoice.
    return (
      <AwaitingPayment
        invoiceUrl={payment.invoice_url}
        amountCents={payment.amount_cents}
        acceptedAt={ff.accepted_at}
      />
    );
  }

  if (
    ff.status === "paid" ||
    ff.status === "pharmacy_requested" ||
    ff.status === "shipped" ||
    ff.status === "delivered"
  ) {
    redirect("/paciente");
  }

  if (ff.status !== "pending_acceptance" && ff.status !== "pending_payment") {
    return (
      <EmptyState
        title="Estado inesperado"
        description={`O fulfillment está em "${ff.status}", que não permite aceite. Fale com o Instituto.`}
      />
    );
  }

  if (!plan.active) {
    return (
      <EmptyState
        title="Plano indisponível"
        description="O plano indicado foi retirado do catálogo. Fale com o Instituto pra receber uma nova indicação."
      />
    );
  }

  if (!appt.memed_prescription_url) {
    return (
      <EmptyState
        title="Prescrição não disponível"
        description="A receita Memed desta consulta ainda não está acessível. Aguarde alguns minutos e recarregue."
      />
    );
  }

  // 4. Customer pra pré-preencher endereço e montar o termo
  const custRes = await supabase
    .from("customers")
    .select(
      `id, name, cpf, email, phone,
       address_zipcode, address_street, address_number, address_complement,
       address_district, address_city, address_state`
    )
    .eq("id", customerId)
    .maybeSingle();

  if (custRes.error || !custRes.data) {
    return (
      <EmptyState
        title="Dados do paciente indisponíveis"
        description="Não conseguimos carregar seus dados. Saia e entre de novo."
      />
    );
  }

  const customer = custRes.data as {
    id: string;
    name: string;
    cpf: string;
    email: string;
    phone: string;
    address_zipcode: string | null;
    address_street: string | null;
    address_number: string | null;
    address_complement: string | null;
    address_district: string | null;
    address_city: string | null;
    address_state: string | null;
  };

  // 5. Renderiza termo com dados reais
  const doctorRaw = Array.isArray(appt.doctor) ? appt.doctor[0] : appt.doctor;
  if (!doctorRaw) {
    return (
      <EmptyState
        title="Dados da médica indisponíveis"
        description="Não conseguimos identificar a médica da sua consulta. Fale com o Instituto."
      />
    );
  }
  const doctorName = doctorRaw.display_name ?? doctorRaw.full_name;
  const doctorCrm = formatDoctorCrm(doctorRaw.crm_number, doctorRaw.crm_uf);
  const priceFormatted = brl(plan.price_pix_cents);

  const acceptanceText = renderAcceptanceTerms({
    patient_name: customer.name,
    patient_cpf: formatCpf(customer.cpf),
    plan_name: plan.name,
    plan_medication: plan.medication ?? plan.name,
    plan_cycle_days: plan.cycle_days,
    price_formatted: priceFormatted,
    doctor_name: doctorName,
    doctor_crm: doctorCrm,
    prescription_url: appt.memed_prescription_url,
  });

  const initialAddress = customerToAddressInput(customer);

  return (
    <div className="max-w-3xl">
      <header className="mb-8">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Indicação médica · aceite do plano
        </p>
        <h1 className="font-serif text-[2rem] sm:text-[2.4rem] leading-tight text-ink-800">
          {plan.name}
        </h1>
        {plan.medication && (
          <p className="mt-1 text-ink-500">{plan.medication}</p>
        )}
      </header>

      <section className="rounded-2xl bg-white border border-ink-100 p-6 sm:p-7 mb-6">
        <div className="grid sm:grid-cols-2 gap-5 text-sm">
          <Info label="Indicado por" value={doctorName} hint={`CRM ${doctorCrm}`} />
          <Info
            label="Consulta"
            value={formatDateBR(appt.scheduled_at, {
              day: "2-digit",
              month: "long",
              year: "numeric",
            })}
          />
          <Info label="Ciclo" value={`${plan.cycle_days} dias`} />
          <Info
            label="Valor à vista"
            value={priceFormatted}
            hint="PIX ou boleto. Cartão em até 3x disponível no checkout."
          />
        </div>

        <div className="mt-6 rounded-xl bg-sage-50 border border-sage-200 p-4 sm:p-5">
          <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
            Sua prescrição
          </p>
          <p className="text-sm text-ink-600 mb-3">
            A receita já está emitida na Memed. Você pode abrir agora
            pra conferir antes de contratar.
          </p>
          <a
            href={appt.memed_prescription_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg bg-white border border-sage-300 text-sage-800 text-sm font-medium px-4 py-2 hover:bg-sage-100 transition-colors"
          >
            Abrir receita Memed →
          </a>
        </div>
      </section>

      <OfferForm
        fulfillmentId={ff.id}
        acceptanceText={acceptanceText}
        acceptanceTermsVersion={ACCEPTANCE_TERMS_VERSION}
        patientName={customer.name}
        initialAddress={initialAddress}
        priceFormatted={priceFormatted}
      />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Helpers de apresentação
// ────────────────────────────────────────────────────────────────────────

function formatCpf(raw: string): string {
  const d = raw.replace(/\D/g, "");
  if (d.length !== 11) return raw;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="max-w-2xl">
      <div className="rounded-2xl bg-white border border-ink-100 p-8 sm:p-10 text-center">
        <h1 className="font-serif text-[1.6rem] text-ink-800 mb-3">{title}</h1>
        <p className="text-ink-500">{description}</p>
        <div className="mt-6">
          <Link
            href="/paciente"
            className="inline-flex items-center rounded-xl bg-ink-800 hover:bg-ink-900 text-white text-sm font-medium px-5 py-2.5 transition-colors"
          >
            Voltar ao painel
          </Link>
        </div>
      </div>
    </div>
  );
}

function AwaitingPayment({
  invoiceUrl,
  amountCents,
  acceptedAt,
}: {
  invoiceUrl: string;
  amountCents: number;
  acceptedAt: string | null;
}) {
  return (
    <div className="max-w-2xl">
      <header className="mb-6">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Plano aceito
        </p>
        <h1 className="font-serif text-[2rem] leading-tight text-ink-800">
          Falta pagar pra liberar o tratamento
        </h1>
        <p className="mt-2 text-ink-500">
          Seu aceite formal foi registrado
          {acceptedAt ? ` em ${formatDateTimeBR(acceptedAt)}` : ""}
          . Agora é só concluir o pagamento de {" "}
          <strong>{brl(amountCents)}</strong>.
        </p>
      </header>

      <div className="rounded-2xl bg-white border border-ink-100 p-6 sm:p-7">
        <a
          href={invoiceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center rounded-xl bg-ink-900 hover:bg-ink-800 text-white text-base font-semibold px-6 py-3 transition-colors shadow-sm"
        >
          Ir para o pagamento →
        </a>
        <p className="mt-4 text-sm text-ink-500">
          Você pode fechar esta aba — assim que o pagamento for
          confirmado, a gente te avisa no WhatsApp e na sua área.
        </p>
      </div>
    </div>
  );
}

function Info({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div>
      <p className="text-[0.72rem] uppercase tracking-wide text-ink-500">
        {label}
      </p>
      <p className="mt-1 text-ink-800 font-medium">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}
