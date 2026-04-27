/**
 * src/lib/admin-appointments.ts — PR-078 · D-090
 *
 * Helpers PUROS para a página `/admin/appointments`. IO fica inline na
 * page (consistente com `/admin/fulfillments`); aqui ficam só labels,
 * agrupamento por status, e formatação determinística.
 *
 * Por que existir lib pura
 * ────────────────────────
 *  - Drift entre admin label e paciente label (`labelForAppointmentStatus`
 *    em `patient-treatment.ts`) é facil — admin precisa diferenciar
 *    `cancelled_by_patient` vs `cancelled_by_doctor` em granularidade
 *    forense, paciente só vê "Cancelada".
 *  - Agrupamento por bucket temporal ("em andamento agora", "próximas
 *    24h", "encerradas") tem regras determinísticas que merecem teste.
 */

export type AppointmentStatusValue =
  | "pending_payment"
  | "scheduled"
  | "confirmed"
  | "in_progress"
  | "completed"
  | "no_show_patient"
  | "no_show_doctor"
  | "cancelled_by_patient"
  | "cancelled_by_doctor"
  | "cancelled_by_admin";

export const ALL_APPOINTMENT_STATUSES: readonly AppointmentStatusValue[] = [
  "pending_payment",
  "scheduled",
  "confirmed",
  "in_progress",
  "completed",
  "no_show_patient",
  "no_show_doctor",
  "cancelled_by_patient",
  "cancelled_by_doctor",
  "cancelled_by_admin",
] as const;

/**
 * Label admin (forense). Diferencia origens de cancelamento e tipos de
 * no-show — operador precisa saber pra agir (clawback × refund × nada).
 */
export function adminLabelForAppointmentStatus(status: string): string {
  const map: Record<string, string> = {
    pending_payment: "Aguardando pagamento (legado)",
    scheduled: "Agendada",
    confirmed: "Confirmada",
    in_progress: "Em andamento",
    completed: "Concluída",
    no_show_patient: "No-show paciente",
    no_show_doctor: "No-show médica",
    cancelled_by_patient: "Cancelada pelo paciente",
    cancelled_by_doctor: "Cancelada pela médica",
    cancelled_by_admin: "Cancelada pelo admin",
  };
  return map[status] ?? status;
}

/**
 * Tom visual por status (reaproveitado em badges). Mantido em string
 * canônica em vez de objeto Tailwind pra centralizar mapping no JSX.
 */
export type AppointmentTone =
  | "active"
  | "ok"
  | "warn"
  | "muted"
  | "neutral";

export function adminToneForAppointmentStatus(
  status: AppointmentStatusValue
): AppointmentTone {
  switch (status) {
    case "in_progress":
      return "active";
    case "scheduled":
    case "confirmed":
      return "neutral";
    case "completed":
      return "ok";
    case "no_show_patient":
    case "no_show_doctor":
    case "cancelled_by_admin":
      return "warn";
    case "cancelled_by_patient":
    case "cancelled_by_doctor":
    case "pending_payment":
      return "muted";
    default: {
      const _exhaustive: never = status;
      void _exhaustive;
      return "neutral";
    }
  }
}

/**
 * Bucket temporal pra agrupamento "sem filtro". As regras:
 *
 *   - `live`: status='in_progress', OU (status in {scheduled, confirmed}
 *     E [scheduled_at - 30min, scheduled_at + 60min]).
 *   - `next_24h`: status in {scheduled, confirmed} E now < scheduled_at
 *     ≤ now + 24h E não-`live`.
 *   - `next_7d`: status in {scheduled, confirmed} E now + 24h <
 *     scheduled_at ≤ now + 7d.
 *   - `recent_finished`: status in {completed, no_show_*, cancelled_*} E
 *     scheduled_at ≥ now - 7d.
 *   - `older`: tudo mais (admin pode ver via filtro, mas não polui a
 *     listagem default).
 *
 * Determinístico: dado o mesmo `now` e `scheduled_at`, sempre devolve
 * o mesmo bucket.
 */
export type AppointmentBucket =
  | "live"
  | "next_24h"
  | "next_7d"
  | "recent_finished"
  | "older";

const TERMINAL_STATUSES = new Set<AppointmentStatusValue>([
  "completed",
  "no_show_patient",
  "no_show_doctor",
  "cancelled_by_patient",
  "cancelled_by_doctor",
  "cancelled_by_admin",
]);

const ACTIVE_STATUSES = new Set<AppointmentStatusValue>([
  "scheduled",
  "confirmed",
]);

