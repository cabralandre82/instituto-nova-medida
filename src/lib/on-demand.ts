/**
 * src/lib/on-demand.ts — PR-079 · D-091
 *
 * Backend de atendimento on-demand (server-only).
 *
 * Componentes
 * ───────────
 *   - createOnDemandRequest({ customerId, chiefComplaint, ttlSeconds? })
 *     RPC `create_on_demand_request`. Idempotente por customer
 *     (1 pending por vez).
 *
 *   - fanOutToOnlineDoctors({ requestId, baseUrl, ttlSeconds })
 *     Procura médicas elegíveis (presença fresh + status ≠ offline,
 *     opcionalmente restringe a quem está em bloco `on_call` agora),
 *     envia WhatsApp em paralelo via wa-templates.ts, registra
 *     dispatches em `on_demand_request_dispatches`. Idempotente
 *     via unique (request_id, doctor_id).
 *
 *   - acceptOnDemandRequest({ requestId, doctorId, durationMinutes? })
 *     RPC `accept_on_demand_request`. Atomic: cria appointment
 *     kind=on_demand status=scheduled E marca request accepted.
 *     Race-safe (única médica vence).
 *
 *   - cancelOnDemandRequest({ requestId, actorKind, reason? })
 *     RPC `cancel_on_demand_request`. Idempotente.
 *
 *   - expireStaleRequests({ limit? })
 *     Sweep do cron. Marca expired pending vencidos.
 *
 *   - listPendingForCustomer(customerId)
 *     Lê o pending atual do paciente (pra UI mostrar "esperando
 *     atendimento — ⏱ 02:34"). Retorna null se nenhum.
 *
 * Decisões
 * ────────
 *  - Fan-out síncrono (não via fila `doctor_notifications`).
 *    Latência de cron de 60s seria fatal pro produto. Trade-off:
 *    sem retry automático — se Meta WA falhar pra uma médica,
 *    perdemos esse disparo. Mitigação: paciente vê "aguardando" e
 *    ainda há outras médicas no fan-out + pode cancelar e
 *    re-solicitar.
 *  - `MAX_FANOUT_DOCTORS = 10` por sanidade (em produção MVP é 1-2).
 *  - `STALE_PRESENCE_THRESHOLD_SECONDS` reusado de doctor-presence
 *    pra coerência: presença "fresh" tem mesma definição em todo
 *    lugar.
 *  - WA dispatch via `Promise.allSettled` em paralelo (rejeição numa
 *    médica não bloqueia outras). Cada outcome vira 1 row de
 *    dispatch.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase";
import { logger } from "./logger";
import {
  STALE_PRESENCE_THRESHOLD_SECONDS,
  type PresenceRow,
} from "./doctor-presence";
import {
  sendMedicaOnDemandRequest,
  firstName,
} from "./wa-templates";
import type { WhatsAppSendResult } from "./whatsapp";
import { sanitizeFreeText } from "./text-sanitize";
import { isOnCallNow } from "./admin-appointments";

const log = logger.with({ mod: "on-demand" });

/** TTL default do request (5 minutos). Valor exposto pra UI mostrar. */
export const ON_DEMAND_DEFAULT_TTL_SECONDS = 300;

/** Limite de fan-out paralelo. */
export const MAX_FANOUT_DOCTORS = 10;

export type OnDemandStatus =
  | "pending"
  | "accepted"
  | "cancelled"
  | "expired";

export type OnDemandRequestRow = {
  id: string;
  customer_id: string;
  status: OnDemandStatus;
  expires_at: string;
  created_at: string;
  updated_at: string;
  chief_complaint: string;
  accepted_at: string | null;
  accepted_doctor_id: string | null;
  accepted_appointment_id: string | null;
  cancelled_at: string | null;
  cancelled_reason: string | null;
  cancelled_by_kind: string | null;
};

// ─── Helpers puros (testáveis sem IO) ───────────────────────────────────

/**
 * Computa quanto tempo falta (em segundos) pra um request expirar.
 * Negativo se já expirou. Usado pela UI pra mostrar countdown.
 */
