/**
 * Política financeira e de notificação para appointments com desfecho
 * de no-show. Chamado pelo webhook do Daily depois de atualizar o
 * `appointments.status` para um dos estados terminais abaixo.
 *
 * Estados tratados:
 *
 *   - `no_show_patient`      → paciente não apareceu, médica esperou.
 *                              Política: zero financeira (médica recebe
 *                              earning integral), paciente é notificado
 *                              e pode escalar via admin. Sem refund
 *                              automático (D-032).
 *
 *   - `no_show_doctor`       → médica não apareceu, paciente esperou.
 *                              Política: clawback da earning +
 *                              refund_required=true + incrementa
 *                              doctors.reliability_incidents + notifica
 *                              paciente (D-032).
 *
 *   - `cancelled_by_admin` com cancelled_reason='expired_no_one_joined'
 *                            → sala expirou vazia. Tratado como
 *                              no_show_doctor (risco da plataforma).
 *
 * Idempotência:
 *   A coluna `appointments.no_show_policy_applied_at` é o guard.
 *   Uma vez preenchida, chamadas subsequentes são noop.
 *
 * Lado financeiro:
 *   Reutiliza `createClawback()` de earnings.ts, que já é idempotente
 *   (não cria clawback duplicado pro mesmo parent earning). Logo,
 *   mesmo que o guard falhe por alguma razão, não há duplo estorno.
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import { createClawback } from "@/lib/earnings";
import { enqueueImmediate } from "@/lib/notifications";
import {
  recordReliabilityEvent,
  evaluateAndMaybeAutoPause,
  type ReliabilityEventKind,
} from "@/lib/reliability";
import {
  grantNoShowCredit,
  type AppointmentCreditReason,
} from "@/lib/appointment-credits";
import { logger } from "./logger";

const log = logger.with({ mod: "no-show-policy" });

export type NoShowFinalStatus =
  | "no_show_patient"
  | "no_show_doctor"
  | "cancelled_by_admin_expired";

export type NoShowAction =
  | "already_applied" // guard falhou antes, noop
  | "patient_notified_only" // no_show_patient, nada financeiro
  | "clawback_and_refund_flagged" // no_show_doctor / expired
  | "no_earnings_to_clawback" // no_show_doctor mas payment_id nulo ou sem earnings
  | "appointment_not_found";

export type NoShowResult = {
  appointmentId: string;
  action: NoShowAction;
  clawbackCount?: number;
  reliabilityIncidentsTotal?: number;
  notificationEnqueued?: boolean;
  refundRequired?: boolean;
  /** D-036: se este incidente fez a médica ser auto-pausada. */
  doctorAutoPaused?: boolean;
  /** D-036: eventos ativos na janela (após registrar este). */
  activeReliabilityEvents?: number;
  /**
   * D-081 · PR-073: id do `appointment_credits` criado (ou reencontrado
   * idempotentemente) neste branch. Ausente pra `no_show_patient` e
   * quando a emissão falhou — caso em que a política financeira já
   * foi aplicada e o admin acompanha via reliability.
   */
  rescheduleCreditId?: string;
};

type ApplyInput = {
  appointmentId: string;
  finalStatus: NoShowFinalStatus;
  cancelledReason?: string | null;
  /** Source do trigger (ex: 'daily-webhook', 'admin-manual'). Vai pro log. */
  source?: string;
};

type AppointmentRow = {
  id: string;
  doctor_id: string;
  payment_id: string | null;
  status: string;
  no_show_policy_applied_at: string | null;
  customer_id: string;
};

/**
 * Normaliza `cancelled_by_admin` com reason especial → "expired" pra
 * roteador de política. Outros cancelamentos administrativos NÃO
 * disparam política financeira (eles foram decididos pelo admin e o
 * refund/clawback, se houver, vai manual).
 */
export function classifyFinalStatus(
  status: string,
  cancelledReason: string | null | undefined
): NoShowFinalStatus | null {
  if (status === "no_show_patient") return "no_show_patient";
  if (status === "no_show_doctor") return "no_show_doctor";
  if (
    status === "cancelled_by_admin" &&
    cancelledReason === "expired_no_one_joined"
  ) {
    return "cancelled_by_admin_expired";
  }
  return null;
}

