/**
 * Reconciliação de appointments (D-035) — Instituto Nova Medida.
 *
 * Função central que decide o status terminal de um appointment a
 * partir de uma lista de sessões de meeting do provider de vídeo.
 * Consumido por dois caminhos:
 *
 *   1. `src/app/api/daily/webhook/route.ts` (em tempo real via
 *      `meeting.ended`), passando `meetings` reconstruído a partir
 *      dos `participant.joined` já persistidos em `daily_events`.
 *
 *   2. `src/app/api/internal/cron/daily-reconcile/route.ts` (fallback),
 *      passando `meetings` direto da REST API do Daily
 *      (`GET /meetings?room=…`).
 *
 * Ambos chegam com o mesmo shape `MeetingSummary[]`, então a lógica
 * de classificação fica única — evita drift entre webhook e cron.
 *
 * Idempotência:
 *   - `reconciled_at` + `reconciled_by_source`: só preenchemos se
 *     estiverem nulos. Primeiro a chegar marca; subsequentes ficam
 *     noop na trilha, mas ainda executam `applyNoShowPolicy` (que
 *     tem guard próprio via `no_show_policy_applied_at`).
 *   - Estado terminal: não regredimos. Se já está `completed`,
 *     `no_show_*`, `cancelled_*`, tudo fica.
 *
 * Regras de classificação (devem bater 1:1 com o webhook D-029):
 *   - Ninguém entrou na sala → `cancelled_by_admin` + reason
 *     `expired_no_one_joined` (risco da plataforma, tratado como
 *     no-show da médica pela política financeira).
 *   - Só a médica → `no_show_patient`.
 *   - Só o paciente → `no_show_doctor`.
 *   - Ambos + duração ≥ 3 min em pelo menos uma sessão → `completed`.
 *   - Ambos + duração curta (< 3 min) → `completed` conservador
 *     (médica pode reclassificar via admin).
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import type { MeetingSummary } from "@/lib/video";
import {
  applyNoShowPolicy,
  classifyFinalStatus,
  type NoShowResult,
} from "@/lib/no-show-policy";

export type ReconcileSource = "daily_webhook" | "daily_cron" | "admin_manual";

export type ReconcileAction =
  | "already_terminal"
  | "not_found"
  | "completed"
  | "no_show_patient"
  | "no_show_doctor"
  | "cancelled_expired";

export type ReconcileResult = {
  ok: boolean;
  appointmentId: string;
  action: ReconcileAction;
  /** Quem marcou — ou "ninguém" se já estava terminal. */
  reconciledBy: ReconcileSource | null;
  noShowPolicy: NoShowResult | null;
  /** Duração máxima encontrada nas sessões (segundos). */
  maxDurationSeconds: number | null;
  /** Flags de presença detectadas na análise. */
  doctorJoined: boolean;
  patientJoined: boolean;
};

export type ReconcileInput = {
  appointmentId: string;
  /** Sessões do meeting (vindas do webhook OU do cron). */
  meetings: MeetingSummary[];
  /**
   * Override opcional do nome da médica pra matching com
   * `participant.user_name`. Se omitido, carregamos de `doctors`.
   */
  doctorNameOverride?: string | null;
  /** De onde veio esta reconciliação. Vai pro DB pra auditoria. */
  source: ReconcileSource;
  /**
   * Quando `true`, também marca `reconciled_*` mesmo se o status
   * já estava terminal (útil pra admin forçar um rebuild da audit
   * trail). Default: false (idempotente).
   */
  forceTouch?: boolean;
};

type AppointmentRow = {
  id: string;
  status: string;
  doctor_id: string;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  reconciled_at: string | null;
  reconciled_by_source: string | null;
  video_room_name: string | null;
  daily_meeting_session_id: string | null;
};

const TERMINAL_STATUSES = new Set([
  "completed",
  "no_show_patient",
  "no_show_doctor",
  "cancelled_by_patient",
  "cancelled_by_doctor",
  "cancelled_by_admin",
]);

const MIN_MEANINGFUL_DURATION_SECONDS = 180;

/**
 * Carrega o display_name da médica pra matching com `user_name` que a
 * gente passou no meeting-token quando criamos a sala.
 */
async function loadDoctorMatchName(
  doctorId: string
): Promise<string | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("doctors")
    .select("display_name, full_name")
    .eq("id", doctorId)
    .maybeSingle();
  if (error) {
    console.warn("[reconcile] loadDoctorMatchName:", error.message);
    return null;
  }
  if (!data) return null;
  return (data.display_name as string | null) || (data.full_name as string | null) || null;
}

function namesMatch(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const normalize = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, ""); // remove acentos
  return normalize(a) === normalize(b);
}

/**
 * Classifica presenças olhando para `MeetingSummary[]`. Retorna quem
 * entrou (médica/paciente) e a maior duração observada entre todas
 * as sessões (usada pra decidir "completed" vs "short call").
 */
