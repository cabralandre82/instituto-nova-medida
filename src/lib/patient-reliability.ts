/**
 * src/lib/patient-reliability.ts — PR-068 · D-076 · finding [17.6]
 *
 * API pragmática sobre `patient_reliability_events` (migration
 * `20260513000000_patient_reliability_events.sql`):
 *
 *   1. Eventos automáticos (`no_show_patient`, `reservation_abandoned`,
 *      `late_cancel_patient`) são gravados pela trigger DB
 *      `trg_record_patient_reliability` em `appointments`. Esta lib
 *      NÃO duplica esse registro — só o fornece pra leitura e pra
 *      casos manuais.
 *
 *   2. `recordManualEvent` — admin registra evento ad-hoc (`manual` ou
 *      `refund_requested`), opcionalmente vinculado a um appointment.
 *
 *   3. `dismissEvent` — admin marca evento como "não conta" (ex: bug
 *      da plataforma que causou falso no-show). Evento permanece na
 *      tabela com `dismissed_at`/`by`/`reason` pra auditoria.
 *
 *   4. `getPatientReliabilitySnapshot` — retorna contagem de eventos
 *      ATIVOS (não dispensados) na janela padrão (90 dias) + flags
 *      de soft-warn / hard-flag.
 *
 *   5. `listRecentEvents`, `listCustomerEvents` — leituras pra UI do
 *      admin.
 *
 * Diferenças vs. `reliability.ts` (médica):
 *   - Janela maior (90d vs 30d): pacientes são humanos "civis",
 *     frequência menor que médica (que tem incentivo a aparecer).
 *   - Sem auto-pause: não bloqueamos paciente automaticamente no MVP.
 *     Admin decide caso a caso via UI. (PR-068-B pode adicionar
 *     `customers.reliability_blocked_at` se sinal operacional
 *     justificar.)
 *   - Kind `reservation_abandoned` é específico do paciente (médica
 *     não reserva; ela só aparece ou não).
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import { logger } from "./logger";

const log = logger.with({ mod: "patient-reliability" });

// ─── Constantes de política ────────────────────────────────────────────

/** Janela de análise em dias pras regras de alerta. Maior que médica
 *  (30d) porque pacientes têm frequência menor. */
export const PATIENT_RELIABILITY_WINDOW_DAYS = 90;

/** N eventos ativos pra paciente aparecer em "warn" no dashboard. */
export const PATIENT_RELIABILITY_SOFT_WARN = 2;

/** N eventos ativos pra paciente aparecer em "flag crítico". Não é
 *  hard-block: só sinaliza ao admin pra decisão manual. */
export const PATIENT_RELIABILITY_HARD_FLAG = 3;

// ─── Tipos ─────────────────────────────────────────────────────────────

export type PatientReliabilityKind =
  | "no_show_patient"
  | "reservation_abandoned"
  | "late_cancel_patient"
  | "refund_requested"
  | "manual";

/** Kinds aceitos em `recordManualEvent` — a trigger cuida dos
 *  automáticos, a lib só permite os que fazem sentido registrar via
 *  UI/admin. */
export const MANUAL_KINDS = ["manual", "refund_requested"] as const;
export type ManualPatientReliabilityKind = (typeof MANUAL_KINDS)[number];

export type PatientReliabilityEvent = {
  id: string;
  customer_id: string;
  appointment_id: string | null;
  kind: PatientReliabilityKind;
  occurred_at: string;
  notes: string | null;
  dismissed_at: string | null;
  dismissed_by: string | null;
  dismissed_reason: string | null;
  created_at: string;
};

export type PatientReliabilitySnapshot = {
  customerId: string;
  activeEventsInWindow: number;
  windowDays: number;
  softWarn: number;
  hardFlag: number;
  isInSoftWarn: boolean;
  isAtHardFlag: boolean;
  lastEventAt: string | null;
  /** Breakdown por kind, só contando ativos na janela. */
  byKind: Record<PatientReliabilityKind, number>;
};

