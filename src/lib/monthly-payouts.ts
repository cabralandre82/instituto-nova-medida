/**
 * Geração mensal de payouts (D-040).
 *
 * Reimplementação Node da RPC `generate_monthly_payouts()` com
 * observabilidade rica:
 *   - Relata médicas puladas por falta de PIX ativo.
 *   - Relata médicas puladas por conflito (payout já existe no período).
 *   - Vincula earnings de forma idempotente (guard por status).
 *   - Marca `auto_generated=true` nos drafts gerados aqui.
 *
 * Regra (COMPENSATION.md):
 *   - Período = mês anterior ao momento da execução, formato 'YYYY-MM'.
 *   - Por médica `status='active'`, agregar earnings com:
 *       status='available'
 *       payout_id IS NULL
 *       available_at < primeiro dia do mês corrente
 *   - Se `sum(amount_cents) <> 0`, criar `doctor_payouts` draft com
 *     snapshot do PIX ativo (`doctor_payment_methods`).
 *   - Vincular earnings agregadas ao payout (`payout_id=new`, `status='in_payout'`).
 *
 * Idempotência:
 *   * UNIQUE(doctor_id, reference_period) no banco impede duplicatas.
 *   * Se INSERT colide, tratamos como "já gerado" e seguimos — sem erro.
 *   * Rodar duas vezes no mesmo período resulta em
 *     `payoutsSkippedExisting` > 0 e `payoutsCreated` = 0 na segunda.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type GenerateMonthlyPayoutsOptions = {
  /**
   * Override do período de referência (YYYY-MM). Se omitido, usa o mês
   * anterior ao `now` atual. Útil para backfill manual ou testes.
   */
  referencePeriod?: string;
  /**
   * Override do `now` — só pra testes. Não usar em produção.
   */
  now?: Date;
};

export type DoctorPayoutWarning = {
  doctorId: string;
  doctorName: string | null;
  amountCents: number;
  earningsCount: number;
  reason:
    | "missing_pix_active"
    | "pix_key_empty"
    | "existing_payout"
    | "doctor_inactive"
    | "doctor_not_found";
};

export type GenerateMonthlyPayoutsResult = {
  ok: true;
  referencePeriod: string;
  doctorsEvaluated: number;
  payoutsCreated: number;
  payoutsSkippedExisting: number;
  payoutsSkippedMissingPix: number;
  earningsLinked: number;
  totalCentsDrafted: number;
  warnings: DoctorPayoutWarning[];
  errors: number;
  errorDetails: string[];
};

type AvailableRow = {
  id: string;
  doctor_id: string;
  amount_cents: number;
};

type DoctorRow = {
  id: string;
  full_name: string | null;
  display_name: string | null;
  status: string;
};

