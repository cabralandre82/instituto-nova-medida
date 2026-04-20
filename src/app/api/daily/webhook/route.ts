/**
 * Webhook do Daily.co — Instituto Nova Medida.
 *
 * Eventos relevantes (https://docs.daily.co/reference/rest-api/webhooks):
 *
 *   - meeting.started        → consulta começou (alguém entrou na sala)
 *   - meeting.ended          → sala terminou (todos saíram OU expirou)
 *   - participant.joined     → alguém entrou (logamos pra auditoria)
 *   - participant.left       → alguém saiu (logamos pra auditoria)
 *   - recording.ready        → gravação pronta (futuro; só persistimos)
 *
 * Resolução do appointment:
 *   - O `payload.room` vem como o nome que criamos (ex: 'c-abc12345').
 *   - Buscamos `appointments` por `video_room_name = payload.room`.
 *   - Se não encontrar, registramos o evento como órfão e ignoramos —
 *     pode ser sala de teste manual no painel Daily.
 *
 * Atualizações em `appointments`:
 *
 *   - meeting.started:
 *       started_at = event.occurredAt
 *       status     = 'in_progress'  (se ainda for scheduled/confirmed)
 *
 *   - meeting.ended:
 *       ended_at         = event.occurredAt
 *       duration_seconds = event.durationSeconds
 *       status           = 'completed'           se started_at existe E
 *                                                  duration_seconds >= 180
 *                          'no_show_patient'     se NUNCA teve participant.joined
 *                                                  (ou só o owner participou)
 *                          'no_show_doctor'      se SÓ o paciente entrou
 *                          mantém o atual        se já estiver em estado
 *                                                  terminal (cancelled, completed)
 *
 * Filosofia (igual asaas-webhook):
 *   1. Persistir RAW antes de processar.
 *   2. Idempotência via unique(event_id, event_type).
 *   3. SEMPRE responder 200 se a assinatura for válida — Daily faz retry
 *      agressivo em 5xx ou timeout.
 *
 * Auth:
 *   - HMAC-SHA256 oficial (X-Webhook-Signature + X-Webhook-Timestamp).
 *   - Fallback: secret bruto via x-daily-webhook-secret (legado).
 *   - Sem secret configurado em dev: aceita e loga (modo permissivo).
 */

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getVideoProvider, parseDailyEvent, type NormalizedVideoEvent } from "@/lib/video";
import {
  reconcileAppointmentFromMeetings,
  buildMeetingSummaryFromWebhookEvents,
} from "@/lib/reconcile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // Validação de assinatura (consome o body cru).
  const provider = (() => {
    try {
      return getVideoProvider();
    } catch (e) {
      console.error("[daily-webhook] provider não configurado:", e);
      return null;
    }
  })();

  if (!provider) {
    // Sem provider configurado = não dá pra validar nada. Negamos.
    return NextResponse.json(
      { ok: false, error: "video_provider_unavailable" },
      { status: 503 }
    );
  }

  let validation;
  try {
    validation = await provider.validateWebhook(req);
  } catch (e) {
    // loadDailyConfig() pode lançar se DAILY_API_KEY/DOMAIN não estão
    // setadas — devolvemos 503 explicitamente em vez de crashar com 500.
    console.error("[daily-webhook] config ausente:", e);
    return NextResponse.json(
      { ok: false, error: "video_provider_unconfigured" },
      { status: 503 }
    );
  }
  if (!validation.ok) {
    console.warn("[daily-webhook] validação falhou:", validation.reason);
    return NextResponse.json(
      { ok: false, error: "unauthorized", reason: validation.reason },
      { status: 401 }
    );
  }

  // Verification ping sem assinatura (Daily envia SEM headers em algumas
  // situações legadas) — respondemos 200 imediatamente, sem persistir.
  if (validation.testPing) {
    return NextResponse.json({ ok: true, pong: true });
  }

  let body: unknown;
  try {
    body = JSON.parse(validation.rawBody);
  } catch {
    return NextResponse.json({ ok: false, error: "json_invalid" }, { status: 400 });
  }

  // Verification ping COM assinatura (POST /webhooks do Daily envia
  // `{"test":"test"}` assinado pra validar nosso endpoint). Respondemos 200
  // e não persistimos — ele não é um evento real de meeting.
  const bodyType = (body as { type?: unknown })?.type;
  const bodyTest = (body as { test?: unknown })?.test;
  const isRealEvent = typeof bodyType === "string" && (
    bodyType.startsWith("meeting.") ||
    bodyType.startsWith("participant.") ||
    bodyType.startsWith("recording.")
  );
  if (!isRealEvent || bodyTest === "test") {
    console.log("[daily-webhook] verification ping recebido", { bodyType, bodyTest });
    return NextResponse.json({ ok: true, pong: true });
  }

  const event = parseDailyEvent(body);

  const supabase = getSupabaseAdmin();

  // 1) Resolve appointment_id pelo nome da sala (best-effort).
  let appointmentId: string | null = null;
  if (event.roomName) {
    const { data: appt } = await supabase
      .from("appointments")
      .select("id")
      .eq("video_room_name", event.roomName)
      .maybeSingle();
    appointmentId = (appt?.id as string | undefined) ?? null;
  }

  // 2) Persiste raw + idempotência.
  let storedEventId: string | null = null;
  try {
    const { data: stored, error: storeErr } = await supabase
      .from("daily_events")
      .insert({
        event_id: event.eventId,
        event_type: (body as { type?: string })?.type ?? "unknown",
        event_ts: event.occurredAt?.toISOString() ?? null,
        daily_room_name: event.roomName,
        daily_meeting_id: event.meetingId,
        appointment_id: appointmentId,
        signature: req.headers.get("x-webhook-signature") ?? null,
        signature_valid: true,
        payload: body as Record<string, unknown>,
      })
      .select("id")
      .single();

    if (storeErr) {
      // Conflict = já recebemos antes (ux_daily_events_id_type). 200 + flag.
      if (storeErr.code === "23505") {
        console.log("[daily-webhook] evento duplicado:", event.eventId, event.type);
        return NextResponse.json({ ok: true, duplicate: true });
      }
      console.error("[daily-webhook] persist raw falhou:", storeErr);
      // Continuamos mesmo assim — não bloqueia processamento.
    } else {
      storedEventId = stored?.id ?? null;
    }
  } catch (e) {
    console.error("[daily-webhook] persist raw exception:", e);
  }

  // 3) Sem appointment vinculado, paramos por aqui (evento órfão).
  if (!appointmentId) {
    if (storedEventId) {
      await supabase
        .from("daily_events")
        .update({
          processed_at: new Date().toISOString(),
          processing_error: event.roomName ? "appointment_not_found" : "no_room_name",
        })
        .eq("id", storedEventId);
    }
    console.log(
      "[daily-webhook] evento sem appointment:",
      event.type,
      "room=",
      event.roomName
    );
    return NextResponse.json({ ok: true, orphan: true });
  }

  // 4) Roteia o tipo de evento.
  try {
    await processEvent(appointmentId, event);
    if (storedEventId) {
      await supabase
        .from("daily_events")
        .update({ processed_at: new Date().toISOString() })
        .eq("id", storedEventId);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[daily-webhook] processamento falhou:", msg);
    if (storedEventId) {
      await supabase
        .from("daily_events")
        .update({ processing_error: msg })
        .eq("id", storedEventId);
    }
  }

  // Sempre 200 quando a auth passou — temos o RAW pra reprocessar.
  return NextResponse.json({ ok: true });
}

