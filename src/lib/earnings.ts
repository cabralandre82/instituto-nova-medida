/**
 * Gestão de doctor_earnings — chamado pelo webhook Asaas
 * (PAYMENT_RECEIVED → consultation earning) e pelo handler de clawback
 * (PAYMENT_REFUNDED / CHARGEBACK → refund_clawback).
 *
 * Princípios (D-022):
 *   1. Earnings imutáveis. Reverter = inserir um earning negativo
 *      apontando pro pai via parent_earning_id.
 *   2. Idempotente: não duplicar se já existe earning pro mesmo
 *      payment_id + type. Não bloquear webhook se earning falha
 *      (loga e continua).
 *   3. Snapshot: registra qual compensation_rule estava ativa no
 *      momento, pra auditoria futura mesmo se a regra mudar.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type CreateConsultationEarningInput = {
  paymentId: string;
  doctorId: string;
  appointmentId?: string;
  appointmentKind?: "scheduled" | "on_demand";
  description?: string;
};

export type CreateClawbackInput = {
  paymentId: string;
  doctorId: string;
  reason: string;
};

export type EarningResult =
  | { ok: true; earningId: string; created: boolean }
  | { ok: false; error: string };

/**
 * Carrega a regra de compensação ativa da médica.
 * Retorna defaults D-024 se nenhuma regra existe (caso patológico).
 */
async function getActiveRule(
  supabase: SupabaseClient,
  doctorId: string
): Promise<{
  id: string | null;
  consultation_cents: number;
  on_demand_bonus_cents: number;
}> {
  const { data } = await supabase
    .from("doctor_compensation_rules")
    .select("id, consultation_cents, on_demand_bonus_cents")
    .eq("doctor_id", doctorId)
    .is("effective_to", null)
    .maybeSingle();
  if (data) {
    return {
      id: data.id as string,
      consultation_cents: data.consultation_cents as number,
      on_demand_bonus_cents: data.on_demand_bonus_cents as number,
    };
  }
  return { id: null, consultation_cents: 20000, on_demand_bonus_cents: 4000 };
}

/**
 * Cria a(s) earning(s) decorrente(s) de um payment confirmado.
 * Para 'scheduled': 1 earning de tipo 'consultation'.
 * Para 'on_demand': 1 earning 'consultation' + 1 'on_demand_bonus'.
 *
 * Idempotente: retorna sem fazer nada se já existe earning desse type
 * para esse payment_id (evita duplo crédito em retry de webhook).
 */
export async function createConsultationEarning(
  supabase: SupabaseClient,
  input: CreateConsultationEarningInput
): Promise<EarningResult> {
  // Idempotência: alguma earning desse payment já existe?
  const { data: existing } = await supabase
    .from("doctor_earnings")
    .select("id, type")
    .eq("payment_id", input.paymentId)
    .in("type", ["consultation", "on_demand_bonus"]);
  if (existing && existing.length > 0) {
    return {
      ok: true,
      earningId: (existing[0] as { id: string }).id,
      created: false,
    };
  }

  const rule = await getActiveRule(supabase, input.doctorId);
  const isOnDemand = input.appointmentKind === "on_demand";
  const now = new Date().toISOString();

  // Earning principal — consulta
  const { data: consultation, error: consErr } = await supabase
    .from("doctor_earnings")
    .insert({
      doctor_id: input.doctorId,
      payment_id: input.paymentId,
      appointment_id: input.appointmentId ?? null,
      compensation_rule_id: rule.id,
      type: "consultation",
      amount_cents: rule.consultation_cents,
      description: input.description ?? "Consulta paga (webhook Asaas)",
      earned_at: now,
      status: "pending",
    })
    .select("id")
    .single();
  if (consErr || !consultation) {
    return { ok: false, error: consErr?.message ?? "Falha ao criar earning" };
  }

  // Bônus on-demand quando aplicável
  if (isOnDemand && rule.on_demand_bonus_cents > 0) {
    const { error: bonusErr } = await supabase.from("doctor_earnings").insert({
      doctor_id: input.doctorId,
      payment_id: input.paymentId,
      appointment_id: input.appointmentId ?? null,
      compensation_rule_id: rule.id,
      type: "on_demand_bonus",
      amount_cents: rule.on_demand_bonus_cents,
      description: "Bônus on-demand",
      earned_at: now,
      status: "pending",
    });
    if (bonusErr) {
      console.error("[earnings] bônus on-demand falhou:", bonusErr);
      // não bloqueia — earning principal já foi criado
    }
  }

  // Dispara recálculo de availability (preenche available_at agora que
  // payment.paid_at provavelmente já foi salvo)
  await supabase.rpc("recalculate_earnings_availability");

  return {
    ok: true,
    earningId: consultation.id as string,
    created: true,
  };
}

/**
 * Cria um clawback (earning negativo) revertendo earnings vinculados
 * a um payment. Chamado em PAYMENT_REFUNDED / PAYMENT_CHARGEBACK_*.
 *
 * Estratégia:
 *   - Para cada earning positivo no payment com status != 'cancelled'/'paid':
 *       cria irmã com amount_cents = -amount_cents (parent_earning_id)
 *       marca a original como 'cancelled' (se ainda 'pending'/'available'/'in_payout')
 *   - Para earnings já 'paid', cria clawback que ficará 'available' pro
 *     próximo payout (subtraindo do próximo lote).
 */
export async function createClawback(
  supabase: SupabaseClient,
  input: CreateClawbackInput
): Promise<{ ok: true; clawbacks: number } | { ok: false; error: string }> {
  const { data: parents, error: loadErr } = await supabase
    .from("doctor_earnings")
    .select("id, doctor_id, amount_cents, status, type, payment_id")
    .eq("payment_id", input.paymentId)
    .eq("doctor_id", input.doctorId)
    .gt("amount_cents", 0)
    .neq("status", "cancelled");
  if (loadErr) return { ok: false, error: loadErr.message };
  if (!parents || parents.length === 0) {
    return { ok: true, clawbacks: 0 };
  }

  const now = new Date().toISOString();
  let count = 0;

  for (const parent of parents as Array<{
    id: string;
    doctor_id: string;
    amount_cents: number;
    status: string;
    type: string;
  }>) {
    // Idempotência: já existe clawback desse pai?
    const { data: existingClawback } = await supabase
      .from("doctor_earnings")
      .select("id")
      .eq("parent_earning_id", parent.id)
      .eq("type", "refund_clawback")
      .maybeSingle();
    if (existingClawback) continue;

    // Cria clawback negativo
    const { error: claErr } = await supabase.from("doctor_earnings").insert({
      doctor_id: parent.doctor_id,
      payment_id: input.paymentId,
      parent_earning_id: parent.id,
      type: "refund_clawback",
      amount_cents: -parent.amount_cents,
      description: `Estorno: ${input.reason}`,
      earned_at: now,
      status: "available", // já elegível pro próximo payout
      available_at: now,
    });
    if (claErr) {
      console.error("[earnings] clawback insert:", claErr);
      continue;
    }

    // Cancela earning original se ainda não foi paga
    if (parent.status === "pending" || parent.status === "available") {
      await supabase
        .from("doctor_earnings")
        .update({
          status: "cancelled",
          cancelled_at: now,
          cancelled_reason: input.reason,
        })
        .eq("id", parent.id);
    } else if (parent.status === "in_payout") {
      // earning já está num payout draft/approved — admin precisa intervir
      console.warn(
        "[earnings] clawback enquanto earning está in_payout — admin deve revisar payout",
        parent.id
      );
    }

    count++;
  }

  return { ok: true, clawbacks: count };
}
