/**
 * /admin/plantao — PR-078 · D-090
 *
 * Visão real-time do plantão:
 *
 *   1. **Online agora** — médicas com `doctor_presence.status` em
 *      ('online','busy') e heartbeat fresco (≤ STALE_THRESHOLD).
 *      Mostra origem (manual / auto_offline reverso), tempo desde
 *      `online_since`, e sinaliza médicas online MAS não escaladas
 *      pra plantão neste horário.
 *
 *   2. **Plantões nas próximas 4 horas** — bloco recorrente
 *      `on_call` ativo cuja próxima ocorrência cai dentro da janela.
 *      Indica também se a médica responsável está online no momento.
 *
 *   3. **Agenda recorrente da semana** — todos os blocos `on_call`
 *      ativos (read-only — médica edita em `/medico/horarios` D-088).
 *
 *   4. **Fila on-demand** (PR-080 · D-092) — pacientes solicitando
 *      atendimento agora. Mostra cada request pending com quem é o
 *      paciente, a queixa principal (truncada), idade e TTL restante.
 *      Resumo das últimas 24h (aceitos/expirados/cancelados) na
 *      mesma seção pra contexto operacional.
 *
 * Sem ações destrutivas — admin não força médica online/offline daqui
 * (decisão D-090: respeita autonomia + evita ambiguidade legal de
 * "estava em plantão" forçado pelo admin).
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { formatDateTimeShortBR } from "@/lib/datetime-br";
import {
  STALE_PRESENCE_THRESHOLD_SECONDS,
  type PresenceRow,
} from "@/lib/doctor-presence";
import {
  isOnCallNow,
  nextOnCallStartUtc,
} from "@/lib/admin-appointments";
import { WEEKDAY_LABELS_PT } from "@/lib/doctor-availability";
import {
  computeSecondsUntilExpiry,
  truncateChiefComplaintForWa,
} from "@/lib/on-demand";
import { firstName } from "@/lib/wa-templates";

const log = logger.with({ route: "/admin/plantao" });

export const dynamic = "force-dynamic";

type DoctorRow = {
  id: string;
  full_name: string;
  display_name: string | null;
  crm_number: string;
  crm_uf: string;
};

type AvailabilityBlockRow = {
  id: string;
  doctor_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  type: string;
  active: boolean;
};

async function loadDoctors(): Promise<DoctorRow[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("doctors")
    .select("id, full_name, display_name, crm_number, crm_uf")
    .order("full_name", { ascending: true });
  if (error) {
    log.error("loadDoctors", { err: error });
    return [];
  }
  return (data ?? []) as DoctorRow[];
}

async function loadPresence(): Promise<PresenceRow[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("doctor_presence")
    .select(
      "doctor_id, status, last_heartbeat_at, online_since, source, client_meta, created_at, updated_at"
    );
  if (error) {
    log.error("loadPresence", { err: error });
    return [];
  }
  return (data ?? []) as PresenceRow[];
}

async function loadAllOnCallBlocks(): Promise<AvailabilityBlockRow[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("doctor_availability")
    .select("id, doctor_id, weekday, start_time, end_time, type, active")
    .eq("active", true)
    .eq("type", "on_call")
    .order("weekday", { ascending: true })
    .order("start_time", { ascending: true });
  if (error) {
    log.error("loadAllOnCallBlocks", { err: error });
    return [];
  }
  return (data ?? []) as AvailabilityBlockRow[];
}

function presenceFreshnessSeconds(row: PresenceRow, now: Date): number {
  return Math.max(
    0,
    Math.floor((now.getTime() - new Date(row.last_heartbeat_at).getTime()) / 1000)
  );
}

function onlineSinceMinutes(
  row: PresenceRow,
  now: Date
): number | null {
  if (!row.online_since) return null;
  return Math.max(
    0,
    Math.floor((now.getTime() - new Date(row.online_since).getTime()) / 60_000)
  );
}

function formatMinutesHuman(min: number): string {
  if (min < 60) return `${min} min`;
  const hours = Math.floor(min / 60);
  const rest = min % 60;
  if (rest === 0) return `${hours} h`;
  return `${hours}h${String(rest).padStart(2, "0")}`;
}

function isFreshPresence(row: PresenceRow, now: Date): boolean {
  return (
    presenceFreshnessSeconds(row, now) <= STALE_PRESENCE_THRESHOLD_SECONDS
  );
}

type OnDemandPendingRow = {
  id: string;
  customer_id: string;
  expires_at: string;
  created_at: string;
  chief_complaint: string;
};

type OnDemandSummary = {
  accepted: number;
  cancelled: number;
  expired: number;
  windowHours: number;
};

const ONDEMAND_SUMMARY_WINDOW_HOURS = 24;

// PR-081 · D-093: liquidações de plantão (últimos 7d).
type SettlementRow = {
  id: string;
  doctor_id: string;
  block_start_utc: string;
  block_end_utc: string;
  block_minutes: number;
  coverage_minutes: number;
  coverage_ratio: number;
  outcome: "paid" | "no_show";
  amount_cents_snapshot: number | null;
  settled_at: string;
};

type SettlementSummary = {
  paid: number;
  noShow: number;
  totalCents: number;
  windowDays: number;
};

const SETTLEMENT_WINDOW_DAYS = 7;
const SETTLEMENT_LIST_LIMIT = 30;

async function loadRecentSettlements(now: Date): Promise<SettlementRow[]> {
  const supabase = getSupabaseAdmin();
  const since = new Date(
    now.getTime() - SETTLEMENT_WINDOW_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const { data, error } = await supabase
    .from("on_call_block_settlements")
    .select(
      "id, doctor_id, block_start_utc, block_end_utc, block_minutes, coverage_minutes, coverage_ratio, outcome, amount_cents_snapshot, settled_at"
    )
    .gte("settled_at", since)
    .order("settled_at", { ascending: false })
    .limit(SETTLEMENT_LIST_LIMIT);
  if (error) {
    log.error("loadRecentSettlements", { err: error });
    return [];
  }
  return (data ?? []) as SettlementRow[];
}

function summarizeSettlements(rows: SettlementRow[]): SettlementSummary {
  let paid = 0;
  let noShow = 0;
  let totalCents = 0;
  for (const r of rows) {
    if (r.outcome === "paid") {
      paid += 1;
      totalCents += r.amount_cents_snapshot ?? 0;
    } else {
      noShow += 1;
    }
  }
  return { paid, noShow, totalCents, windowDays: SETTLEMENT_WINDOW_DAYS };
}

async function loadOnDemandPending(now: Date): Promise<OnDemandPendingRow[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("on_demand_requests")
    .select("id, customer_id, expires_at, created_at, chief_complaint")
    .eq("status", "pending")
    .gt("expires_at", now.toISOString())
    .order("created_at", { ascending: true })
    .limit(50);
  if (error) {
    log.error("loadOnDemandPending", { err: error });
    return [];
  }
  return (data ?? []) as OnDemandPendingRow[];
}

async function loadOnDemandSummary(now: Date): Promise<OnDemandSummary> {
  const supabase = getSupabaseAdmin();
  const since = new Date(
    now.getTime() - ONDEMAND_SUMMARY_WINDOW_HOURS * 60 * 60 * 1000
  ).toISOString();
  const { data, error } = await supabase
    .from("on_demand_requests")
    .select("status")
    .gte("created_at", since)
    .neq("status", "pending");
  if (error) {
    log.error("loadOnDemandSummary", { err: error });
    return {
      accepted: 0,
      cancelled: 0,
      expired: 0,
      windowHours: ONDEMAND_SUMMARY_WINDOW_HOURS,
    };
  }
  let accepted = 0;
  let cancelled = 0;
  let expired = 0;
  for (const r of (data ?? []) as Array<{ status: string }>) {
    if (r.status === "accepted") accepted += 1;
    else if (r.status === "cancelled") cancelled += 1;
    else if (r.status === "expired") expired += 1;
  }
  return {
    accepted,
    cancelled,
    expired,
    windowHours: ONDEMAND_SUMMARY_WINDOW_HOURS,
  };
}

async function loadCustomersForRequests(
  rows: OnDemandPendingRow[]
): Promise<Map<string, string>> {
  if (rows.length === 0) return new Map();
  const ids = Array.from(new Set(rows.map((r) => r.customer_id)));
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("customers")
    .select("id, name")
    .in("id", ids);
  if (error) {
    log.error("loadCustomersForRequests", { err: error });
    return new Map();
  }
  const m = new Map<string, string>();
  for (const c of (data ?? []) as Array<{ id: string; name: string | null }>) {
    m.set(c.id, c.name ?? "");
  }
  return m;
}

export default async function PlantaoAdminPage() {
  const now = new Date();
  const [
    doctors,
    presenceRows,
    onCallBlocks,
    onDemandPending,
    onDemandSummary,
    settlements,
  ] = await Promise.all([
    loadDoctors(),
    loadPresence(),
    loadAllOnCallBlocks(),
    loadOnDemandPending(now),
    loadOnDemandSummary(now),
    loadRecentSettlements(now),
  ]);
  const onDemandCustomers = await loadCustomersForRequests(onDemandPending);
  const settlementSummary = summarizeSettlements(settlements);

  const doctorById = new Map(doctors.map((d) => [d.id, d] as const));
  const presenceByDoctor = new Map(
    presenceRows.map((p) => [p.doctor_id, p] as const)
  );

  // ── Online agora (status fresh) ────────────────────────────────────
  const onlineRows = presenceRows
    .filter((p) => p.status !== "offline" && isFreshPresence(p, now))
    .sort(
      (a, b) =>
        new Date(b.online_since ?? b.updated_at).getTime() -
        new Date(a.online_since ?? a.updated_at).getTime()
    );

  // ── Plantões nas próximas 4 horas (próxima ocorrência) ─────────────
  type UpcomingShift = {
    block: AvailabilityBlockRow;
    nextStartUtc: Date;
    isLive: boolean;
    doctorOnline: boolean;
  };
  const upcomingShifts: UpcomingShift[] = [];
  for (const block of onCallBlocks) {
    const live = isOnCallNow({
      weekday: block.weekday,
      startTime: block.start_time,
      endTime: block.end_time,
      now,
    });
    const nextStart = nextOnCallStartUtc({
      weekday: block.weekday,
      startTime: block.start_time,
      now,
      withinHours: 4,
    });
    if (!live && !nextStart) continue;
    const presence = presenceByDoctor.get(block.doctor_id);
    upcomingShifts.push({
      block,
      // se está live, usamos `now` como nextStartUtc só pro sort
      nextStartUtc: live ? now : (nextStart as Date),
      isLive: live,
      doctorOnline: Boolean(
        presence && presence.status !== "offline" && isFreshPresence(presence, now)
      ),
    });
  }
  upcomingShifts.sort(
    (a, b) => a.nextStartUtc.getTime() - b.nextStartUtc.getTime()
  );

  // ── Agenda recorrente da semana (read-only) ────────────────────────
  const blocksByWeekday = new Map<number, AvailabilityBlockRow[]>();
  for (const b of onCallBlocks) {
    const list = blocksByWeekday.get(b.weekday) ?? [];
    list.push(b);
    blocksByWeekday.set(b.weekday, list);
  }

  return (
    <div>
      <header className="mb-6">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Operação
        </p>
        <h1 className="font-serif text-[1.85rem] sm:text-[2.2rem] leading-tight text-ink-800">
          Plantão
        </h1>
        <p className="text-ink-500 text-sm mt-1.5 max-w-2xl">
          Médicas online agora, plantões nas próximas 4 horas e agenda
          recorrente da semana. Médica edita o próprio plantão em{" "}
          <code className="text-ink-700 bg-ink-50 px-1.5 py-0.5 rounded text-[0.85rem]">
            /medico/horarios
          </code>
          .
        </p>
      </header>

      {/* ── Card 1: Online agora ─────────────────────────────────── */}
      <section className="mb-8">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2 className="font-serif text-[1.3rem] text-ink-800 leading-tight">
              Online agora{" "}
              <span className="text-ink-400 font-sans text-base">
                ({onlineRows.length})
              </span>
            </h2>
            <p className="text-sm text-ink-500 mt-0.5 max-w-2xl">
              Médicas com heartbeat ≤ {STALE_PRESENCE_THRESHOLD_SECONDS}s.
              Cron stale-presence força offline além disso.
            </p>
          </div>
        </div>
        {onlineRows.length === 0 ? (
          <div className="rounded-xl border border-ink-100 bg-white px-5 py-6 text-sm text-ink-500">
            Nenhuma médica online no momento.
          </div>
        ) : (
          <ul className="divide-y divide-ink-100 rounded-xl border border-ink-100 bg-white overflow-hidden">
            {onlineRows.map((p) => {
              const d = doctorById.get(p.doctor_id);
              const onlineMin = onlineSinceMinutes(p, now);
              const freshSec = presenceFreshnessSeconds(p, now);
              return (
                <li key={p.doctor_id} className="px-5 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <p className="font-serif text-[1.05rem] text-ink-800">
                        {d?.display_name || d?.full_name || p.doctor_id}
                      </p>
                      <p className="text-xs text-ink-500 mt-0.5">
                        {d
                          ? `CRM ${d.crm_uf} ${d.crm_number}`
                          : "médica não encontrada"}
                      </p>
                      <p className="text-xs text-ink-500 mt-1">
                        Último heartbeat: {freshSec}s atrás · origem{" "}
                        <code className="text-ink-700">{p.source}</code>
                      </p>
                    </div>
                    <div className="text-right text-sm">
                      <span
                        className={`inline-block rounded-full text-xs px-2.5 py-1 font-medium ${
                          p.status === "online"
                            ? "bg-sage-700 text-white"
                            : "bg-terracotta-100 text-terracotta-800 border border-terracotta-200"
                        }`}
                      >
                        {p.status === "online" ? "Online" : "Em consulta"}
                      </span>
                      {onlineMin != null && (
                        <p className="mt-1 text-xs text-ink-500">
                          há {formatMinutesHuman(onlineMin)}
                        </p>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── Card 2: Plantões nas próximas 4 horas ────────────────── */}
      <section className="mb-8">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2 className="font-serif text-[1.3rem] text-ink-800 leading-tight">
              Plantões nas próximas 4 horas{" "}
              <span className="text-ink-400 font-sans text-base">
                ({upcomingShifts.length})
              </span>
            </h2>
            <p className="text-sm text-ink-500 mt-0.5 max-w-2xl">
              Blocos recorrentes <code className="text-ink-700">on_call</code>{" "}
              que estão acontecendo agora ou começam em ≤ 4h.
            </p>
          </div>
        </div>
        {upcomingShifts.length === 0 ? (
          <div className="rounded-xl border border-ink-100 bg-white px-5 py-6 text-sm text-ink-500">
            Nenhum plantão nas próximas 4 horas.
          </div>
        ) : (
          <ul className="divide-y divide-ink-100 rounded-xl border border-ink-100 bg-white overflow-hidden">
            {upcomingShifts.map((s) => {
              const d = doctorById.get(s.block.doctor_id);
              return (
                <li key={s.block.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <p className="font-serif text-[1.05rem] text-ink-800">
                        {d?.display_name || d?.full_name || s.block.doctor_id}
                      </p>
                      <p className="text-sm text-ink-600 mt-0.5">
                        {WEEKDAY_LABELS_PT[s.block.weekday]} ·{" "}
                        {s.block.start_time.slice(0, 5)}–
                        {s.block.end_time.slice(0, 5)}
                      </p>
                      {s.isLive ? (
                        <p className="text-xs text-sage-700 mt-1 font-medium">
                          Em curso agora
                        </p>
                      ) : (
                        <p className="text-xs text-ink-500 mt-1">
                          Começa {formatDateTimeShortBR(s.nextStartUtc)}
                        </p>
                      )}
                    </div>
                    <div className="text-right text-sm">
                      <span
                        className={`inline-block rounded-full text-xs px-2.5 py-1 font-medium ${
                          s.doctorOnline
                            ? "bg-sage-700 text-white"
                            : s.isLive
                              ? "bg-terracotta-100 text-terracotta-800 border border-terracotta-200"
                              : "bg-ink-100 text-ink-600"
                        }`}
                      >
                        {s.doctorOnline
                          ? "Médica online"
                          : s.isLive
                            ? "Médica offline"
                            : "—"}
                      </span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── Card 3: Agenda recorrente da semana ──────────────────── */}
      <section className="mb-8">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2 className="font-serif text-[1.3rem] text-ink-800 leading-tight">
              Agenda recorrente da semana{" "}
              <span className="text-ink-400 font-sans text-base">
                ({onCallBlocks.length} bloco{onCallBlocks.length === 1 ? "" : "s"})
              </span>
            </h2>
            <p className="text-sm text-ink-500 mt-0.5 max-w-2xl">
              Read-only. Médica edita em{" "}
              <code className="text-ink-700 bg-ink-50 px-1.5 py-0.5 rounded text-[0.85rem]">
                /medico/horarios
              </code>
              .
            </p>
          </div>
        </div>
        {onCallBlocks.length === 0 ? (
          <div className="rounded-xl border border-ink-100 bg-white px-5 py-6 text-sm text-ink-500">
            Nenhum bloco <code className="text-ink-700">on_call</code> ativo
            cadastrado.
          </div>
        ) : (
          <div className="rounded-xl border border-ink-100 bg-white overflow-hidden divide-y divide-ink-100">
            {[0, 1, 2, 3, 4, 5, 6].map((wd) => {
              const blocks = blocksByWeekday.get(wd) ?? [];
              if (blocks.length === 0) return null;
              return (
                <div key={wd} className="px-5 py-4">
                  <p className="font-serif text-[1rem] text-ink-800 mb-2">
                    {WEEKDAY_LABELS_PT[wd]}
                  </p>
                  <ul className="space-y-1">
                    {blocks.map((b) => {
                      const d = doctorById.get(b.doctor_id);
                      return (
                        <li
                          key={b.id}
                          className="text-sm text-ink-700 flex flex-wrap gap-x-3 gap-y-0.5"
                        >
                          <span className="font-medium">
                            {b.start_time.slice(0, 5)}–{b.end_time.slice(0, 5)}
                          </span>
                          <span className="text-ink-500">
                            {d?.display_name || d?.full_name || b.doctor_id}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Card 4: Fila on-demand (PR-080 · D-092) ──────────────── */}
      <section className="mb-8">
        <div className="mb-3 flex items-baseline justify-between flex-wrap gap-2">
          <div>
            <h2 className="font-serif text-[1.3rem] text-ink-800 leading-tight">
              Fila on-demand{" "}
              {onDemandPending.length > 0 && (
                <span className="text-ink-400 text-sm font-sans">
                  ({onDemandPending.length})
                </span>
              )}
            </h2>
            <p className="text-sm text-ink-500 mt-0.5 max-w-2xl">
              Pacientes solicitando atendimento agora. Snapshot — sem
              auto-refresh; recarregue pra atualizar. Métricas detalhadas
              vêm em PR-082.
            </p>
          </div>
          <div className="text-xs text-ink-500">
            Últimas {onDemandSummary.windowHours}h:{" "}
            <span className="text-sage-700 font-medium">
              {onDemandSummary.accepted} aceito
              {onDemandSummary.accepted === 1 ? "" : "s"}
            </span>
            {" · "}
            <span className="text-amber-700 font-medium">
              {onDemandSummary.expired} expirado
              {onDemandSummary.expired === 1 ? "" : "s"}
            </span>
            {" · "}
            <span className="text-ink-500">
              {onDemandSummary.cancelled} cancelado
              {onDemandSummary.cancelled === 1 ? "" : "s"}
            </span>
          </div>
        </div>
        {onDemandPending.length === 0 ? (
          <div className="rounded-xl border border-ink-100 bg-white px-5 py-6 text-sm text-ink-500">
            Nenhum paciente aguardando atendimento agora.
          </div>
        ) : (
          <ul className="space-y-2">
            {onDemandPending.map((r) => {
              const ttl = computeSecondsUntilExpiry({
                expiresAt: r.expires_at,
                now,
              });
              const ageMin = Math.max(
                0,
                Math.floor(
                  (now.getTime() - new Date(r.created_at).getTime()) / 60_000
                )
              );
              const ageSec = Math.max(
                0,
                Math.floor(
                  (now.getTime() - new Date(r.created_at).getTime()) / 1000
                )
              );
              const ageStr =
                ageMin >= 1
                  ? `${ageMin} min`
                  : `${ageSec}s`;
              const ttlMin = Math.floor(ttl / 60);
              const ttlSec = ttl % 60;
              const ttlStr = `${String(ttlMin).padStart(2, "0")}:${String(
                Math.max(0, ttlSec)
              ).padStart(2, "0")}`;
              const fullName = onDemandCustomers.get(r.customer_id) ?? "";
              const fName = firstName(fullName || "Paciente");
              return (
                <li
                  key={r.id}
                  className="rounded-xl border border-ink-100 bg-white px-4 py-3 flex items-start gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-[0.95rem] font-medium text-ink-800">
                        {fName}
                      </p>
                      <span className="text-xs text-ink-400">
                        há {ageStr}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-ink-700 leading-snug break-words">
                      {truncateChiefComplaintForWa(r.chief_complaint)}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-[0.7rem] uppercase tracking-wider text-ink-400">
                      TTL
                    </p>
                    <p className="font-mono text-sm text-ink-700 tabular-nums">
                      {ttlStr}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── Card 5: Liquidações de plantão (PR-081 · D-093) ──────── */}
      <section className="mb-8">
        <div className="mb-3 flex items-baseline justify-between flex-wrap gap-2">
          <div>
            <h2 className="font-serif text-[1.3rem] text-ink-800 leading-tight">
              Liquidações de plantão{" "}
              {settlements.length > 0 && (
                <span className="text-ink-400 text-sm font-sans">
                  ({settlements.length})
                </span>
              )}
            </h2>
            <p className="text-sm text-ink-500 mt-0.5 max-w-2xl">
              Blocos <code className="text-ink-700">on_call</code> liquidados
              pelo cron <code className="text-ink-700">monitor_on_call</code>{" "}
              nos últimos {SETTLEMENT_WINDOW_DAYS} dias. Plantão cumprido
              (≥ 50%) gera earning <code className="text-ink-700">plantao_hour</code>;
              abaixo gera reliability event <code className="text-ink-700">on_call_no_show</code>.
            </p>
          </div>
          <div className="text-xs text-ink-500">
            Últimos {settlementSummary.windowDays}d:{" "}
            <span className="text-sage-700 font-medium">
              {settlementSummary.paid} pago{settlementSummary.paid === 1 ? "" : "s"}
            </span>
            {" · "}
            <span className="text-terracotta-700 font-medium">
              {settlementSummary.noShow} no-show
              {settlementSummary.noShow === 1 ? "" : "s"}
            </span>
            {settlementSummary.totalCents > 0 && (
              <>
                {" · "}
                <span className="text-ink-700 font-medium">
                  {formatCentsBR(settlementSummary.totalCents)}
                </span>{" "}
                total
              </>
            )}
          </div>
        </div>
        {settlements.length === 0 ? (
          <div className="rounded-xl border border-ink-100 bg-white px-5 py-6 text-sm text-ink-500">
            Nenhum bloco liquidado nos últimos {SETTLEMENT_WINDOW_DAYS} dias.
          </div>
        ) : (
          <ul className="divide-y divide-ink-100 rounded-xl border border-ink-100 bg-white overflow-hidden">
            {settlements.map((s) => {
              const d = doctorById.get(s.doctor_id);
              const startUtc = new Date(s.block_start_utc);
              const endUtc = new Date(s.block_end_utc);
              const pct = Math.round(s.coverage_ratio * 100);
              const cov = formatMinutesHuman(s.coverage_minutes);
              return (
                <li key={s.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <p className="font-serif text-[1.05rem] text-ink-800">
                        {d?.display_name || d?.full_name || s.doctor_id}
                      </p>
                      <p className="text-sm text-ink-600 mt-0.5">
                        {formatDateTimeShortBR(startUtc)} →{" "}
                        {formatDateTimeShortBR(endUtc)}
                      </p>
                      <p className="text-xs text-ink-500 mt-1">
                        Cobertura: {cov} de {formatMinutesHuman(s.block_minutes)}{" "}
                        ({pct}%)
                      </p>
                    </div>
                    <div className="text-right text-sm">
                      {s.outcome === "paid" ? (
                        <>
                          <span className="inline-block rounded-full text-xs px-2.5 py-1 font-medium bg-sage-700 text-white">
                            Pago
                          </span>
                          {s.amount_cents_snapshot != null && (
                            <p className="mt-1 text-sm text-sage-700 font-medium">
                              {formatCentsBR(s.amount_cents_snapshot)}
                            </p>
                          )}
                        </>
                      ) : (
                        <span className="inline-block rounded-full text-xs px-2.5 py-1 font-medium bg-terracotta-100 text-terracotta-800 border border-terracotta-200">
                          No-show
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function formatCentsBR(cents: number): string {
  const reais = cents / 100;
  return `R$ ${reais.toFixed(2).replace(".", ",")}`;
}