export function GET() {
  return NextResponse.json({
    ok: true,
    service: "instituto-nova-medida-daily-webhook",
    docs:
      "POST com headers X-Webhook-Signature/X-Webhook-Timestamp ou x-daily-webhook-secret",
  });
}

// ────────────────────────────────────────────────────────────────────
// Processamento por tipo de evento
// ────────────────────────────────────────────────────────────────────

async function processEvent(appointmentId: string, event: NormalizedVideoEvent) {
  const supabase = getSupabaseAdmin();

  if (event.type === "meeting.started") {
    const { data: cur } = await supabase
      .from("appointments")
      .select("status, started_at, daily_meeting_session_id")
      .eq("id", appointmentId)
      .maybeSingle();
    if (!cur) return;

    const updates: Record<string, unknown> = {};
    if (!cur.started_at && event.occurredAt) {
      updates.started_at = event.occurredAt.toISOString();
    }
    if (event.meetingId && !cur.daily_meeting_session_id) {
      updates.daily_meeting_session_id = event.meetingId;
    }
    // Promove pra in_progress se ainda for um estado pré-consulta.
    if (cur.status === "scheduled" || cur.status === "confirmed") {
      updates.status = "in_progress";
    }
    if (Object.keys(updates).length > 0) {
      await supabase.from("appointments").update(updates).eq("id", appointmentId);
      console.log("[daily-webhook] appointment iniciado:", appointmentId, updates);
    }
    return;
  }

  if (event.type === "meeting.ended") {
    // Delega ao reconciler central (D-035). Reconstrói
    // `MeetingSummary[]` a partir dos `participant.joined` persistidos
    // em `daily_events` + durationSeconds do evento em si, mantendo
    // a lógica de classificação uniforme entre webhook e cron.
    const summary = await buildMeetingSummaryFromWebhookEvents(
      appointmentId,
      event.durationSeconds,
      event.occurredAt,
      event.meetingId
    );
    const result = await reconcileAppointmentFromMeetings({
      appointmentId,
      meetings: [summary],
      source: "daily_webhook",
    });
    console.log("[daily-webhook] reconcile:", {
      appointment_id: appointmentId,
      action: result.action,
      doctor_joined: result.doctorJoined,
      patient_joined: result.patientJoined,
      max_duration_s: result.maxDurationSeconds,
      policy: result.noShowPolicy?.action ?? null,
    });
    return;
  }

  if (event.type === "participant.joined") {
    // Apenas log/auditoria — o status já foi (ou será) atualizado pelo
    // meeting.started. Persistimos no daily_events pra a checagem de
    // no-show no meeting.ended.
    return;
  }

  if (event.type === "participant.left") {
    // Mesmo: apenas auditoria.
    return;
  }

  if (event.type === "recording.ready") {
    // Futuro: extrair URL da gravação e persistir em
    // appointments.recording_url. Hoje só persistimos o raw.
    return;
  }
}
