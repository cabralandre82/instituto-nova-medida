/**
 * /admin/payouts/[id] — Detalhes e ações sobre um payout.
 *
 * Mostra: médica, período, total, lista de earnings, PIX da médica,
 * histórico de mudanças de status. Ações disponíveis variam por status.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { getSupabaseAdmin } from "@/lib/supabase";
import { PayoutActions } from "./PayoutActions";

export const dynamic = "force-dynamic";

type Payout = {
  id: string;
  doctor_id: string;
  reference_period: string;
  amount_cents: number;
  status: "draft" | "approved" | "pix_sent" | "confirmed" | "cancelled" | "failed";
  earnings_count: number;
  approved_at: string | null;
  pix_sent_at: string | null;
  confirmed_at: string | null;
  pix_proof_url: string | null;
  pix_transaction_id: string | null;
  notes: string | null;
  created_at: string;
};

type Doctor = {
  id: string;
  full_name: string;
  display_name: string | null;
  email: string;
};

type PaymentMethod = {
  pix_key_type: string;
  pix_key: string;
  account_holder_name: string;
  account_holder_cpf_or_cnpj: string;
};

type Earning = {
  id: string;
  type: string;
  amount_cents: number;
  description: string | null;
  status: string;
  appointment_id: string | null;
  payment_id: string | null;
  earned_at: string;
};

function brl(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

const STATUS = {
  draft: { label: "Rascunho", cls: "bg-cream-100 text-ink-700 border-ink-200" },
  approved: { label: "Aprovado", cls: "bg-sage-50 text-sage-800 border-sage-200" },
  pix_sent: { label: "PIX enviado", cls: "bg-blue-50 text-blue-800 border-blue-200" },
  confirmed: { label: "Confirmado", cls: "bg-sage-100 text-sage-900 border-sage-300" },
  cancelled: { label: "Cancelado", cls: "bg-ink-100 text-ink-500 border-ink-200" },
  failed: { label: "Falhou", cls: "bg-terracotta-100 text-terracotta-800 border-terracotta-300" },
} as const;

const EARNING_LABELS: Record<string, string> = {
  consultation: "Consulta agendada",
  on_demand_bonus: "Bônus on-demand",
  plantao_hour: "Plantão (hora)",
  manual_bonus: "Bônus manual",
  refund_clawback: "Estorno (clawback)",
  adjustment: "Ajuste",
};

async function load(id: string) {
  const supabase = getSupabaseAdmin();
  const { data: payout } = await supabase
    .from("doctor_payouts")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!payout) return null;

  const [docRes, pmRes, earningsRes] = await Promise.all([
    supabase
      .from("doctors")
      .select("id, full_name, display_name, email")
      .eq("id", payout.doctor_id)
      .maybeSingle(),
    supabase
      .from("doctor_payment_methods")
      .select("pix_key_type, pix_key, account_holder_name, account_holder_cpf_or_cnpj")
      .eq("doctor_id", payout.doctor_id)
      .eq("is_default", true)
      .maybeSingle(),
    supabase
      .from("doctor_earnings")
      .select("id, type, amount_cents, description, status, appointment_id, payment_id, earned_at")
      .eq("payout_id", id)
      .order("earned_at", { ascending: true }),
  ]);

  return {
    payout: payout as Payout,
    doctor: docRes.data as Doctor | null,
    pix: pmRes.data as PaymentMethod | null,
    earnings: (earningsRes.data ?? []) as Earning[],
  };
}

export default async function PayoutDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await load(id);
  if (!data) notFound();
  const { payout, doctor, pix, earnings } = data;

  const st = STATUS[payout.status];

  return (
    <div className="max-w-4xl">
      <Link
        href="/admin/payouts"
        className="text-sm text-ink-500 hover:text-ink-800 mb-3 inline-flex items-center gap-1"
      >
        ← Voltar
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-4 mb-8">
        <div>
          <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
            Repasse · {payout.reference_period}
          </p>
          <h1 className="font-serif text-[2rem] leading-tight text-ink-800">
            {doctor?.display_name ?? doctor?.full_name ?? "Médica"}
          </h1>
          <p className="mt-1 text-ink-500 font-mono text-sm">
            {brl(payout.amount_cents)} · {payout.earnings_count} earnings
          </p>
        </div>
        <span
          className={`inline-flex items-center text-sm font-medium px-3 py-1.5 rounded-full border ${st.cls}`}
        >
          {st.label}
        </span>
      </header>

      <div className="grid lg:grid-cols-[1fr_320px] gap-6">
        <div className="space-y-6">
          {/* Earnings */}
          <section className="rounded-2xl bg-white border border-ink-100 overflow-hidden">
            <header className="px-6 py-4 border-b border-ink-100 flex justify-between items-center">
              <h2 className="font-serif text-[1.2rem] text-ink-800">Earnings consolidados</h2>
              <span className="text-sm text-ink-500">{earnings.length} item(s)</span>
            </header>
            {earnings.length === 0 ? (
              <p className="px-6 py-8 text-center text-ink-500">
                Nenhum earning vinculado.
              </p>
            ) : (
              <table className="w-full">
                <thead className="bg-cream-50 border-b border-ink-100">
                  <tr className="text-left text-[0.78rem] uppercase tracking-[0.12em] text-ink-500 font-medium">
                    <th className="px-6 py-2">Data</th>
                    <th className="px-6 py-2">Tipo</th>
                    <th className="px-6 py-2 text-right">Valor</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {earnings.map((e) => (
                    <tr key={e.id} className="hover:bg-cream-50">
                      <td className="px-6 py-3 text-sm text-ink-600 font-mono">
                        {new Date(e.earned_at).toLocaleDateString("pt-BR")}
                      </td>
                      <td className="px-6 py-3 text-sm">
                        <div className="text-ink-800">
                          {EARNING_LABELS[e.type] ?? e.type}
                        </div>
                        {e.description && (
                          <div className="text-xs text-ink-400 mt-0.5">{e.description}</div>
                        )}
                      </td>
                      <td
                        className={`px-6 py-3 text-right font-mono ${
                          e.amount_cents < 0 ? "text-terracotta-700" : "text-ink-800"
                        }`}
                      >
                        {brl(e.amount_cents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-cream-50 border-t border-ink-100 font-medium">
                  <tr>
                    <td className="px-6 py-3" colSpan={2}>
                      Total
                    </td>
                    <td className="px-6 py-3 text-right font-mono text-ink-800">
                      {brl(payout.amount_cents)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            )}
          </section>

          {/* Histórico */}
          <section className="rounded-2xl bg-white border border-ink-100 p-6">
            <h2 className="font-serif text-[1.2rem] text-ink-800 mb-3">Histórico</h2>
            <ul className="space-y-2 text-sm text-ink-600">
              <li>
                <strong className="text-ink-800">Criado:</strong>{" "}
                {new Date(payout.created_at).toLocaleString("pt-BR")}
              </li>
              {payout.approved_at && (
                <li>
                  <strong className="text-ink-800">Aprovado:</strong>{" "}
                  {new Date(payout.approved_at).toLocaleString("pt-BR")}
                </li>
              )}
              {payout.pix_sent_at && (
                <li>
                  <strong className="text-ink-800">PIX enviado:</strong>{" "}
                  {new Date(payout.pix_sent_at).toLocaleString("pt-BR")}
                  {payout.pix_transaction_id && (
                    <span className="ml-2 font-mono text-xs text-ink-400">
                      tx: {payout.pix_transaction_id}
                    </span>
                  )}
                </li>
              )}
              {payout.confirmed_at && (
                <li>
                  <strong className="text-ink-800">Confirmado:</strong>{" "}
                  {new Date(payout.confirmed_at).toLocaleString("pt-BR")}
                </li>
              )}
            </ul>
            {payout.notes && (
              <p className="mt-3 pt-3 border-t border-ink-100 text-sm text-ink-600 italic">
                &ldquo;{payout.notes}&rdquo;
              </p>
            )}
          </section>
        </div>

        <aside className="space-y-6">
          {/* PIX */}
          <section className="rounded-2xl bg-white border border-ink-100 p-5">
            <h3 className="font-serif text-[1rem] text-ink-800 mb-3">
              Pagar via PIX
            </h3>
            {pix ? (
              <dl className="space-y-2 text-sm">
                <div>
                  <dt className="text-xs uppercase tracking-wide text-ink-400">Tipo</dt>
                  <dd className="text-ink-800 font-medium">{pix.pix_key_type}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-ink-400">Chave</dt>
                  <dd className="text-ink-800 font-mono break-all">{pix.pix_key}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-ink-400">Titular</dt>
                  <dd className="text-ink-800">{pix.account_holder_name}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-ink-400">CPF/CNPJ</dt>
                  <dd className="text-ink-800 font-mono">{pix.account_holder_cpf_or_cnpj}</dd>
                </div>
              </dl>
            ) : (
              <p className="text-sm text-terracotta-700">
                Médica ainda não cadastrou PIX.
                <Link
                  href={`/admin/doctors/${payout.doctor_id}`}
                  className="block mt-2 text-sage-700 hover:underline"
                >
                  Cadastrar PIX →
                </Link>
              </p>
            )}
          </section>

          {/* Ações */}
          <PayoutActions
            payoutId={payout.id}
            status={payout.status}
            hasPix={!!pix}
            amountCents={payout.amount_cents}
          />
        </aside>
      </div>
    </div>
  );
}