export async function applyNoShowPolicy(input: ApplyInput): Promise<NoShowResult> {
  const supabase = getSupabaseAdmin();
  const source = input.source ?? "unknown";

  const { data: appt, error: loadErr } = await supabase
    .from("appointments")
    .select(
      "id, doctor_id, payment_id, status, no_show_policy_applied_at, customer_id"
    )
    .eq("id", input.appointmentId)
    .maybeSingle();

  if (loadErr) {
    log.error("load appointment", { err: loadErr, appointment_id: input.appointmentId });
    return {
      appointmentId: input.appointmentId,
      action: "appointment_not_found",
    };
  }
  if (!appt) {
    return {
      appointmentId: input.appointmentId,
      action: "appointment_not_found",
    };
  }

  const row = appt as AppointmentRow;

  // Guard idempotência — não processar duas vezes o mesmo appointment.
  if (row.no_show_policy_applied_at) {
    log.info("já aplicado, noop", {
      appointment_id: row.id,
      applied_at: row.no_show_policy_applied_at,
    });
    return { appointmentId: row.id, action: "already_applied" };
  }

  const now = new Date().toISOString();

  // ─── no_show_patient: zero financeiro + notifica ─────────────────────
  if (input.finalStatus === "no_show_patient") {
    await supabase
      .from("appointments")
      .update({
        no_show_policy_applied_at: now,
      })
      .eq("id", row.id);

    const notifId = await enqueueImmediate(row.id, "no_show_patient");

    log.info("applied", {
      source,
      appointment_id: row.id,
      action: "patient_notified_only",
      notification_enqueued: Boolean(notifId),
    });

    return {
      appointmentId: row.id,
      action: "patient_notified_only",
      notificationEnqueued: Boolean(notifId),
      refundRequired: false,
    };
  }

  // ─── no_show_doctor / expired: clawback + refund_required + métrica ──
  if (!row.payment_id) {
    // Appointment sem payment vinculado — sem earnings pra estornar.
    // Só marca a flag e notifica paciente (pra ele saber que precisa
    // reagendar), incrementa reliability.
    await supabase
      .from("appointments")
      .update({
        no_show_policy_applied_at: now,
        refund_required: false,
      })
      .eq("id", row.id);

    await bumpDoctorReliability(row.doctor_id);
    const reliabilityNoPayment = await registerReliabilityIncident(
      row.doctor_id,
      row.id,
      input.finalStatus
    );
    const notifId = await enqueueImmediate(row.id, "no_show_doctor");
    const creditNoPayment = await emitRescheduleCredit(
      row.customer_id,
      row.id,
      input.finalStatus,
    );

    log.warn("sem payment_id — só reliability", {
      source,
      appointment_id: row.id,
      active_events: reliabilityNoPayment.activeEvents,
      auto_paused: reliabilityNoPayment.autoPaused,
      reschedule_credit_id: creditNoPayment,
    });

    return {
      appointmentId: row.id,
      action: "no_earnings_to_clawback",
      clawbackCount: 0,
      notificationEnqueued: Boolean(notifId),
      refundRequired: false,
      doctorAutoPaused: reliabilityNoPayment.autoPaused,
      activeReliabilityEvents: reliabilityNoPayment.activeEvents ?? undefined,
      rescheduleCreditId: creditNoPayment ?? undefined,
    };
  }

  const clawbackReason =
    input.finalStatus === "cancelled_by_admin_expired"
      ? "Sala expirou sem participantes"
      : "No-show da médica";

  const clawbackResult = await createClawback(supabase, {
    paymentId: row.payment_id,
    doctorId: row.doctor_id,
    reason: clawbackReason,
  });

  const clawbackCount = clawbackResult.ok ? clawbackResult.clawbacks : 0;
  if (!clawbackResult.ok) {
    log.error("clawback falhou", {
      appointment_id: row.id,
      err: clawbackResult.error,
    });
  }

  // Marca o appointment independentemente do clawback — o guard é crítico
  // pra evitar retry repetir as notificações / reliability bump.
  await supabase
    .from("appointments")
    .update({
      no_show_policy_applied_at: now,
      refund_required: true,
    })
    .eq("id", row.id);

  const reliabilityTotal = await bumpDoctorReliability(row.doctor_id);
  const reliabilityRich = await registerReliabilityIncident(
    row.doctor_id,
    row.id,
    input.finalStatus
  );

  const notifId = await enqueueImmediate(row.id, "no_show_doctor");
  const creditId = await emitRescheduleCredit(
    row.customer_id,
    row.id,
    input.finalStatus,
  );

  log.info("applied", {
    source,
    appointment_id: row.id,
    action: "clawback_and_refund_flagged",
    clawback_count: clawbackCount,
    reliability_total: reliabilityTotal,
    active_events: reliabilityRich.activeEvents,
    auto_paused: reliabilityRich.autoPaused,
    notification_enqueued: Boolean(notifId),
    reschedule_credit_id: creditId,
  });

  return {
    appointmentId: row.id,
    action: "clawback_and_refund_flagged",
    clawbackCount,
    reliabilityIncidentsTotal: reliabilityTotal ?? undefined,
    notificationEnqueued: Boolean(notifId),
    refundRequired: true,
    doctorAutoPaused: reliabilityRich.autoPaused,
    activeReliabilityEvents: reliabilityRich.activeEvents ?? undefined,
    rescheduleCreditId: creditId ?? undefined,
  };
}

