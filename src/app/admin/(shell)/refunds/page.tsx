/**
 * /admin/refunds — Triagem e registro manual de estornos pendentes.
 *
 * Por quê (D-033):
 *   D-032 instituiu política assimétrica: quando a médica falha ou a sala
 *   expira vazia, `appointments.refund_required=true` é setado — o
 *   clawback na earning da médica acontece automático, mas o refund pro
 *   paciente é operação humana (admin processa no painel Asaas). Sem UI,
 *   esses casos ficavam invisíveis.
 *
 * Duas seções:
 *   1. "Pendentes" — `refund_required=true AND refund_processed_at IS NULL`.
 *      Admin anota o id do refund/PIX, adiciona notas, clica "Registrar".
 *   2. "Histórico" — últimos 50 processados (independente do method), só
 *      pra conferência. Uma vez processado, não reabre via UI (se precisar
 *      corrigir, SQL manual + ADR).
 *
 * Sprint 5 (opção B do backlog) trocará "Registrar" por botão "Estornar
 * no Asaas" que dispara a API sem copy-paste. Schema já está pronto
 * (`refund_processed_method`, `refund_external_ref`).
 */

import Link from "next/link";
import { getSupabaseAdmin } from "@/lib/supabase";
import { RefundForm } from "./_RefundForm";

export const dynamic = "force-dynamic";

type PendingRow = {
  id: string;
  scheduled_at: string;
  status: string;
  cancelled_reason: string | null;
  no_show_notes: string | null;
  no_show_policy_applied_at: string | null;
  payment_id: string | null;
  customer_id: string;
  doctor_id: string;
  customers: { name: string; phone: string | null } | null;
  doctors: { display_name: string | null; full_name: string } | null;
  payments: {
    amount_cents: number;
    asaas_payment_id: string | null;
    billing_type: string | null;
    invoice_url: string | null;
  } | null;
};

