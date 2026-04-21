/**
 * POST /api/admin/lgpd-requests/[id]/reject — PR-017 · D-051 · Onda 2A
 *
 * Admin recusa um pedido de anonimização pendente com motivo
 * (obrigatório). A recusa também é auditada — paciente pode
 * questionar depois, e o motivo vira a defesa.
 *
 * Recusas típicas:
 *   - "Paciente tem chargeback ativo; aguardar conclusão financeira."
 *   - "Tratamento em curso; aguardar entrega ou cancelar antes."
 */

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { rejectAnonymizeRequest } from "@/lib/patient-lgpd-requests";
import {
  getAuditContextFromRequest,
  logAdminAction,
} from "@/lib/admin-audit-log";
import {
  getAccessContextFromRequest,
  logPatientAccess,
} from "@/lib/patient-access-log";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/admin/lgpd-requests/[id]/reject" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  reason?: string;
};

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Body;
  const reason = (body.reason ?? "").trim();

  if (!reason) {
    return NextResponse.json(
      {
        ok: false,
        error: "reason_required",
        message: "Envie { reason: '...' } com o motivo da recusa.",
      },
      { status: 400 }
    );
  }

  try {
    const supabase = getSupabaseAdmin();
    const res = await rejectAnonymizeRequest(supabase, {
      requestId: id,
      adminUserId: admin.id,
      reason,
    });

    if (!res.ok) {
      const status =
        res.code === "not_found"
          ? 404
          : res.code === "not_pending"
          ? 409
          : 500;
      return NextResponse.json(
        { ok: false, error: res.code, message: res.message },
        { status }
      );
    }

    const auditRes = await logAdminAction(
      supabase,
      {
        actorUserId: admin.id,
        actorEmail: admin.email,
        action: "lgpd.anonymize_request.reject",
        entityType: "lgpd_request",
        entityId: id,
        metadata: {
          ...getAuditContextFromRequest(req),
          reason,
        },
      },
      // failSoft aqui — recusa não é irreversível, registro opcional no
      // admin_audit_log pode falhar sem bloquear. Mas logamos no console.
      { failHard: false }
    );
    if (!auditRes.ok) {
      log.error("audit log falhou", { err: auditRes.error, request_id: id });
    }

    // PR-032 · D-051: trilha separada por customer_id.
    await logPatientAccess(supabase, {
      adminUserId: admin.id,
      adminEmail: admin.email,
      customerId: res.customerId,
      action: "lgpd_reject",
      reason,
      metadata: {
        ...getAccessContextFromRequest(req),
        requestId: id,
      },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown_error";
    log.error("failed", { err, request_id: id });
    return NextResponse.json(
      { ok: false, error: "internal_error", message },
      { status: 500 }
    );
  }
}
