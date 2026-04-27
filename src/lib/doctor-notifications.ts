/**
 * Worker e enqueue da fila `public.doctor_notifications`.
 *
 * PR-077 · D-089. Gêmeo operacional de `notifications.ts` (que cuida de
 * mensagens **pro paciente**), agora pro lado da **médica**. Server-only;
 * usa service role.
 *
 * Por que existe lib separada
 * ───────────────────────────
 * - Hidratação é diferente: target é `doctors.phone` em vez de
 *   `customers.phone`.
 * - Templates são diferentes (4 helpers novos em `wa-templates.ts`).
 * - 2 dos 4 kinds não amarram a 1 appointment (resumo, plantão), então
 *   o snapshot de body forense (PR-067/D-075) NÃO é replicado aqui.
 *   Mensagens internas têm requisito CFM mais frouxo — ver D-089
 *   pra raciocínio.
 *
 * Filosofia operacional
 * ─────────────────────
 * - `enqueueDoctorNotification` é wrapper tipado sobre RPC
 *   `public.enqueue_doctor_notification`. Idempotente por construção
 *   (3 índices unique parciais na tabela). Retorna id se criou ou
 *   null se conflito (já existia viva).
 * - `processDuePendingDoctor(limit)` é o worker, chamado pelo cron
 *   `wa-reminders` (mesmo schedule, mesma instância) a cada minuto.
 *   Carrega ≤ limit linhas pending vencidas, hidrata cada uma com
 *   `doctors`/`appointments`/`doctor_availability` conforme o anchor,
 *   despacha pro helper correto, e atualiza status sent/failed.
 * - Erro `templates_not_approved` mantém a linha em `pending` (mesmo
 *   padrão de `notifications.ts`), pra re-tentar quando templates
 *   forem aprovados na Meta (PR-077-B).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase";
import { logger } from "./logger";
import type { WhatsAppSendResult } from "@/lib/whatsapp";
import {
  sendMedicaConsultaPaga,
  sendMedicaLinkSala,
  sendMedicaResumoAmanha,
  sendMedicaPlantaoIniciando,
  DOCTOR_KIND_TO_TEMPLATE,
  firstName,
  type DoctorNotificationKind,
} from "@/lib/wa-templates";

const log = logger.with({ mod: "doctor-notifications" });

const PATIENT_CONSULTA_PATH = "/consulta";

function publicBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_BASE_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    "https://institutonovamedida.com.br"
  );
}

function painelMedicaUrl(): string {
  return `${publicBaseUrl()}/medico`;
}

// ─── Enqueue ─────────────────────────────────────────────────────────────

export type EnqueueDoctorInput = {
  doctorId: string;
  kind: DoctorNotificationKind;
  scheduledFor?: Date;
  appointmentId?: string | null;
  availabilityId?: string | null;
  /** YYYY-MM-DD em America/Sao_Paulo (caller que normaliza). */
  summaryDate?: string | null;
  payload?: Record<string, unknown> | null;
};

/**
 * Enfileira uma notificação pra médica. Idempotente via os 3 índices
 * unique parciais na tabela. Retorna o id se inseriu, ou null se já
 * havia viva (ON CONFLICT suprimido).
 */
export async function enqueueDoctorNotification(
  input: EnqueueDoctorInput
): Promise<string | null> {
  if (!input.doctorId) {
    log.warn("enqueue sem doctor_id", { kind: input.kind });
    return null;
  }
  if (
    !input.appointmentId &&
    !input.availabilityId &&
    !input.summaryDate
  ) {
    log.warn("enqueue sem anchor", {
      kind: input.kind,
      doctor_id: input.doctorId,
    });
    return null;
  }

  const supabase = getSupabaseAdmin();
  const template = DOCTOR_KIND_TO_TEMPLATE[input.kind];
  const { data, error } = await supabase.rpc("enqueue_doctor_notification", {
    p_doctor_id: input.doctorId,
    p_kind: input.kind,
    p_scheduled_for: input.scheduledFor?.toISOString() ?? null,
    p_appointment_id: input.appointmentId ?? null,
    p_availability_id: input.availabilityId ?? null,
    p_summary_date: input.summaryDate ?? null,
    p_payload: input.payload ?? null,
    p_template_name: template ?? null,
  });

  if (error) {
    log.error("enqueueDoctorNotification rpc", {
      err: error,
      kind: input.kind,
      doctor_id: input.doctorId,
    });
    return null;
  }
  return (data as string | null) ?? null;
}

