/**
 * /admin/appointments — PR-078 · D-090
 *
 * Painel operacional unificado de consultas. Dois modos espelhando o
 * padrão de `/admin/fulfillments`:
 *
 *   - **Sem filtro:** lista agrupada por bucket temporal (em
 *     andamento agora, próximas 24h, próximas 7 dias, encerradas
 *     recentes) — scan rápido pra "o que precisa de atenção agora".
 *   - **Com filtro:** lista única ordenada por `scheduled_at desc`,
 *     respeitando search por nome do paciente, status, médica, kind
 *     (scheduled/on_demand) e date range. Útil pra "achar a consulta
 *     do João da Silva da semana passada".
 *
 * Decisões:
 *   - Sem detalhe-página dedicado: o admin já tem `/admin/pacientes/[id]`
 *     com tab de consultas; navegação via patient_id.
 *   - Limite 200 linhas em modo filtrado (consistente com fulfillments
 *     /payouts/refunds).
 *   - Hidratação: customer.name + doctor.display_name||full_name +
 *     nada mais (PII mínima na listagem; detalhe vai pra /admin/pacientes).
 */

import Link from "next/link";
import { getSupabaseAdmin } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { formatDateTimeShortBR } from "@/lib/datetime-br";
import {
  buildAdminListUrl,
  escapeIlike,
  hasActiveFilters,
  parseDateRange,
  parseSearch,
  parseStatusFilter,
} from "@/lib/admin-list-filters";
import {
  ALL_APPOINTMENT_STATUSES,
  adminLabelForAppointmentStatus,
  adminToneForAppointmentStatus,
  bucketForAppointment,
  type AppointmentBucket,
  type AppointmentStatusValue,
} from "@/lib/admin-appointments";

const log = logger.with({ route: "/admin/appointments" });

export const dynamic = "force-dynamic";

const ALL_KINDS = ["scheduled", "on_demand"] as const;
type AppointmentKind = (typeof ALL_KINDS)[number];

type AppointmentRow = {
  id: string;
  scheduled_at: string;
  scheduled_until: string | null;
  status: string;
  kind: string;
  customer_id: string;
  doctor_id: string;
  customers: { name: string | null } | null;
  doctors: {
    display_name: string | null;
    full_name: string | null;
  } | null;
};

type DoctorOption = {
  id: string;
  display_name: string | null;
  full_name: string;
};

const APPT_SELECT =
  "id, scheduled_at, scheduled_until, status, kind, customer_id, doctor_id, customers ( name ), doctors ( display_name, full_name )";

async function loadDoctors(): Promise<DoctorOption[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("doctors")
    .select("id, display_name, full_name")
    .order("full_name", { ascending: true });
  if (error) {
    log.error("loadDoctors", { err: error });
    return [];
  }
  return (data ?? []) as DoctorOption[];
}

async function loadCustomerIdsByName(name: string): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("customers")
    .select("id")
    .ilike("name", `%${escapeIlike(name)}%`)
    .limit(500);
  if (error) {
    log.warn("loadCustomerIdsByName", { err: error });
    return [];
  }
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
}

type Filters = {
  q: string | null;
  status: AppointmentStatusValue | null;
  kind: AppointmentKind | null;
  doctorId: string | null;
  fromIso: string | null;
  toIso: string | null;
  invertedRange: boolean;
};

async function loadFiltered(filters: Filters): Promise<AppointmentRow[]> {
  const supabase = getSupabaseAdmin();
  let builder = supabase
    .from("appointments")
    .select(APPT_SELECT)
    .order("scheduled_at", { ascending: false })
    .limit(200);

  if (filters.status) builder = builder.eq("status", filters.status);
  if (filters.kind) builder = builder.eq("kind", filters.kind);
  if (filters.doctorId) builder = builder.eq("doctor_id", filters.doctorId);
  if (filters.fromIso) builder = builder.gte("scheduled_at", filters.fromIso);
  if (filters.toIso) builder = builder.lte("scheduled_at", filters.toIso);

  if (filters.q) {
    const ids = await loadCustomerIdsByName(filters.q);
    if (ids.length === 0) return [];
    builder = builder.in("customer_id", ids);
  }

  const { data, error } = await builder;
  if (error) {
    log.error("loadFiltered", { err: error });
    return [];
  }
  return (data ?? []) as unknown as AppointmentRow[];
}

