/**
 * POST /api/medico/on-demand/[requestId]/accept
 *
 * PR-080 · D-092. Médica aceita um request on-demand. Atomic via RPC
 * `accept_on_demand_request`. Race-safe: se outra médica aceitou
 * primeiro, retorna 409 com `{ reason: "already_accepted" }`.
 *
 * Auth: requireDoctor (cookie). doctor_id vem da sessão — médica não
 * pode aceitar em nome de outra.
 *
 * Side-effects ao sucesso:
 *   - Cria appointment kind=on_demand status=scheduled scheduled_at=now.
 *   - Marca request accepted.
 *   - Enfileira `enqueueDoctorPaid`/lembretes? NÃO. On-demand é
 *     gratuito (D-044), não há "paid event". UI mostra a sala
 *     direto. Notificação de início vai pra paciente via
 *     `enqueueImmediate('confirmacao')` igual /agendar/free.
 *   - Marca presença=busy (mão na massa, não fica de plantão pra
 *     receber outro request enquanto atende este).
 *
 * Body opcional:
 *   { durationMinutes?: number }
 *
 * Resposta sucesso:
 *   { ok:true, appointmentId, salaUrl: "/medico/consultas/<id>" }
 */

import { NextResponse } from "next/server";
import { requireDoctor } from "@/lib/auth";
import { acceptOnDemandRequest } from "@/lib/on-demand";
import {
  enqueueImmediate,
  scheduleRemindersForAppointment,
} from "@/lib/notifications";
import { setPresenceStatus } from "@/lib/doctor-presence";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/medico/on-demand/[requestId]/accept" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { durationMinutes?: number; recordingConsent?: boolean };

export async function POST(
  req: Request,
  ctx: { params: Promise<{ requestId: string }> }
) {
  const { doctorId } = await requireDoctor();
  const { requestId } = await ctx.params;

  if (!requestId) {
    return NextResponse.json(
      { ok: false, error: "request_id_required" },
      { status: 400 }
    );
  }

  let body: Body = {};
  try {
    const raw = await req.json();
    if (raw && typeof raw === "object") body = raw as Body;
  } catch {
    /* body opcional */
  }

  const result = await acceptOnDemandRequest({
    requestId,
    doctorId,
    durationMinutes: body.durationMinutes ?? 30,
    recordingConsent: body.recordingConsent ?? false,
  });

  if (!result.ok) {
    if (result.reason === "already_accepted") {
      return NextResponse.json(
        { ok: false, error: "already_accepted" },
        { status: 409 }
      );
    }
    if (result.reason === "already_cancelled") {
      return NextResponse.json(
        { ok: false, error: "already_cancelled" },
        { status: 409 }
      );
    }
    if (result.reason === "expired" || result.reason === "already_expired") {
      return NextResponse.json(
        { ok: false, error: "expired" },
        { status: 409 }
      );
    }
    if (result.reason === "not_found") {
      return NextResponse.json(
        { ok: false, error: "not_found" },
        { status: 404 }
      );
    }
    if (result.reason === "validation") {
      return NextResponse.json(
        { ok: false, error: "validation" },
        { status: 400 }
      );
    }
    log.error("accept failed", { request_id: requestId, doctor_id: doctorId });
    return NextResponse.json({ ok: false, error: "internal" }, { status: 500 });
  }

  const appointmentId = result.appointmentId;

  // Notificações pro paciente (sem doctor reminder porque é "agora").
  // Não derruba a resposta se falhar — appointment já existe.
  try {
    await Promise.all([
      enqueueImmediate(appointmentId, "confirmacao"),
      scheduleRemindersForAppointment(appointmentId),
    ]);
  } catch (e) {
    log.warn("notif setup failed", { err: e, appointment_id: appointmentId });
  }

  // Marca presença=busy. Best-effort: se falhar, médica fica online
  // mas o front mostra "em consulta" porque tem appointment ativo.
  try {
    await setPresenceStatus(doctorId, "busy", { source: "manual" });
  } catch (e) {
    log.warn("presence busy failed", { err: e, doctor_id: doctorId });
  }

  log.info("accepted", {
    request_id: requestId,
    appointment_id: appointmentId,
    doctor_id: doctorId,
  });

  return NextResponse.json({
    ok: true,
    appointmentId,
    salaUrl: `/medico/consultas/${appointmentId}`,
  });
}
