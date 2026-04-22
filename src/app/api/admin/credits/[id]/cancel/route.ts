/**
 * POST /api/admin/credits/[id]/cancel (PR-073-C · D-083)
 *
 * Cancela um `appointment_credits` row com razão explícita. Terminal:
 * credit cancelado não pode voltar pra active. Idempotente: chamar 2×
 * devolve `already_cancelled=true`.
 *
 * Body JSON:
 *   { "reason": "string (4..500 chars)" }
 *
 * Políticas:
 *   - Admin-only (requireAdmin).
 *   - reason obrigatório, trimado, mínimo 4 chars (para evitar "x"),
 *     máximo 500 (CHECK constraint).
 *   - Só cancela status='active'. Consumed/expired → 409.
 *   - Usa `cancelCredit` da lib.
 *   - Audit log registrado só em transição real.
 *
 * Responses:
 *   200 { ok: true, already_cancelled: boolean }
 *   400 { ok: false, code: "invalid_credit_id" | "invalid_reason" | "missing_body" }
 *   404 { ok: false, code: "not_found" }
 *   409 { ok: false, code: "not_cancellable" }
 *   500 { ok: false, code: "db_error" }
 */

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { cancelCredit } from "@/lib/appointment-credits";
import { actorSnapshotFromSession } from "@/lib/actor-snapshot";
import {
  getAuditContextFromRequest,
  logAdminAction,
} from "@/lib/admin-audit-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  reason?: string;
};

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requireAdmin();
  const { id } = await params;

  let body: Body = {};
  try {
    const parsed = (await req.json()) as Body | null;
    if (parsed && typeof parsed === "object") body = parsed;
  } catch {
    return NextResponse.json(
      { ok: false, code: "missing_body", error: "JSON inválido" },
      { status: 400 },
    );
  }

  const reason = (body.reason ?? "").trim();
  if (reason.length < 4 || reason.length > 500) {
    return NextResponse.json(
      {
        ok: false,
        code: "invalid_reason",
        error: "Razão deve ter entre 4 e 500 caracteres.",
      },
      { status: 400 },
    );
  }

  const supabase = getSupabaseAdmin();
  const actor = actorSnapshotFromSession(
    { id: admin.id, email: admin.email },
    "admin",
  );

  const result = await cancelCredit({
    supabase,
    creditId: id,
    reason,
    actor,
  });

  if (!result.ok) {
    const status =
      result.error === "not_found"
        ? 404
        : result.error === "invalid_credit_id" ||
            result.error === "invalid_reason"
          ? 400
          : result.error === "not_cancellable"
            ? 409
            : 500;
    return NextResponse.json(
      { ok: false, code: result.error, error: result.message ?? result.error },
      { status },
    );
  }

  if (!result.alreadyCancelled) {
    await logAdminAction(supabase, {
      actorUserId: admin.id,
      actorEmail: admin.email,
      action: "appointment_credit.cancelled",
      entityType: "appointment_credit",
      entityId: id,
      after: {
        cancelled_reason: reason,
      },
      metadata: getAuditContextFromRequest(req),
    });
  }

  return NextResponse.json({
    ok: true,
    already_cancelled: result.alreadyCancelled,
  });
}
