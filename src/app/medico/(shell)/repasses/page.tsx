/**
 * /medico/repasses — histórico de payouts da médica.
 *
 * Read-only. Mostra status do ciclo (draft/approved/pix_sent/confirmed/cancelled)
 * com timeline visual e os valores. PIX key snapshot é exibido pra
 * conferência. Comprovante (Sprint 4.1 3/3) ainda não anexável aqui.
 */

import { requireDoctor } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type PayoutRow = {
  id: string;
  reference_period: string;
  amount_cents: number;
  earnings_count: number;
  status: string;
  approved_at: string | null;
  paid_at: string | null;
  receipt_url: string | null;
  pix_tx_id: string | null;
  pix_key_snapshot: string | null;
  pix_key_type_snapshot: string | null;
  notes: string | null;
  failed_reason: string | null;
  cancelled_reason: string | null;
  created_at: string;
};

async function loadPayouts(doctorId: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("doctor_payouts")
    .select(
      "id, reference_period, amount_cents, earnings_count, status, approved_at, paid_at, receipt_url, pix_tx_id, pix_key_snapshot, pix_key_type_snapshot, notes, failed_reason, cancelled_reason, created_at"
    )
    .eq("doctor_id", doctorId)
    .order("reference_period", { ascending: false })
    .limit(24);

  if (error) {
    console.error("[medico/repasses] load:", error);
    return [] as PayoutRow[];
  }
  return (data ?? []) as PayoutRow[];
}

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
    description: "Confirmado pelo banco. Comprovante disponível.",
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
  const payouts = await loadPayouts(doctorId);

  const totals = payouts.reduce(
    (acc, p) => {
      if (p.status === "confirmed") acc.confirmed += p.amount_cents;
      else if (["draft", "approved", "pix_sent"].includes(p.status))
        acc.inFlight += p.amount_cents;
      return acc;
    },
    { confirmed: 0, inFlight: 0 }
  );

  return (
    <div>
      <header className="mb-8">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Repasses
        </p>
        <h1 className="font-serif text-[2rem] sm:text-[2.4rem] leading-tight text-ink-800">
          Seus pagamentos
        </h1>
        <p className="mt-2 text-ink-500">
          Cada mês de competência gera um repasse via PIX. Histórico dos últimos 24 meses.
        </p>
      </header>

      <section className="grid sm:grid-cols-2 gap-4 mb-8">
        <div className="rounded-2xl border border-sage-200 bg-sage-50 p-5">
          <p className="text-[0.78rem] uppercase tracking-[0.14em] text-ink-500 font-medium mb-1.5">
            Total recebido (histórico)
          </p>
          <p className="font-serif text-[1.7rem] leading-none text-sage-800">
            {brl(totals.confirmed)}
          </p>
        </div>
        <div className="rounded-2xl border border-ink-100 bg-white p-5">
          <p className="text-[0.78rem] uppercase tracking-[0.14em] text-ink-500 font-medium mb-1.5">
            Em processamento
          </p>
          <p className="font-serif text-[1.7rem] leading-none text-ink-800">
            {brl(totals.inFlight)}
          </p>
        </div>
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

                <dl className="mt-4 grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
                  {p.pix_key_snapshot && (
                    <div className="flex justify-between gap-3">
                      <dt className="text-ink-500">Chave PIX</dt>
                      <dd className="text-ink-800 font-mono truncate" title={p.pix_key_snapshot}>
                        {p.pix_key_snapshot}
                      </dd>
                    </div>
                  )}
                  {p.approved_at && (
                    <div className="flex justify-between gap-3">
                      <dt className="text-ink-500">Aprovado em</dt>
                      <dd className="text-ink-800">{fmtDate(p.approved_at)}</dd>
                    </div>
                  )}
                  {p.paid_at && (
                    <div className="flex justify-between gap-3">
                      <dt className="text-ink-500">Pago em</dt>
                      <dd className="text-ink-800">{fmtDate(p.paid_at)}</dd>
                    </div>
                  )}
                  {p.pix_tx_id && (
                    <div className="flex justify-between gap-3">
                      <dt className="text-ink-500">ID PIX</dt>
                      <dd className="text-ink-800 font-mono truncate" title={p.pix_tx_id}>
                        {p.pix_tx_id}
                      </dd>
                    </div>
                  )}
                </dl>

                {p.notes && (
                  <p className="mt-3 text-xs text-ink-500 border-t border-ink-100 pt-3">
                    Observação do operador: {p.notes}
                  </p>
                )}
                {(p.failed_reason || p.cancelled_reason) && (
                  <p className="mt-3 text-xs text-terracotta-700 border-t border-terracotta-100 pt-3">
                    {p.failed_reason ?? p.cancelled_reason}
                  </p>
                )}

                {p.receipt_url && (
                  <a
                    href={p.receipt_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-sage-700 hover:text-sage-800 hover:underline"
                  >
                    Ver comprovante →
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
