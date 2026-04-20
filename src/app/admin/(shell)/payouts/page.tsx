/**
 * /admin/payouts — Lista de repasses (payouts) por status.
 *
 * Status:
 *   - draft     → gerado pelo cron, aguardando revisão
 *   - approved  → aprovado pelo admin, aguarda PIX manual
 *   - pix_sent  → PIX enviado, aguarda confirmação manual
 *   - confirmed → bateu na conta da médica
 *   - cancelled → cancelado
 */

import Link from "next/link";
import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type Payout = {
  id: string;
  doctor_id: string;
  reference_period: string;
  amount_cents: number;
  status: "draft" | "approved" | "pix_sent" | "confirmed" | "cancelled" | "failed";
  earnings_count: number;
  auto_generated: boolean | null;
  approved_at: string | null;
  pix_sent_at: string | null;
  confirmed_at: string | null;
  created_at: string;
  doctors: { full_name: string; display_name: string | null } | null;
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

async function loadPayouts(): Promise<Payout[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("doctor_payouts")
    .select(
      "id, doctor_id, reference_period, amount_cents, status, earnings_count, auto_generated, approved_at, pix_sent_at, confirmed_at, created_at, doctors(full_name, display_name)"
    )
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) {
    console.error("[admin/payouts]", error);
    return [];
  }
  return (data ?? []) as unknown as Payout[];
}

export default async function PayoutsPage() {
  const payouts = await loadPayouts();
  const groups: Record<Payout["status"], Payout[]> = {
    draft: [],
    approved: [],
    pix_sent: [],
    confirmed: [],
    cancelled: [],
    failed: [],
  };
  for (const p of payouts) groups[p.status].push(p);

  return (
    <div>
      <header className="mb-8">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Financeiro
        </p>
        <h1 className="font-serif text-[1.85rem] sm:text-[2.2rem] leading-tight text-ink-800">
          Repasses
        </h1>
        <p className="mt-1 text-ink-500">
          Lotes mensais por médica. Geração automática no dia 1º.
          Aprovação, envio do PIX e confirmação são manuais.
        </p>
      </header>

      {payouts.length === 0 ? (
        <div className="rounded-2xl bg-white border border-ink-100 p-10 text-center">
          <h2 className="font-serif text-[1.3rem] text-ink-800 mb-2">
            Sem repasses ainda
          </h2>
          <p className="text-ink-500">
            O primeiro lote será gerado automaticamente no dia 1º do
            próximo mês, consolidando earnings disponíveis por médica.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {(["draft", "approved", "pix_sent", "confirmed", "failed", "cancelled"] as const).map((st) => {
            const list = groups[st];
            if (list.length === 0) return null;
            return (
              <section key={st}>
                <h2 className="font-serif text-[1.2rem] text-ink-800 mb-3">
                  {STATUS[st].label}{" "}
                  <span className="text-ink-400 font-normal">({list.length})</span>
                </h2>
                <div className="rounded-2xl bg-white border border-ink-100 overflow-hidden">
                  <table className="w-full">
                    <thead className="bg-cream-50 border-b border-ink-100">
                      <tr className="text-left text-[0.78rem] uppercase tracking-[0.12em] text-ink-500 font-medium">
                        <th className="px-5 py-3">Médica</th>
                        <th className="px-5 py-3">Período</th>
                        <th className="px-5 py-3 text-right">Valor</th>
                        <th className="px-5 py-3 hidden sm:table-cell">Earnings</th>
                        <th className="px-5 py-3 hidden md:table-cell">Status atual</th>
                        <th className="px-5 py-3 text-right" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-100">
                      {list.map((p) => (
                        <tr key={p.id} className="hover:bg-cream-50">
                          <td className="px-5 py-4 font-medium text-ink-800">
                            <div className="flex items-center gap-2">
                              <span>
                                {p.doctors?.display_name ?? p.doctors?.full_name ?? "—"}
                              </span>
                              {p.auto_generated ? (
                                <span
                                  className="inline-flex items-center text-[0.7rem] px-2 py-0.5 rounded-full border border-sage-200 bg-sage-50 text-sage-800 font-medium"
                                  title="Este rascunho foi criado automaticamente pelo cron mensal (D-040)."
                                >
                                  auto
                                </span>
                              ) : null}
                            </div>
                          </td>
                          <td className="px-5 py-4 text-ink-600 font-mono text-sm">
                            {p.reference_period}
                          </td>
                          <td className="px-5 py-4 text-right font-mono text-ink-800 font-medium">
                            {brl(p.amount_cents)}
                          </td>
                          <td className="px-5 py-4 hidden sm:table-cell text-sm text-ink-500">
                            {p.earnings_count}
                          </td>
                          <td className="px-5 py-4 hidden md:table-cell">
                            <span
                              className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full border ${STATUS[st].cls}`}
                            >
                              {STATUS[st].label}
                            </span>
                          </td>
                          <td className="px-5 py-4 text-right">
                            <Link
                              href={`/admin/payouts/${p.id}`}
                              className="text-sage-700 hover:text-sage-800 hover:underline text-sm font-medium"
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
            );
          })}
        </div>
      )}
    </div>
  );
}
