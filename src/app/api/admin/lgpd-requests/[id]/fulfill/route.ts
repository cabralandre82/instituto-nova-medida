/**
 * POST /api/admin/lgpd-requests/[id]/fulfill — PR-017 · D-051 · Onda 2A
 *
 * Admin triaga e executa um pedido de anonimização pendente. Reusa
 * `fulfillAnonymizeRequest`, que por sua vez chama `anonymizePatient`.
 *
 * Body (opcional):
 *   { "confirm": "anonimizar", "force": false }
 *
 * `confirm` exigido literal pra evitar POST acidental de ferramenta.
 * `force=true` ignora bloqueio por fulfillment ativo — justificativa
 * escrita obrigatória no admin_audit_log via metadata.
 */

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { fulfillAnonymizeRequest } from "@/lib/patient-lgpd-requests";
import {
  getAuditContextFromRequest,
  logAdminAction,
} from "@/lib/admin-audit-log";
import {
  getAccessContextFromRequest,
  logPatientAccess,
} from "@/lib/patient-access-log";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/admin/lgpd-requests/[id]/fulfill" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  confirm?: string;
  force?: boolean;
  reason?: string;
};

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Body;

  if ((body.confirm ?? "").trim().toLowerCase() !== "anonimizar") {
    return NextResponse.json(
      {
        ok: false,
        error: "confirmation_required",
        message:
          'Envie {"confirm":"anonimizar"} no body pra confirmar a execução irreversível.',
      },
      { status: 400 }
    );
  }

  try {
    const supabase = getSupabaseAdmin();
    const res = await fulfillAnonymizeRequest(supabase, {
      requestId: id,
      adminUserId: admin.id,
      force: body.force === true,
    });

    if (!res.ok) {
      const status =
        res.code === "not_found" || res.code === "customer_not_found"
          ? 404
          : res.code === "not_pending" ||
            res.code === "already_anonymized" ||
            res.code === "has_active_fulfillment"
          ? 409
          : 500;
      return NextResponse.json(
        { ok: false, error: res.code, message: res.message },
        { status }
      );
    }

    // LGPD Art. 37 + D-051: todo fulfillment de anonimização precisa de
    // rastro. failHard garante que sem log, não retornamos sucesso.
    const auditRes = await logAdminAction(
      supabase,
      {
        actorUserId: admin.id,
        actorEmail: admin.email,
        action: "lgpd.anonymize_request.fulfill",
        entityType: "lgpd_request",
        entityId: id,
        after: {
          customer_id: res.customerId,
          anonymized_at: res.anonymizedAt,
          anonymized_ref: res.anonymizedRef,
        },
        metadata: {
          ...getAuditContextFromRequest(req),
          force: body.force === true,
          reason: body.reason ?? null,
        },
      },
      { failHard: true }
    );
    if (!auditRes.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: "audit_log_failed",
          message:
            "Anonimização executada, mas rastro de auditoria falhou. Registre manualmente e contate o responsável técnico.",
          anonymizedRef: res.anonymizedRef,
          anonymizedAt: res.anonymizedAt,
        },
        { status: 500 }
      );
    }

    // PR-032 · D-051: além do admin_audit_log, registramos na trilha
    // específica de acesso a paciente — facilita relatórios por
    // customer_id e cumpre requisito LGPD Art. 37 de rastreabilidade
    // de operações sobre dados pessoais. failSoft porque audit_log já
    // garantiu a irreversibilidade via failHard acima.
    await logPatientAccess(supabase, {
      adminUserId: admin.id,
      adminEmail: admin.email,
      customerId: res.customerId,
      action: "lgpd_fulfill",
      reason: body.reason ?? null,
      metadata: {
        ...getAccessContextFromRequest(req),
        requestId: id,
        anonymizedRef: res.anonymizedRef,
        force: body.force === true,
      },
    });

    return NextResponse.json({
      ok: true,
      requestId: id,
      customerId: res.customerId,
      anonymizedRef: res.anonymizedRef,
      anonymizedAt: res.anonymizedAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown_error";
    log.error("failed", { err, request_id: id });
    return NextResponse.json(
      { ok: false, error: "internal_error", message },
      { status: 500 }
    );
  }
}