export type RecordManualEventInput = {
  customerId: string;
  appointmentId?: string | null;
  kind: ManualPatientReliabilityKind;
  notes: string;
  /** admin user id — preserva quem registrou; grava em `notes` já que
   *  não temos coluna `created_by` (mantém schema simétrico ao doctor_). */
  adminUserId?: string | null;
};

export type RecordManualEventResult =
  | { ok: true; eventId: string; alreadyRecorded: boolean }
  | {
      ok: false;
      code:
        | "invalid_customer"
        | "invalid_kind"
        | "invalid_notes"
        | "db_error";
      message: string;
    };

export type DismissEventInput = {
  eventId: string;
  dismissedBy: string;
  reason: string;
};

export type DismissEventResult =
  | { ok: true; eventId: string; alreadyDismissed: boolean }
  | {
      ok: false;
      code: "event_not_found" | "invalid_reason" | "db_error";
      message: string;
    };

// ─── Helpers puros ─────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function sanitizeNotes(value: unknown, maxLen = 1000): string | null {
  if (typeof value !== "string") return null;
  // Remove controles exceto \n\r\t; trim; clampa.
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim();
  if (!clean) return null;
  return clean.length > maxLen ? clean.slice(0, maxLen) : clean;
}

export function computeSnapshotFromEvents(
  customerId: string,
  activeEvents: ReadonlyArray<
    Pick<PatientReliabilityEvent, "kind" | "occurred_at">
  >,
  now: Date = new Date()
): PatientReliabilitySnapshot {
  const since = new Date(
    now.getTime() - PATIENT_RELIABILITY_WINDOW_DAYS * 24 * 60 * 60 * 1000
  );
  const byKind: Record<PatientReliabilityKind, number> = {
    no_show_patient: 0,
    reservation_abandoned: 0,
    late_cancel_patient: 0,
    refund_requested: 0,
    manual: 0,
  };
  let lastEventAt: string | null = null;
  let count = 0;
  for (const ev of activeEvents) {
    const ts = new Date(ev.occurred_at);
    if (Number.isNaN(ts.getTime()) || ts < since) continue;
    count += 1;
    byKind[ev.kind] = (byKind[ev.kind] ?? 0) + 1;
    if (!lastEventAt || ev.occurred_at > lastEventAt) {
      lastEventAt = ev.occurred_at;
    }
  }
  return {
    customerId,
    activeEventsInWindow: count,
    windowDays: PATIENT_RELIABILITY_WINDOW_DAYS,
    softWarn: PATIENT_RELIABILITY_SOFT_WARN,
    hardFlag: PATIENT_RELIABILITY_HARD_FLAG,
    isInSoftWarn:
      count >= PATIENT_RELIABILITY_SOFT_WARN &&
      count < PATIENT_RELIABILITY_HARD_FLAG,
    isAtHardFlag: count >= PATIENT_RELIABILITY_HARD_FLAG,
    lastEventAt,
    byKind,
  };
}

// ─── Record manual ─────────────────────────────────────────────────────

/**
 * Registra um evento manual pelo admin (kind: 'manual' ou
 * 'refund_requested'). Eventos automáticos (`no_show_patient`,
 * `reservation_abandoned`, `late_cancel_patient`) são gravados pela
 * trigger DB — **não use esta função pra re-registrar eles**, vai
 * conflitar com o unique(appointment_id, kind).
 *
 * Idempotência: se fornecer `appointmentId`, unique parcial impede
 * duplicata pro mesmo par. Sem appointment, cada chamada cria linha
 * nova (responsabilidade do caller não duplicar).
 */
