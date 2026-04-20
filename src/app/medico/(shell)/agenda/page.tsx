/**
 * /medico/agenda — lista de consultas próximas e passadas da médica.
 *
 * Próximas (≤ 30 dias): sortidas asc, com botão "Entrar na sala" habilitado
 * quando faltam ≤ 60 min para o início e a sala é aberta até 30 min após o fim.
 *
 * Passadas (últimas 30): sortidas desc, link discreto para revisar
 * (futuro: link para anamnese/prescrição).
 */

import { requireDoctor } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { JoinButton } from "./JoinButton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ApptRow = {
  id: string;
  scheduled_at: string;
  scheduled_until: string | null;
  kind: "scheduled" | "on_demand";
  status: string;
  customers: { name: string | null; email: string | null; phone: string | null } | null;
};

const ALL_FIELDS =
  "id, scheduled_at, scheduled_until, kind, status, customers ( name, email, phone )";

async function loadAppointments(doctorId: string): Promise<{
  upcoming: ApptRow[];
  past: ApptRow[];
}> {
  const supabase = getSupabaseAdmin();
  const now = new Date();
  const horizonForward = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const horizonBackward = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

  const [up, pa] = await Promise.all([
    supabase
      .from("appointments")
      .select(ALL_FIELDS)
      .eq("doctor_id", doctorId)
      .gte("scheduled_at", now.toISOString())
      .lte("scheduled_at", horizonForward.toISOString())
      .neq("status", "cancelled")
      .order("scheduled_at", { ascending: true })
      .limit(60),
    supabase
      .from("appointments")
      .select(ALL_FIELDS)
      .eq("doctor_id", doctorId)
      .lt("scheduled_at", now.toISOString())
      .gte("scheduled_at", horizonBackward.toISOString())
      .order("scheduled_at", { ascending: false })
      .limit(30),
  ]);

  const normalize = (rows: unknown[] | null): ApptRow[] =>
    (rows ?? []).map((r) => {
      const row = r as ApptRow & { customers: ApptRow["customers"] | ApptRow["customers"][] };
      const customers = Array.isArray(row.customers) ? row.customers[0] ?? null : row.customers;
      return { ...row, customers } as ApptRow;
    });

  return {
    upcoming: normalize(up.data as unknown[] | null),
    past: normalize(pa.data as unknown[] | null),
  };
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR", {
    weekday: "short",
    day: "2-digit",
    month: "short",
  });
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusLabel(status: string): { label: string; className: string } {
  switch (status) {
    case "scheduled":
      return {
        label: "Agendada",
        className: "bg-sage-50 text-sage-800 border-sage-200",
      };
    case "in_progress":
      return {
        label: "Em curso",
        className: "bg-terracotta-50 text-terracotta-800 border-terracotta-200",
      };
    case "completed":
      return {
        label: "Concluída",
        className: "bg-ink-50 text-ink-700 border-ink-200",
      };
    case "no_show":
      return {
        label: "Faltou",
        className: "bg-ink-50 text-ink-500 border-ink-200",
      };
    case "cancelled":
      return {
        label: "Cancelada",
        className: "bg-ink-50 text-ink-400 border-ink-100",
      };
    default:
      return {
        label: status,
        className: "bg-ink-50 text-ink-600 border-ink-200",
      };
  }
}

function joinAvailability(scheduledAt: string, scheduledUntil: string | null) {
  const start = new Date(scheduledAt).getTime();
  const end = scheduledUntil
    ? new Date(scheduledUntil).getTime()
    : start + 60 * 60 * 1000;
  const now = Date.now();
  const opensAt = start - 60 * 60 * 1000; // 60 min antes
  const closesAt = end + 30 * 60 * 1000; // 30 min depois
  if (now < opensAt) {
    const minutes = Math.round((start - now) / 60000);
    if (minutes <= 60 * 24) return { ok: false as const, reason: `Abre 60 min antes (em ${minutes} min)` };
    return { ok: false as const, reason: "Disponível 60 min antes" };
  }
  if (now > closesAt) return { ok: false as const, reason: "Sala expirada" };
  return { ok: true as const };
}

