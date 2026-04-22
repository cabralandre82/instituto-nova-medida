/**
 * /admin/payouts — Lista de repasses (payouts) por status.
 *
 * Status:
 *   - draft     → gerado pelo cron, aguardando revisão
 *   - approved  → aprovado pelo admin, aguarda PIX manual
 *   - pix_sent  → PIX enviado, aguarda confirmação manual
 *   - confirmed → bateu na conta da médica
 *   - cancelled → cancelado
 *   - failed    → PIX falhou (erro técnico ou chave inválida)
 *
 * PR-058 · D-069 · finding 8.7 — adiciona FilterBar com:
 *   - busca por nome da médica (display_name OU full_name)
 *   - filtro por status (allowlist)
 *   - filtro por reference_period (`YYYY-MM`)
 *   - date range em `created_at`
 *
 * Sem filtros aplicados, mantém o agrupamento por status (UX
 * existente). Com qualquer filtro, vira tabela única ordenada por
 * `created_at desc`.
 */

import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase";
import { formatCurrencyBRL } from "@/lib/datetime-br";
import { logger } from "@/lib/logger";
import {
  buildAdminListUrl,
  escapeIlike,
  hasActiveFilters,
  parseDateRange,
  parsePeriodFilter,
  parseSearch,
  parseStatusFilter,
} from "@/lib/admin-list-filters";

const log = logger.with({ route: "/admin/payouts" });

export const dynamic = "force-dynamic";

type PayoutStatus =
  | "draft"
  | "approved"
  | "pix_sent"
  | "confirmed"
  | "cancelled"
  | "failed";

const ALL_PAYOUT_STATUSES: readonly PayoutStatus[] = [
  "draft",
  "approved",
  "pix_sent",
  "confirmed",
  "failed",
  "cancelled",
] as const;

type Payout = {
  id: string;
  doctor_id: string;
  reference_period: string;
  amount_cents: number;
  status: PayoutStatus;
  earnings_count: number;
  auto_generated: boolean | null;
  approved_at: string | null;
  pix_sent_at: string | null;
  confirmed_at: string | null;
  created_at: string;
  doctors: { full_name: string; display_name: string | null } | null;
};

const PAYOUT_SELECT =
  "id, doctor_id, reference_period, amount_cents, status, earnings_count, auto_generated, approved_at, pix_sent_at, confirmed_at, created_at, doctors(full_name, display_name)";

function brl(cents: number): string {
  return formatCurrencyBRL(cents);
}

const STATUS = {
  draft: { label: "Rascunho", cls: "bg-cream-100 text-ink-700 border-ink-200" },
  approved: { label: "Aprovado", cls: "bg-sage-50 text-sage-800 border-sage-200" },
  pix_sent: { label: "PIX enviado", cls: "bg-blue-50 text-blue-800 border-blue-200" },
  confirmed: { label: "Confirmado", cls: "bg-sage-100 text-sage-900 border-sage-300" },
  cancelled: { label: "Cancelado", cls: "bg-ink-100 text-ink-500 border-ink-200" },
  failed: { label: "Falhou", cls: "bg-terracotta-100 text-terracotta-800 border-terracotta-300" },
} as const;

async function loadAll(): Promise<Payout[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("doctor_payouts")
    .select(PAYOUT_SELECT)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) {
    log.error("load", { err: error });
    return [];
  }
  return (data ?? []) as unknown as Payout[];
}

type Filters = {
  q: string | null;
  status: PayoutStatus | null;
  period: string | null;
  fromIso: string | null;
  toIso: string | null;
  invertedRange: boolean;
};

async function loadFiltered(filters: Filters): Promise<Payout[]> {
  // Search por nome da médica precisa de OR em duas colunas dentro de
  // doctors. Estratégia mais simples e tipada: pre-resolve doctor_ids
  // que casam, depois filtra `doctor_id IN (...)`. Evita PostgREST
  // .or() em colunas relacionadas (frágil) e a sintaxe nested filter.
  const supabase = getSupabaseAdmin();
  let doctorIdSubset: string[] | null = null;
  if (filters.q) {
    doctorIdSubset = await resolveDoctorsByName(supabase, filters.q);
    if (doctorIdSubset.length === 0) return [];
  }

  let builder = supabase
    .from("doctor_payouts")
    .select(PAYOUT_SELECT)
    .order("created_at", { ascending: false })
    .limit(200);

  if (filters.status) builder = builder.eq("status", filters.status);
  if (filters.period) builder = builder.eq("reference_period", filters.period);
  if (filters.fromIso) builder = builder.gte("created_at", filters.fromIso);
  if (filters.toIso) builder = builder.lte("created_at", filters.toIso);
  if (doctorIdSubset) builder = builder.in("doctor_id", doctorIdSubset);

  const { data, error } = await builder;
  if (error) {
    log.error("loadFiltered", { err: error });
    return [];
  }
  return (data ?? []) as unknown as Payout[];
}

async function resolveDoctorsByName(
  supabase: SupabaseClient,
  q: string
): Promise<string[]> {
  const escaped = escapeIlike(q);
  const { data, error } = await supabase
    .from("doctors")
    .select("id")
    .or(`display_name.ilike.%${escaped}%,full_name.ilike.%${escaped}%`)
    .limit(50);
  if (error) {
    log.error("resolveDoctorsByName", { err: error });
    return [];
  }
  return ((data ?? []) as { id: string }[]).map((r) => r.id);
}