type PaymentMethodRow = {
  doctor_id: string;
  pix_key: string | null;
  pix_key_type: string | null;
  pix_key_holder: string | null;
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * Calcula o reference_period default = mês anterior a `now` em fuso UTC
 * (o formato 'YYYY-MM' não depende de TZ — a ambiguidade cross-TZ é
 * menor que 1 dia e não muda o mês exceto na virada às 00:00 BRT, quando
 * o cron já foi disparado às 09:00 UTC = 06:00 BRT do dia 1).
 */
export function defaultReferencePeriod(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-indexed; mês anterior = month - 1
  const previousMonthIndex = month === 0 ? 12 : month;
  const previousYear = month === 0 ? year - 1 : year;
  return `${previousYear}-${pad2(previousMonthIndex)}`;
}

/**
 * Primeiro dia do mês *corrente* em que o cron está rodando (limite
 * superior exclusivo pras earnings elegíveis). Em ISO UTC.
 */
export function currentMonthStartIso(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return new Date(Date.UTC(y, m, 1, 0, 0, 0, 0)).toISOString();
}

export async function generateMonthlyPayouts(
  supabase: SupabaseClient,
  opts: GenerateMonthlyPayoutsOptions = {}
): Promise<GenerateMonthlyPayoutsResult> {
  const now = opts.now ?? new Date();
  const referencePeriod = opts.referencePeriod ?? defaultReferencePeriod(now);
  const monthStart = currentMonthStartIso(now);

  const result: GenerateMonthlyPayoutsResult = {
    ok: true,
    referencePeriod,
    doctorsEvaluated: 0,
    payoutsCreated: 0,
    payoutsSkippedExisting: 0,
    payoutsSkippedMissingPix: 0,
    earningsLinked: 0,
    totalCentsDrafted: 0,
    warnings: [],
    errors: 0,
    errorDetails: [],
  };

  // 1) Earnings candidatas: available + sem payout + available_at < mês atual
  const { data: earningsData, error: earningsErr } = await supabase
    .from("doctor_earnings")
    .select("id, doctor_id, amount_cents")
    .eq("status", "available")
    .is("payout_id", null)
    .lt("available_at", monthStart);

  if (earningsErr) {
    result.errors += 1;
    result.errorDetails.push(`select available: ${earningsErr.message}`);
    return result;
  }

  const earnings = (earningsData ?? []) as unknown as AvailableRow[];
  if (earnings.length === 0) {
    return result;
  }

  // 2) Agrega por médica
  const perDoctor = new Map<
    string,
    { total: number; count: number; earningIds: string[] }
  >();
  for (const e of earnings) {
    const agg = perDoctor.get(e.doctor_id) ?? {
      total: 0,
      count: 0,
      earningIds: [],
    };
    agg.total += e.amount_cents;
    agg.count += 1;
    agg.earningIds.push(e.id);
    perDoctor.set(e.doctor_id, agg);
  }

  // Descarta médicas com sum(amount_cents) === 0 (ex: clawback zera tudo)
  for (const [doctorId, agg] of perDoctor) {
    if (agg.total === 0) perDoctor.delete(doctorId);
  }

  if (perDoctor.size === 0) return result;

  const doctorIds = Array.from(perDoctor.keys());

  // 3) Carrega status e PIX ativo de cada médica num batch
  const [{ data: doctorsData, error: doctorsErr }, { data: pmData, error: pmErr }] =
    await Promise.all([
      supabase
        .from("doctors")
        .select("id, full_name, display_name, status")
        .in("id", doctorIds),
      supabase
        .from("doctor_payment_methods")
        .select("doctor_id, pix_key, pix_key_type, pix_key_holder")
        .in("doctor_id", doctorIds)
        .eq("active", true),
    ]);

  if (doctorsErr) {
    result.errors += 1;
    result.errorDetails.push(`select doctors: ${doctorsErr.message}`);
    return result;
  }
  if (pmErr) {
    result.errors += 1;
    result.errorDetails.push(`select payment_methods: ${pmErr.message}`);
    return result;
  }

  const doctorsById = new Map<string, DoctorRow>();
  for (const d of (doctorsData ?? []) as unknown as DoctorRow[]) {
    doctorsById.set(d.id, d);
  }
  const pmByDoctor = new Map<string, PaymentMethodRow>();
  for (const pm of (pmData ?? []) as unknown as PaymentMethodRow[]) {
    // Se houver duplicatas por bug upstream, ficamos com o primeiro
    if (!pmByDoctor.has(pm.doctor_id)) pmByDoctor.set(pm.doctor_id, pm);
  }

  // 4) Por médica: valida → cria payout → vincula earnings
  for (const [doctorId, agg] of perDoctor) {
    result.doctorsEvaluated += 1;

    const doctor = doctorsById.get(doctorId);
    const doctorName = doctor?.display_name || doctor?.full_name || null;

    if (!doctor) {
      result.warnings.push({
        doctorId,
        doctorName,
        amountCents: agg.total,
        earningsCount: agg.count,
        reason: "doctor_not_found",
      });
      result.payoutsSkippedMissingPix += 1;
      continue;
    }
    if (doctor.status !== "active") {
      // Médica inativa: não gera payout (se quiser gerar mesmo assim,
      // admin faz manual); registra warning pra review.
      result.warnings.push({
        doctorId,
        doctorName,
        amountCents: agg.total,
        earningsCount: agg.count,
        reason: "doctor_inactive",
      });
      result.payoutsSkippedMissingPix += 1;
      continue;
    }

    const pm = pmByDoctor.get(doctorId);
    if (!pm || !pm.pix_key || !pm.pix_key.trim()) {
      result.warnings.push({
        doctorId,
        doctorName,
        amountCents: agg.total,
        earningsCount: agg.count,
        reason: pm ? "pix_key_empty" : "missing_pix_active",
      });
      result.payoutsSkippedMissingPix += 1;
      continue;
    }

    // 4a) Insere o payout — se bater UNIQUE, trata como existing
    const insertRes = await supabase
      .from("doctor_payouts")
      .insert({
        doctor_id: doctorId,
        reference_period: referencePeriod,
        amount_cents: agg.total,
        earnings_count: agg.count,
        pix_key_snapshot: pm.pix_key,
        pix_key_type_snapshot: pm.pix_key_type,
        pix_key_holder_snapshot: pm.pix_key_holder,
        status: "draft",
        auto_generated: true,
      })
      .select("id")
      .single();

    if (insertRes.error) {
      // 23505 = unique violation (Postgres) — payout do período já existe
      const code = (insertRes.error as unknown as { code?: string }).code;
      if (code === "23505") {
        result.payoutsSkippedExisting += 1;
        result.warnings.push({
          doctorId,
          doctorName,
          amountCents: agg.total,
          earningsCount: agg.count,
          reason: "existing_payout",
        });
        continue;
      }
      result.errors += 1;
      result.errorDetails.push(
        `insert payout ${doctorId}: ${insertRes.error.message}`
      );
      continue;
    }

    const newPayoutId = (insertRes.data as { id: string }).id;

    // 4b) Vincula earnings — guard por status garante que só pega as
    // que continuam 'available' (defesa contra corrida com clawback).
    const { data: linked, error: linkErr } = await supabase
      .from("doctor_earnings")
      .update({
        payout_id: newPayoutId,
        status: "in_payout",
        updated_at: new Date().toISOString(),
      })
      .in("id", agg.earningIds)
      .eq("status", "available")
      .is("payout_id", null)
      .select("id");

    if (linkErr) {
      result.errors += 1;
      result.errorDetails.push(
        `link earnings ${doctorId}: ${linkErr.message}`
      );
      continue;
    }

    const linkedCount = (linked ?? []).length;
    result.earningsLinked += linkedCount;
    result.payoutsCreated += 1;
    result.totalCentsDrafted += agg.total;

    // Edge-case raro: payout foi criado mas 0 earnings vinculadas
    // (todas viraram cancelled entre o select e o update).
    if (linkedCount === 0) {
      result.warnings.push({
        doctorId,
        doctorName,
        amountCents: 0,
        earningsCount: 0,
        reason: "existing_payout",
      });
    }
  }

  return result;
}
