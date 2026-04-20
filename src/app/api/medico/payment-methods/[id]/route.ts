/**
 * /api/medico/payment-methods/[id] — D-042
 *
 * DELETE → remove um registro do histórico de PIX da médica.
 *   Só permite se `is_default=false`. Para trocar o default, a médica
 *   usa POST /api/medico/payment-methods (que desativa o antigo
 *   automaticamente).
 */

import { NextResponse } from "next/server";
import { requireDoctor } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { deleteHistoricalPaymentMethod } from "@/lib/doctor-payment-methods";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { doctorId } = await requireDoctor();
  const { id } = await params;

  const supabase = getSupabaseAdmin();
  const result = await deleteHistoricalPaymentMethod(supabase, doctorId, id);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