type SearchParams = {
  q?: string;
  status?: string;
  period?: string;
  from?: string;
  to?: string;
};

export default async function PayoutsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const q = parseSearch(params.q);
  const status = parseStatusFilter<PayoutStatus>(
    params.status,
    ALL_PAYOUT_STATUSES
  );
  const period = parsePeriodFilter(params.period);
  const { fromIso, toIso, invertedRange } = parseDateRange(
    params.from,
    params.to
  );

  const filters: Filters = {
    q,
    status,
    period,
    fromIso,
    toIso,
    invertedRange,
  };
  const isFiltered = hasActiveFilters({
    q,
    status,
    period,
    fromIso,
    toIso,
  });

  const payouts = isFiltered ? await loadFiltered(filters) : await loadAll();

  return (
    <div>
      <header className="mb-6">
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

      <FilterBar
        defaults={{
          q: q ?? "",
          status: status ?? "",
          period: period ?? "",
          from: typeof params.from === "string" ? params.from : "",
          to: typeof params.to === "string" ? params.to : "",
        }}
        invertedRange={invertedRange}
      />

      {payouts.length === 0 ? (
        <EmptyState filtered={isFiltered} />
      ) : isFiltered ? (
        <FilteredTable payouts={payouts} />
      ) : (
        <GroupedTables payouts={payouts} />
      )}
    </div>
  );
}

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div className="rounded-2xl bg-white border border-ink-100 p-10 text-center">
      <h2 className="font-serif text-[1.3rem] text-ink-800 mb-2">
        {filtered ? "Sem resultados pra esses filtros" : "Sem repasses ainda"}
      </h2>
      <p className="text-ink-500">
        {filtered
          ? "Ajuste os critérios ou clique em Limpar."
          : "O primeiro lote será gerado automaticamente no dia 1º do próximo mês, consolidando earnings disponíveis por médica."}
      </p>
    </div>
  );
}

function GroupedTables({ payouts }: { payouts: Payout[] }) {
  const groups: Record<PayoutStatus, Payout[]> = {
    draft: [],
    approved: [],
    pix_sent: [],
    confirmed: [],
    cancelled: [],
    failed: [],
  };
  for (const p of payouts) groups[p.status].push(p);

  return (
    <div className="space-y-8">
      {ALL_PAYOUT_STATUSES.map((st) => {
        const list = groups[st];
        if (list.length === 0) return null;
        return (
          <section key={st}>
            <h2 className="font-serif text-[1.2rem] text-ink-800 mb-3">
              {STATUS[st].label}{" "}
              <span className="text-ink-400 font-normal">({list.length})</span>
            </h2>
            <PayoutTable list={list} />
          </section>
        );
      })}
    </div>
  );
}

function FilteredTable({ payouts }: { payouts: Payout[] }) {
  return (
    <section>
      <p className="mb-3 text-sm text-ink-500">
        {payouts.length} resultado{payouts.length === 1 ? "" : "s"} (limite 200).
      </p>
      <PayoutTable list={payouts} />
    </section>
  );
}

function PayoutTable({ list }: { list: Payout[] }) {
  return (
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
                  className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full border ${STATUS[p.status].cls}`}
                >
                  {STATUS[p.status].label}
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
  );
}

function FilterBar({
  defaults,
  invertedRange,
}: {
  defaults: {
    q: string;
    status: string;
    period: string;
    from: string;
    to: string;
  };
  invertedRange: boolean;
}) {
  const isFiltered =
    defaults.q.length > 0 ||
    defaults.status.length > 0 ||
    defaults.period.length > 0 ||
    defaults.from.length > 0 ||
    defaults.to.length > 0;

  return (
    <form
      method="get"
      action="/admin/payouts"
      className="mb-6 rounded-2xl border border-ink-100 bg-white p-4"
    >
      <div className="grid gap-3 md:grid-cols-[1fr_160px_120px_140px_140px_auto]">
        <input
          type="search"
          name="q"
          defaultValue={defaults.q}
          placeholder="Buscar por nome da médica"
          className="h-10 px-3 rounded-lg border border-ink-200 bg-white text-sm text-ink-800 focus:outline-none focus:border-sage-500"
          aria-label="Buscar por nome da médica"
        />
        <select
          name="status"
          defaultValue={defaults.status}
          className="h-10 px-3 rounded-lg border border-ink-200 bg-white text-sm text-ink-800 focus:outline-none focus:border-sage-500"
          aria-label="Filtrar por status"
        >
          <option value="">Todos os status</option>
          {ALL_PAYOUT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS[s].label}
            </option>
          ))}
        </select>
        <input
          type="month"
          name="period"
          defaultValue={defaults.period}
          className="h-10 px-3 rounded-lg border border-ink-200 bg-white text-sm text-ink-800 focus:outline-none focus:border-sage-500"
          aria-label="Período de referência (YYYY-MM)"
        />
        <input
          type="date"
          name="from"
          defaultValue={defaults.from}
          className="h-10 px-3 rounded-lg border border-ink-200 bg-white text-sm text-ink-800 focus:outline-none focus:border-sage-500"
          aria-label="Criado a partir de"
        />
        <input
          type="date"
          name="to"
          defaultValue={defaults.to}
          className="h-10 px-3 rounded-lg border border-ink-200 bg-white text-sm text-ink-800 focus:outline-none focus:border-sage-500"
          aria-label="Criado até"
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
              href={buildAdminListUrl("/admin/payouts", {})}
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
