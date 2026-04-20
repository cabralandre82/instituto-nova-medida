/**
 * POST /api/medico/appointments/[id]/finalize — D-044 · onda 2.B
 *
 * A médica finaliza uma consulta, declarando se prescreveu um plano
 * ou apenas avaliou sem indicação. Quando prescreve, o endpoint
 * cria o `fulfillment(pending_acceptance)` que será consumido pela
 * tela de aceite formal do paciente (onda 2.C).
 *
 * Hard-gate: só a médica dona do appointment pode finalizar.
 * Idempotente: tentativas de re-finalização retornam 409; tentativa
 * em paralelo não duplica fulfillment (unique no banco + checagem
 * prévia na lib).
 *
 * Toda a lógica mora em `src/lib/appointment-finalize.ts` (testada
 * unitariamente). Esta rota é apenas o transport + auth.
 */

import { NextResponse } from "next/server";
import { requireDoctor } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  finalizeAppointment,
  type FinalizeInput,
  type PrescriptionDecision,
} from "@/lib/appointment-finalize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  decision?: string;
  anamnese?: unknown;
  hipotese?: unknown;
  conduta?: unknown;
  prescribed_plan_id?: unknown;
  memed_prescription_url?: unknown;
  memed_prescription_id?: unknown;
};

type RouteParams = { params: Promise<{ id: string }> };

function asStringOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function asAnamnese(v: unknown): Record<string, unknown> | null {
  if (v == null) return null;
  if (typeof v === "string") {
    const trimmed = v.trim();
    return trimmed.length === 0 ? null : { text: trimmed };
  }
  if (typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

export async function POST(req: Request, { params }: RouteParams) {
  const { id: appointmentId } = await params;
  const { user, doctorId } = await requireDoctor();

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_json", message: "JSON inválido." },
      { status: 400 }
    );
  }

  const input: FinalizeInput = {
    decision: body.decision as PrescriptionDecision,
    anamnese: asAnamnese(body.anamnese),
    hipotese: asStringOrNull(body.hipotese),
    conduta: asStringOrNull(body.conduta),
    prescribed_plan_id: asStringOrNull(body.prescribed_plan_id),
    memed_prescription_url: asStringOrNull(body.memed_prescription_url),
    memed_prescription_id: asStringOrNull(body.memed_prescription_id),
  };

  const supabase = getSupabaseAdmin();
  const result = await finalizeAppointment(supabase, {
    appointmentId,
    doctorId,
    userId: user.id,
    input,
  });

  if (!result.ok) {
    const statusByCode: Record<typeof result.code, number> = {
      not_found: 404,
      forbidden: 403,
      cancelled: 409,
      already_finalized: 409,
      invalid_payload: 400,
      plan_not_active: 400,
      db_error: 500,
    };
    return NextResponse.json(
      {
        ok: false,
        error: result.code,
        message: result.message,
        field: result.field,
      },
      { status: statusByCode[result.code] ?? 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    appointmentId: result.appointmentId,
    fulfillmentId: result.fulfillmentId,
    status: result.status,
  });
}
