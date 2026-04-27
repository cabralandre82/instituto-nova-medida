/**
 * Scheduling helpers — Instituto Nova Medida.
 *
 * Server-only. Calcula slots disponíveis a partir de
 * `doctor_availability` (regra semanal) menos `appointments` ainda
 * "vivos" (ocupando agenda) na janela.
 *
 * Decisões:
 *   - Slots de duração fixa = `doctors.consultation_minutes`.
 *   - "Vivos" = status em
 *     ('pending_payment','scheduled','confirmed','in_progress').
 *   - Reserva atomic é feita pelo SQL function
 *     `book_pending_appointment_slot` (migration 008). Esta lib só prepara
 *     a lista de candidatos para a UI.
 *   - Operamos em UTC nos cálculos. A conversão pra display em fuso
 *     local (America/Sao_Paulo) acontece na UI, via `Intl.DateTimeFormat`.
 *   - Para o MVP, a médica é única. Mas as funções já recebem `doctorId`
 *     pra evoluir pra múltiplas sem refactor.
 *
 * Limitações conhecidas:
 *   - `doctor_availability` é por weekday em hora LOCAL da médica
 *     (sem timezone na coluna). Por enquanto assumimos `America/Sao_Paulo`
 *     para todo o sistema (mesma timezone do operador). Quando suportarmos
 *     médicas em outros fusos, a coluna `availability.timezone` entra.
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import { logger } from "./logger";

const log = logger.with({ mod: "scheduling" });

export const DEFAULT_TZ = "America/Sao_Paulo";

/** Status que ocupam a agenda — não permitem nova reserva no mesmo slot. */
export const ALIVE_STATUSES = [
  "pending_payment",
  "scheduled",
  "confirmed",
  "in_progress",
] as const;

export type DoctorAvailabilityRow = {
  weekday: number; // 0 = domingo
  start_time: string; // 'HH:MM:SS'
  end_time: string;
  type: "agendada" | "plantao" | "scheduled" | "on_call";
};

export type AvailableSlot = {
  /** ISO string em UTC (ex: 2026-04-22T13:30:00.000Z). */
  startsAt: string;
  /** ISO em UTC. */
  endsAt: string;
  /** Mesma data em ms epoch — útil para sort/keys. */
  startsAtMs: number;
};

type DoctorMinimal = {
  id: string;
  consultation_minutes: number;
  display_name: string | null;
  full_name: string;
};

/**
 * Carrega a primeira médica ativa e NÃO pausada por regra de
 * confiabilidade (D-036).
 *
 * Médicas com `reliability_paused_at IS NOT NULL` ficam fora do fluxo
 * de agendamento público. Appointments já agendadas com elas seguem
 * seu curso normal; só novas reservas ficam bloqueadas.
 */
export async function getPrimaryDoctor(): Promise<DoctorMinimal | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("doctors")
    .select("id, consultation_minutes, display_name, full_name")
    .eq("status", "active")
    .is("reliability_paused_at", null)
    .order("activated_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    log.error("getPrimaryDoctor", { err: error });
    return null;
  }
  return data ?? null;
}

/** Carrega availability ativo (apenas tipo "agendada", para o MVP). */
export async function getDoctorAvailability(doctorId: string): Promise<DoctorAvailabilityRow[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("doctor_availability")
    .select("weekday, start_time, end_time, type")
    .eq("doctor_id", doctorId)
    .eq("active", true)
    .in("type", ["agendada", "scheduled"]);
  if (error) {
    log.error("getDoctorAvailability", { err: error });
    return [];
  }
  return (data ?? []) as DoctorAvailabilityRow[];
}

/**
 * Carrega timestamps já ocupados (slots vivos) de um doctor no intervalo.
 * Retorna ms epoch como Set para lookup O(1).
 */
async function loadBookedSlotMs(
  doctorId: string,
  fromUTC: Date,
  toUTC: Date
): Promise<Set<number>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("appointments")
    .select("scheduled_at, pending_payment_expires_at, status")
    .eq("doctor_id", doctorId)
    .in("status", ALIVE_STATUSES as unknown as string[])
    .gte("scheduled_at", fromUTC.toISOString())
    .lt("scheduled_at", toUTC.toISOString());
  if (error) {
    log.error("loadBookedSlotMs", { err: error });
    return new Set();
  }

  const now = Date.now();
  const occupied = new Set<number>();
  for (const row of data ?? []) {
    const ms = new Date(row.scheduled_at as string).getTime();
    // Reservas pending_payment expiradas NÃO bloqueiam: o cron vai limpar
    // (e o próprio book_pending_appointment_slot limpa antes de inserir).
    if (
      row.status === "pending_payment" &&
      row.pending_payment_expires_at &&
      new Date(row.pending_payment_expires_at as string).getTime() < now
    ) {
      continue;
    }
    occupied.add(ms);
  }
  return occupied;
}

/**
 * Converte uma combinação (data local na TZ, "HH:MM:SS") em Date UTC.
 *
 * Por que tão verboso: JS não tem API nativa pra "construir Date numa TZ
 * específica". O truque é usar `Intl.DateTimeFormat` pra descobrir o offset
 * em milissegundos pra aquele instante.
 */
