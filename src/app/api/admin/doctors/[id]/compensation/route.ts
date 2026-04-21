/**
 * POST /api/admin/doctors/[id]/compensation
 *
 * Cria nova regra de compensação. Operação atômica:
 *   1. Fecha a regra ativa atual (effective_to = now())
 *   2. Insere a nova com effective_from = now() e reason
 *
 * Earnings JÁ existentes não mudam — eles consomem a regra que estava
 * ativa no momento do payment. Earnings futuros usam a nova.
 */

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { requireAdmin } from "@/lib/auth";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/admin/doctors/[id]/compensation" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  consultation_cents?: number;
  on_demand_bonus_cents?: number;
  plantao_hour_cents?: number;
  after_hours_multiplier?: number;
  available_days_pix?: number;
  available_days_boleto?: number;
  available_days_card?: number;
  reason?: string;
};

function nonNeg(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id: doctorId } = await params;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }

  if (
    !nonNeg(body.consultation_cents) ||
    !nonNeg(body.on_demand_bonus_cents) ||
    !nonNeg(body.plantao_hour_cents) ||
    !nonNeg(body.available_days_pix) ||
    !nonNeg(body.available_days_boleto) ||
    !nonNeg(body.available_days_card)
  ) {
    return NextResponse.json({ ok: false, error: "Valores inválidos" }, { status: 400 });
  }

  if (!body.reason || body.reason.trim().length < 5) {
    return NextResponse.json(
      { ok: false, error: "Justificativa obrigatória (mínimo 5 caracteres)" },
      { status: 400 }
    );
  }

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();

  // Confirma que a médica existe
  const { data: doctor } = await supabase
    .from("doctors")
    .select("id")
    .eq("id", doctorId)
    .maybeSingle();
  if (!doctor) {
    return NextResponse.json({ ok: false, error: "Médica não encontrada" }, { status: 404 });
  }

  // Fecha regra ativa
  const { error: closeErr } = await supabase
    .from("doctor_compensation_rules")
    .update({ effective_to: now })
    .eq("doctor_id", doctorId)
    .is("effective_to", null);
  if (closeErr) {
    log.error("close", { err: closeErr, doctor_id: doctorId });
    return NextResponse.json({ ok: false, error: closeErr.message }, { status: 500 });
  }

  // Insere nova
  const { data: rule, error: insErr } = await supabase
    .from("doctor_compensation_rules")
    .insert({
      doctor_id: doctorId,
      consultation_cents: Math.round(body.consultation_cents),
      on_demand_bonus_cents: Math.round(body.on_demand_bonus_cents),
      plantao_hour_cents: Math.round(body.plantao_hour_cents),
      after_hours_multiplier: body.after_hours_multiplier ?? 1.0,
      available_days_pix: Math.round(body.available_days_pix),
      available_days_boleto: Math.round(body.available_days_boleto),
      available_days_card: Math.round(body.available_days_card),
      effective_from: now,
      reason: body.reason.trim(),
    })
    .select("id")
    .single();
  if (insErr || !rule) {
    log.error("insert", { err: insErr, doctor_id: doctorId });
    return NextResponse.json({ ok: false, error: insErr?.message ?? "Falha" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, ruleId: rule.id });
}