function analyzeMeetings(
  meetings: MeetingSummary[],
  doctorMatchName: string | null
): {
  doctorJoined: boolean;
  patientJoined: boolean;
  maxDurationSeconds: number | null;
  anyParticipant: boolean;
} {
  let doctorJoined = false;
  let patientJoined = false;
  let maxDuration: number | null = null;
  let anyParticipant = false;

  for (const meeting of meetings) {
    if (meeting.durationSeconds != null) {
      if (maxDuration == null || meeting.durationSeconds > maxDuration) {
        maxDuration = meeting.durationSeconds;
      }
    }
    for (const p of meeting.participants) {
      anyParticipant = true;
      // Primeiro tenta `isOwner` (webhook passa essa flag via
      // payload.is_owner). Fallback: match do `user_name` com o
      // `display_name` da médica (caminho do cron, que recebe user_name
      // vindo do meeting-token mas sem is_owner na REST API).
      if (p.isOwner === true) {
        doctorJoined = true;
      } else if (p.isOwner === false) {
        patientJoined = true;
      } else if (doctorMatchName && namesMatch(p.userName, doctorMatchName)) {
        doctorJoined = true;
      } else if (p.userName) {
        // Qualquer nome diferente do da médica que também entrou
        // contamos como paciente. Conservador: prefere acusar
        // "presença" a errar pra o lado "no_show".
        patientJoined = true;
      }
    }
  }

  return {
    doctorJoined,
    patientJoined,
    maxDurationSeconds: maxDuration,
    anyParticipant,
  };
}

/**
 * Função central. Idempotente. Pode ser chamada infinitas vezes
 * pro mesmo appointment sem efeito colateral além de logs.
 */
export async function reconcileAppointmentFromMeetings(
  input: ReconcileInput
): Promise<ReconcileResult> {
  const supabase = getSupabaseAdmin();

  const { data: apptRaw, error: loadErr } = await supabase
    .from("appointments")
    .select(
      "id, status, doctor_id, started_at, ended_at, duration_seconds, reconciled_at, reconciled_by_source, video_room_name, daily_meeting_session_id"
    )
    .eq("id", input.appointmentId)
    .maybeSingle();

  if (loadErr) {
    console.error("[reconcile] load falhou:", loadErr);
    return {
      ok: false,
      appointmentId: input.appointmentId,
      action: "not_found",
      reconciledBy: null,
      noShowPolicy: null,
      maxDurationSeconds: null,
      doctorJoined: false,
      patientJoined: false,
    };
  }
  if (!apptRaw) {
    return {
      ok: false,
      appointmentId: input.appointmentId,
      action: "not_found",
      reconciledBy: null,
      noShowPolicy: null,
      maxDurationSeconds: null,
      doctorJoined: false,
      patientJoined: false,
    };
  }
  const appt = apptRaw as AppointmentRow;

  // Se já está em estado terminal e não é forceTouch, noop limpo.
  if (TERMINAL_STATUSES.has(appt.status) && !input.forceTouch) {
    return {
      ok: true,
      appointmentId: appt.id,
      action: "already_terminal",
      reconciledBy: null,
      noShowPolicy: null,
      maxDurationSeconds: null,
      doctorJoined: false,
      patientJoined: false,
    };
  }

  const doctorMatchName =
    input.doctorNameOverride ?? (await loadDoctorMatchName(appt.doctor_id));

  const analysis = analyzeMeetings(input.meetings, doctorMatchName);

  // Decisão de status final
  let newStatus: string;
  let cancelledReason: string | null = null;
  let action: ReconcileAction;

  if (!analysis.anyParticipant) {
    newStatus = "cancelled_by_admin";
    cancelledReason = "expired_no_one_joined";
    action = "cancelled_expired";
  } else if (analysis.doctorJoined && analysis.patientJoined) {
    // Ambos → completed (política D-029 mantida: curtas também viram
    // completed; admin reclassifica manualmente se necessário).
    newStatus = "completed";
    action = "completed";
  } else if (analysis.doctorJoined && !analysis.patientJoined) {
    newStatus = "no_show_patient";
    action = "no_show_patient";
  } else if (!analysis.doctorJoined && analysis.patientJoined) {
    newStatus = "no_show_doctor";
    action = "no_show_doctor";
  } else {
    // Defensivo: analyzeMeetings indica anyParticipant=true mas nem
    // médica nem paciente bateram — nome de owner imprevisível.
    // Trata como "ninguém entrou reconhecível" → expired.
    newStatus = "cancelled_by_admin";
    cancelledReason = "expired_no_one_joined";
    action = "cancelled_expired";
  }

  // Monta o update respeitando idempotência das colunas de audit.
  const updates: Record<string, unknown> = { status: newStatus };
  const nowIso = new Date().toISOString();

  // Se nunca tivemos meeting.started persistido, puxamos do earliest
  // join_time pra não deixar started_at nulo quando o cron fecha um
  // appointment que de fato rolou.
  if (!appt.started_at && analysis.anyParticipant) {
    const earliestJoin = input.meetings
      .flatMap((m) => m.participants.map((p) => p.joinTime))
      .filter((t): t is number => typeof t === "number")
      .sort((a, b) => a - b)[0];
    if (earliestJoin != null) {
      updates.started_at = new Date(earliestJoin * 1000).toISOString();
    } else {
      // fallback: usa o menor start_time das sessões
      const earliestStart = input.meetings
        .map((m) => m.startTime)
        .filter((t): t is number => typeof t === "number")
        .sort((a, b) => a - b)[0];
      if (earliestStart != null) {
        updates.started_at = new Date(earliestStart * 1000).toISOString();
      }
    }
  }

  if (!appt.ended_at) {
    updates.ended_at = nowIso;
  }

  if (!appt.duration_seconds && analysis.maxDurationSeconds != null) {
    updates.duration_seconds = analysis.maxDurationSeconds;
  }

  if (cancelledReason) {
    updates.cancelled_at = nowIso;
    updates.cancelled_reason = cancelledReason;
  }

  // Audit trail: só carimba se ainda não carimbou.
  if (!appt.reconciled_at) {
    updates.reconciled_at = nowIso;
    updates.reconciled_by_source = input.source;
  }

  // daily_meeting_session_id — se ainda não temos, pega do primeiro
  // meeting disponível (útil pro cron, webhook já setou antes).
  if (!appt.daily_meeting_session_id) {
    const firstMeetingId = input.meetings
      .map((m) => m.meetingId)
      .filter((id): id is string => typeof id === "string" && id.length > 0)[0];
    if (firstMeetingId) {
      updates.daily_meeting_session_id = firstMeetingId;
    }
  }

  const { error: updateErr } = await supabase
    .from("appointments")
    .update(updates)
    .eq("id", appt.id);

  if (updateErr) {
    console.error("[reconcile] update falhou:", updateErr);
    return {
      ok: false,
      appointmentId: appt.id,
      action,
      reconciledBy: null,
      noShowPolicy: null,
      maxDurationSeconds: analysis.maxDurationSeconds,
      doctorJoined: analysis.doctorJoined,
      patientJoined: analysis.patientJoined,
    };
  }

  // Dispara política de no-show se aplicável. applyNoShowPolicy tem
  // guard próprio via `no_show_policy_applied_at` — é seguro chamar
  // mesmo em re-execuções.
  let noShowPolicyResult: NoShowResult | null = null;
  const finalClassification = classifyFinalStatus(newStatus, cancelledReason);
  if (finalClassification) {
    try {
      noShowPolicyResult = await applyNoShowPolicy({
        appointmentId: appt.id,
        finalStatus: finalClassification,
        cancelledReason,
        source: input.source,
      });
    } catch (e) {
      console.error("[reconcile] applyNoShowPolicy falhou:", e);
      // Não bloqueia — o status já foi atualizado. Admin pode retry
      // via UI futura se necessário.
    }
  }

  console.log("[reconcile] fechado:", {
    appointment_id: appt.id,
    action,
    source: input.source,
    doctor_joined: analysis.doctorJoined,
    patient_joined: analysis.patientJoined,
    max_duration_s: analysis.maxDurationSeconds,
    policy: noShowPolicyResult?.action ?? null,
  });

  return {
    ok: true,
    appointmentId: appt.id,
    action,
    reconciledBy: input.source,
    noShowPolicy: noShowPolicyResult,
    maxDurationSeconds: analysis.maxDurationSeconds,
    doctorJoined: analysis.doctorJoined,
    patientJoined: analysis.patientJoined,
  };
}

