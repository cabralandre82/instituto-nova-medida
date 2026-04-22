/**
 * /admin/credits — Créditos de reagendamento (PR-073-C · D-083).
 *
 * Por quê:
 *   PR-073 · D-081 formalizou `appointment_credits` pra registrar o direito
 *   a reagendamento gratuito quando a médica no-showa ou a sala expira
 *   vazia. Até aqui, admin consumia/cancelava crédito via SQL editor ou
 *   inline em outras páginas — sem listagem dedicada.
 *
 *   Esta página fecha o loop: lista, filtra por status/razão/paciente,
 *   marca como consumido ou cancela, sem precisar abrir SQL nem correlacionar
 *   manualmente com `/admin/reliability`.
 *
 * Duas seções:
 *   1. "Ativos" — status='active' E (!sweep ainda rodou) `expires_at > now`.
 *      Foco no dia a dia: "esse paciente tem crédito pendente?"
 *   2. "Histórico" — status em {consumed, expired, cancelled} OU
 *      active-mas-já-expirado. Filtrável por data/paciente pra
 *      suporte pós-fato ("procuraram reagendar, era do mês passado?").
 *
 * Status é compute-on-read (ver `computeCurrentStatus`): row `active` com
 * expires_at no passado aparece como "expirado (não-sweepado)" na UI.
 * Quando o sweep PR-073-B rodar, o status vira `expired` no DB e a linha
 * sai pro bucket de "expired".
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import Link from "next/link";
import { getSupabaseAdmin } from "@/lib/supabase";
import { formatDateTimeBR } from "@/lib/datetime-br";
import { logger } from "@/lib/logger";
import {
  buildAdminListUrl,
  escapeIlike,
  hasActiveFilters,
  parseDateRange,
  parseSearch,
  parseStatusFilter,
} from "@/lib/admin-list-filters";
import {
  computeCurrentStatus,
  daysUntilExpiry,
  CREDIT_STATUSES,
  CREDIT_REASONS,
  type AppointmentCreditStatus,
  type AppointmentCreditReason,
} from "@/lib/appointment-credits";
import { CreditActions } from "./_Actions";

const log = logger.with({ route: "/admin/credits" });

export const dynamic = "force-dynamic";

const REASON_LABELS: Record<AppointmentCreditReason, string> = {
  no_show_doctor: "No-show da médica",
  cancelled_by_admin_expired: "Sala expirou vazia",
};

const STATUS_LABELS: Record<AppointmentCreditStatus | "active_expired", string> = {
  active: "Ativo",
  active_expired: "Ativo (expirado, sweep pendente)",
  consumed: "Consumido",
  expired: "Expirado",
  cancelled: "Cancelado",
};

const HISTORY_STATUSES = ["consumed", "expired", "cancelled"] as const;
type HistoryStatus = (typeof HISTORY_STATUSES)[number];

type CreditRow = {
  id: string;
  customer_id: string;
  source_appointment_id: string;
  source_reason: AppointmentCreditReason;
  status: AppointmentCreditStatus;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  consumed_appointment_id: string | null;
  consumed_by_email: string | null;
  cancelled_at: string | null;
  cancelled_reason: string | null;
  cancelled_by_email: string | null;
  customers: { name: string; phone: string | null } | null;
};

type ActiveRow = CreditRow & {
  effectiveStatus: "active" | "active_expired";
  daysRemaining: number;
};

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  return formatDateTimeBR(iso);
}

async function resolveCustomersByName(
  supabase: SupabaseClient,
  q: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from("customers")
    .select("id")
    .ilike("name", `%${escapeIlike(q)}%`)
    .limit(50);
  if (error) {
    log.error("resolveCustomersByName", { err: error.message });
    return [];
  }
  return ((data ?? []) as { id: string }[]).map((r) => r.id);
}

async function loadActive(): Promise<ActiveRow[]> {
  const supabase = getSupabaseAdmin();
  const now = new Date();
  const { data, error } = await supabase
    .from("appointment_credits")
    .select(
      "id, customer_id, source_appointment_id, source_reason, status, created_at, expires_at, consumed_at, consumed_appointment_id, consumed_by_email, cancelled_at, cancelled_reason, cancelled_by_email, customers ( name, phone )",
    )
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(200);

  if (error) {
    log.error("loadActive", { err: error.message });
    return [];
  }

  const rows = (data ?? []) as unknown as CreditRow[];
  return rows.map((r) => {
    const effective = computeCurrentStatus(
      { status: r.status, expires_at: r.expires_at },
      now,
    );
    return {
      ...r,
      effectiveStatus:
        effective === "expired" ? ("active_expired" as const) : "active",
      daysRemaining: daysUntilExpiry({ expires_at: r.expires_at }, now),
    };
  });
}

type HistoryFilters = {
  q: string | null;
  status: HistoryStatus | null;
  reason: AppointmentCreditReason | null;
  fromIso: string | null;
  toIso: string | null;
  invertedRange: boolean;
};

async function loadHistory(filters: HistoryFilters): Promise<CreditRow[]> {
  const supabase = getSupabaseAdmin();

  let customerIdSubset: string[] | null = null;
  if (filters.q) {
    customerIdSubset = await resolveCustomersByName(supabase, filters.q);
    if (customerIdSubset.length === 0) return [];
  }

  let builder = supabase
    .from("appointment_credits")
    .select(
      "id, customer_id, source_appointment_id, source_reason, status, created_at, expires_at, consumed_at, consumed_appointment_id, consumed_by_email, cancelled_at, cancelled_reason, cancelled_by_email, customers ( name, phone )",
    )
    .in("status", filters.status ? [filters.status] : (HISTORY_STATUSES as readonly string[]))
    .order("created_at", { ascending: false })
    .limit(200);

  if (filters.reason) {
    builder = builder.eq("source_reason", filters.reason);
  }
  if (filters.fromIso) {
    builder = builder.gte("created_at", filters.fromIso);
  }
  if (filters.toIso) {
    builder = builder.lte("created_at", filters.toIso);
  }
  if (customerIdSubset) {
    builder = builder.in("customer_id", customerIdSubset);
  }

  const { data, error } = await builder;
  if (error) {
    log.error("loadHistory", { err: error.message });
    return [];
  }
  return (data ?? []) as unknown as CreditRow[];
}

type SearchParams = {
  q?: string;
  status?: string;
  reason?: string;
  from?: string;
  to?: string;
};

export default async function CreditsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const q = parseSearch(params.q);
  const status = parseStatusFilter<HistoryStatus>(params.status, HISTORY_STATUSES);
  const reason = parseStatusFilter<AppointmentCreditReason>(
    params.reason,
    CREDIT_REASONS,
  );
  const { fromIso, toIso, invertedRange } = parseDateRange(
    params.from,
    params.to,
  );

  const filters: HistoryFilters = { q, status, reason, fromIso, toIso, invertedRange };
  const isFiltered = hasActiveFilters({ q, status, reason, fromIso, toIso });

  const [active, history] = await Promise.all([loadActive(), loadHistory(filters)]);

  const activeSweepPending = active.filter(
    (r) => r.effectiveStatus === "active_expired",
  ).length;

  return (
    <div>
      <header className="mb-6">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Pacientes
        </p>
        <h1 className="font-serif text-[1.85rem] sm:text-[2.2rem] leading-tight text-ink-800">
          Créditos de reagendamento
        </h1>
        <p className="mt-1 text-ink-500 max-w-2xl">
          Créditos gratuitos emitidos pra paciente quando a médica não
          comparece ou a sala expira sem participantes (
          <Link
            href="/admin/reliability"
            className="underline decoration-ink-300 hover:decoration-ink-600"
          >
            ver reliability
          </Link>
          ). Marque como consumido quando um novo appointment for criado pro
          paciente, ou cancele se o crédito não se aplica mais. Validade
          padrão: 90 dias.
        </p>
      </header>

      {/* Resumo */}
      <section className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-8">
        <Card
          label="Ativos"
          value={String(active.length)}
          hint={
            activeSweepPending > 0
              ? `${activeSweepPending} já expirou (sweep pendente)`
              : active.length > 0
                ? "a reagendar"
                : "nada pendente"
          }
          tone={active.length > 0 ? "sage" : "ink"}
        />
        <Card
          label={isFiltered ? "Histórico (filtrado)" : "Histórico (últimos 200)"}
          value={String(history.length)}
          hint={history.length > 0 ? "consumidos, expirados e cancelados" : "sem histórico"}
          tone="ink"
        />
        <Card
          label="Validade"
          value="90 dias"
          hint="prazo default do crédito (D-081)"
          tone="ink"
        />
      </section>

      {/* Ativos */}
      <section className="mb-10">
        <h2 className="font-serif text-[1.3rem] text-ink-800 mb-4">
          Ativos ({active.length})
        </h2>

        {active.length === 0 ? (
          <div className="rounded-2xl bg-white border border-ink-100 p-10 text-center">
            <p className="text-ink-500">
              Nenhum crédito ativo. Quando houver no-show da médica ou sala
              expirar vazia, o caso aparece aqui.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {active.map((r) => (
              <ActiveCreditCard key={r.id} row={r} />
            ))}
          </div>
        )}
      </section>

      {/* Histórico */}
      <section>
        <h2 className="font-serif text-[1.3rem] text-ink-800 mb-4">
          Histórico{" "}
          <span className="text-ink-400 font-sans text-base font-normal">
            ({history.length}
            {isFiltered ? " · filtrado" : ""})
          </span>
        </h2>

        <HistoryFilterBar
          defaults={{
            q: q ?? "",
            status: status ?? "",
            reason: reason ?? "",
            from: typeof params.from === "string" ? params.from : "",
            to: typeof params.to === "string" ? params.to : "",
          }}
          invertedRange={invertedRange}
        />

        {history.length === 0 ? (
          <p className="text-ink-500">
            {isFiltered
              ? "Nenhum crédito histórico bate com os filtros."
              : "Sem créditos no histórico ainda."}
          </p>
        ) : (
          <div className="rounded-2xl bg-white border border-ink-100 overflow-hidden">
            <table className="w-full">
              <thead className="bg-cream-50 border-b border-ink-100">
                <tr className="text-left text-[0.72rem] uppercase tracking-[0.12em] text-ink-500 font-medium">
                  <th className="px-5 py-2.5">Paciente</th>
                  <th className="px-5 py-2.5">Motivo</th>
                  <th className="px-5 py-2.5">Status</th>
                  <th className="px-5 py-2.5">Criado</th>
                  <th className="px-5 py-2.5">Fim da janela</th>
                  <th className="px-5 py-2.5">Referência</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {history.map((r) => (
                  <tr key={r.id} className="hover:bg-cream-50 align-top">
                    <td className="px-5 py-3 text-sm text-ink-800">
                      {r.customers?.name ?? "—"}
                    </td>
                    <td className="px-5 py-3 text-sm text-ink-600">
                      {REASON_LABELS[r.source_reason]}
                    </td>
                    <td className="px-5 py-3 text-sm">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="px-5 py-3 text-xs text-ink-500 font-mono">
                      {fmtDateTime(r.created_at)}
                    </td>
                    <td className="px-5 py-3 text-xs text-ink-500 font-mono">
                      {fmtDateTime(
                        r.status === "consumed"
                          ? r.consumed_at
                          : r.status === "cancelled"
                            ? r.cancelled_at
                            : r.expires_at,
                      )}
                    </td>
                    <td className="px-5 py-3 text-xs text-ink-500">
                      {r.status === "consumed" && r.consumed_appointment_id ? (
                        <span
                          className="font-mono break-all"
                          title={`por ${r.consumed_by_email ?? "—"}`}
                        >
                          appt {r.consumed_appointment_id.slice(0, 8)}…
                        </span>
                      ) : r.status === "cancelled" ? (
                        <span className="italic" title={r.cancelled_by_email ?? undefined}>
                          &ldquo;{(r.cancelled_reason ?? "").slice(0, 60)}
                          {(r.cancelled_reason ?? "").length > 60 ? "…" : ""}&rdquo;
                        </span>
                      ) : (
                        <span className="text-ink-400">—</span>
                      )}
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

function StatusBadge({ status }: { status: AppointmentCreditStatus }) {
  const toneClasses: Record<AppointmentCreditStatus, string> = {
    active: "bg-sage-50 text-sage-800 border-sage-200",
    consumed: "bg-cream-100 text-ink-700 border-ink-200",
    expired: "bg-cream-100 text-ink-500 border-ink-200",
    cancelled: "bg-terracotta-50 text-terracotta-700 border-terracotta-200",
  };
  return (
    <span
      className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full border ${toneClasses[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

function ActiveCreditCard({ row }: { row: ActiveRow }) {
  const patient = row.customers?.name ?? "(sem paciente)";
  const phone = row.customers?.phone ?? null;
  const expired = row.effectiveStatus === "active_expired";
  const daysLabel = expired
    ? `expirou há ${Math.abs(row.daysRemaining)}d (sweep pendente)`
    : `${row.daysRemaining}d restantes`;

  return (
    <article className="rounded-2xl bg-white border border-ink-100 p-5">
      <div className="grid md:grid-cols-[1fr_320px] gap-5">
        <div>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-2">
            <h3 className="font-serif text-[1.15rem] text-ink-800">{patient}</h3>
            {expired ? (
              <span className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full bg-terracotta-50 text-terracotta-700 border border-terracotta-200">
                {daysLabel}
              </span>
            ) : (
              <span className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full bg-sage-50 text-sage-800 border border-sage-200">
                {daysLabel}
              </span>
            )}
          </div>

          <dl className="grid grid-cols-2 gap-y-2 gap-x-5 text-sm">
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-400">
                Motivo
              </dt>
              <dd className="text-terracotta-700 font-medium">
                {REASON_LABELS[row.source_reason]}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-400">
                Telefone
              </dt>
              <dd className="text-ink-800 font-mono">{phone ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-400">
                Emitido em
              </dt>
              <dd className="text-ink-800 font-mono">
                {fmtDateTime(row.created_at)}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-400">
                Expira em
              </dt>
              <dd className="text-ink-800 font-mono">
                {fmtDateTime(row.expires_at)}
              </dd>
            </div>
            <div className="col-span-2">
              <dt className="text-xs uppercase tracking-wide text-ink-400">
                Consulta de origem
              </dt>
              <dd className="text-ink-500 font-mono text-xs break-all">
                {row.source_appointment_id}
              </dd>
            </div>
            <div className="col-span-2">
              <dt className="text-xs uppercase tracking-wide text-ink-400">
                Credit id
              </dt>
              <dd className="text-ink-500 font-mono text-xs break-all">
                {row.id}
              </dd>
            </div>
          </dl>
        </div>

        <div>
          <CreditActions creditId={row.id} patientName={patient} />
        </div>
      </div>
    </article>
  );
}

function HistoryFilterBar({
  defaults,
  invertedRange,
}: {
  defaults: { q: string; status: string; reason: string; from: string; to: string };
  invertedRange: boolean;
}) {
  const isFiltered =
    defaults.q.length > 0 ||
    defaults.status.length > 0 ||
    defaults.reason.length > 0 ||
    defaults.from.length > 0 ||
    defaults.to.length > 0;

  return (
    <form
      method="get"
      action="/admin/credits"
      className="mb-4 rounded-2xl border border-ink-100 bg-white p-4"
    >
      <div className="grid gap-3 md:grid-cols-[1fr_160px_180px_140px_140px_auto]">
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
          <option value="consumed">Consumidos</option>
          <option value="expired">Expirados</option>
          <option value="cancelled">Cancelados</option>
        </select>
        <select
          name="reason"
          defaultValue={defaults.reason}
          className="h-10 px-3 rounded-lg border border-ink-200 bg-white text-sm text-ink-800 focus:outline-none focus:border-sage-500"
          aria-label="Filtrar por motivo"
        >
          <option value="">Todos os motivos</option>
          {CREDIT_REASONS.map((r) => (
            <option key={r} value={r}>
              {REASON_LABELS[r]}
            </option>
          ))}
        </select>
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
              href={buildAdminListUrl("/admin/credits", {})}
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

// dummy reference to keep CREDIT_STATUSES imported (sanity — runtime check
// que em dev trava se alguém adicionar um status novo sem atualizar UI).
if (process.env.NODE_ENV === "development") {
  for (const s of CREDIT_STATUSES) {
    if (!(s in STATUS_LABELS)) {
      throw new Error(`[/admin/credits] status sem label: ${s}`);
    }
  }
}