export async function recordManualEvent(
  input: RecordManualEventInput
): Promise<RecordManualEventResult> {
  if (!isUuid(input.customerId)) {
    return {
      ok: false,
      code: "invalid_customer",
      message: "customerId deve ser UUID válido.",
    };
  }

  const allowedKinds = MANUAL_KINDS as readonly string[];
  if (!allowedKinds.includes(input.kind)) {
    return {
      ok: false,
      code: "invalid_kind",
      message: `kind deve ser um de: ${MANUAL_KINDS.join(", ")}.`,
    };
  }

  const notes = sanitizeNotes(input.notes);
  if (!notes || notes.length < 4) {
    return {
      ok: false,
      code: "invalid_notes",
      message:
        "notes obrigatório (mín. 4 chars após sanitização) — contexto do evento manual é requerido pra auditoria.",
    };
  }

  const appointmentId =
    input.appointmentId && isUuid(input.appointmentId)
      ? input.appointmentId
      : null;

  const supabase = getSupabaseAdmin();

  // Composição do notes preserva autor; schema não tem `created_by`
  // porque a trigger não passa actor.
  const fullNotes = input.adminUserId
    ? `[admin=${input.adminUserId}] ${notes}`
    : notes;

  const ins = await supabase
    .from("patient_reliability_events")
    .insert({
      customer_id: input.customerId,
      appointment_id: appointmentId,
      kind: input.kind,
      notes: fullNotes,
    })
    .select("id")
    .maybeSingle();

  if (ins.error) {
    // Conflict em (appointment_id, kind) — já existe linha pra esse par.
    if (ins.error.code === "23505" && appointmentId) {
      const existing = await supabase
        .from("patient_reliability_events")
        .select("id")
        .eq("appointment_id", appointmentId)
        .eq("kind", input.kind)
        .maybeSingle();
      if (!existing.error && existing.data) {
        return {
          ok: true,
          eventId: (existing.data as { id: string }).id,
          alreadyRecorded: true,
        };
      }
    }
    log.error("recordManualEvent falhou", {
      err: ins.error,
      customer_id: input.customerId,
      kind: input.kind,
    });
    return { ok: false, code: "db_error", message: ins.error.message };
  }

  if (!ins.data) {
    return {
      ok: false,
      code: "db_error",
      message: "INSERT não retornou id.",
    };
  }

  return {
    ok: true,
    eventId: (ins.data as { id: string }).id,
    alreadyRecorded: false,
  };
}

// ─── Dismiss ───────────────────────────────────────────────────────────

export async function dismissEvent(
  input: DismissEventInput
): Promise<DismissEventResult> {
  if (!isUuid(input.eventId)) {
    return {
      ok: false,
      code: "event_not_found",
      message: "eventId inválido.",
    };
  }

  const reason = sanitizeNotes(input.reason, 500);
  if (!reason || reason.length < 4) {
    return {
      ok: false,
      code: "invalid_reason",
      message:
        "reason obrigatório (mín. 4 chars após sanitização) pra justificar a dispensa.",
    };
  }

  const supabase = getSupabaseAdmin();

  const current = await supabase
    .from("patient_reliability_events")
    .select("id, dismissed_at, customer_id")
    .eq("id", input.eventId)
    .maybeSingle();

  if (current.error) {
    log.error("dismissEvent load", { err: current.error });
    return { ok: false, code: "db_error", message: current.error.message };
  }
  if (!current.data) {
    return {
      ok: false,
      code: "event_not_found",
      message: `Evento ${input.eventId} não encontrado.`,
    };
  }

  const row = current.data as {
    id: string;
    dismissed_at: string | null;
    customer_id: string;
  };
  if (row.dismissed_at) {
    return { ok: true, eventId: row.id, alreadyDismissed: true };
  }

  const upd = await supabase
    .from("patient_reliability_events")
    .update({
      dismissed_at: new Date().toISOString(),
      dismissed_by: input.dismissedBy,
      dismissed_reason: reason,
    })
    .eq("id", input.eventId);

  if (upd.error) {
    log.error("dismissEvent update", { err: upd.error });
    return { ok: false, code: "db_error", message: upd.error.message };
  }

  log.info("evento paciente dispensado", {
    event_id: input.eventId,
    customer_id: row.customer_id,
    by: input.dismissedBy,
    reason,
  });

  return { ok: true, eventId: input.eventId, alreadyDismissed: false };
}