export function bucketForAppointment(input: {
  status: AppointmentStatusValue | string;
  scheduledAt: Date;
  now: Date;
}): AppointmentBucket {
  const { status, scheduledAt, now } = input;
  const deltaMs = scheduledAt.getTime() - now.getTime();
  const oneHourMs = 60 * 60 * 1000;
  const thirtyMinMs = 30 * 60 * 1000;
  const oneDayMs = 24 * oneHourMs;
  const sevenDayMs = 7 * oneDayMs;

  if (status === "in_progress") return "live";

  if (
    ACTIVE_STATUSES.has(status as AppointmentStatusValue) &&
    deltaMs >= -oneHourMs &&
    deltaMs <= thirtyMinMs
  ) {
    return "live";
  }

  if (
    ACTIVE_STATUSES.has(status as AppointmentStatusValue) &&
    deltaMs > thirtyMinMs &&
    deltaMs <= oneDayMs
  ) {
    return "next_24h";
  }

  if (
    ACTIVE_STATUSES.has(status as AppointmentStatusValue) &&
    deltaMs > oneDayMs &&
    deltaMs <= sevenDayMs
  ) {
    return "next_7d";
  }

  if (
    TERMINAL_STATUSES.has(status as AppointmentStatusValue) &&
    -sevenDayMs <= deltaMs &&
    deltaMs <= 0
  ) {
    return "recent_finished";
  }

  return "older";
}

/**
 * Próxima ocorrência (em UTC) de um bloco recorrente `on_call` em
 * America/Sao_Paulo. Retorna null se nenhuma das próximas 7 ocorrências
 * estiver dentro de `withinHours`.
 *
 * Algoritmo:
 *   - Para cada offset 0..6 (dias), constrói um Date candidato no
 *     timezone SP usando `weekday`+`start_time`.
 *   - O primeiro candidato cujo getTime() > now.getTime() é o "next".
 *   - Se ele estiver dentro de `withinHours`, retorna; senão retorna
 *     null (admin não precisa ver plantão de 5 dias à frente nesta
 *     viewmais imediata).
 *
 * Trade-off: assume SP fixo UTC-3 (sem DST desde 2019). Se mudar,
 * basta aceitar o offset como parâmetro.
 */
export function nextOnCallStartUtc(input: {
  weekday: number;
  startTime: string;
  now: Date;
  withinHours?: number;
}): Date | null {
  const { weekday, startTime, now } = input;
  const withinHours = input.withinHours ?? 24 * 7;
  if (
    !Number.isInteger(weekday) ||
    weekday < 0 ||
    weekday > 6 ||
    typeof startTime !== "string"
  ) {
    return null;
  }
  const [hStr, mStr] = startTime.split(":");
  const h = Number.parseInt(hStr ?? "", 10);
  const m = Number.parseInt(mStr ?? "", 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;

  // Determina parts SP do `now`.
  const sp = new Date(now.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const nowWeekday = sp.getDay();

  // Tenta na primeira ocorrência futura desse weekday (≤ 6 dias) e,
  // se ainda assim cair antes de `now` (caso `weekday === today` e
  // `start_time` já passou), tenta a semana seguinte.
  for (let weekOffset = 0; weekOffset <= 1; weekOffset += 1) {
    const daysUntil = ((weekday - nowWeekday + 7) % 7) + weekOffset * 7;
    const candidateSp = new Date(sp);
    candidateSp.setDate(sp.getDate() + daysUntil);
    // SP fixo UTC-3 (sem DST desde 2019).
    const candidateUtc = new Date(
      Date.UTC(
        candidateSp.getFullYear(),
        candidateSp.getMonth(),
        candidateSp.getDate(),
        h + 3,
        m,
        0,
        0
      )
    );
    if (candidateUtc.getTime() <= now.getTime()) continue;
    const deltaHours =
      (candidateUtc.getTime() - now.getTime()) / (60 * 60 * 1000);
    if (deltaHours > withinHours) return null;
    return candidateUtc;
  }
  return null;
}

/**
 * Determina se uma médica está "ativa em plantão agora" considerando
 * o snapshot da agenda (`weekday`, `start_time`, `end_time`) + o
 * timestamp atual em SP.
 *
 * Uma médica está ativa SE existe um bloco `on_call` ativo cujo
 * (weekday, [start_time, end_time)) cobre o `now` em SP.
 */
export function isOnCallNow(input: {
  weekday: number;
  startTime: string;
  endTime: string;
  now: Date;
}): boolean {
  const sp = new Date(
    input.now.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" })
  );
  if (sp.getDay() !== input.weekday) return false;
  const [sh, sm] = input.startTime.split(":").map((v) => Number.parseInt(v, 10));
  const [eh, em] = input.endTime.split(":").map((v) => Number.parseInt(v, 10));
  if (
    !Number.isFinite(sh) ||
    !Number.isFinite(sm) ||
    !Number.isFinite(eh) ||
    !Number.isFinite(em)
  ) {
    return false;
  }
  const nowMin = sp.getHours() * 60 + sp.getMinutes();
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  return nowMin >= startMin && nowMin < endMin;
}