async function loadDefaultWindow(): Promise<AppointmentRow[]> {
  const supabase = getSupabaseAdmin();
  // Janela default: -7d a +14d em torno de now. Cobre os 4 buckets
  // (live, next_24h, next_7d, recent_finished) com folga.
  const now = new Date();
  const windowStart = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
  const windowEnd = new Date(now.getTime() + 14 * 24 * 60 * 60_000);
  const { data, error } = await supabase
    .from("appointments")
    .select(APPT_SELECT)
    .gte("scheduled_at", windowStart.toISOString())
    .lte("scheduled_at", windowEnd.toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(500);
  if (error) {
    log.error("loadDefaultWindow", { err: error });
    return [];
  }
  return (data ?? []) as unknown as AppointmentRow[];
}

type SearchParams = {
  q?: string;
  status?: string;
  kind?: string;
  doctor?: string;
  from?: string;
  to?: string;
};

export default async function AppointmentsAdminPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const q = parseSearch(params.q);
  const status = parseStatusFilter<AppointmentStatusValue>(
    params.status,
    ALL_APPOINTMENT_STATUSES
  );
  const kind = parseStatusFilter<AppointmentKind>(params.kind, ALL_KINDS);
  const doctorParam =
    typeof params.doctor === "string" && params.doctor.length > 0
      ? params.doctor
      : null;
  const { fromIso, toIso, invertedRange } = parseDateRange(
    params.from,
    params.to
  );

  const filters: Filters = {
    q,
    status,
    kind,
    doctorId: doctorParam,
    fromIso,
    toIso,
    invertedRange,
  };
  const isFiltered = hasActiveFilters({
    q,
    status,
    kind,
    doctor: doctorParam,
    fromIso,
    toIso,
  });

  const doctors = await loadDoctors();

  return (
    <div>
      <header className="mb-6">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Operação
        </p>
        <h1 className="font-serif text-[1.85rem] sm:text-[2.2rem] leading-tight text-ink-800">
          Consultas
        </h1>
        <p className="text-ink-500 text-sm mt-1.5 max-w-2xl">
          Sem filtro, mostra o que precisa de atenção agora (em andamento,
          próximas 24h, próximas 7 dias, encerradas recentes). Use os
          filtros pra investigar casos específicos.
        </p>
      </header>

      <FilterBar
        defaults={{
          q: q ?? "",
          status: status ?? "",
          kind: kind ?? "",
          doctor: doctorParam ?? "",
          from: typeof params.from === "string" ? params.from : "",
          to: typeof params.to === "string" ? params.to : "",
        }}
        statuses={ALL_APPOINTMENT_STATUSES}
        kinds={ALL_KINDS}
        doctors={doctors}
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

const GROUPS: Array<{
  bucket: AppointmentBucket;
  title: string;
  subtitle: string;
  emptyMessage: string;
  tone: "action" | "info" | "muted";
}> = [
  {
    bucket: "live",
    title: "Em andamento agora",
    subtitle:
      "Consulta começou (in_progress) ou está dentro da janela de início (-30min/+1h). Acompanhar ao vivo.",
    emptyMessage: "Nenhuma consulta acontecendo agora.",
    tone: "action",
  },
  {
    bucket: "next_24h",
    title: "Próximas 24 horas",
    subtitle:
      "Agendadas pra hoje/amanhã. Lembretes T-1h e T-15min são automáticos — só intervir se algo destoar.",
    emptyMessage: "Nada nas próximas 24 horas.",
    tone: "info",
  },
  {
    bucket: "next_7d",
    title: "Próximos 7 dias",
    subtitle:
      "Pipeline curto. Use pra checar se a agenda está coerente antes do dia chegar.",
    emptyMessage: "Nada agendado pros próximos 7 dias.",
    tone: "info",
  },
  {
    bucket: "recent_finished",
    title: "Encerradas nos últimos 7 dias",
    subtitle:
      "Consultas concluídas, no-shows, cancelamentos. Investigar pelo nome se houver atendimento ao paciente em curso.",
    emptyMessage: "Nada encerrado nos últimos 7 dias.",
    tone: "muted",
  },
];

async function GroupedList() {
  const rows = await loadDefaultWindow();
  const now = new Date();

  const byBucket = new Map<AppointmentBucket, AppointmentRow[]>();
  for (const r of rows) {
    const bucket = bucketForAppointment({
      status: r.status as AppointmentStatusValue,
      scheduledAt: new Date(r.scheduled_at),
      now,
    });
    const list = byBucket.get(bucket) ?? [];
    list.push(r);
    byBucket.set(bucket, list);
  }

  const liveCount = byBucket.get("live")?.length ?? 0;
  const next24Count = byBucket.get("next_24h")?.length ?? 0;
  const summary =
    liveCount + next24Count === 0
      ? "Operação tranquila no momento."
      : `${liveCount} ao vivo · ${next24Count} nas próximas 24h.`;

  return (
    <>
      <p className="mb-6 text-ink-500 text-sm">{summary}</p>

      <div className="space-y-10">
        {GROUPS.map((group) => {
          const groupRows = byBucket.get(group.bucket) ?? [];
          // Pra "live" e "next_24h" mantém ordem cronológica
          // ascendente (próxima começa primeiro). Pra demais, mantém
          // a ordem padrão da janela.
          if (group.bucket === "live" || group.bucket === "next_24h") {
            groupRows.sort(
              (a, b) =>
                new Date(a.scheduled_at).getTime() -
                new Date(b.scheduled_at).getTime()
            );
          } else if (group.bucket === "recent_finished") {
            groupRows.sort(
              (a, b) =>
                new Date(b.scheduled_at).getTime() -
                new Date(a.scheduled_at).getTime()
            );
          }
          return (
            <section key={group.bucket}>
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
                <div>
                  <h2 className="font-serif text-[1.3rem] text-ink-800 leading-tight">
                    {group.title}{" "}
                    <span className="text-ink-400 font-sans text-base">
                      ({groupRows.length})
                    </span>
                  </h2>
                  <p className="text-sm text-ink-500 mt-0.5 max-w-2xl">
                    {group.subtitle}
                  </p>
                </div>
              </div>

              {groupRows.length === 0 ? (
                <div className="rounded-xl border border-ink-100 bg-white px-5 py-6 text-sm text-ink-500">
                  {group.emptyMessage}
                </div>
              ) : (
                <AppointmentRowsList rows={groupRows} />
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
          : `${rows.length} resultado${rows.length === 1 ? "" : "s"} (limite 200, ordenado por scheduled_at desc).`}
      </p>
      {rows.length > 0 && <AppointmentRowsList rows={rows} />}
    </section>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone = adminToneForAppointmentStatus(status as AppointmentStatusValue);
  const cls =
    tone === "active"
      ? "bg-terracotta-600 text-white"
      : tone === "ok"
        ? "bg-sage-700 text-white"
        : tone === "warn"
          ? "bg-terracotta-100 text-terracotta-800 border border-terracotta-200"
          : tone === "muted"
            ? "bg-ink-100 text-ink-600"
            : "bg-ink-800 text-white";
  return (
    <span
      className={`inline-block rounded-full text-xs px-2.5 py-1 font-medium ${cls}`}
    >
      {adminLabelForAppointmentStatus(status)}
    </span>
  );
}

function AppointmentRowsList({ rows }: { rows: AppointmentRow[] }) {
  return (
    <ul className="divide-y divide-ink-100 rounded-xl border border-ink-100 bg-white overflow-hidden">
      {rows.map((r) => {
        const customerName = r.customers?.name ?? "—";
        const doctorName =
          r.doctors?.display_name || r.doctors?.full_name || "—";
        return (
          <li key={r.id}>
            <Link
              href={`/admin/pacientes/${r.customer_id}`}
              className="block px-5 py-4 hover:bg-cream-50 transition-colors"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <p className="font-serif text-[1.05rem] text-ink-800">
                    {customerName}
                  </p>
                  <p className="text-sm text-ink-600 mt-0.5">
                    {doctorName}
                    {r.kind === "on_demand" && (
                      <span className="ml-2 text-[0.7rem] uppercase tracking-wide text-terracotta-700 font-medium">
                        on-demand
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-ink-500 mt-1">
                    {formatDateTimeShortBR(r.scheduled_at)}
                  </p>
                </div>
                <div className="text-right text-sm">
                  <StatusBadge status={r.status} />
                </div>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function FilterBar({
  defaults,
  statuses,
  kinds,
  doctors,
  invertedRange,
}: {
  defaults: {
    q: string;
    status: string;
    kind: string;
    doctor: string;
    from: string;
    to: string;
  };
  statuses: readonly AppointmentStatusValue[];
  kinds: readonly AppointmentKind[];
  doctors: DoctorOption[];
  invertedRange: boolean;
}) {
  const isFiltered =
    defaults.q.length > 0 ||
    defaults.status.length > 0 ||
    defaults.kind.length > 0 ||
    defaults.doctor.length > 0 ||
    defaults.from.length > 0 ||
    defaults.to.length > 0;

  return (
    <form
      method="get"
      action="/admin/appointments"
      className="mb-6 rounded-2xl border border-ink-100 bg-white p-4"
    >
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-[1fr_180px_140px_180px_140px_140px_auto]">
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
              {adminLabelForAppointmentStatus(s)}
            </option>
          ))}
        </select>
        <select
          name="kind"
          defaultValue={defaults.kind}
          className="h-10 px-3 rounded-lg border border-ink-200 bg-white text-sm text-ink-800 focus:outline-none focus:border-sage-500"
          aria-label="Filtrar por tipo"
        >
          <option value="">Todos os tipos</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {k === "scheduled" ? "Agendada" : "On-demand"}
            </option>
          ))}
        </select>
        <select
          name="doctor"
          defaultValue={defaults.doctor}
          className="h-10 px-3 rounded-lg border border-ink-200 bg-white text-sm text-ink-800 focus:outline-none focus:border-sage-500"
          aria-label="Filtrar por médica"
        >
          <option value="">Todas as médicas</option>
          {doctors.map((d) => (
            <option key={d.id} value={d.id}>
              {d.display_name || d.full_name}
            </option>
          ))}
        </select>
        <input
          type="date"
          name="from"
          defaultValue={defaults.from}
          className="h-10 px-3 rounded-lg border border-ink-200 bg-white text-sm text-ink-800 focus:outline-none focus:border-sage-500"
          aria-label="Data inicial (scheduled_at)"
        />
        <input
          type="date"
          name="to"
          defaultValue={defaults.to}
          className="h-10 px-3 rounded-lg border border-ink-200 bg-white text-sm text-ink-800 focus:outline-none focus:border-sage-500"
          aria-label="Data final (scheduled_at)"
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
              href={buildAdminListUrl("/admin/appointments", {})}
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