export function computeSecondsUntilExpiry(input: {
  expiresAt: Date | string;
  now?: Date;
}): number {
  const expires = typeof input.expiresAt === "string"
    ? new Date(input.expiresAt)
    : input.expiresAt;
  if (Number.isNaN(expires.getTime())) return -1;
  const now = input.now ?? new Date();
  return Math.floor((expires.getTime() - now.getTime()) / 1000);
}

/**
 * Decide se uma presença é "fresh" pro fan-out: status ≠ offline E
 * heartbeat ≤ STALE_PRESENCE_THRESHOLD_SECONDS atrás.
 */
export function isPresenceEligible(
  presence: { status: string; last_heartbeat_at: string },
  now: Date = new Date()
): boolean {
  if (presence.status === "offline") return false;
  const last = new Date(presence.last_heartbeat_at);
  if (Number.isNaN(last.getTime())) return false;
  const ageSec = (now.getTime() - last.getTime()) / 1000;
  return ageSec <= STALE_PRESENCE_THRESHOLD_SECONDS;
}

/**
 * Trunca chief complaint pro template WA (≤ 120 chars).
 * Replace newlines com espaço pra evitar quebras de layout.
 */
export function truncateChiefComplaintForWa(s: string): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  if (oneLine.length <= 120) return oneLine;
  return oneLine.slice(0, 117) + "…";
}

// ─── Validação de input ─────────────────────────────────────────────────

export type CreateRequestInput = {
  customerId: string;
  chiefComplaint: string;
  ttlSeconds?: number;
};

export type CreateRequestResult =
  | { ok: true; requestId: string; isNew: boolean }
  | {
      ok: false;
      error:
        | "customer_id_required"
        | "chief_complaint_too_short"
        | "chief_complaint_too_long"
        | "control_chars"
        | "db_error";
    };

export async function createOnDemandRequest(
  input: CreateRequestInput
): Promise<CreateRequestResult> {
  if (!input.customerId) {
    return { ok: false, error: "customer_id_required" };
  }
  const sanitized = sanitizeFreeText(input.chiefComplaint, {
    maxLen: 500,
    minLen: 4,
  });
  if (!sanitized.ok) {
    if (sanitized.reason === "too_long") {
      return { ok: false, error: "chief_complaint_too_long" };
    }
    if (sanitized.reason === "control_chars") {
      return { ok: false, error: "control_chars" };
    }
    return { ok: false, error: "chief_complaint_too_short" };
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("create_on_demand_request", {
    p_customer_id: input.customerId,
    p_chief_complaint: sanitized.value,
    p_ttl_seconds: input.ttlSeconds ?? ON_DEMAND_DEFAULT_TTL_SECONDS,
  });
  if (error) {
    log.error("createOnDemandRequest rpc", {
      err: error,
      customer_id: input.customerId,
    });
    return { ok: false, error: "db_error" };
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") {
    return { ok: false, error: "db_error" };
  }
  return {
    ok: true,
    requestId: (row as { request_id: string }).request_id,
    isNew: Boolean((row as { is_new: boolean }).is_new),
  };
}

// ─── Lookup ─────────────────────────────────────────────────────────────

export async function getRequestById(
  requestId: string
): Promise<OnDemandRequestRow | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("on_demand_requests")
    .select(
      "id, customer_id, status, expires_at, created_at, updated_at, chief_complaint, accepted_at, accepted_doctor_id, accepted_appointment_id, cancelled_at, cancelled_reason, cancelled_by_kind"
    )
    .eq("id", requestId)
    .maybeSingle();
  if (error) {
    log.error("getRequestById", { err: error, request_id: requestId });
    return null;
  }
  return (data as OnDemandRequestRow | null) ?? null;
}

export async function listPendingForCustomer(
  customerId: string
): Promise<OnDemandRequestRow | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("on_demand_requests")
    .select(
      "id, customer_id, status, expires_at, created_at, updated_at, chief_complaint, accepted_at, accepted_doctor_id, accepted_appointment_id, cancelled_at, cancelled_reason, cancelled_by_kind"
    )
    .eq("customer_id", customerId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    log.error("listPendingForCustomer", { err: error, customer_id: customerId });
    return null;
  }
  return (data as OnDemandRequestRow | null) ?? null;
}