/**
 * Helper: enfileira `doctor_t_minus_15min` pra um appointment recém-
 * criado. Calcula scheduled_for = scheduled_at - 15 min.
 *
 * Pula silenciosamente se o disparo já passou (consulta marcada pra
 * daqui a 5 min — não faz sentido enfileirar).
 */
export async function enqueueDoctorAppointmentReminder(
  appointmentId: string,
  doctorId: string,
  scheduledAt: Date
): Promise<string | null> {
  const fireAt = new Date(scheduledAt.getTime() - 15 * 60_000);
  if (fireAt.getTime() < Date.now() - 60_000) {
    return null;
  }
  return enqueueDoctorNotification({
    doctorId,
    kind: "doctor_t_minus_15min",
    appointmentId,
    scheduledFor: fireAt,
  });
}

/**
 * Helper: enfileira `doctor_paid` imediato pra um appointment que
 * acabou de ser ativado pelo webhook Asaas. Disparo é now() — o
 * worker pega no próximo ciclo do cron (≤ 1 min).
 */
export async function enqueueDoctorPaid(
  appointmentId: string,
  doctorId: string,
  payload: { plano_nome?: string; valor_reais?: string } = {}
): Promise<string | null> {
  return enqueueDoctorNotification({
    doctorId,
    kind: "doctor_paid",
    appointmentId,
    payload: {
      plano_nome: payload.plano_nome ?? null,
      valor_reais: payload.valor_reais ?? null,
    },
  });
}

// ─── Worker ──────────────────────────────────────────────────────────────

type DoctorRow = {
  id: string;
  full_name: string;
  display_name: string | null;
  phone: string;
};

type ApptHydrated = {
  id: string;
  scheduled_at: string;
  scheduled_until: string | null;
  customers: { name: string | null } | null;
};

type AvailabilityHydrated = {
  id: string;
  weekday: number;
  start_time: string;
  end_time: string;
};

type DoctorNotificationRow = {
  id: string;
  doctor_id: string;
  appointment_id: string | null;
  availability_id: string | null;
  summary_date: string | null;
  kind: string;
  template_name: string | null;
  scheduled_for: string;
  payload: Record<string, unknown> | null;
};

async function loadDueDoctorNotifications(
  supabase: SupabaseClient,
  limit: number
): Promise<DoctorNotificationRow[]> {
  const { data, error } = await supabase
    .from("doctor_notifications")
    .select(
      "id, doctor_id, appointment_id, availability_id, summary_date, kind, template_name, scheduled_for, payload"
    )
    .eq("status", "pending")
    .eq("channel", "whatsapp")
    .lte("scheduled_for", new Date().toISOString())
    .order("scheduled_for", { ascending: true })
    .limit(limit);

  if (error) {
    log.error("loadDueDoctorNotifications", { err: error });
    return [];
  }
  return (data ?? []) as DoctorNotificationRow[];
}

async function loadDoctor(
  supabase: SupabaseClient,
  doctorId: string
): Promise<DoctorRow | null> {
  const { data, error } = await supabase
    .from("doctors")
    .select("id, full_name, display_name, phone")
    .eq("id", doctorId)
    .maybeSingle();
  if (error) {
    log.warn("loadDoctor", { err: error, doctor_id: doctorId });
    return null;
  }
  return (data as DoctorRow | null) ?? null;
}

async function loadAppt(
  supabase: SupabaseClient,
  appointmentId: string
): Promise<ApptHydrated | null> {
  const { data, error } = await supabase
    .from("appointments")
    .select(
      "id, scheduled_at, scheduled_until, customers ( name )"
    )
    .eq("id", appointmentId)
    .maybeSingle();
  if (error) {
    log.warn("loadAppt", { err: error, appointment_id: appointmentId });
    return null;
  }
  if (!data) return null;
  const row = data as ApptHydrated & {
    customers: ApptHydrated["customers"] | ApptHydrated["customers"][];
  };
  const customers = Array.isArray(row.customers)
    ? row.customers[0] ?? null
    : row.customers;
  return { ...row, customers } as ApptHydrated;
}

