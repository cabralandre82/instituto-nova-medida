/**
 * POST /api/admin/credits/[id]/consume (PR-073-C · D-083)
 *
 * Marca um `appointment_credits` row como `consumed`, referenciando o
 * novo `appointment_id` criado pro reagendamento. Idempotente:
 * chamar 2× com o mesmo payload devolve `already_consumed=true`.
 *
 * Body JSON:
 *   { "consumed_appointment_id": "<uuid>" }
 *
 * Políticas:
 *   - Admin-only (requireAdmin já checa).
 *   - Status='active' é pré-condição. Se crédito está consumed/cancelled
 *     com outro appointment_id → 409 not_active.
 *   - Usa `markCreditConsumed` da lib — toda lógica de guard já está lá.
 *   - Audita em `admin_audit_log` só quando transição real aconteceu
 *     (não registra idempotência, pra não poluir o log).
 *
 * Responses:
 *   200 { ok: true, already_consumed: boolean }
 *   400 { ok: false, code: "invalid_credit_id" | "invalid_appointment_id" | "missing_body" }
 *   404 { ok: false, code: "not_found" }
 *   409 { ok: false, code: "not_active" }
 *   500 { ok: false, code: "db_error" }
 */

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { markCreditConsumed } from "@/lib/appointment-credits";
import { actorSnapshotFromSession } from "@/lib/actor-snapshot";
import {
  getAuditContextFromRequest,
  logAdminAction,
} from "@/lib/admin-audit-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  consumed_appointment_id?: string;
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

  const consumedAppointmentId = (body.consumed_appointment_id ?? "").trim();
  if (!consumedAppointmentId) {
    return NextResponse.json(
      {
        ok: false,
        code: "invalid_appointment_id",
        error: "Informe consumed_appointment_id (uuid do appointment reagendado).",
      },
      { status: 400 },
    );
  }

  const supabase = getSupabaseAdmin();
  const actor = actorSnapshotFromSession(
    { id: admin.id, email: admin.email },
    "admin",
  );

  const result = await markCreditConsumed({
    supabase,
    creditId: id,
    consumedAppointmentId,
    actor,
  });

  if (!result.ok) {
    const status =
      result.error === "not_found"
        ? 404
        : result.error === "invalid_credit_id" ||
            result.error === "invalid_appointment_id"
          ? 400
          : result.error === "not_active"
            ? 409
            : 500;
    return NextResponse.json(
      { ok: false, code: result.error, error: result.message ?? result.error },
      { status },
    );
  }

  if (!result.alreadyConsumed) {
    await logAdminAction(supabase, {
      actorUserId: admin.id,
      actorEmail: admin.email,
      action: "appointment_credit.consumed",
      entityType: "appointment_credit",
      entityId: id,
      after: {
        consumed_appointment_id: consumedAppointmentId,
      },
      metadata: getAuditContextFromRequest(req),
    });
  }

  return NextResponse.json({
    ok: true,
    already_consumed: result.alreadyConsumed,
  });
}