// ─── Fan-out ────────────────────────────────────────────────────────────

type DoctorContact = {
  id: string;
  full_name: string;
  display_name: string | null;
  phone: string;
};

type AvailabilityBlock = {
  doctor_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
};

export type FanOutReport = {
  candidatesConsidered: number;
  candidatesEligible: number;
  dispatched: number;
  failed: number;
  skipped: number;
  details: Array<{
    doctor_id: string;
    outcome: "sent" | "failed" | "skipped";
    reason?: string;
    wa_message_id?: string;
    on_call: boolean;
  }>;
};

export type FanOutInput = {
  requestId: string;
  baseUrl: string;
  /** Sobrescrever pra testes; default: now() */
  now?: Date;
  /** Se true, só fan-out pra médicas em bloco on_call ativo. Default: false. */
  requireOnCall?: boolean;
};

/**
 * Procura médicas online + envia WA + grava dispatches. Síncrono.
 *
 * Por que NÃO via fila `doctor_notifications`:
 *   - Latência: cron de 60s + processamento = ~2min até WA chegar.
 *     On-demand requer ≤ 30s pra ser viável.
 *   - Idempotência: a tabela tem unique parcial (request_id, doctor_id)
 *     que garante que retry chama mas não duplica.
 */
export async function fanOutToOnlineDoctors(
  input: FanOutInput
): Promise<FanOutReport> {
  const supabase = getSupabaseAdmin();
  const now = input.now ?? new Date();
  const report: FanOutReport = {
    candidatesConsidered: 0,
    candidatesEligible: 0,
    dispatched: 0,
    failed: 0,
    skipped: 0,
    details: [],
  };

  // 1. Carrega request (pra TTL + chief_complaint + customer name).
  const request = await getRequestById(input.requestId);
  if (!request) {
    log.warn("fanOut: request not found", { request_id: input.requestId });
    return report;
  }
  if (request.status !== "pending") {
    log.info("fanOut: request not pending, skipping", {
      request_id: input.requestId,
      status: request.status,
    });
    return report;
  }

  const ttlSec = computeSecondsUntilExpiry({
    expiresAt: request.expires_at,
    now,
  });
  if (ttlSec <= 0) {
    log.info("fanOut: request already expired", {
      request_id: input.requestId,
    });
    return report;
  }
  const ttlMinutes = Math.max(1, Math.ceil(ttlSec / 60));

  // 2. Busca paciente (firstName).
  const customerRes = await supabase
    .from("customers")
    .select("name")
    .eq("id", request.customer_id)
    .maybeSingle();
  const pacienteFirstName = firstName(
    (customerRes.data as { name?: string } | null)?.name ?? ""
  );

  // 3. Busca todas as presence rows online + busy.
  const presenceRes = await supabase
    .from("doctor_presence")
    .select("doctor_id, status, last_heartbeat_at")
    .neq("status", "offline");
  if (presenceRes.error) {
    log.error("fanOut: presence query", { err: presenceRes.error });
    return report;
  }
  const presenceRows = (presenceRes.data ?? []) as Array<
    Pick<PresenceRow, "doctor_id" | "status" | "last_heartbeat_at">
  >;
  const eligibleDoctorIds = presenceRows
    .filter((p) => isPresenceEligible(p, now))
    .filter((p) => p.status === "online") // busy = em consulta, não chama
    .map((p) => p.doctor_id);

  report.candidatesConsidered = presenceRows.length;
  if (eligibleDoctorIds.length === 0) {
    return report;
  }

  // 4. Carrega blocos on_call (pra contexto + opção requireOnCall).
  const availRes = await supabase
    .from("doctor_availability")
    .select("doctor_id, weekday, start_time, end_time")
    .in("doctor_id", eligibleDoctorIds)
    .eq("active", true)
    .eq("type", "on_call");
  const blocks = (availRes.data ?? []) as AvailabilityBlock[];
  const onCallByDoctor = new Map<string, boolean>();
  for (const id of eligibleDoctorIds) onCallByDoctor.set(id, false);
  for (const b of blocks) {
    if (
      isOnCallNow({
        weekday: b.weekday,
        startTime: b.start_time,
        endTime: b.end_time,
        now,
      })
    ) {
      onCallByDoctor.set(b.doctor_id, true);
    }
  }

  let candidates = eligibleDoctorIds;
  if (input.requireOnCall) {
    candidates = candidates.filter((id) => onCallByDoctor.get(id) === true);
  }
  candidates = candidates.slice(0, MAX_FANOUT_DOCTORS);
  report.candidatesEligible = candidates.length;

  if (candidates.length === 0) {
    return report;
  }

  // 5. Hidrata contato das médicas elegíveis.
  const doctorsRes = await supabase
    .from("doctors")
    .select("id, full_name, display_name, phone")
    .in("id", candidates);
  const doctors = (doctorsRes.data ?? []) as DoctorContact[];

  const chiefShort = truncateChiefComplaintForWa(request.chief_complaint);

  // 6. Dispara WA em paralelo.
  const results = await Promise.allSettled(
    doctors.map(async (d) => {
      const acceptUrl = `${input.baseUrl}/medico/plantao/${input.requestId}`;
      const onCall = onCallByDoctor.get(d.id) === true;
      const result: WhatsAppSendResult = await sendMedicaOnDemandRequest({
        to: d.phone,
        doctorNome: d.display_name || d.full_name,
        pacienteFirstName,
        chiefComplaintShort: chiefShort,
        acceptUrl,
        ttlMinutes,
      });
      return { doctor: d, result, onCall };
    })
  );

  // 7. Grava dispatches.
  type DispatchRow = {
    request_id: string;
    doctor_id: string;
    dispatch_status: "sent" | "failed" | "skipped";
    wa_message_id: string | null;
    error: string | null;
    doctor_was_online: boolean;
    doctor_was_on_call: boolean;
  };
  const dispatchRows: DispatchRow[] = [];

  for (const settled of results) {
    if (settled.status === "rejected") {
      report.failed += 1;
      report.details.push({
        doctor_id: "unknown",
        outcome: "failed",
        reason: String(settled.reason ?? "unknown"),
        on_call: false,
      });
      continue;
    }
    const { doctor, result, onCall } = settled.value;
    if (result.ok) {
      report.dispatched += 1;
      report.details.push({
        doctor_id: doctor.id,
        outcome: "sent",
        wa_message_id: result.messageId,
        on_call: onCall,
      });
      dispatchRows.push({
        request_id: input.requestId,
        doctor_id: doctor.id,
        dispatch_status: "sent",
        wa_message_id: result.messageId,
        error: null,
        doctor_was_online: true,
        doctor_was_on_call: onCall,
      });
    } else {
      // `templates_not_approved` é "skipped" (não conta como falha
      // operacional — quando templates aprovarem, fan-out funciona).
      const isStub = result.message === "templates_not_approved";
      const outcome: "failed" | "skipped" = isStub ? "skipped" : "failed";
      if (isStub) report.skipped += 1;
      else report.failed += 1;
      report.details.push({
        doctor_id: doctor.id,
        outcome,
        reason: result.details ?? result.message ?? undefined,
        on_call: onCall,
      });
      dispatchRows.push({
        request_id: input.requestId,
        doctor_id: doctor.id,
        dispatch_status: outcome,
        wa_message_id: null,
        error: (result.details ?? result.message ?? "").slice(0, 500),
        doctor_was_online: true,
        doctor_was_on_call: onCall,
      });
    }
  }

  if (dispatchRows.length > 0) {
    // upsert idempotente: ON CONFLICT (request_id, doctor_id) DO NOTHING
    // não disponível direto; usamos insert + ignore via try/catch
    // por linha pra não falhar tudo se uma colidir.
    const { error: insertErr } = await supabase
      .from("on_demand_request_dispatches")
      .upsert(dispatchRows, {
        onConflict: "request_id,doctor_id",
        ignoreDuplicates: true,
      });
    if (insertErr) {
      log.warn("fanOut: dispatches upsert", { err: insertErr });
    }
  }

  return report;
}

