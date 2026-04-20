/**
 * POST /api/medico/appointments/[id]/join
 *
 * Garante que existe sala Daily para a consulta e retorna a URL com
 * o token da médica (owner) embutido — pronta pra abrir em nova aba.
 *
 * Idempotente: se já existe `video_room_url` válido, gera só um novo
 * meeting-token (curto) e devolve. Se não, cria a sala (provisionConsultationRoom).
 *
 * Hard-gate: a appointment precisa pertencer à médica autenticada.
 *
 * NOTA MVP (Sprint 4.1 3/3):
 *   Em ambiente sem DAILY_API_KEY configurado, devolve 503 com mensagem
 *   amigável em vez de crash — o painel exibe "vídeo indisponível".
 */

import { NextResponse } from "next/server";
import { requireDoctor } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getVideoProvider, provisionConsultationRoom } from "@/lib/video";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: RouteParams) {
  const { id: appointmentId } = await params;
  const { doctorId } = await requireDoctor();

  if (!process.env.DAILY_API_KEY || !process.env.DAILY_DOMAIN) {
    return NextResponse.json(
      {
        ok: false,
        error: "video_unavailable",
        message:
          "Vídeo ainda não está configurado no servidor. Fale com o operador.",
      },
      { status: 503 }
    );
  }

  const supabase = getSupabaseAdmin();

  const { data: appt, error } = await supabase
    .from("appointments")
    .select(
      "id, doctor_id, customer_id, scheduled_at, scheduled_until, status, video_room_name, video_room_url, video_doctor_token, recording_consent, customers ( name ), doctors ( display_name, full_name, consultation_minutes )"
    )
    .eq("id", appointmentId)
    .maybeSingle();

  if (error || !appt) {
    return NextResponse.json(
      { ok: false, error: "appointment_not_found" },
      { status: 404 }
    );
  }

  if (appt.doctor_id !== doctorId) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  if (appt.status === "cancelled") {
    return NextResponse.json(
      { ok: false, error: "appointment_cancelled" },
      { status: 409 }
    );
  }

  const customer = Array.isArray(appt.customers) ? appt.customers[0] : appt.customers;
  const doctor = Array.isArray(appt.doctors) ? appt.doctors[0] : appt.doctors;
  const patientName = customer?.name ?? "Paciente";
  const doctorName = doctor?.display_name ?? doctor?.full_name ?? "Médica";
  const durationMinutes = doctor?.consultation_minutes ?? 30;

  const scheduledAt = new Date(appt.scheduled_at as string);

  let roomUrl = appt.video_room_url as string | null;
  let roomName = appt.video_room_name as string | null;
  let doctorToken: string | null = null;

  if (!roomUrl || !roomName) {
    try {
      const result = await provisionConsultationRoom({
        appointmentId: appt.id as string,
        scheduledAt,
        durationMinutes,
        patientName,
        doctorName,
        recordingConsent: Boolean(appt.recording_consent),
      });
      roomUrl = result.room.url;
      roomName = result.room.name;
      doctorToken = result.tokens.doctorToken;

      await supabase
        .from("appointments")
        .update({
          video_provider: "daily",
          video_room_name: roomName,
          video_room_url: roomUrl,
          video_doctor_token: doctorToken,
          video_patient_token: result.tokens.patientToken,
          updated_at: new Date().toISOString(),
        })
        .eq("id", appt.id);
    } catch (e) {
      console.error("[medico/appointments/join] provision error:", e);
      return NextResponse.json(
        {
          ok: false,
          error: "provision_failed",
          message: "Não foi possível criar a sala. Tente novamente em instantes.",
        },
        { status: 502 }
      );
    }
  } else {
    // Sala já existe; gera só um meeting-token novo pra médica (mais seguro
    // que reutilizar o salvo no banco — esse pode estar expirado).
    try {
      const provider = getVideoProvider();
      const endTs =
        Math.floor(scheduledAt.getTime() / 1000) + (durationMinutes + 30) * 60;
      const tokens = await provider.getJoinTokens({
        roomName,
        patientName,
        doctorName,
        enableRecording: Boolean(appt.recording_consent),
        expiresAt: endTs,
      });
      doctorToken = tokens.doctorToken;
    } catch (e) {
      console.error("[medico/appointments/join] token error:", e);
      return NextResponse.json(
        {
          ok: false,
          error: "token_failed",
          message: "Não foi possível gerar o token de entrada. Tente novamente.",
        },
        { status: 502 }
      );
    }
  }

  return NextResponse.json({
    ok: true,
    url: `${roomUrl}?t=${doctorToken}`,
    roomName,
  });
}
