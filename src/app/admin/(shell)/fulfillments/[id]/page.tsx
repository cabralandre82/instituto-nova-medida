/**
 * /admin/fulfillments/[id] — D-044 · 2.E
 *
 * Detalhe do fulfillment com tudo que o admin precisa pra agir:
 *
 *   - Cabeçalho com status atual e valor.
 *   - Timeline dos eventos (aceite, pagamento, etapas operacionais).
 *   - Paciente: nome, CPF, contato.
 *   - Prescrição: link Memed (CTA copiar link), médica responsável.
 *   - Endereço de entrega: só aparece a partir do status
 *     `pharmacy_requested`. Antes disso a tela não mostra endereço
 *     (compromisso legal do termo — farmácia não recebe endereço).
 *   - Cobrança: status Asaas, invoice_url.
 *   - Botões de ação (via client component `FulfillmentActions`).
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { getSupabaseAdmin } from "@/lib/supabase";
import type { FulfillmentStatus } from "@/lib/fulfillments";
import { labelForFulfillmentStatus } from "@/lib/fulfillment-transitions";
import { FulfillmentActions } from "./_FulfillmentActions";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

type FfRow = {
  fulfillment_id: string;
  fulfillment_status: FulfillmentStatus;
  created_at: string;
  accepted_at: string | null;
  paid_at: string | null;
  pharmacy_requested_at: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  cancelled_reason: string | null;
  tracking_note: string | null;
  shipping_recipient_name: string | null;
  shipping_zipcode: string | null;
  shipping_street: string | null;
  shipping_number: string | null;
  shipping_complement: string | null;
  shipping_district: string | null;
  shipping_city: string | null;
  shipping_state: string | null;
  customer_id: string;
  customer_name: string;
  customer_cpf: string;
  customer_email: string;
  customer_phone: string | null;
  plan_id: string;
  plan_name: string;
  plan_medication: string | null;
  plan_cycle_days: number;
  plan_price_pix_cents: number;
  plan_price_cents: number;
  doctor_id: string;
  doctor_name: string;
  doctor_crm_number: string;
  doctor_crm_uf: string;
  appointment_id: string;
  appointment_scheduled_at: string;
  appointment_finalized_at: string | null;
  prescription_url: string | null;
  prescription_memed_id: string | null;
  payment_id: string | null;
  payment_status: string | null;
  payment_amount_cents: number | null;
  payment_invoice_url: string | null;
  payment_paid_at: string | null;
};

function brl(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatCpf(d: string): string {
  const only = d.replace(/\D/g, "");
  if (only.length !== 11) return d;
  return `${only.slice(0, 3)}.${only.slice(3, 6)}.${only.slice(6, 9)}-${only.slice(9)}`;
}

function formatCep(d: string | null): string {
  if (!d) return "—";
  const only = d.replace(/\D/g, "");
  if (only.length !== 8) return d;
  return `${only.slice(0, 5)}-${only.slice(5)}`;
}

function formatPhone(d: string | null): string {
  if (!d) return "—";
  const only = d.replace(/\D/g, "");
  if (only.length === 11) {
    return `(${only.slice(0, 2)}) ${only.slice(2, 7)}-${only.slice(7)}`;
  }
  if (only.length === 13 && only.startsWith("55")) {
    return `+55 (${only.slice(2, 4)}) ${only.slice(4, 9)}-${only.slice(9)}`;
  }
  return d;
}

const TONE_BY_STATUS: Record<FulfillmentStatus, string> = {
  pending_acceptance: "bg-ink-100 text-ink-700",
  pending_payment: "bg-cream-200 text-ink-800",
  paid: "bg-sage-200 text-sage-900",
  pharmacy_requested: "bg-sage-300 text-sage-900",
  shipped: "bg-sage-400 text-white",
  delivered: "bg-sage-700 text-white",
  cancelled: "bg-terracotta-200 text-terracotta-800",
};

export default async function FulfillmentDetailPage({ params }: RouteParams) {
  const { id } = await params;
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("fulfillments_operational")
    .select("*")
    .eq("fulfillment_id", id)
    .maybeSingle();

  if (error) {
    console.error("[admin/fulfillments/:id] load:", error);
    notFound();
  }
  if (!data) notFound();

  const ff = data as unknown as FfRow;

  const canSeeAddress =
    ff.fulfillment_status === "pharmacy_requested" ||
    ff.fulfillment_status === "shipped" ||
    ff.fulfillment_status === "delivered" ||
    ff.fulfillment_status === "cancelled";

  return (
    <div className="max-w-4xl">
      <Link
        href="/admin/fulfillments"
        className="text-sm text-sage-700 hover:text-sage-800 mb-3 inline-flex items-center gap-1"
      >
        ← Voltar à lista
      </Link>

      <header className="mb-8">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Fulfillment
        </p>
        <h1 className="font-serif text-[2rem] sm:text-[2.4rem] leading-tight text-ink-800">
          {ff.plan_name}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <span
            className={`inline-block rounded-full text-xs px-2.5 py-1 font-medium ${
              TONE_BY_STATUS[ff.fulfillment_status]
            }`}
          >
            {labelForFulfillmentStatus(ff.fulfillment_status)}
          </span>
          <span className="text-ink-600 font-medium">
            {brl(ff.plan_price_pix_cents)}
          </span>
          <span className="text-ink-500 text-sm">
            {ff.plan_cycle_days} dias ·{" "}
            {ff.plan_medication ?? "sem medicação declarada"}
          </span>
        </div>
      </header>

      <section className="mb-8">
        <h2 className="font-serif text-[1.2rem] text-ink-800 mb-4">
          Ações disponíveis
        </h2>
        <FulfillmentActions
          fulfillmentId={ff.fulfillment_id}
          status={ff.fulfillment_status}
          prescriptionUrl={ff.prescription_url}
          patientName={ff.customer_name}
          patientCpf={ff.customer_cpf}
          shippingAddress={{
            recipient_name: ff.shipping_recipient_name,
            zipcode: ff.shipping_zipcode,
            street: ff.shipping_street,
            number: ff.shipping_number,
            complement: ff.shipping_complement,
            district: ff.shipping_district,
            city: ff.shipping_city,
            state: ff.shipping_state,
          }}
        />
      </section>

      <div className="grid md:grid-cols-2 gap-6 mb-8">
        <Panel title="Paciente">
          <Kv k="Nome" v={ff.customer_name} />
          <Kv k="CPF" v={formatCpf(ff.customer_cpf)} />
          <Kv k="Email" v={ff.customer_email} />
          <Kv k="Telefone" v={formatPhone(ff.customer_phone)} />
        </Panel>

        <Panel title="Prescrição">
          <Kv
            k="Médica"
            v={`${ff.doctor_name} · CRM ${ff.doctor_crm_number}/${ff.doctor_crm_uf}`}
          />
          <Kv
            k="Consulta"
            v={`${fmtDateTime(ff.appointment_scheduled_at)}${
              ff.appointment_finalized_at
                ? ` · finalizada ${fmtDateTime(ff.appointment_finalized_at)}`
                : ""
            }`}
          />
          {ff.prescription_url ? (
            <div>
              <p className="text-[0.72rem] uppercase tracking-wide text-ink-500">
                Receita Memed
              </p>
              <a
                href={ff.prescription_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-sage-700 hover:text-sage-800 underline break-all"
              >
                {ff.prescription_url}
              </a>
            </div>
          ) : (
            <Kv k="Receita Memed" v="indisponível" />
          )}
        </Panel>
      </div>

      {canSeeAddress && (
        <Panel title="Endereço de entrega" className="mb-8">
          <p className="text-xs text-ink-500 mb-3">
            Este endereço NÃO é compartilhado com a farmácia de manipulação —
            apenas o Instituto despacha a caixa final para cá.
          </p>
          <Kv
            k="Destinatário"
            v={ff.shipping_recipient_name ?? ff.customer_name}
          />
          <Kv
            k="Logradouro"
            v={`${ff.shipping_street ?? "—"}, ${ff.shipping_number ?? "—"}${
              ff.shipping_complement ? ` · ${ff.shipping_complement}` : ""
            }`}
          />
          <Kv
            k="Bairro · Cidade/UF"
            v={`${ff.shipping_district ?? "—"} · ${ff.shipping_city ?? "—"}/${
              ff.shipping_state ?? "—"
            }`}
          />
          <Kv k="CEP" v={formatCep(ff.shipping_zipcode)} />
          {ff.tracking_note && <Kv k="Rastreio" v={ff.tracking_note} />}
        </Panel>
      )}

      <Panel title="Cobrança" className="mb-8">
        <Kv
          k="Status Asaas"
          v={ff.payment_status ?? "sem cobrança vinculada"}
        />
        <Kv k="Valor" v={brl(ff.payment_amount_cents ?? ff.plan_price_pix_cents)} />
        <Kv k="Pago em" v={fmtDateTime(ff.payment_paid_at)} />
        {ff.payment_invoice_url && (
          <div>
            <p className="text-[0.72rem] uppercase tracking-wide text-ink-500">
              Invoice Asaas
            </p>
            <a
              href={ff.payment_invoice_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-sage-700 hover:text-sage-800 underline break-all"
            >
              {ff.payment_invoice_url}
            </a>
          </div>
        )}
      </Panel>

      <Panel title="Linha do tempo" className="mb-8">
        <ol className="space-y-3 text-sm">
          <TimelineItem
            label="Criado"
            when={ff.created_at}
            hint="Médica finalizou consulta e prescreveu plano."
          />
          <TimelineItem
            label="Aceite do paciente"
            when={ff.accepted_at}
            hint="Termo assinado; endereço informado."
          />
          <TimelineItem
            label="Pagamento confirmado"
            when={ff.paid_at}
            hint="Webhook Asaas promoveu fulfillment pra `paid`."
          />
          <TimelineItem
            label="Receita enviada à farmácia"
            when={ff.pharmacy_requested_at}
            hint="Farmácia recebe prescrição + nome + CPF (sem endereço)."
          />
          <TimelineItem
            label="Medicamento despachado"
            when={ff.shipped_at}
            hint={
              ff.tracking_note
                ? `Rastreio: ${ff.tracking_note}`
                : "Instituto enviou ao endereço do paciente."
            }
          />
          <TimelineItem
            label="Entrega confirmada"
            when={ff.delivered_at}
            hint="Paciente (ou admin) confirmou recebimento."
          />
          {ff.cancelled_at && (
            <TimelineItem
              label="Cancelado"
              when={ff.cancelled_at}
              hint={ff.cancelled_reason ?? "Sem motivo registrado."}
              isCancelled
            />
          )}
        </ol>
      </Panel>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────

function Panel({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-2xl bg-white border border-ink-100 p-5 sm:p-6 ${
        className ?? ""
      }`}
    >
      <h2 className="font-serif text-[1.15rem] text-ink-800 mb-4">{title}</h2>
      <div className="space-y-3 text-sm">{children}</div>
    </section>
  );
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <p className="text-[0.72rem] uppercase tracking-wide text-ink-500">{k}</p>
      <p className="text-ink-700 break-words">{v}</p>
    </div>
  );
}

function TimelineItem({
  label,
  when,
  hint,
  isCancelled,
}: {
  label: string;
  when: string | null;
  hint?: string;
  isCancelled?: boolean;
}) {
  const done = when !== null;
  const dotClass = isCancelled
    ? "bg-terracotta-500"
    : done
      ? "bg-sage-600"
      : "bg-ink-200";
  const textClass = isCancelled
    ? "text-terracotta-800"
    : done
      ? "text-ink-800"
      : "text-ink-400";

  return (
    <li className="flex items-start gap-3">
      <span
        className={`mt-1 inline-block w-2.5 h-2.5 rounded-full flex-shrink-0 ${dotClass}`}
      />
      <div className="flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className={`font-medium ${textClass}`}>{label}</span>
          <span className="text-xs text-ink-500 font-mono">
            {when ? new Date(when).toLocaleString("pt-BR") : "—"}
          </span>
        </div>
        {hint && <p className="text-xs text-ink-500 mt-0.5">{hint}</p>}
      </div>
    </li>
  );
}
