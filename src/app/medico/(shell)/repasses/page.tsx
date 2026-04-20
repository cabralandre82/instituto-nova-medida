/**
 * /medico/repasses — histórico de payouts da médica + upload de NF-e.
 *
 * Mostra:
 *   - Saldo em tempo real: available + pending + próximo payout estimado
 *   - Lista de payouts com status PIX, comprovante, NF anexada e validação
 *
 * Ações da médica por linha:
 *   - Ver comprovante (quando admin já subiu)
 *   - Enviar/substituir/remover NF-e (D-041)
 *   - Ver NF enviada
 */

import { requireDoctor } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  getDoctorBalance,
  estimateNextPayout,
  listPayoutsWithDocuments,
} from "@/lib/doctor-finance";
import { ProofLink } from "./ProofLink";
import { BillingDocumentBlock } from "./BillingDocumentBlock";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function brl(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function fmtDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function fmtPeriod(period: string): string {
  if (!/^\d{4}-\d{2}$/.test(period)) return period;
  const [y, m] = period.split("-").map((s) => Number(s));
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
}

const STATUS_META: Record<
  string,
  { label: string; tone: "sage" | "terracotta" | "ink"; description: string }
> = {
  draft: {
    label: "Em revisão",
    tone: "ink",
    description: "Operador está conferindo os valores.",
  },
  approved: {
    label: "Aprovado",
    tone: "sage",
    description: "Aprovado. PIX será enviado em até 1 dia útil.",
  },
  pix_sent: {
    label: "PIX enviado",
    tone: "terracotta",
    description: "Pagamento enviado, aguardando confirmação bancária.",
  },
  confirmed: {
    label: "Pago",
    tone: "sage",
    description: "Confirmado pelo banco. NF-e necessária para o ciclo fiscal.",
  },
  cancelled: {
    label: "Cancelado",
    tone: "ink",
    description: "Cancelado. Os ganhos retornam para o próximo repasse.",
  },
  failed: {
    label: "Falhou",
    tone: "terracotta",
    description: "Falha técnica. Operador foi notificado.",
  },
};

export default async function DoctorPayoutsPage() {
  const { doctorId } = await requireDoctor();
  const supabase = getSupabaseAdmin();

  const [balance, nextPayout, payouts] = await Promise.all([
    getDoctorBalance(supabase, doctorId),
    estimateNextPayout(supabase, doctorId),
    listPayoutsWithDocuments(supabase, doctorId, 24),
  ]);

  const totals = payouts.reduce(
    (acc, p) => {
      if (p.status === "confirmed") acc.confirmed += p.amount_cents;
      else if (["draft", "approved", "pix_sent"].includes(p.status))
        acc.inFlight += p.amount_cents;
      return acc;
    },
    { confirmed: 0, inFlight: 0 }
  );

  const pendingNfCount = payouts.filter(
    (p) =>
      p.status === "confirmed" && (!p.document || !p.document.validatedAt)
  ).length;

  return (
    <div>
      <header className="mb-8">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Financeiro
        </p>
        <h1 className="font-serif text-[2rem] sm:text-[2.4rem] leading-tight text-ink-800">
          Seus repasses
        </h1>
        <p className="mt-2 text-ink-500">
          Saldo em tempo real, histórico de PIX e envio de NF-e por ciclo.
        </p>
      </header>

      {pendingNfCount > 0 && (
        <div className="mb-6 rounded-2xl border border-terracotta-200 bg-terracotta-50 p-4 sm:p-5">
          <p className="text-sm text-terracotta-800">
            <strong>NF-e pendente em {pendingNfCount} repasse{pendingNfCount === 1 ? "" : "s"}.</strong>{" "}
            Envie a nota fiscal nos cards abaixo para manter o ciclo fiscal em dia.
          </p>
        </div>
      )}

      <section className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <BalanceCard
          label="Disponível"
          value={brl(balance.availableCents)}
          helper={`${balance.counts.available} ganho${balance.counts.available === 1 ? "" : "s"}`}
          tone="sage"
        />
        <BalanceCard
          label="Aguardando"
          value={brl(balance.pendingCents)}
          helper={`${balance.counts.pending} na janela de risco`}
          tone="ink"
        />
        <BalanceCard
          label="Próximo repasse"
          value={brl(nextPayout.eligibleCents)}
          helper={`Fechamento em ${fmtDate(nextPayout.scheduledAt) ?? "—"}`}
          tone="terracotta"
        />
        <BalanceCard
          label="Total recebido"
          value={brl(totals.confirmed)}
          helper={`${balance.counts.paid} ganho${balance.counts.paid === 1 ? "" : "s"} pago${balance.counts.paid === 1 ? "" : "s"}`}
          tone="ink-light"
        />
      </section>

      {payouts.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-ink-200 bg-cream-50 p-8 text-center">
          <p className="text-ink-600">Nenhum repasse gerado ainda.</p>
          <p className="mt-2 text-sm text-ink-500">
            Repasses são fechados na virada do mês a partir das earnings disponíveis.
          </p>
        </div>
      ) : (
        <ul className="space-y-4">
          {payouts.map((p) => {
            const meta = STATUS_META[p.status] ?? {
              label: p.status,
              tone: "ink" as const,
              description: "",
            };
            const toneBadge =
              meta.tone === "sage"
                ? "bg-sage-50 text-sage-800 border-sage-200"
                : meta.tone === "terracotta"
                ? "bg-terracotta-50 text-terracotta-800 border-terracotta-200"
                : "bg-ink-50 text-ink-700 border-ink-200";

            const canUpload =
              p.status === "confirmed" ||
              p.status === "pix_sent" ||
              p.status === "approved";

            const doc = p.document;

            return (
              <li
                key={p.id}
                className="rounded-2xl border border-ink-100 bg-white p-5 sm:p-6"
              >
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-4">
                  <div>
                    <p className="font-serif text-[1.3rem] text-ink-800 capitalize">
                      {fmtPeriod(p.reference_period)}
                    </p>
                    <p className="text-sm text-ink-500 mt-0.5">
                      {p.earnings_count} ganho{p.earnings_count === 1 ? "" : "s"}{" "}
                      consolidado{p.earnings_count === 1 ? "" : "s"}
                    </p>
                  </div>
                  <div className="text-left sm:text-right">
                    <p className="font-serif text-[1.5rem] text-ink-800 leading-none">
                      {brl(p.amount_cents)}
                    </p>
                    <span
                      className={`mt-2 inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border ${toneBadge}`}
                    >
                      {meta.label}
                    </span>
                  </div>
                </div>

                <p className="text-sm text-ink-600">{meta.description}</p>

                {(p.confirmed_at || p.paid_at) && (
                  <dl className="mt-4 grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
                    {p.paid_at && (
                      <div className="flex justify-between gap-3">
                        <dt className="text-ink-500">PIX enviado em</dt>
                        <dd className="text-ink-800">{fmtDate(p.paid_at)}</dd>
                      </div>
                    )}
                    {p.confirmed_at && (
                      <div className="flex justify-between gap-3">
                        <dt className="text-ink-500">Confirmado em</dt>
                        <dd className="text-ink-800">{fmtDate(p.confirmed_at)}</dd>
                      </div>
                    )}
                  </dl>
                )}

                {p.status === "confirmed" && <ProofLink payoutId={p.id} />}

                {canUpload && (
                  <BillingDocumentBlock
                    payoutId={p.id}
                    amountCents={p.amount_cents}
                    canUpload={canUpload}
                    document={doc}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function BalanceCard({
  label,
  value,
  helper,
  tone,
}: {
  label: string;
  value: string;
  helper?: string;
  tone: "sage" | "terracotta" | "ink" | "ink-light";
}) {
  const toneClasses = {
    sage: "border-sage-200 bg-sage-50",
    terracotta: "border-terracotta-200 bg-terracotta-50",
    ink: "border-ink-100 bg-white",
    "ink-light": "border-ink-100 bg-cream-50",
  }[tone];
  const valueClasses = {
    sage: "text-sage-800",
    terracotta: "text-terracotta-700",
    ink: "text-ink-800",
    "ink-light": "text-ink-700",
  }[tone];
  return (
    <div className={`rounded-2xl border p-4 ${toneClasses}`}>
      <p className="text-[0.78rem] uppercase tracking-[0.14em] text-ink-500 font-medium mb-1.5">
        {label}
      </p>
      <p className={`font-serif text-[1.5rem] leading-none ${valueClasses}`}>
        {value}
      </p>
      {helper && <p className="mt-2 text-xs text-ink-500">{helper}</p>}
    </div>
  );
}
