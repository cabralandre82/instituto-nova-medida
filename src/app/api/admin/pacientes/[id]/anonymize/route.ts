/**
 * POST /api/admin/pacientes/[id]/anonymize — D-045 · 3.G
 *
 * Anonimiza o paciente em cumprimento ao direito de eliminação /
 * anonimização (LGPD Art. 18, IV e VI). Irreversível.
 *
 * Request body (opcional):
 *   {
 *     "confirm": "anonimizar",    // obrigatório, literal, evita PUT acidental
 *     "force": false              // default false; se true, ignora bloqueio
 *                                 // de fulfillment em paid/pharmacy_requested/shipped
 *   }
 *
 * Responses:
 *   200 { ok: true, anonymizedRef, anonymizedAt }
 *   400 { ok: false, error: "confirmation_required" }
 *   404 { ok: false, error: "customer_not_found" }
 *   409 { ok: false, error: "already_anonymized" | "has_active_fulfillment" }
 *   500 { ok: false, error: "update_failed" }
 *
 * Observações pro operador:
 *   - Após anonimizar, o usuário no `auth.users` continua linkado.
 *     Se o paciente usa acesso logado, revogue manualmente pelo
 *     Supabase Auth (runbook).
 *   - Dados fiscais e clínicos NÃO são apagados (retenção legal).
 *     Apenas a PII do `customers` é substituída por placeholders.
 */

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { anonymizePatient } from "@/lib/patient-lgpd";
import {
  getAuditContextFromRequest,
  logAdminAction,
} from "@/lib/admin-audit-log";
import {
  getAccessContextFromRequest,
  logPatientAccess,
} from "@/lib/patient-access-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  confirm?: string;
  force?: boolean;
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
          'Envie {"confirm": "anonimizar"} no body pra confirmar a ação irreversível.',
      },
      { status: 400 }
    );
  }

  try {
    const supabase = getSupabaseAdmin();
    const result = await anonymizePatient(supabase, id, {
      force: body.force === true,
    });

    if (!result.ok) {
      const statusCode =
        result.code === "customer_not_found"
          ? 404
          : result.code === "already_anonymized" ||
            result.code === "has_active_fulfillment"
          ? 409
          : 500;
      return NextResponse.json(
        { ok: false, error: result.code, message: result.message },
        { status: statusCode }
      );
    }

    // PR-031: LGPD exige rastro obrigatório de ações irreversíveis
    // sobre dados pessoais (Art. 37). failHard=true porque sem log
    // a anonimização não pode ser auditada no futuro — se o insert
    // falhar, devolvemos 500 em vez de deixar o buraco.
    const auditRes = await logAdminAction(
      supabase,
      {
        actorUserId: admin.id,
        actorEmail: admin.email,
        action: "customer.anonymize",
        entityType: "customer",
        entityId: id,
        after: {
          anonymized_at: result.anonymizedAt,
          anonymized_ref: result.anonymizedRef,
        },
        metadata: {
          ...getAuditContextFromRequest(req),
          force: body.force === true,
        },
      },
      { failHard: true }
    );
    if (!auditRes.ok) {
      console.error(
        "[admin/pacientes/anonymize] audit log falhou — operação foi executada mas sem rastro:",
        auditRes.error
      );
      return NextResponse.json(
        {
          ok: false,
          error: "audit_log_failed",
          message:
            "Anonimização executada, mas rastro de auditoria não foi gravado. Contate o responsável técnico com urgência.",
          anonymizedRef: result.anonymizedRef,
          anonymizedAt: result.anonymizedAt,
        },
        { status: 500 }
      );
    }

    // PR-032 · D-051: trilha específica por customer_id pro relatório
    // LGPD. failSoft — admin_audit_log failHard acima já garantiu
    // rastro obrigatório.
    await logPatientAccess(supabase, {
      adminUserId: admin.id,
      adminEmail: admin.email,
      customerId: id,
      action: "anonymize",
      metadata: {
        ...getAccessContextFromRequest(req),
        anonymizedRef: result.anonymizedRef,
        force: body.force === true,
      },
    });

    return NextResponse.json({
      ok: true,
      anonymizedRef: result.anonymizedRef,
      anonymizedAt: result.anonymizedAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown_error";
    console.error("[admin/pacientes/anonymize] failed", err);
    return NextResponse.json(
      { ok: false, error: "internal_error", message },
      { status: 500 }
    );
  }
}