// ─── Accept ─────────────────────────────────────────────────────────────

export type AcceptResult =
  | { ok: true; appointmentId: string }
  | {
      ok: false;
      reason:
        | "not_found"
        | "expired"
        | "already_accepted"
        | "already_cancelled"
        | "already_expired"
        | "validation"
        | "db_error";
    };

export type AcceptInput = {
  requestId: string;
  doctorId: string;
  durationMinutes?: number;
  recordingConsent?: boolean;
};

export async function acceptOnDemandRequest(
  input: AcceptInput
): Promise<AcceptResult> {
  if (!input.requestId || !input.doctorId) {
    return { ok: false, reason: "validation" };
  }
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("accept_on_demand_request", {
    p_request_id: input.requestId,
    p_doctor_id: input.doctorId,
    p_duration_minutes: input.durationMinutes ?? 30,
    p_recording_consent: input.recordingConsent ?? false,
  });
  if (error) {
    log.error("acceptOnDemandRequest rpc", {
      err: error,
      request_id: input.requestId,
      doctor_id: input.doctorId,
    });
    return { ok: false, reason: "db_error" };
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") {
    return { ok: false, reason: "db_error" };
  }
  const r = row as {
    accepted: boolean;
    appointment_id: string | null;
    reason: string | null;
  };
  if (r.accepted && r.appointment_id) {
    return { ok: true, appointmentId: r.appointment_id };
  }
  const reason = r.reason ?? "db_error";
  if (
    reason === "not_found" ||
    reason === "expired" ||
    reason === "already_accepted" ||
    reason === "already_cancelled" ||
    reason === "already_expired"
  ) {
    return { ok: false, reason };
  }
  return { ok: false, reason: "db_error" };
}

