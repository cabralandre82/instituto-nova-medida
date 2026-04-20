/**
 * Worker e enqueue da fila `appointment_notifications`.
 *
 * Server-only. Usa service role pra ler/escrever em RLS.
 *
 * Fluxo:
 *   1. Quando o webhook do Asaas ativa um appointment (D-027), chamamos
 *      `scheduleRemindersForAppointment(appointmentId)` — enfileira os 4
 *      lembretes temporais (T-24h, T-1h, T-15min, T+10min) via RPC
 *      `schedule_appointment_notifications()` (migration 011).
 *   2. Ao mesmo tempo, disparamos `enqueueImmediate(appointmentId,
 *      'confirmacao')` pra mandar a confirmação na hora.
 *   3. O cron `/api/internal/cron/wa-reminders` roda a cada 1 min e
 *      chama `processDuePending(limit)` — pega todas as notifs com
 *      `scheduled_for <= now()` e `status='pending'`, hidrata cada
 *      uma com dados do appointment/customer, despacha pro helper
 *      correto em `wa-templates.ts`, e atualiza `status` pra `sent` ou
 *      `failed` conforme resultado.
 *
 * Robustez:
 *   - Worker processa no máximo `limit` linhas por execução (default 20)
 *     pra caber dentro do `maxDuration` do Vercel (30s).
 *   - Cada disparo é independente — falha em 1 não bloqueia as outras.
 *   - Erro `templates_not_approved` mantém a linha em `pending` (não
 *     marca failed), pra re-tentar no minuto seguinte caso a Meta tenha
 *     aprovado nesse meio tempo.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase";
import type { WhatsAppSendResult } from "@/lib/whatsapp";
import {
  sendConfirmacaoAgendamento,
  sendLembrete24h,
  sendLembrete1h,
  sendLinkSala,
  sendPosConsultaResumo,
  sendPagamentoPixPendente,
  sendNoShowPatient,
  sendNoShowDoctor,
  KIND_TO_TEMPLATE,
  type NotificationKind,
} from "@/lib/wa-templates";

const PATIENT_CONSULTA_PATH = "/consulta";

function publicBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_BASE_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    "https://institutonovamedida.com.br"
  );
}

// ─── Enqueue helpers ─────────────────────────────────────────────────────

export type ScheduleResult = {
  appointmentId: string;
  scheduled: Array<{ kind: string; scheduled_for: string; created: boolean }>;
};

/**
 * Enfileira os 4 lembretes temporais padrão para um appointment recém-ativado.
 * Idempotente — chamar duas vezes no mesmo appointment não duplica.
 */
export async function scheduleRemindersForAppointment(
  appointmentId: string
): Promise<ScheduleResult> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("schedule_appointment_notifications", {
    p_appointment_id: appointmentId,
  });
  if (error) {
    console.error("[notifications] schedule rpc:", error);
    return { appointmentId, scheduled: [] };
  }
  return {
    appointmentId,
    scheduled: (data ?? []) as Array<{
      kind: string;
      scheduled_for: string;
      created: boolean;
    }>,
  };
}

/**
 * Enfileira uma notificação isolada (ex: confirmacao imediata, pos_consulta,
 * reserva_expirada). Idempotente: se já existir uma "viva" do mesmo kind
 * pro mesmo appointment, retorna null.
 */
export async function enqueueImmediate(
  appointmentId: string,
  kind: NotificationKind,
  opts: { payload?: Record<string, unknown>; scheduledFor?: Date } = {}
): Promise<string | null> {
  const supabase = getSupabaseAdmin();
  const template = KIND_TO_TEMPLATE[kind];
  const { data, error } = await supabase.rpc("enqueue_appointment_notification", {
    p_appointment_id: appointmentId,
    p_kind: kind,
    p_template_name: template ?? null,
    p_scheduled_for: opts.scheduledFor ? opts.scheduledFor.toISOString() : null,
    p_payload: opts.payload ?? null,
  });
  if (error) {
    console.error("[notifications] enqueue rpc:", error);
    return null;
  }
  return (data as string | null) ?? null;
}

// ─── Worker ──────────────────────────────────────────────────────────────

type NotificationRow = {
  id: string;
  appointment_id: string;
  kind: string;
  template_name: string | null;
  scheduled_for: string | null;
  payload: Record<string, unknown> | null;
  appointments: {
    id: string;
    scheduled_at: string;
    scheduled_until: string | null;
    doctor_id: string;
    status: string;
    customers: { name: string; phone: string } | null;
    doctors: { display_name: string | null; full_name: string } | null;
  } | null;
};

async function loadDueNotifications(
  supabase: SupabaseClient,
  limit: number
): Promise<NotificationRow[]> {
  const { data, error } = await supabase
    .from("appointment_notifications")
    .select(
      "id, appointment_id, kind, template_name, scheduled_for, payload, appointments ( id, scheduled_at, scheduled_until, doctor_id, status, customers ( name, phone ), doctors ( display_name, full_name ) )"
    )
    .eq("status", "pending")
    .eq("channel", "whatsapp")
    .lte("scheduled_for", new Date().toISOString())
    .order("scheduled_for", { ascending: true })
    .limit(limit);

  if (error) {
    console.error("[notifications] loadDueNotifications:", error);
    return [];
  }
  return (data ?? []) as unknown as NotificationRow[];
}

export type DispatchOutcome =
  | { ok: true; messageId: string; note?: string }
  | { ok: false; retry: boolean; reason: string; code?: number | null };

