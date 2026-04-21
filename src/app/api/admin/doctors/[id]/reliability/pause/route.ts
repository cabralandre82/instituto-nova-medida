/**
 * POST /api/admin/doctors/[id]/reliability/pause
 *
 * Pausa manualmente uma médica por regra de confiabilidade (D-036).
 * A médica fica fora do `/agendar` até admin dar unpause; appointments
 * já marcados seguem seu curso.
 *
 * Body JSON:
 *   {
 *     "reason": string,                   // obrigatório
 *     "until_reviewed"?: boolean          // default true
 *   }
 */

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { pauseDoctor } from "@/lib/reliability";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  getAuditContextFromRequest,
  logAdminAction,
} from "@/lib/admin-audit-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  reason?: string;
  until_reviewed?: boolean;
};

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  const { id } = await params;

  let body: Body = {};
  try {
    const parsed = (await req.json()) as Body | null;
    if (parsed && typeof parsed === "object") body = parsed;
  } catch {
    // body vazio — vamos exigir reason explicitamente
  }

  const reason = (body.reason ?? "").trim();
  if (!reason || reason.length < 4) {
    return NextResponse.json(
      {
        ok: false,
        code: "reason_required",
        error: "Informe o motivo do pause (mín. 4 caracteres).",
      },
      { status: 400 }
    );
  }

  const result = await pauseDoctor({
    doctorId: id,
    triggeredBy: admin.id,
    auto: false,
    reason,
    untilReviewed: body.until_reviewed ?? true,
  });

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, code: result.code, error: result.message },
      { status: result.code === "doctor_not_found" ? 404 : 500 }
    );
  }

  if (!result.alreadyPaused) {
    await logAdminAction(getSupabaseAdmin(), {
      actorUserId: admin.id,
      actorEmail: admin.email,
      action: "doctor.reliability_pause",
      entityType: "doctor",
      entityId: id,
      after: {
        paused_at: result.pausedAt,
        previously_paused_auto: result.previouslyPausedAuto,
      },
      metadata: {
        ...getAuditContextFromRequest(req),
        reason,
        until_reviewed: body.until_reviewed ?? true,
      },
    });
  }

  return NextResponse.json({
    ok: true,
    doctor_id: result.doctorId,
    paused_at: result.pausedAt,
    already_paused: result.alreadyPaused,
    previously_paused_auto: result.previouslyPausedAuto,
  });
}
