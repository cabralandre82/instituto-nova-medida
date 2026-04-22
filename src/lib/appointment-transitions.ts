/**
 * Espelho TS da tabela `appointment_state_transitions` (D-070).
 *
 * Esta lista é a FONTE DE VERDADE da camada de aplicação para validar
 * transições de `appointments.status`. Deve estar 100% sincronizada
 * com o seed da migration `20260509000000_appointment_state_machine.sql`.
 *
 * Uso:
 *   - `isAllowedTransition(from, to)` — guard rápido em código novo.
 *   - Teste em `appointment-transitions.test.ts` falha se alguém
 *     adicionar uma transição em código real (`reconcile.ts`,
 *     `appointment-finalize.ts`, RPC etc.) sem atualizar este arquivo
 *     E o seed SQL.
 *
 * Onda 3B · PR-059 · audit finding [10.5].
 */

export type AppointmentStatus =
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

export const APPOINTMENT_STATUSES: readonly AppointmentStatus[] = [
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

export const TERMINAL_APPOINTMENT_STATUSES: readonly AppointmentStatus[] = [
  "completed",
  "no_show_patient",
  "no_show_doctor",
  "cancelled_by_patient",
  "cancelled_by_doctor",
  "cancelled_by_admin",
] as const;

export type AppointmentTransition = {
  from: AppointmentStatus;
  to: AppointmentStatus;
  description: string;
};

/**
 * ATENÇÃO: editar este array exige editar TAMBÉM o `insert into
 * appointment_state_transitions` em
 * `supabase/migrations/20260509000000_appointment_state_machine.sql`.
 * O teste `appointment-transitions.test.ts` valida invariantes mas
 * não consegue verificar paridade com o SQL — discrepância vira
 * `warning` em produção (modo warn) ou `blocked` (enforce).
 */
export const ALLOWED_APPOINTMENT_TRANSITIONS: readonly AppointmentTransition[] = [
  // pending_payment
  { from: "pending_payment", to: "scheduled",            description: "Pagamento confirmado (activate_appointment_after_payment)" },
  { from: "pending_payment", to: "cancelled_by_admin",   description: "TTL expirou (expire_abandoned_reservations / book_pending_appointment_slot cleanup)" },
  { from: "pending_payment", to: "cancelled_by_patient", description: "Paciente cancela antes de pagar" },
  { from: "pending_payment", to: "cancelled_by_doctor",  description: "Médica cancela slot antes do paciente pagar" },
  { from: "pending_payment", to: "completed",            description: "Defensivo: reconcile fecha appt sem started_at" },
  { from: "pending_payment", to: "no_show_patient",      description: "Defensivo: reconcile classifica no-show direto" },
  { from: "pending_payment", to: "no_show_doctor",       description: "Defensivo: idem para no-show da médica" },

  // scheduled
  { from: "scheduled", to: "confirmed",            description: "Notificação de confirmação enviada / paciente confirmou" },
  { from: "scheduled", to: "in_progress",          description: "Daily meeting.started detectado (webhook)" },
  { from: "scheduled", to: "completed",            description: "reconcile (ambos entraram) OU appointment-finalize" },
  { from: "scheduled", to: "no_show_patient",      description: "reconcile: só médica entrou" },
  { from: "scheduled", to: "no_show_doctor",       description: "reconcile: só paciente entrou" },
  { from: "scheduled", to: "cancelled_by_patient", description: "Paciente cancelou" },
  { from: "scheduled", to: "cancelled_by_doctor",  description: "Médica cancelou" },
  { from: "scheduled", to: "cancelled_by_admin",   description: "Admin cancelou OU reconcile expired_no_one_joined" },

  // confirmed
  { from: "confirmed", to: "in_progress",          description: "Daily meeting.started" },
  { from: "confirmed", to: "completed",            description: "reconcile / appointment-finalize" },
  { from: "confirmed", to: "no_show_patient",      description: "reconcile: só médica entrou" },
  { from: "confirmed", to: "no_show_doctor",       description: "reconcile: só paciente entrou" },
  { from: "confirmed", to: "cancelled_by_patient", description: "Paciente cancelou" },
  { from: "confirmed", to: "cancelled_by_doctor",  description: "Médica cancelou" },
  { from: "confirmed", to: "cancelled_by_admin",   description: "Admin cancelou OU reconcile expired_no_one_joined" },

  // in_progress
  { from: "in_progress", to: "completed",            description: "reconcile (ambos entraram E ≥ 3min) OU appointment-finalize" },
  { from: "in_progress", to: "no_show_patient",      description: "reconcile: paciente nunca entrou" },
  { from: "in_progress", to: "no_show_doctor",       description: "reconcile: médica nunca entrou" },
  { from: "in_progress", to: "cancelled_by_admin",   description: "Admin força encerramento (expired_no_one_joined defensivo)" },
  { from: "in_progress", to: "cancelled_by_doctor",  description: "Médica encerra meeting cedo" },
  { from: "in_progress", to: "cancelled_by_patient", description: "Paciente sai e cancela" },
] as const;

const allowedSet: ReadonlySet<string> = new Set(
  ALLOWED_APPOINTMENT_TRANSITIONS.map((t) => `${t.from}>${t.to}`)
);

/**
 * Retorna `true` se a transição está listada como válida. Reflexivos
 * (from === to) são considerados sempre válidos (no-op).
 */
export function isAllowedAppointmentTransition(
  from: AppointmentStatus,
  to: AppointmentStatus
): boolean {
  if (from === to) return true;
  return allowedSet.has(`${from}>${to}`);
}

/**
 * Retorna a lista de transições proibidas a partir de um estado.
 * Usado por testes/diagnóstico.
 */
export function listForbiddenTransitionsFrom(
  from: AppointmentStatus
): readonly AppointmentStatus[] {
  return APPOINTMENT_STATUSES.filter(
    (s) => s !== from && !isAllowedAppointmentTransition(from, s)
  );
}

/**
 * `true` se o status é terminal (não deveria mais mudar sem bypass).
 */
export function isTerminalAppointmentStatus(s: AppointmentStatus): boolean {
  return (TERMINAL_APPOINTMENT_STATUSES as readonly string[]).includes(s);
}
