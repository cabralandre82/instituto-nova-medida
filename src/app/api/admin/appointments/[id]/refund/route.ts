/**
 * POST /api/admin/appointments/[id]/refund
 *
 * Registra que o refund pro paciente foi PROCESSADO. Hoje só suporta
 * `method='manual'` (admin abre painel Asaas, emite o estorno lá, e marca
 * aqui pro sistema saber). O gancho pra `method='asaas_api'` já está no
 * schema e na lib (`processRefundViaAsaas`) — Sprint 5 liga.
 *
 * Body JSON:
 *   {
 *     "external_ref"?: string,  // id do refund no Asaas (rf_xxx) ou txid PIX
 *     "notes"?: string          // observações humanas
 *   }
 *
 * Pré-condições:
 *   - Appointment existe.
 *   - `refund_required = true` (a política de no-show marcou direito).
 *   - `refund_processed_at IS NULL` (não processado ainda).
 *
 * Idempotência: chamada repetida com o mesmo appointment retorna 200 com
 * `already_processed=true`, sem sobrescrever os campos registrados da
 * primeira vez.
 */

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { markRefundProcessed } from "@/lib/refunds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  external_ref?: string;
  notes?: string;
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
    // body vazio é aceitável — admin pode só querer marcar como processado sem ref
  }

  const result = await markRefundProcessed({
    appointmentId: id,
    method: "manual",
    externalRef: body.external_ref ?? null,
    notes: body.notes ?? null,
    processedBy: admin.id,
  });

  if (!result.ok) {
    const httpStatus =
      result.code === "appointment_not_found"
        ? 404
        : result.code === "refund_not_required"
        ? 409
        : 500;
    return NextResponse.json(
      { ok: false, code: result.code, error: result.message },
      { status: httpStatus }
    );
  }

  return NextResponse.json({
    ok: true,
    appointment_id: result.appointmentId,
    processed_at: result.processedAt,
    method: result.method,
    already_processed: result.alreadyProcessed,
  });
}
