/**
 * POST /api/paciente/appointments/[id]/join
 *
 * Autenticado por TOKEN (HMAC, ver src/lib/patient-tokens.ts) — não exige
 * login. O paciente recebe o link `/consulta/{id}?t=...` por
 * WhatsApp/email após o pagamento confirmar.
 *
 * Regras:
 *   - Token tem que validar e bater com o appointment_id da URL.
 *   - Appointment tem que estar em status ativo (scheduled / confirmed
 *     / in_progress). Pending_payment, cancelled, completed → 409/410.
 *   - Janela: paciente pode entrar de 30 min antes a 30 min depois do
 *     scheduled_at + duração (mesma janela da sala Daily).
 *   - Se a sala ainda não existir (pode acontecer se webhook Daily
 *     atrasou ou DAILY_API_KEY não estava setada na hora da reserva),
 *     provisionamos sob demanda — best effort.
 *
 * Resposta sucesso: { url: <URL Daily com ?t=patientToken> }
 * Erros: { error, message }
 */

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { verifyPatientToken } from "@/lib/patient-tokens";
import { getVideoProvider, provisionConsultationRoom } from "@/lib/video";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

const ENTRY_WINDOW_BEFORE_MIN = 30;
const ENTRY_WINDOW_AFTER_MIN = 30;

export async function POST(req: Request, { params }: RouteParams) {
  const { id: appointmentId } = await params;

  const url = new URL(req.url);
  const headerToken = req.headers.get("x-patient-token");
  const queryToken = url.searchParams.get("t");
  let bodyToken: string | undefined;
  try {
    const body = (await req.json().catch(() => ({}))) as { token?: string };
    bodyToken = body?.token;
  } catch {
    // ok
  }

  const token = bodyToken || headerToken || queryToken;
  const verification = verifyPatientToken(token);
  if (!verification.ok) {
    return NextResponse.json(
      { ok: false, error: "token_invalid", reason: verification.reason },
      { status: 401 }
    );
  }
  if (verification.appointmentId !== appointmentId) {
    return NextResponse.json({ ok: false, error: "token_mismatch" }, { status: 403 });
  }

  if (!process.env.DAILY_API_KEY || !process.env.DAILY_DOMAIN) {
    return NextResponse.json(
      {
        ok: false,
        error: "video_unavailable",
        message:
          "O vídeo não está configurado no servidor. Aguarde alguns minutos ou fale com a equipe.",
      },
      { status: 503 }
    );
  }

  const supabase = getSupabaseAdmin();
  const { data: appt, error: apptErr } = await supabase
    .from("appointments")
    .select(
      "id, doctor_id, customer_id, status, scheduled_at, scheduled_until, video_room_name, video_room_url, video_patient_token, recording_consent, doctors ( full_name, display_name, consultation_minutes ), customers ( name )"
    )
    .eq("id", appointmentId)
    .maybeSingle();

  if (apptErr) {
    console.error("[paciente/join] load:", apptErr);
    return NextResponse.json({ ok: false, error: "lookup_failed" }, { status: 500 });
  }
  if (!appt) {
    return NextResponse.json({ ok: false, error: "appointment_not_found" }, { status: 404 });
  }

  const status = appt.status as string;
  if (status === "pending_payment") {
    return NextResponse.json(
      { ok: false, error: "payment_pending", message: "O pagamento ainda não foi confirmado." },
      { status: 409 }
    );
  }
  if (
    status === "completed" ||
    status === "no_show_patient" ||
    status === "no_show_doctor" ||
    status.startsWith("cancelled")
  ) {
    return NextResponse.json(
      { ok: false, error: "appointment_closed", status },
      { status: 410 }
    );
  }

  // Janela de entrada
  const scheduledAt = new Date(appt.scheduled_at as string);
  const doctor = (appt as { doctors?: { full_name?: string; display_name?: string | null; consultation_minutes?: number } })
    .doctors;
  const durationMinutes = doctor?.consultation_minutes ?? 30;
  const endsAt = new Date(scheduledAt.getTime() + durationMinutes * 60_000);

  const now = Date.now();
  const earliestEntry = scheduledAt.getTime() - ENTRY_WINDOW_BEFORE_MIN * 60_000;
  const latestEntry = endsAt.getTime() + ENTRY_WINDOW_AFTER_MIN * 60_000;

  if (now < earliestEntry) {
    const waitMin = Math.ceil((earliestEntry - now) / 60_000);
    return NextResponse.json(
      {
        ok: false,
        error: "too_early",
        message: `A sala abre 30 minutos antes do horário. Volte em ${waitMin} min.`,
        opensAt: new Date(earliestEntry).toISOString(),
      },
      { status: 425 }
    );
  }
  if (now > latestEntry) {
    return NextResponse.json(
      { ok: false, error: "too_late", message: "Janela da consulta encerrada." },
      { status: 410 }
    );
  }

  let roomName = appt.video_room_name as string | null;
  let roomUrl = appt.video_room_url as string | null;
  let patientToken = appt.video_patient_token as string | null;

  if (!roomName || !roomUrl || !patientToken) {
    // Best-effort provisioning (caso o webhook Asaas não tenha provisionado)
    try {
      const customerName =
        (appt as { customers?: { name?: string } }).customers?.name ?? "Paciente";
      const doctorName = doctor?.display_name || doctor?.full_name || "Médica";

      const result = await provisionConsultationRoom({
        appointmentId,
        scheduledAt,
        durationMinutes,
        patientName: customerName,
        doctorName,
        recordingConsent: Boolean(appt.recording_consent),
      });
      roomName = result.room.name;
      roomUrl = result.room.url;
      patientToken = result.tokens.patientToken;

      await supabase
        .from("appointments")
        .update({
          video_provider: "daily",
          video_room_name: roomName,
          video_room_url: roomUrl,
          video_doctor_token: result.tokens.doctorToken,
          video_patient_token: patientToken,
          daily_room_id: result.room.providerId,
          daily_raw: result.room.raw as unknown as Record<string, unknown>,
        })
        .eq("id", appointmentId);
    } catch (e) {
      console.error("[paciente/join] provision falhou:", e);
      return NextResponse.json(
        {
          ok: false,
          error: "provision_failed",
          message: "Não foi possível abrir a sala. Tente novamente em alguns instantes.",
        },
        { status: 503 }
      );
    }
  } else {
    // Sala existe — geramos um token NOVO, curto, pra entrada (anti-replay)
    try {
      const provider = getVideoProvider();
      const customerName =
        (appt as { customers?: { name?: string } }).customers?.name ?? "Paciente";
      const doctorName = doctor?.display_name || doctor?.full_name || "Médica";
      const expiresAt = Math.floor(endsAt.getTime() / 1000) + 30 * 60;

      const tokens = await provider.getJoinTokens({
        roomName,
        patientName: customerName,
        doctorName,
        enableRecording: Boolean(appt.recording_consent),
        expiresAt,
      });
      patientToken = tokens.patientToken;
    } catch (e) {
      console.error("[paciente/join] token-only falhou:", e);
      return NextResponse.json(
        { ok: false, error: "token_failed" },
        { status: 503 }
      );
    }
  }

  return NextResponse.json({
    ok: true,
    url: `${roomUrl}?t=${patientToken}`,
    roomName,
  });
}
