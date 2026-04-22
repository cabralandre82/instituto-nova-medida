/**
 * /admin/fulfillments — D-044 · 2.E + PR-058 · D-069 · finding 8.7
 *
 * Painel operacional dos fulfillments. Dois modos:
 *
 *   - **Sem filtro:** lista por grupo de status (Pagos, Na farmácia,
 *     Despachados, Pendentes), exatamente como antes — preserva o
 *     fluxo "scan rápido do que precisa de ação".
 *   - **Com filtro:** lista única ordenada por `created_at desc`,
 *     respeitando search por nome do paciente, status específico e
 *     date range (em `created_at`). Útil pra "achar o fulfillment do
 *     João da Silva de duas semanas atrás" sem SQL.
 *
 * A lista lê da view `fulfillments_operational` (2.C.1) que agrega
 * paciente, plano, médica, prescrição e cobrança num row só.
 */

import Link from "next/link";
import { getSupabaseAdmin } from "@/lib/supabase";
import { labelForFulfillmentStatus } from "@/lib/fulfillment-transitions";
import type { FulfillmentStatus } from "@/lib/fulfillments";
import { logger } from "@/lib/logger";
import {
  buildAdminListUrl,
  escapeIlike,
  hasActiveFilters,
  parseDateRange,
  parseSearch,
  parseStatusFilter,
} from "@/lib/admin-list-filters";

const log = logger.with({ route: "/admin/fulfillments" });

export const dynamic = "force-dynamic";

const ALL_STATUSES: readonly FulfillmentStatus[] = [
  "pending_acceptance",
  "pending_payment",
  "paid",
  "pharmacy_requested",
  "shipped",
  "delivered",
  "cancelled",
] as const;

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

const FF_OP_SELECT =
  "fulfillment_id, fulfillment_status, created_at, accepted_at, paid_at, pharmacy_requested_at, shipped_at, delivered_at, customer_name, plan_name, plan_medication, plan_price_pix_cents, doctor_name, appointment_id, shipping_city, shipping_state";

async function loadByStatuses(
  statuses: FulfillmentStatus[]
): Promise<FfOperationalRow[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("fulfillments_operational")
    .select(FF_OP_SELECT)
    .in("fulfillment_status", statuses)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    log.error("load", { err: error });
    return [];
  }
  return (data ?? []) as unknown as FfOperationalRow[];
}

type Filters = {
  q: string | null;
  status: FulfillmentStatus | null;
  fromIso: string | null;
  toIso: string | null;
  invertedRange: boolean;
};

async function loadFiltered(filters: Filters): Promise<FfOperationalRow[]> {
  const supabase = getSupabaseAdmin();
  let builder = supabase
    .from("fulfillments_operational")
    .select(FF_OP_SELECT)
    .order("created_at", { ascending: false })
    .limit(200);

  if (filters.status) {
    builder = builder.eq("fulfillment_status", filters.status);
  }
  if (filters.fromIso) {
    builder = builder.gte("created_at", filters.fromIso);
  }
  if (filters.toIso) {
    builder = builder.lte("created_at", filters.toIso);
  }
  if (filters.q) {
    builder = builder.ilike("customer_name", `%${escapeIlike(filters.q)}%`);
  }

  const { data, error } = await builder;
  if (error) {
    log.error("loadFiltered", { err: error });
    return [];
  }
  return (data ?? []) as unknown as FfOperationalRow[];
}

type SearchParams = {
  q?: string;
  status?: string;
  from?: string;
  to?: string;
};

export default async function FulfillmentsAdminPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const q = parseSearch(params.q);
  const status = parseStatusFilter<FulfillmentStatus>(
    params.status,
    ALL_STATUSES
  );
  const { fromIso, toIso, invertedRange } = parseDateRange(
    params.from,
    params.to
  );

  const filters: Filters = { q, status, fromIso, toIso, invertedRange };
  const isFiltered = hasActiveFilters({
    q,
    status,
    fromIso,
    toIso,
  });

  return (
    <div>
      <header className="mb-6">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Operação
        </p>
        <h1 className="font-serif text-[1.85rem] sm:text-[2.2rem] leading-tight text-ink-800">
          Planos em fulfillment
        </h1>
      </header>

      <FilterBar
        defaults={{
          q: q ?? "",
          status: status ?? "",
          from: typeof params.from === "string" ? params.from : "",
          to: typeof params.to === "string" ? params.to : "",
        }}
        statuses={ALL_STATUSES}
        invertedRange={invertedRange}
      />

      {isFiltered ? (
        <FilteredList filters={filters} />
      ) : (
        <GroupedList />
      )}
    </div>
  );
}