/**
 * D-081 · PR-073: emite (ou resgata idempotentemente) o
 * `appointment_credits` que formaliza o direito do paciente a
 * reagendamento gratuito. Fail-soft: qualquer erro vira log.warn e
 * retorna null — a política financeira e a notificação já rodaram e
 * não podem travar por um benefício que o admin pode emitir manualmente.
 */
async function emitRescheduleCredit(
  customerId: string,
  sourceAppointmentId: string,
  finalStatus: NoShowFinalStatus,
): Promise<string | null> {
  if (finalStatus === "no_show_patient") return null; // defensivo
  const reason: AppointmentCreditReason =
    finalStatus === "cancelled_by_admin_expired"
      ? "cancelled_by_admin_expired"
      : "no_show_doctor";

  const supabase = getSupabaseAdmin();
  const result = await grantNoShowCredit({
    supabase,
    customerId,
    sourceAppointmentId,
    reason,
  });
  if (!result.ok) {
    log.warn("grantNoShowCredit falhou", {
      appointment_id: sourceAppointmentId,
      customer_id: customerId,
      reason,
      error: result.error,
      message: result.message,
    });
    return null;
  }
  return result.credit.id;
}

/**
 * D-036: registra o incidente granular na tabela de eventos
 * (idempotente via unique(appointment_id)) e roda avaliação de
 * auto-pause.
 *
 * Paralelo ao contador antigo em `doctors.reliability_incidents` —
 * este é a verdade operacional; o contador fica como métrica histórica
 * agregada.
 */
async function registerReliabilityIncident(
  doctorId: string,
  appointmentId: string,
  finalStatus: NoShowFinalStatus
): Promise<{ activeEvents: number | null; autoPaused: boolean }> {
  const kind: ReliabilityEventKind =
    finalStatus === "cancelled_by_admin_expired"
      ? "expired_no_one_joined"
      : "no_show_doctor";

  const rec = await recordReliabilityEvent({
    doctorId,
    appointmentId,
    kind,
  });
  if (!rec.ok) {
    log.error("recordReliabilityEvent falhou", { result: rec });
    return { activeEvents: null, autoPaused: false };
  }

  const evalResult = await evaluateAndMaybeAutoPause(doctorId);
  return {
    activeEvents: evalResult.snapshot?.activeEventsInWindow ?? null,
    autoPaused: evalResult.autoPaused,
  };
}

/**
 * Incrementa `doctors.reliability_incidents` de forma atômica.
 * Retorna o novo total ou null em caso de erro.
 */
async function bumpDoctorReliability(doctorId: string): Promise<number | null> {
  const supabase = getSupabaseAdmin();

  // Lê o contador atual (não é race-free, mas race é inofensivo aqui —
  // no máximo perdemos 1 incremento num racing window de ms; volume
  // esperado é << 1/min).
  const { data: current, error: loadErr } = await supabase
    .from("doctors")
    .select("reliability_incidents")
    .eq("id", doctorId)
    .maybeSingle();

  if (loadErr || !current) {
    log.error("load doctor reliability", { err: loadErr, doctor_id: doctorId });
    return null;
  }

  const newTotal =
    ((current as { reliability_incidents: number }).reliability_incidents ?? 0) +
    1;

  const { error: upErr } = await supabase
    .from("doctors")
    .update({
      reliability_incidents: newTotal,
      last_reliability_incident_at: new Date().toISOString(),
    })
    .eq("id", doctorId);

  if (upErr) {
    log.error("bump reliability", { err: upErr, doctor_id: doctorId });
    return null;
  }
  return newTotal;
}
