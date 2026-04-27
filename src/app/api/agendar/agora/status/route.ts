/**
 * GET /api/agendar/agora/status?id=<request_id>
 *
 * PR-080 · D-092. Polling endpoint da UI do paciente em /agendar/agora.
 * Cada 3-5s o cliente chama este endpoint pra detectar transição
 * pending → accepted/cancelled/expired.
 *
 * Quando aceito, devolve:
 *   - status: "accepted"
 *   - appointmentId: <uuid>
 *   - consultaUrl: URL pública (com patient token assinado, TTL 7d)
 *
 * Auth: lead cookie. O request precisa pertencer ao customer associado
 * ao lead atual (mesma trilha de `/api/agendar/agora`). Sem isso →
 * 404 (sem oracle pra atacante saber se request_id existe).
 *
 * Não-objetivo: não atualiza nada. É read-only.
 */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSupabaseAdmin } from "@/lib/supabase";
import { LEAD_COOKIE_NAME } from "@/lib/lead-cookie";
import { getRequestById, computeSecondsUntilExpiry } from "@/lib/on-demand";
import { signPatientToken, buildConsultationUrl } from "@/lib/patient-tokens";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/agendar/agora/status" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ ok: false, error: "id_required" }, { status: 400 });
  }

  const cookieStore = await cookies();
  const leadId = cookieStore.get(LEAD_COOKIE_NAME)?.value ?? null;
  if (!leadId) {
    return NextResponse.json(
      { ok: false, error: "lead_required" },
      { status: 401 }
    );
  }

  const supabase = getSupabaseAdmin();

  // Resolve customer do lead.
  const { data: lead } = await supabase
    .from("leads")
    .select("id")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) {
    return NextResponse.json(
      { ok: false, error: "lead_invalid_or_expired" },
      { status: 401 }
    );
  }

  const { data: customers } = await supabase
    .from("customers")
    .select("id")
    .eq("lead_id", leadId);
  const customerIds = ((customers ?? []) as Array<{ id: string }>).map(
    (c) => c.id
  );

  const request = await getRequestById(id);
  if (!request) {
    return NextResponse.json(
      { ok: false, error: "not_found" },
      { status: 404 }
    );
  }
  // Bind: request precisa pertencer a um customer ligado ao lead atual.
  if (!customerIds.includes(request.customer_id)) {
    log.warn("status: forbidden bind", {
      request_id: id,
      lead_id: leadId,
    });
    return NextResponse.json(
      { ok: false, error: "not_found" },
      { status: 404 }
    );
  }

  const secondsUntilExpiry = computeSecondsUntilExpiry({
    expiresAt: request.expires_at,
  });

  if (request.status === "accepted" && request.accepted_appointment_id) {
    const token = signPatientToken(request.accepted_appointment_id, {
      ttlSeconds: 7 * 24 * 3600,
    });
    const consultaUrl = buildConsultationUrl(
      request.accepted_appointment_id,
      token
    );
    return NextResponse.json({
      ok: true,
      status: "accepted",
      appointmentId: request.accepted_appointment_id,
      consultaUrl,
      acceptedAt: request.accepted_at,
    });
  }

  return NextResponse.json({
    ok: true,
    status: request.status,
    expiresAt: request.expires_at,
    secondsUntilExpiry,
    cancelledReason: request.cancelled_reason,
  });
}