// ─── Cancel ─────────────────────────────────────────────────────────────

export type CancelResult =
  | { ok: true; alreadyCancelled: boolean }
  | {
      ok: false;
      reason:
        | "not_found"
        | "validation"
        | "cannot_cancel_accepted"
        | "cannot_cancel_expired"
        | "db_error";
    };

export type CancelInput = {
  requestId: string;
  actorKind: "patient" | "admin" | "system";
  reason?: string;
};

export async function cancelOnDemandRequest(
  input: CancelInput
): Promise<CancelResult> {
  if (!input.requestId) return { ok: false, reason: "validation" };
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("cancel_on_demand_request", {
    p_request_id: input.requestId,
    p_actor_kind: input.actorKind,
    p_reason: input.reason ?? null,
  });
  if (error) {
    log.error("cancelOnDemandRequest rpc", {
      err: error,
      request_id: input.requestId,
    });
    return { ok: false, reason: "db_error" };
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") {
    return { ok: false, reason: "db_error" };
  }
  const r = row as { cancelled: boolean; reason: string | null };
  if (r.cancelled) {
    return { ok: true, alreadyCancelled: r.reason === "already_cancelled" };
  }
  if (r.reason === "not_found") return { ok: false, reason: "not_found" };
  if (r.reason === "cannot_cancel_accepted") {
    return { ok: false, reason: "cannot_cancel_accepted" };
  }
  if (r.reason === "cannot_cancel_expired") {
    return { ok: false, reason: "cannot_cancel_expired" };
  }
  return { ok: false, reason: "db_error" };
}

// ─── Expire sweep (cron) ────────────────────────────────────────────────

export type ExpireSweepReport = {
  expiredCount: number;
};

export async function expireStaleRequests(opts: {
  limit?: number;
  supabase?: SupabaseClient;
} = {}): Promise<ExpireSweepReport> {
  const supabase = opts.supabase ?? getSupabaseAdmin();
  const { data, error } = await supabase.rpc(
    "expire_stale_on_demand_requests",
    { p_limit: opts.limit ?? 200 }
  );
  if (error) {
    log.error("expireStaleRequests rpc", { err: error });
    return { expiredCount: 0 };
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") return { expiredCount: 0 };
  return {
    expiredCount: Number((row as { expired_count: number }).expired_count) || 0,
  };
}
