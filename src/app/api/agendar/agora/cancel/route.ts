/**
 * POST /api/agendar/agora/cancel
 *
 * PR-080 · D-092. Paciente cancela seu próprio request on-demand
 * pending. Auth via cookie de lead — request precisa pertencer a um
 * customer associado ao lead atual.
 *
 * Body:
 *   { requestId: string, reason?: string }
 *
 * Idempotente: já cancelado → 200 com `alreadyCancelled: true`.
 * Estado terminal não-cancelado (accepted, expired) → 409.
 */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSupabaseAdmin } from "@/lib/supabase";
import { LEAD_COOKIE_NAME } from "@/lib/lead-cookie";
import {
  cancelOnDemandRequest,
  getRequestById,
} from "@/lib/on-demand";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/agendar/agora/cancel" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { requestId?: string; reason?: string };

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "json_invalid" }, { status: 400 });
  }
  const requestId = typeof body.requestId === "string" ? body.requestId : "";
  if (!requestId) {
    return NextResponse.json(
      { ok: false, error: "request_id_required" },
      { status: 400 }
    );
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
  const { data: customers } = await supabase
    .from("customers")
    .select("id")
    .eq("lead_id", leadId);
  const customerIds = ((customers ?? []) as Array<{ id: string }>).map(
    (c) => c.id
  );

  const request = await getRequestById(requestId);
  if (!request || !customerIds.includes(request.customer_id)) {
    return NextResponse.json(
      { ok: false, error: "not_found" },
      { status: 404 }
    );
  }

  const result = await cancelOnDemandRequest({
    requestId,
    actorKind: "patient",
    reason: typeof body.reason === "string" ? body.reason.slice(0, 500) : undefined,
  });

  if (!result.ok) {
    if (result.reason === "cannot_cancel_accepted") {
      return NextResponse.json(
        { ok: false, error: "already_accepted" },
        { status: 409 }
      );
    }
    if (result.reason === "cannot_cancel_expired") {
      return NextResponse.json(
        { ok: false, error: "already_expired" },
        { status: 409 }
      );
    }
    log.error("cancel failed", { request_id: requestId, reason: result.reason });
    return NextResponse.json(
      { ok: false, error: "internal" },
      { status: 500 }
    );
  }

  log.info("cancelled", {
    request_id: requestId,
    already: result.alreadyCancelled,
  });
  return NextResponse.json({
    ok: true,
    alreadyCancelled: result.alreadyCancelled,
  });
}