async function GroupedList() {
  const results = await Promise.all(
    GROUPS.map((g) => loadByStatuses(g.statuses))
  );
  const actionCount =
    results[0].length + results[1].length + results[2].length;

  return (
    <>
      <p className="mb-6 text-ink-500 text-sm">
        {actionCount === 0
          ? "Nada pendente no momento."
          : `${actionCount} ${
              actionCount === 1 ? "caso aguardando" : "casos aguardando"
            } ação operacional.`}
      </p>

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
                <FulfillmentRowsList rows={rows} />
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}

async function FilteredList({ filters }: { filters: Filters }) {
  const rows = await loadFiltered(filters);
  return (
    <section>
      <p className="mb-4 text-ink-500 text-sm">
        {rows.length === 0
          ? "Nenhum resultado para os filtros selecionados."
          : `${rows.length} resultado${rows.length === 1 ? "" : "s"} (limite 200).`}
      </p>
      {rows.length > 0 && <FulfillmentRowsList rows={rows} />}
    </section>
  );
}

function FulfillmentRowsList({ rows }: { rows: FfOperationalRow[] }) {
  return (
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
  );
}

function FilterBar({
  defaults,
  statuses,
  invertedRange,
}: {
  defaults: { q: string; status: string; from: string; to: string };
  statuses: readonly FulfillmentStatus[];
  invertedRange: boolean;
}) {
  const isFiltered =
    defaults.q.length > 0 ||
    defaults.status.length > 0 ||
    defaults.from.length > 0 ||
    defaults.to.length > 0;

  return (
    <form
      method="get"
      action="/admin/fulfillments"
      className="mb-6 rounded-2xl border border-ink-100 bg-white p-4"
    >
      <div className="grid gap-3 md:grid-cols-[1fr_180px_140px_140px_auto]">
        <input
          type="search"
          name="q"
          defaultValue={defaults.q}
          placeholder="Buscar por nome do paciente"
          className="h-10 px-3 rounded-lg border border-ink-200 bg-white text-sm text-ink-800 focus:outline-none focus:border-sage-500"
          aria-label="Buscar por nome do paciente"
        />
        <select
          name="status"
          defaultValue={defaults.status}
          className="h-10 px-3 rounded-lg border border-ink-200 bg-white text-sm text-ink-800 focus:outline-none focus:border-sage-500"
          aria-label="Filtrar por status"
        >
          <option value="">Todos os status</option>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {labelForFulfillmentStatus(s)}
            </option>
          ))}
        </select>
        <input
          type="date"
          name="from"
          defaultValue={defaults.from}
          className="h-10 px-3 rounded-lg border border-ink-200 bg-white text-sm text-ink-800 focus:outline-none focus:border-sage-500"
          aria-label="Data inicial (criação)"
        />
        <input
          type="date"
          name="to"
          defaultValue={defaults.to}
          className="h-10 px-3 rounded-lg border border-ink-200 bg-white text-sm text-ink-800 focus:outline-none focus:border-sage-500"
          aria-label="Data final (criação)"
        />
        <div className="flex gap-2">
          <button
            type="submit"
            className="h-10 px-4 rounded-lg bg-ink-800 text-white text-sm font-medium hover:bg-ink-700 transition-colors"
          >
            Filtrar
          </button>
          {isFiltered && (
            <Link
              href={buildAdminListUrl("/admin/fulfillments", {})}
              className="h-10 px-4 flex items-center rounded-lg border border-ink-200 text-sm text-ink-600 hover:bg-cream-50 transition-colors"
            >
              Limpar
            </Link>
          )}
        </div>
      </div>
      {invertedRange && (
        <p className="mt-2 text-xs text-terracotta-700">
          ⚠ Data inicial maior que a final — corrija pra ver resultados.
        </p>
      )}
    </form>
  );
}
