/**
 * POST /api/admin/appointments/[id]/refund
 *
 * Registra que o refund pro paciente foi processado. Dois modos:
 *
 *   - `method='manual'`  → admin abriu o painel Asaas e emitiu o estorno
 *     lá (ou fez PIX direto). Só registra metadata no nosso lado.
 *
 *   - `method='asaas_api'` → chama a Asaas API pra estornar
 *     automaticamente e depois registra. Requer
 *     `REFUNDS_VIA_ASAAS=true` no env (D-034).
 *
 * Default:
 *   - Sem `method` no body → usa `asaas_api` se feature ligada, senão
 *     `manual` (preserva comportamento pré-D-034).
 *   - `asaas_api` explícito com feature desligada → 400.
 *
 * Body JSON:
 *   {
 *     "method"?: "manual" | "asaas_api",
 *     "external_ref"?: string,   // só usado em method='manual'
 *     "notes"?: string           // só usado em method='manual'
 *   }
 *
 * Fallback pra UI (D-034):
 *   Quando Asaas retorna erro (saldo insuficiente, cartão muito antigo,
 *   chargeback em curso, etc), devolvemos 502 com `code='asaas_api_error'`
 *   + os detalhes do Asaas em `asaas_status`/`asaas_code`. A UI usa isso
 *   pra mostrar o erro e abrir o form manual pré-preenchido — sem
 *   perder o contexto.
 */

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import {
  markRefundProcessed,
  processRefundViaAsaas,
  isAsaasRefundsEnabled,
  type RefundMethod,
  type RefundResult,
} from "@/lib/refunds";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  getAuditContextFromRequest,
  logAdminAction,
} from "@/lib/admin-audit-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  method?: RefundMethod;
  external_ref?: string;
  notes?: string;
};

function resolveMethod(requested: RefundMethod | undefined): {
  ok: true;
  method: RefundMethod;
} | {
  ok: false;
  error: string;
} {
  const asaasOn = isAsaasRefundsEnabled();

  if (!requested) {
    return { ok: true, method: asaasOn ? "asaas_api" : "manual" };
  }

  if (requested === "asaas_api" && !asaasOn) {
    return {
      ok: false,
      error:
        "Estorno automático via Asaas está desligado (REFUNDS_VIA_ASAAS!='true'). Use method='manual' ou ative a flag.",
    };
  }

  return { ok: true, method: requested };
}

function httpStatusFromRefundResult(result: RefundResult): number {
  if (result.ok) return 200;
  switch (result.code) {
    case "appointment_not_found":
      return 404;
    case "refund_not_required":
    case "already_processed":
    case "appointment_no_payment":
    case "asaas_payment_missing":
      return 409;
    case "asaas_disabled":
      return 400;
    case "asaas_api_error":
      return 502; // bad gateway — upstream falhou
    default:
      return 500;
  }
}

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
    // body vazio é aceitável — admin pode só querer marcar sem ref/notes
  }

  const methodResolution = resolveMethod(body.method);
  if (!methodResolution.ok) {
    return NextResponse.json(
      { ok: false, code: "asaas_disabled", error: methodResolution.error },
      { status: 400 }
    );
  }

  let result: RefundResult;
  if (methodResolution.method === "asaas_api") {
    result = await processRefundViaAsaas({
      appointmentId: id,
      processedBy: admin.id,
      processedByEmail: admin.email,
    });
  } else {
    result = await markRefundProcessed({
      appointmentId: id,
      method: "manual",
      externalRef: body.external_ref ?? null,
      notes: body.notes ?? null,
      processedBy: admin.id,
      processedByEmail: admin.email,
    });
  }

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        code: result.code,
        error: result.message,
        asaas_status: "asaasStatus" in result ? result.asaasStatus ?? null : null,
        asaas_code: "asaasCode" in result ? result.asaasCode ?? null : null,
      },
      { status: httpStatusFromRefundResult(result) }
    );
  }

  // PR-031: audita refund só quando efetivamente processado agora
  // (evita poluir o log com alreadyProcessed, que é no-op idempotente).
  if (!result.alreadyProcessed) {
    await logAdminAction(getSupabaseAdmin(), {
      actorUserId: admin.id,
      actorEmail: admin.email,
      action: "refund.mark_processed",
      entityType: "appointment",
      entityId: result.appointmentId,
      after: {
        method: result.method,
        processed_at: result.processedAt,
        external_ref: result.externalRef ?? null,
      },
      metadata: {
        ...getAuditContextFromRequest(req),
        notes: body.notes ?? null,
      },
    });
  }

  return NextResponse.json({
    ok: true,
    appointment_id: result.appointmentId,
    processed_at: result.processedAt,
    method: result.method,
    already_processed: result.alreadyProcessed,
    external_ref: result.externalRef ?? null,
  });
}
