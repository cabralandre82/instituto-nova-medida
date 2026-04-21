/**
 * /admin/fulfillments — D-044 · 2.E
 *
 * Painel operacional dos fulfillments em aberto. Lista separada
 * por status pra o operador entender o que precisa de ação:
 *
 *   - Pagos aguardando envio à farmácia
 *   - Na farmácia aguardando despacho
 *   - Despachados aguardando entrega/confirmação
 *   - Pendentes de pagamento (visibilidade, sem ação direta)
 *
 * A lista lê da view `fulfillments_operational` (2.C.1) que agrega
 * tudo — paciente, plano, médica, prescrição, cobrança — num row só.
 *
 * Cada linha linka pro detalhe `/admin/fulfillments/[id]` onde ficam
 * os botões de transição.
 */

import Link from "next/link";
import { getSupabaseAdmin } from "@/lib/supabase";
import { labelForFulfillmentStatus } from "@/lib/fulfillment-transitions";
import type { FulfillmentStatus } from "@/lib/fulfillments";

export const dynamic = "force-dynamic";

type FfOperationalRow = {
  fulfillment_id: string;
  fulfillment_status: FulfillmentStatus;
  created_at: string;
  accepted_at: string | null;
  paid_at: string | null;
  pharmacy_requested_at: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  customer_name: string;
  plan_name: string;
  plan_medication: string | null;
  plan_price_pix_cents: number;
  doctor_name: string;
  appointment_id: string;
  shipping_city: string | null;
  shipping_state: string | null;
};

const GROUPS: Array<{
  key: string;
  title: string;
  subtitle: string;
  statuses: FulfillmentStatus[];
  emptyMessage: string;
  tone: "action" | "info" | "muted";
}> = [
  {
    key: "paid",
    title: "Pagos · enviar à farmácia",
    subtitle:
      "Paciente aceitou, pagou. Confirme os dados da prescrição antes de acionar a farmácia de manipulação.",
    statuses: ["paid"],
    emptyMessage: "Nenhum fulfillment aguardando envio à farmácia.",
    tone: "action",
  },
  {
    key: "pharmacy_requested",
    title: "Na farmácia · despachar ao paciente",
    subtitle:
      "Manipulação solicitada. Quando a caixa chegar ao Instituto, registre o rastreio e marque como despachado.",
    statuses: ["pharmacy_requested"],
    emptyMessage: "Nenhum pedido aguardando despacho.",
    tone: "action",
  },
  {
    key: "shipped",
    title: "Despachados · aguardando confirmação",
    subtitle:
      "Em trânsito. O paciente pode confirmar recebimento na área dele; admin pode forçar caso necessário.",
    statuses: ["shipped"],
    emptyMessage: "Nenhuma entrega em trânsito.",
    tone: "info",
  },
  {
    key: "pending",
    title: "Pendentes · aceite ou pagamento",
    subtitle:
      "Ainda não viraram ação operacional. Só visibilidade — não confronte o paciente por aqui.",
    statuses: ["pending_acceptance", "pending_payment"],
    emptyMessage: "Nenhum fulfillment pendente.",
    tone: "muted",
  },
];

import { formatCurrencyBRL, formatDateTimeShortBR } from "@/lib/datetime-br";

function brl(cents: number | null | undefined): string {
  return cents == null ? "—" : formatCurrencyBRL(cents);
}

function fmtDate(iso: string | null): string {
  return iso ? formatDateTimeShortBR(iso) : "—";
}

async function loadByStatuses(
  statuses: FulfillmentStatus[]
): Promise<FfOperationalRow[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("fulfillments_operational")
    .select(
      "fulfillment_id, fulfillment_status, created_at, accepted_at, paid_at, pharmacy_requested_at, shipped_at, delivered_at, customer_name, plan_name, plan_medication, plan_price_pix_cents, doctor_name, appointment_id, shipping_city, shipping_state"
    )
    .in("fulfillment_status", statuses)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    console.error("[admin/fulfillments] load:", error);
    return [];
  }
  return (data ?? []) as unknown as FfOperationalRow[];
}

export default async function FulfillmentsAdminPage() {
  const results = await Promise.all(
    GROUPS.map((g) => loadByStatuses(g.statuses))
  );
  const actionCount =
    results[0].length + results[1].length + results[2].length;

  return (
    <div>
      <header className="mb-8">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Operação
        </p>
        <h1 className="font-serif text-[1.85rem] sm:text-[2.2rem] leading-tight text-ink-800">
          Planos em fulfillment
        </h1>
        <p className="mt-1 text-ink-500">
          {actionCount === 0
            ? "Nada pendente no momento."
            : `${actionCount} ${
                actionCount === 1 ? "caso aguardando" : "casos aguardando"
              } ação operacional.`}
        </p>
      </header>

      <div className="space-y-10">
        {GROUPS.map((group, idx) => {
          const rows = results[idx];
          return (
            <section key={group.key}>
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
                <div>
                  <h2 className="font-serif text-[1.3rem] text-ink-800 leading-tight">
                    {group.title}{" "}
                    <span className="text-ink-400 font-sans text-base">
                      ({rows.length})
                    </span>
                  </h2>
                  <p className="text-sm text-ink-500 mt-0.5 max-w-2xl">
                    {group.subtitle}
                  </p>
                </div>
              </div>

              {rows.length === 0 ? (
                <div className="rounded-xl border border-ink-100 bg-white px-5 py-6 text-sm text-ink-500">
                  {group.emptyMessage}
                </div>
              ) : (
                <ul className="divide-y divide-ink-100 rounded-xl border border-ink-100 bg-white overflow-hidden">
                  {rows.map((r) => (
                    <li key={r.fulfillment_id}>
                      <Link
                        href={`/admin/fulfillments/${r.fulfillment_id}`}
                        className="block px-5 py-4 hover:bg-cream-50 transition-colors"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-4">
                          <div className="min-w-0 flex-1">
                            <p className="font-serif text-[1.05rem] text-ink-800">
                              {r.customer_name}
                            </p>
                            <p className="text-sm text-ink-600 mt-0.5">
                              {r.plan_name}
                              {r.plan_medication && (
                                <span className="text-ink-400">
                                  {" · "}
                                  {r.plan_medication}
                                </span>
                              )}
                            </p>
                            <p className="text-xs text-ink-500 mt-1">
                              {r.doctor_name}
                              {(r.shipping_city || r.shipping_state) && (
                                <>
                                  {" · entrega "}
                                  {[r.shipping_city, r.shipping_state]
                                    .filter(Boolean)
                                    .join("/")}
                                </>
                              )}
                            </p>
                          </div>
                          <div className="text-right text-sm">
                            <span className="inline-block rounded-full bg-ink-800 text-white text-xs px-2.5 py-1 font-medium">
                              {labelForFulfillmentStatus(r.fulfillment_status)}
                            </span>
                            <p className="mt-1 text-ink-700 font-medium">
                              {brl(r.plan_price_pix_cents)}
                            </p>
                            <p className="mt-0.5 text-xs text-ink-500">
                              {fmtDate(
                                r.shipped_at ??
                                  r.pharmacy_requested_at ??
                                  r.paid_at ??
                                  r.accepted_at ??
                                  r.created_at
                              )}
                            </p>
                          </div>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