function localDateTimeToUTC(
  localYear: number,
  localMonth: number, // 1..12
  localDay: number,
  hour: number,
  minute: number,
  timeZone: string
): Date {
  // Constrói o instante "pretend it's UTC" e ajusta pelo offset real.
  const fakeUTC = Date.UTC(localYear, localMonth - 1, localDay, hour, minute, 0);
  // Descobre quanto que esse instante "é" na timezone alvo (em ms desde epoch).
  // Forma compacta: usa o trick de toLocaleString → reparse.
  const tzString = new Date(fakeUTC).toLocaleString("en-US", { timeZone });
  const tzMs = Date.parse(tzString);
  // diferença = (interpretação local) - (epoch construído como UTC)
  // se positiva, a TZ está ATRÁS de UTC; se negativa, ADIANTE.
  const diff = tzMs - fakeUTC;
  return new Date(fakeUTC - diff);
}

/**
 * Quebra HH:MM:SS em [hour, minute].
 */
function parseTime(t: string): [number, number] {
  const [h, m] = t.split(":");
  return [Number(h), Number(m)];
}

/**
 * Retorna os componentes (year/month/day/weekday 0-6) da data **na TZ alvo**.
 */
function getLocalDateComponents(d: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  weekday: number;
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(d).map((p) => [p.type, p.value])
  );
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: weekdayMap[parts.weekday] ?? 0,
  };
}

export type ListSlotsOptions = {
  /** Quantos dias adiante a partir de "hoje" (na TZ). Default 7. */
  days?: number;
  /** Mínimo de minutos no futuro (não oferece slot daqui a 5 min). Default 60. */
  minLeadMinutes?: number;
  /** Slots por dia no máximo (cap). Default 12. */
  maxPerDay?: number;
  /** Timezone. Default America/Sao_Paulo. */
  timeZone?: string;
};

/**
 * Lista próximos slots disponíveis na agenda da médica.
 *
 * Para cada dia da janela, intercepta `doctor_availability` daquele
 * weekday, divide em slots de `consultation_minutes`, filtra os já
 * ocupados, e retorna em ordem cronológica.
 */
export async function listAvailableSlots(
  doctorId: string,
  consultationMinutes: number,
  opts: ListSlotsOptions = {}
): Promise<AvailableSlot[]> {
  const days = Math.min(Math.max(opts.days ?? 7, 1), 30);
  const minLead = Math.max(opts.minLeadMinutes ?? 60, 0);
  const maxPerDay = Math.min(Math.max(opts.maxPerDay ?? 12, 1), 48);
  const tz = opts.timeZone ?? DEFAULT_TZ;

  const availability = await getDoctorAvailability(doctorId);
  if (availability.length === 0) return [];

  // Indexa availability por weekday
  const byWeekday = new Map<number, DoctorAvailabilityRow[]>();
  for (const row of availability) {
    const arr = byWeekday.get(row.weekday) ?? [];
    arr.push(row);
    byWeekday.set(row.weekday, arr);
  }

  const now = new Date();
  const earliest = new Date(now.getTime() + minLead * 60_000);

  // Janela em UTC pra carregar appointments (1 dia de margem em cada ponta)
  const fromUTC = new Date(now.getTime() - 24 * 3600 * 1000);
  const toUTC = new Date(now.getTime() + (days + 2) * 24 * 3600 * 1000);
  const occupied = await loadBookedSlotMs(doctorId, fromUTC, toUTC);

  const todayLocal = getLocalDateComponents(now, tz);

  const slots: AvailableSlot[] = [];

  for (let dayOffset = 0; dayOffset < days; dayOffset += 1) {
    // Constrói "esse dia local" no calendário da TZ.
    const cursor = new Date(
      Date.UTC(todayLocal.year, todayLocal.month - 1, todayLocal.day + dayOffset, 12, 0, 0)
    );
    const local = getLocalDateComponents(cursor, tz);
    const weekdayRows = byWeekday.get(local.weekday);
    if (!weekdayRows) continue;

    let perDay = 0;
    for (const row of weekdayRows) {
      const [sh, sm] = parseTime(row.start_time);
      const [eh, em] = parseTime(row.end_time);

      const blockStart = localDateTimeToUTC(local.year, local.month, local.day, sh, sm, tz);
      const blockEnd = localDateTimeToUTC(local.year, local.month, local.day, eh, em, tz);

      let cur = blockStart.getTime();
      const end = blockEnd.getTime();
      while (cur + consultationMinutes * 60_000 <= end) {
        if (perDay >= maxPerDay) break;

        const candidate = cur;
        if (candidate < earliest.getTime()) {
          cur += consultationMinutes * 60_000;
          continue;
        }
        if (occupied.has(candidate)) {
          cur += consultationMinutes * 60_000;
          continue;
        }
        slots.push({
          startsAt: new Date(candidate).toISOString(),
          endsAt: new Date(candidate + consultationMinutes * 60_000).toISOString(),
          startsAtMs: candidate,
        });
        perDay += 1;
        cur += consultationMinutes * 60_000;
      }
    }
  }

  slots.sort((a, b) => a.startsAtMs - b.startsAtMs);
  return slots;
}