async function loadAvailability(
  supabase: SupabaseClient,
  availabilityId: string
): Promise<AvailabilityHydrated | null> {
  const { data, error } = await supabase
    .from("doctor_availability")
    .select("id, weekday, start_time, end_time")
    .eq("id", availabilityId)
    .maybeSingle();
  if (error) {
    log.warn("loadAvailability", { err: error, id: availabilityId });
    return null;
  }
  return (data as AvailabilityHydrated | null) ?? null;
}

export type DoctorDispatchOutcome =
  | { ok: true; messageId: string; note?: string }
  | { ok: false; retry: boolean; reason: string; code?: number | null };

async function dispatch(
  supabase: SupabaseClient,
  row: DoctorNotificationRow
): Promise<DoctorDispatchOutcome> {
  const doctor = await loadDoctor(supabase, row.doctor_id);
  if (!doctor) {
    return { ok: false, retry: false, reason: "doctor_missing" };
  }
  if (!doctor.phone) {
    return { ok: false, retry: false, reason: "doctor_phone_missing" };
  }
  const doctorNome = doctor.display_name || doctor.full_name || "Médica";
  const painel = painelMedicaUrl();

  let result: WhatsAppSendResult;

  switch (row.kind as DoctorNotificationKind) {
    case "doctor_paid": {
      if (!row.appointment_id) {
        return { ok: false, retry: false, reason: "appointment_id_missing" };
      }
      const appt = await loadAppt(supabase, row.appointment_id);
      if (!appt) {
        return { ok: false, retry: false, reason: "appointment_missing" };
      }
      const payload = (row.payload ?? {}) as {
        plano_nome?: string;
        valor_reais?: string;
      };
      result = await sendMedicaConsultaPaga({
        to: doctor.phone,
        doctorNome,
        pacienteFirstName: firstName(appt.customers?.name ?? ""),
        consultaDateTime: new Date(appt.scheduled_at),
        valorReais: payload.valor_reais ?? "—",
        painelUrl: painel,
      });
      break;
    }
    case "doctor_t_minus_15min": {
      if (!row.appointment_id) {
        return { ok: false, retry: false, reason: "appointment_id_missing" };
      }
      const appt = await loadAppt(supabase, row.appointment_id);
      if (!appt) {
        return { ok: false, retry: false, reason: "appointment_missing" };
      }
      const consultaUrl = `${publicBaseUrl()}${PATIENT_CONSULTA_PATH}/${appt.id}`;
      const scheduledAt = new Date(appt.scheduled_at);
      const validaAte = appt.scheduled_until
        ? new Date(appt.scheduled_until)
        : new Date(scheduledAt.getTime() + 30 * 60_000);
      result = await sendMedicaLinkSala({
        to: doctor.phone,
        doctorNome,
        pacienteFirstName: firstName(appt.customers?.name ?? ""),
        consultaUrl,
        salaValidaAte: validaAte,
      });
      break;
    }
    case "doctor_daily_summary": {
      const payload = (row.payload ?? {}) as {
        total_consultas?: number;
        primeiro_horario?: string;
        ultimo_horario?: string;
      };
      result = await sendMedicaResumoAmanha({
        to: doctor.phone,
        doctorNome,
        totalConsultas: payload.total_consultas ?? 0,
        primeiroHorario: payload.primeiro_horario ?? "—",
        ultimoHorario: payload.ultimo_horario ?? "—",
        painelUrl: `${painel}/agenda`,
      });
      break;
    }
    case "doctor_on_call_t_minus_15min": {
      if (!row.availability_id) {
        return { ok: false, retry: false, reason: "availability_id_missing" };
      }
      const avail = await loadAvailability(supabase, row.availability_id);
      if (!avail) {
        return { ok: false, retry: false, reason: "availability_missing" };
      }
      const scheduledFor = new Date(row.scheduled_for);
      // shift starts 15 min after scheduled_for (which was set as
      // start_minus_15min on enqueue)
      const shiftStart = new Date(scheduledFor.getTime() + 15 * 60_000);
      // Compute shiftEnd: replace the time portion of shiftStart with end_time
      const shiftEnd = combineDateAndTime(shiftStart, avail.end_time);
      result = await sendMedicaPlantaoIniciando({
        to: doctor.phone,
        doctorNome,
        shiftStart,
        shiftEnd,
        painelUrl: `${painel}/horarios`,
      });
      break;
    }
    default:
      return {
        ok: false,
        retry: false,
        reason: `unknown_kind:${row.kind}`,
      };
  }

  if (result.ok) {
    return { ok: true, messageId: result.messageId };
  }
  if (result.message === "templates_not_approved") {
    return {
      ok: false,
      retry: true,
      reason: "templates_not_approved",
      code: null,
    };
  }
  return {
    ok: false,
    retry: false,
    reason: result.details || result.message || "send_failed",
    code: result.code,
  };
}