export default async function DoctorAgendaPage() {
  const { doctorId } = await requireDoctor();
  const { upcoming, past } = await loadAppointments(doctorId);

  const next = upcoming[0];
  const rest = upcoming.slice(1);

  return (
    <div>
      <header className="mb-8">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Agenda
        </p>
        <h1 className="font-serif text-[2rem] sm:text-[2.4rem] leading-tight text-ink-800">
          Suas consultas
        </h1>
        <p className="mt-2 text-ink-500">
          Próximas {upcoming.length === 0 ? "—" : `${upcoming.length}`} · histórico recente
          {past.length === 0 ? " vazio" : ` (${past.length})`}
        </p>
      </header>

      {next && (
        <section className="mb-8 rounded-2xl border border-sage-200 bg-sage-50 p-6">
          <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-3">
            Próxima consulta
          </p>
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-5">
            <div>
              <p className="font-serif text-[1.5rem] text-ink-800 leading-tight">
                {next.customers?.name ?? "Paciente sem nome cadastrado"}
              </p>
              <p className="mt-1 text-ink-600">
                {fmtDate(next.scheduled_at)} · {fmtTime(next.scheduled_at)}
                {next.scheduled_until ? ` – ${fmtTime(next.scheduled_until)}` : ""}
                {next.kind === "on_demand" ? " · sob demanda" : ""}
              </p>
              {next.customers?.phone && (
                <p className="mt-1 text-sm text-ink-500">{next.customers.phone}</p>
              )}
            </div>
            <div>
              {(() => {
                const av = joinAvailability(next.scheduled_at, next.scheduled_until);
                return av.ok ? (
                  <JoinButton appointmentId={next.id} variant="primary" />
                ) : (
                  <JoinButton
                    appointmentId={next.id}
                    variant="primary"
                    disabled
                    disabledReason={av.reason}
                  />
                );
              })()}
            </div>
          </div>
        </section>
      )}

      <section className="mb-12">
        <h2 className="font-serif text-[1.4rem] text-ink-800 mb-4">
          Próximas {rest.length > 0 ? `(${rest.length})` : ""}
        </h2>
        {rest.length === 0 && !next && (
          <div className="rounded-2xl border border-dashed border-ink-200 bg-cream-50 p-8 text-center">
            <p className="text-ink-600">Nenhuma consulta agendada nos próximos 30 dias.</p>
            <p className="mt-2 text-sm text-ink-500">
              A agenda fica visível para pacientes assim que o operador ativar seus horários.
            </p>
          </div>
        )}
        {rest.length > 0 && (
          <div className="rounded-2xl border border-ink-100 bg-white overflow-hidden">
            <ul className="divide-y divide-ink-100">
              {rest.map((appt) => {
                const status = statusLabel(appt.status);
                const av = joinAvailability(appt.scheduled_at, appt.scheduled_until);
                return (
                  <li key={appt.id} className="flex items-center gap-4 px-5 py-4">
                    <div className="w-24 flex-shrink-0">
                      <p className="text-sm font-medium text-ink-800">
                        {fmtDate(appt.scheduled_at)}
                      </p>
                      <p className="text-sm text-ink-500">{fmtTime(appt.scheduled_at)}</p>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-ink-800 font-medium truncate">
                        {appt.customers?.name ?? "Paciente"}
                      </p>
                      <p className="text-sm text-ink-500">
                        {appt.kind === "on_demand" ? "Sob demanda" : "Agendada"}
                        {appt.customers?.phone ? ` · ${appt.customers.phone}` : ""}
                      </p>
                    </div>
                    <span
                      className={`hidden sm:inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border ${status.className}`}
                    >
                      {status.label}
                    </span>
                    <div className="ml-2">
                      {av.ok ? (
                        <JoinButton appointmentId={appt.id} variant="ghost" />
                      ) : (
                        <JoinButton
                          appointmentId={appt.id}
                          variant="ghost"
                          disabled
                          disabledReason={av.reason}
                        />
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>

      <section>
        <h2 className="font-serif text-[1.4rem] text-ink-800 mb-4">Histórico</h2>
        {past.length === 0 ? (
          <p className="text-ink-500">Sem consultas anteriores.</p>
        ) : (
          <div className="rounded-2xl border border-ink-100 bg-white overflow-hidden">
            <ul className="divide-y divide-ink-100">
              {past.map((appt) => {
                const status = statusLabel(appt.status);
                return (
                  <li key={appt.id} className="flex items-center gap-4 px-5 py-3">
                    <div className="w-24 flex-shrink-0">
                      <p className="text-sm text-ink-700">{fmtDate(appt.scheduled_at)}</p>
                      <p className="text-xs text-ink-500">{fmtTime(appt.scheduled_at)}</p>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-ink-800 truncate">
                        {appt.customers?.name ?? "Paciente"}
                      </p>
                      <p className="text-xs text-ink-500">
                        {appt.kind === "on_demand" ? "Sob demanda" : "Agendada"}
                      </p>
                    </div>
                    <span
                      className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border ${status.className}`}
                    >
                      {status.label}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