// ─── Reads ─────────────────────────────────────────────────────────────

/**
 * Snapshot de confiabilidade do paciente: contagem ativa (não
 * dispensada) na janela + flags derivadas. Retorna null se customer
 * não existir.
 */
export async function getPatientReliabilitySnapshot(
  customerId: string
): Promise<PatientReliabilitySnapshot | null> {
  if (!isUuid(customerId)) return null;

  const supabase = getSupabaseAdmin();

  // Defensivo: valida que o customer existe antes de retornar snapshot.
  const cust = await supabase
    .from("customers")
    .select("id")
    .eq("id", customerId)
    .maybeSingle();
  if (cust.error) {
    log.error("snapshot customer", { err: cust.error });
    return null;
  }
  if (!cust.data) return null;

  const since = new Date(
    Date.now() - PATIENT_RELIABILITY_WINDOW_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const events = await supabase
    .from("patient_reliability_events")
    .select("kind, occurred_at")
    .eq("customer_id", customerId)
    .is("dismissed_at", null)
    .gte("occurred_at", since);

  if (events.error) {
    log.error("snapshot events", { err: events.error });
    return null;
  }

  const rows = (events.data ?? []) as Array<{
    kind: PatientReliabilityKind;
    occurred_at: string;
  }>;
  return computeSnapshotFromEvents(customerId, rows);
}

export type PatientReliabilityEventWithContext = PatientReliabilityEvent & {
  customer_name: string | null;
  appointment_scheduled_at: string | null;
};

/**
 * Lista eventos de 1 paciente (ativos + dispensados), ordenados do
 * mais recente. Sem paginação — volume por paciente é baixo.
 */
export async function listCustomerEvents(
  customerId: string,
  limit = 30
): Promise<PatientReliabilityEvent[]> {
  if (!isUuid(customerId)) return [];
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("patient_reliability_events")
    .select(
      "id, customer_id, appointment_id, kind, occurred_at, notes, dismissed_at, dismissed_by, dismissed_reason, created_at"
    )
    .eq("customer_id", customerId)
    .order("occurred_at", { ascending: false })
    .limit(Math.max(1, Math.min(200, limit)));

  if (error) {
    log.error("listCustomerEvents", { err: error });
    return [];
  }
  return (data ?? []) as PatientReliabilityEvent[];
}

/**
 * Lista eventos recentes de todos pacientes com contexto (nome +
 * scheduled_at do appt), pra overview do admin.
 */
export async function listRecentEvents(
  limit = 50
): Promise<PatientReliabilityEventWithContext[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("patient_reliability_events")
    .select(
      "id, customer_id, appointment_id, kind, occurred_at, notes, dismissed_at, dismissed_by, dismissed_reason, created_at, customers ( name ), appointments ( scheduled_at )"
    )
    .order("occurred_at", { ascending: false })
    .limit(Math.max(1, Math.min(500, limit)));

  if (error) {
    log.error("listRecentEvents", { err: error });
    return [];
  }

  return (data ?? []).map((raw) => {
    const r = raw as unknown as PatientReliabilityEvent & {
      customers?: { name: string | null } | null;
      appointments?: { scheduled_at: string | null } | null;
    };
    return {
      ...r,
      customer_name: r.customers?.name ?? null,
      appointment_scheduled_at: r.appointments?.scheduled_at ?? null,
    };
  });
}

// ─── Labels humanos pra UI ────────────────────────────────────────────

export const PATIENT_RELIABILITY_KIND_LABEL: Record<
  PatientReliabilityKind,
  string
> = {
  no_show_patient: "Não apareceu na consulta",
  reservation_abandoned: "Reserva expirou (não pagou)",
  late_cancel_patient: "Cancelou em cima da hora",
  refund_requested: "Solicitou reembolso pós-consulta",
  manual: "Registro manual do admin",
};