type ProcessedRow = {
  id: string;
  scheduled_at: string;
  status: string;
  refund_processed_at: string;
  refund_processed_method: "manual" | "asaas_api" | null;
  refund_external_ref: string | null;
  refund_processed_notes: string | null;
  customers: { name: string } | null;
  doctors: { display_name: string | null; full_name: string } | null;
  payments: { amount_cents: number } | null;
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

function reasonLabel(status: string, cancelledReason: string | null): string {
  if (status === "no_show_doctor") return "No-show médica";
  if (
    status === "cancelled_by_admin" &&
    cancelledReason === "expired_no_one_joined"
  )
    return "Sala expirou sem participantes";
  if (status === "cancelled_by_admin") return "Cancelado pelo admin";
  return status;
}

async function loadPending(): Promise<PendingRow[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("appointments")
    .select(
      "id, scheduled_at, status, cancelled_reason, no_show_notes, no_show_policy_applied_at, payment_id, customer_id, doctor_id, customers ( name, phone ), doctors ( display_name, full_name ), payments ( amount_cents, asaas_payment_id, billing_type, invoice_url )"
    )
    .eq("refund_required", true)
    .is("refund_processed_at", null)
    .order("scheduled_at", { ascending: false })
    .limit(100);
  if (error) {
    console.error("[admin/refunds] loadPending:", error);
    return [];
  }
  return (data ?? []) as unknown as PendingRow[];
}

async function loadProcessed(): Promise<ProcessedRow[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("appointments")
    .select(
      "id, scheduled_at, status, refund_processed_at, refund_processed_method, refund_external_ref, refund_processed_notes, customers ( name ), doctors ( display_name, full_name ), payments ( amount_cents )"
    )
    .not("refund_processed_at", "is", null)
    .order("refund_processed_at", { ascending: false })
    .limit(50);
  if (error) {
    console.error("[admin/refunds] loadProcessed:", error);
    return [];
  }
  return (data ?? []) as unknown as ProcessedRow[];
}

export default async function RefundsPage() {
  const [pending, processed] = await Promise.all([
    loadPending(),
    loadProcessed(),
  ]);

  const totalPendingCents = pending.reduce(
    (acc, r) => acc + (r.payments?.amount_cents ?? 0),
    0
  );

  return (
    <div>
      <header className="mb-6">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Financeiro
        </p>
        <h1 className="font-serif text-[1.85rem] sm:text-[2.2rem] leading-tight text-ink-800">
          Estornos
        </h1>
        <p className="mt-1 text-ink-500">
          Casos em que a política de no-show (D-032) criou direito a refund
          pro paciente. Hoje você processa manualmente no painel Asaas e
          registra aqui. Sprint 5 automatiza.
        </p>
      </header>

      {/* Resumo */}
      <section className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-8">
        <Card
          label="Pendentes"
          value={String(pending.length)}
          hint={pending.length > 0 ? brl(totalPendingCents) : "nada a fazer"}
          tone={pending.length > 0 ? "terracotta" : "ink"}
        />
        <Card
          label="Processados (últimos 50)"
          value={String(processed.length)}
          hint={processed.length > 0 ? "histórico recente" : "ainda vazio"}
          tone="ink"
        />
        <Card
          label="Método hoje"
          value="Manual"
          hint="Asaas API: Sprint 5"
          tone="sage"
        />
      </section>

      {/* Pendentes */}
      <section className="mb-10">
        <h2 className="font-serif text-[1.3rem] text-ink-800 mb-4">
          Pendentes ({pending.length})
        </h2>

        {pending.length === 0 ? (
          <div className="rounded-2xl bg-white border border-ink-100 p-10 text-center">
            <p className="text-ink-500">
              Nenhum estorno pendente. Quando uma consulta ficar em
              no-show por culpa da médica (ou a sala expirar vazia), o caso
              aparece aqui pra você processar.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {pending.map((r) => (
              <PendingCard key={r.id} row={r} />
            ))}
          </div>
        )}
      </section>

      {/* Histórico */}
      <section>
        <h2 className="font-serif text-[1.3rem] text-ink-800 mb-4">
          Histórico
        </h2>
        {processed.length === 0 ? (
          <p className="text-ink-500">Sem estornos processados ainda.</p>
        ) : (
          <div className="rounded-2xl bg-white border border-ink-100 overflow-hidden">
            <table className="w-full">
              <thead className="bg-cream-50 border-b border-ink-100">
                <tr className="text-left text-[0.72rem] uppercase tracking-[0.12em] text-ink-500 font-medium">
                  <th className="px-5 py-2.5">Paciente</th>
                  <th className="px-5 py-2.5">Médica</th>
                  <th className="px-5 py-2.5">Consulta</th>
                  <th className="px-5 py-2.5 text-right">Valor</th>
                  <th className="px-5 py-2.5">Processado</th>
                  <th className="px-5 py-2.5">Método</th>
                  <th className="px-5 py-2.5">Ref externa</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {processed.map((p) => (
                  <tr key={p.id} className="hover:bg-cream-50 align-top">
                    <td className="px-5 py-3 text-sm text-ink-800">
                      {p.customers?.name ?? "—"}
                    </td>
                    <td className="px-5 py-3 text-sm text-ink-800">
                      {p.doctors?.display_name ??
                        p.doctors?.full_name ??
                        "—"}
                    </td>
                    <td className="px-5 py-3 text-sm text-ink-600 font-mono">
                      {fmtDateTime(p.scheduled_at)}
                    </td>
                    <td className="px-5 py-3 text-sm text-right font-mono text-ink-800">
                      {brl(p.payments?.amount_cents)}
                    </td>
                    <td className="px-5 py-3 text-sm text-ink-600 font-mono">
                      {fmtDateTime(p.refund_processed_at)}
                    </td>
                    <td className="px-5 py-3 text-sm text-ink-600">
                      {p.refund_processed_method === "asaas_api" ? (
                        <span className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full bg-sage-50 text-sage-800 border border-sage-200">
                          Asaas API
                        </span>
                      ) : (
                        <span className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full bg-cream-100 text-ink-700 border border-ink-200">
                          Manual
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-xs text-ink-500 font-mono break-all max-w-[240px]">
                      {p.refund_external_ref ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
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

function PendingCard({ row }: { row: PendingRow }) {
  const patient = row.customers?.name ?? "(sem cliente)";
  const doctor =
    row.doctors?.display_name ?? row.doctors?.full_name ?? "—";
  const amount = row.payments?.amount_cents ?? null;
  const asaasId = row.payments?.asaas_payment_id ?? null;
  const invoice = row.payments?.invoice_url ?? null;
  const reason = reasonLabel(row.status, row.cancelled_reason);

  return (
    <article className="rounded-2xl bg-white border border-ink-100 p-5">
      <div className="grid md:grid-cols-[1fr_320px] gap-5">
        <div>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-2">
            <h3 className="font-serif text-[1.15rem] text-ink-800">
              {patient}
            </h3>
            <span className="text-sm text-ink-500">
              com {doctor}
            </span>
          </div>

          <dl className="grid grid-cols-2 gap-y-2 gap-x-5 text-sm">
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-400">
                Consulta
              </dt>
              <dd className="text-ink-800 font-mono">
                {fmtDateTime(row.scheduled_at)}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-400">
                Motivo
              </dt>
              <dd className="text-terracotta-700 font-medium">{reason}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-400">
                Valor pago
              </dt>
              <dd className="text-ink-800 font-mono">{brl(amount)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-400">
                Telefone
              </dt>
              <dd className="text-ink-800 font-mono">
                {row.customers?.phone ?? "—"}
              </dd>
            </div>
            <div className="col-span-2">
              <dt className="text-xs uppercase tracking-wide text-ink-400">
                Asaas payment
              </dt>
              <dd className="text-ink-800 font-mono text-xs break-all">
                {asaasId ? (
                  <>
                    {asaasId}
                    {invoice && (
                      <>
                        {" · "}
                        <a
                          href={invoice}
                          target="_blank"
                          rel="noreferrer"
                          className="text-sage-700 hover:underline"
                        >
                          abrir invoice
                        </a>
                      </>
                    )}
                  </>
                ) : (
                  <span className="text-ink-400">
                    Sem payment vinculado — só anotar aqui, sem refund Asaas.
                  </span>
                )}
              </dd>
            </div>
            {row.no_show_notes && (
              <div className="col-span-2">
                <dt className="text-xs uppercase tracking-wide text-ink-400">
                  Notas do sistema
                </dt>
                <dd className="text-ink-600 italic">
                  &ldquo;{row.no_show_notes}&rdquo;
                </dd>
              </div>
            )}
            <div className="col-span-2">
              <dt className="text-xs uppercase tracking-wide text-ink-400">
                Appointment
              </dt>
              <dd className="text-ink-500 font-mono text-xs break-all">
                {row.id}
              </dd>
            </div>
          </dl>

          <div className="mt-3 rounded-xl bg-cream-50 border border-ink-100 p-3 text-xs text-ink-600 leading-relaxed">
            <strong className="text-ink-800">Fluxo:</strong> 1) abra o
            Asaas, localize o payment <span className="font-mono">{asaasId ?? "—"}</span>, emita o
            estorno. 2) copie o id do refund (algo como{" "}
            <span className="font-mono">rf_xxx</span>) ou o end-to-end do
            PIX. 3) cole ao lado + clique <em>Registrar</em>.
          </div>
        </div>

        <div>
          <RefundForm
            appointmentId={row.id}
            defaultNotes={row.no_show_notes ?? ""}
          />
        </div>
      </div>
    </article>
  );
}