// ────────────────────────────────────────────────────────────────────
// Helper pro webhook — reconstrói MeetingSummary[] a partir de
// daily_events.participant.joined persistidos. Mantém a API do
// reconciler única (MeetingSummary[]) independente da origem.
// ────────────────────────────────────────────────────────────────────

/**
 * Webhook meeting.ended chega com `durationSeconds` e a gente já
 * acumulou `participant.joined` em `daily_events`. Constrói um
 * `MeetingSummary` equivalente pra feed do reconciler.
 */
export async function buildMeetingSummaryFromWebhookEvents(
  appointmentId: string,
  totalDurationSeconds: number | null,
  endedOccurredAt: Date | null,
  meetingId: string | null
): Promise<MeetingSummary> {
  const supabase = getSupabaseAdmin();
  const { data: joinedRows } = await supabase
    .from("daily_events")
    .select("payload, event_ts")
    .eq("appointment_id", appointmentId)
    .eq("event_type", "participant.joined");

  const participants = (joinedRows ?? []).map((row) => {
    const p = (row.payload as { payload?: { is_owner?: boolean; user_name?: string; user_id?: string } })
      ?.payload;
    const eventTs = row.event_ts
      ? Math.floor(new Date(row.event_ts as string).getTime() / 1000)
      : null;
    return {
      userId: p?.user_id ?? null,
      userName: p?.user_name ?? null,
      durationSeconds: null,
      joinTime: eventTs,
      isOwner: p?.is_owner ?? null,
    };
  });

  const startTime =
    participants
      .map((p) => p.joinTime)
      .filter((t): t is number => typeof t === "number")
      .sort((a, b) => a - b)[0] ?? null;

  return {
    meetingId,
    startTime,
    durationSeconds: totalDurationSeconds,
    ongoing: false,
    participants,
    raw: { source: "webhook_reconstructed", endedOccurredAt },
  };
}