/**
 * Combina a data de `base` com o horário "HH:MM:SS" mantendo o
 * fuso horário local da instância (server roda America/Sao_Paulo
 * em prod). Usado pra calcular fim do plantão a partir do início.
 *
 * Nota: simplificação consciente — não considera DST. Em America/
 * Sao_Paulo o DST foi abolido em 2019, então é seguro.
 */
function combineDateAndTime(base: Date, timeStr: string): Date {
  const [h, m, s] = timeStr.split(":").map((v) => Number.parseInt(v, 10));
  const out = new Date(base);
  out.setHours(
    Number.isFinite(h) ? h : 0,
    Number.isFinite(m) ? m : 0,
    Number.isFinite(s) ? s : 0,
    0
  );
  return out;
}

export type DoctorProcessReport = {
  processed: number;
  sent: number;
  failed: number;
  retried: number;
  details: Array<{
    id: string;
    doctor_id: string;
    kind: string;
    outcome: "sent" | "failed" | "retried";
    reason?: string;
    message_id?: string;
  }>;
};

export async function processDuePendingDoctor(
  limit = 20
): Promise<DoctorProcessReport> {
  const supabase = getSupabaseAdmin();
  const rows = await loadDueDoctorNotifications(supabase, limit);

  const report: DoctorProcessReport = {
    processed: rows.length,
    sent: 0,
    failed: 0,
    retried: 0,
    details: [],
  };

  for (const row of rows) {
    const outcome = await dispatch(supabase, row);

    if (outcome.ok) {
      // Salva também target_phone pra debug/forense leve, mas sem
      // body snapshot (conforme D-089).
      const doctor = await loadDoctor(supabase, row.doctor_id);
      await supabase
        .from("doctor_notifications")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          message_id: outcome.messageId,
          target_phone: doctor?.phone ?? null,
          error: null,
        })
        .eq("id", row.id);

      report.sent += 1;
      report.details.push({
        id: row.id,
        doctor_id: row.doctor_id,
        kind: row.kind,
        outcome: "sent",
        message_id: outcome.messageId,
      });
      continue;
    }

    if (outcome.retry) {
      await supabase
        .from("doctor_notifications")
        .update({ error: outcome.reason })
        .eq("id", row.id);

      report.retried += 1;
      report.details.push({
        id: row.id,
        doctor_id: row.doctor_id,
        kind: row.kind,
        outcome: "retried",
        reason: outcome.reason,
      });
      continue;
    }

    await supabase
      .from("doctor_notifications")
      .update({
        status: "failed",
        error: outcome.reason,
      })
      .eq("id", row.id);

    report.failed += 1;
    report.details.push({
      id: row.id,
      doctor_id: row.doctor_id,
      kind: row.kind,
      outcome: "failed",
      reason: outcome.reason,
    });
  }

  return report;
}

// ─── Helpers de cron (resumo + plantão) ─────────────────────────────────

/**
 * YYYY-MM-DD do dia *seguinte* em America/Sao_Paulo. Usado pro
 * cron de resumo (`doctor_daily_summary`).
 */
export function tomorrowSPDateString(now: Date = new Date()): string {
  const sp = new Date(
    now.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" })
  );
  sp.setDate(sp.getDate() + 1);
  const y = sp.getFullYear();
  const m = String(sp.getMonth() + 1).padStart(2, "0");
  const d = String(sp.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