/**
 * Despacha UMA notificação pro helper correto. Sem side-effects no DB —
 * o caller é responsável por marcar sent/failed.
 */
async function dispatch(row: NotificationRow): Promise<DispatchOutcome> {
  const appt = row.appointments;
  if (!appt) {
    return { ok: false, retry: false, reason: "appointment_missing" };
  }
  const customer = appt.customers;
  if (!customer?.phone) {
    return { ok: false, retry: false, reason: "customer_phone_missing" };
  }
  const doctorDisplay =
    appt.doctors?.display_name || appt.doctors?.full_name || "Médica";
  const scheduledAt = new Date(appt.scheduled_at);
  const consultaUrl = `${publicBaseUrl()}${PATIENT_CONSULTA_PATH}/${appt.id}`;
  const reagendamentoUrl = consultaUrl;
  const salaValidaAte = appt.scheduled_until
    ? new Date(appt.scheduled_until)
    : new Date(scheduledAt.getTime() + 30 * 60_000);

  let result: WhatsAppSendResult;

  switch (row.kind as NotificationKind) {
    case "confirmacao":
      result = await sendConfirmacaoAgendamento({
        to: customer.phone,
        pacienteNome: customer.name,
        consultaDateTime: scheduledAt,
        doctorDisplay,
        reagendamentoUrl,
      });
      break;
    case "t_minus_24h":
      result = await sendLembrete24h({
        to: customer.phone,
        pacienteNome: customer.name,
        consultaDateTime: scheduledAt,
        doctorDisplay,
      });
      break;
    case "t_minus_1h":
      result = await sendLembrete1h({
        to: customer.phone,
        pacienteNome: customer.name,
        consultaDateTime: scheduledAt,
      });
      break;
    case "t_minus_15min":
      result = await sendLinkSala({
        to: customer.phone,
        pacienteNome: customer.name,
        consultaUrl,
        salaValidaAte,
      });
      break;
    case "t_plus_10min":
    case "pos_consulta": {
      const payload = (row.payload ?? {}) as {
        receita_url?: string;
        conduta_resumo?: string;
      };
      result = await sendPosConsultaResumo({
        to: customer.phone,
        pacienteNome: customer.name,
        receitaUrl: payload.receita_url ?? consultaUrl,
        condutaResumo:
          payload.conduta_resumo ??
          "Sua médica registrou a conduta. Qualquer dúvida, é só responder aqui.",
      });
      break;
    }
    case "reserva_expirada": {
      const payload = (row.payload ?? {}) as {
        plano_nome?: string;
        invoice_url?: string;
      };
      result = await sendPagamentoPixPendente({
        to: customer.phone,
        pacienteNome: customer.name,
        planoNome: payload.plano_nome ?? "seu plano",
        invoiceUrl: payload.invoice_url ?? `${publicBaseUrl()}/planos`,
      });
      break;
    }
    case "no_show_patient":
      result = await sendNoShowPatient({
        to: customer.phone,
        pacienteNome: customer.name,
        doctorDisplay,
        reagendamentoUrl,
      });
      break;
    case "no_show_doctor":
      result = await sendNoShowDoctor({
        to: customer.phone,
        pacienteNome: customer.name,
        doctorDisplay,
        reagendamentoUrl,
      });
      break;
    default:
      return { ok: false, retry: false, reason: `unknown_kind:${row.kind}` };
  }

  if (result.ok) {
    return { ok: true, messageId: result.messageId };
  }

  // Heurística de retry: se é apenas "templates ainda não aprovados",
  // mantemos pending e re-tentamos no próximo minuto. Qualquer outro
  // erro (código HTTP ou body inválido) marca failed pra inspeção manual.
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

export type ProcessReport = {
  processed: number;
  sent: number;
  failed: number;
  retried: number;
  details: Array<{
    id: string;
    appointment_id: string;
    kind: string;
    outcome: "sent" | "failed" | "retried";
    reason?: string;
    message_id?: string;
  }>;
};

export async function processDuePending(limit = 20): Promise<ProcessReport> {
  const supabase = getSupabaseAdmin();
  const rows = await loadDueNotifications(supabase, limit);

  const report: ProcessReport = {
    processed: rows.length,
    sent: 0,
    failed: 0,
    retried: 0,
    details: [],
  };

  for (const row of rows) {
    const outcome = await dispatch(row);

    if (outcome.ok) {
      await supabase
        .from("appointment_notifications")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          message_id: outcome.messageId,
          error: null,
        })
        .eq("id", row.id);

      report.sent += 1;
      report.details.push({
        id: row.id,
        appointment_id: row.appointment_id,
        kind: row.kind,
        outcome: "sent",
        message_id: outcome.messageId,
      });
      continue;
    }

    if (outcome.retry) {
      // Mantém pending pra re-tentativa. Guarda o motivo em error
      // só pra log (sem promover pra failed).
      await supabase
        .from("appointment_notifications")
        .update({
          error: outcome.reason,
        })
        .eq("id", row.id);

      report.retried += 1;
      report.details.push({
        id: row.id,
        appointment_id: row.appointment_id,
        kind: row.kind,
        outcome: "retried",
        reason: outcome.reason,
      });
      continue;
    }

    await supabase
      .from("appointment_notifications")
      .update({
        status: "failed",
        error: outcome.reason,
      })
      .eq("id", row.id);

    report.failed += 1;
    report.details.push({
      id: row.id,
      appointment_id: row.appointment_id,
      kind: row.kind,
      outcome: "failed",
      reason: outcome.reason,
    });
  }

  return report;
}