/** Verifica se um candidato é VÁLIDO segundo a agenda (anti-tampering). */
export async function isSlotAvailable(
  doctorId: string,
  consultationMinutes: number,
  startsAtIso: string,
  opts: { minLeadMinutes?: number; timeZone?: string } = {}
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const target = new Date(startsAtIso);
  if (Number.isNaN(target.getTime())) return { ok: false, reason: "invalid_iso" };

  const all = await listAvailableSlots(doctorId, consultationMinutes, {
    days: 30,
    minLeadMinutes: opts.minLeadMinutes ?? 60,
    maxPerDay: 48,
    timeZone: opts.timeZone,
  });

  const exact = all.find((s) => s.startsAtMs === target.getTime());
  if (!exact) return { ok: false, reason: "slot_not_offered" };
  return { ok: true };
}

/**
 * Chama a SQL function `book_pending_appointment_slot`.
 * Retorna o appointment id ou um erro tipado.
 */
export async function bookPendingSlot(input: {
  doctorId: string;
  customerId: string;
  scheduledAt: string; // ISO
  durationMinutes: number;
  kind?: "scheduled" | "on_demand";
  ttlMinutes?: number;
  recordingConsent?: boolean;
}): Promise<
  | { ok: true; appointmentId: string }
  | { ok: false; error: "slot_taken" | "validation_failed" | "internal"; message?: string }
> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("book_pending_appointment_slot", {
    p_doctor_id: input.doctorId,
    p_customer_id: input.customerId,
    p_scheduled_at: input.scheduledAt,
    p_duration_minutes: input.durationMinutes,
    p_kind: input.kind ?? "scheduled",
    p_ttl_minutes: input.ttlMinutes ?? 15,
    p_recording_consent: input.recordingConsent ?? false,
  });
  if (error) {
    const msg = error.message || "";
    if (msg.includes("slot_taken")) {
      return { ok: false, error: "slot_taken", message: "Slot já reservado." };
    }
    if (error.code === "22023") {
      return { ok: false, error: "validation_failed", message: msg };
    }
    log.error("bookPendingSlot", { err: error });
    return { ok: false, error: "internal", message: msg };
  }
  if (!data || typeof data !== "string") {
    return { ok: false, error: "internal", message: "RPC retornou vazio" };
  }
  return { ok: true, appointmentId: data };
}

/**
 * Chama a SQL function `book_free_appointment_slot` (D-086).
 *
 * Cria um appointment com `status='scheduled'` direto, sem
 * payment_id e sem TTL de pending_payment. Usado pela rota
 * canônica `/api/agendar/free` (consulta inicial gratuita do
 * fluxo D-044). Compartilha com `bookPendingSlot` o mesmo índice
 * unique parcial `ux_app_doctor_slot_alive` — garantia
 * anti-double-book sem alteração de schema.
 */
export async function bookFreeSlot(input: {
  doctorId: string;
  customerId: string;
  scheduledAt: string; // ISO
  durationMinutes: number;
  kind?: "scheduled" | "on_demand";
  recordingConsent?: boolean;
}): Promise<
  | { ok: true; appointmentId: string }
  | { ok: false; error: "slot_taken" | "validation_failed" | "internal"; message?: string }
> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("book_free_appointment_slot", {
    p_doctor_id: input.doctorId,
    p_customer_id: input.customerId,
    p_scheduled_at: input.scheduledAt,
    p_duration_minutes: input.durationMinutes,
    p_kind: input.kind ?? "scheduled",
    p_recording_consent: input.recordingConsent ?? false,
  });
  if (error) {
    const msg = error.message || "";
    if (msg.includes("slot_taken")) {
      return { ok: false, error: "slot_taken", message: "Slot já reservado." };
    }
    if (error.code === "22023") {
      return { ok: false, error: "validation_failed", message: msg };
    }
    log.error("bookFreeSlot", { err: error });
    return { ok: false, error: "internal", message: msg };
  }
  if (!data || typeof data !== "string") {
    return { ok: false, error: "internal", message: "RPC retornou vazio" };
  }
  return { ok: true, appointmentId: data };
}

/**
 * Chama `activate_appointment_after_payment`. Idempotente.
 */
export async function activateAppointmentAfterPayment(
  appointmentId: string,
  paymentId: string
): Promise<
  | { ok: true; wasActivated: boolean; status: string }
  | { ok: false; error: string }
> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("activate_appointment_after_payment", {
    p_appointment_id: appointmentId,
    p_payment_id: paymentId,
  });
  if (error) {
    log.error("activate", { err: error });
    return { ok: false, error: error.message };
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { ok: false, error: "no_row" };
  return {
    ok: true,
    wasActivated: Boolean(row.was_activated),
    status: String(row.status),
  };
}
