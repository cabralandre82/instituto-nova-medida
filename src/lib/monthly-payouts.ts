/**
 * Geração mensal de payouts (D-040, D-062).
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
 *
 * Race contra clawback (D-062 · PR-051 · finding 5.5):
 *   Entre o SELECT inicial (passo 1) e o UPDATE de vinculação (passo 4b),
 *   um webhook PAYMENT_REFUNDED / PAYMENT_CHARGEBACK pode criar um
 *   earning negativo (`type='refund_clawback'`, `status='available'`,
 *   `available_at=now`). Se `now < monthStart` ainda (virada de ciclo),
 *   esse clawback é elegível pro payout corrente, mas NÃO entrou no
 *   `agg.total` porque o SELECT já aconteceu.
 *
 *   Sintoma: payout criado com amount=+300, médica recebe via PIX, clawback
 *   de -50 fica órfão pro próximo mês → saldo inicial negativo. Se a médica
 *   sair antes, vira prejuízo do Instituto (audit 5.5).
 *
 *   Correção: após o link inicial, fazer um loop bounded de reconciliação
 *   (max 3 iter) que:
 *     (a) re-busca earnings available/unlinked do doctor (apenas com
 *         available_at < monthStart — só o ciclo corrente);
 *     (b) tenta linkar ao payout recém-criado (guard status + payout_id);
 *     (c) se encontra extras, ajusta `amount_cents` e `earnings_count` do
 *         payout (somente se ainda `draft`).
 *
 *   Se a soma final ficar ≤ 0 (clawback dominante), o payout é
 *   automaticamente cancelado (`status='cancelled'`, razão explícita)
 *   e os earnings voltam pra `available`/`payout_id=null` — o próximo
 *   ciclo reprocessa. Limite de 3 iter evita starvation em cenário
 *   patológico (chargeback em massa) — nesse caso fica warning
 *   `reconcile_incomplete` e o resto rola pro próximo mês.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "./logger";

const log = logger.with({ mod: "monthly-payouts" });

/**
 * Limite do loop de reconciliação. Valor empírico: 3 iters dão espaço
 * pra absorver até 3 rajadas consecutivas de clawback enquanto o cron
 * roda, sem arriscar loop infinito se algum bug criar earnings
 * continuamente. Na prática, a 2ª iter já deveria convergir (o cron
 * leva <5s por médica).
 */
const RECONCILE_MAX_ITERATIONS = 3;

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
    | "doctor_not_found"
    /** Extras linkados pós-criação (info — não é falha). D-062. */
    | "clawback_reconciled"
    /** Sum final ≤ 0; payout cancelado automaticamente. D-062. */
    | "clawback_dominant_cancelled"
    /** 3 iters sem convergir; próximo ciclo pega. D-062. */
    | "reconcile_incomplete";
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

    const linkedRows = (linked ?? []) as Array<{ id: string }>;
    const linkedCount = linkedRows.length;
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

    // ────────────────────────────────────────────────────────────────
    // 4c) Reconciliação pós-link (D-062 · PR-051 · finding 5.5).
    //
    // Captura earnings que chegaram ENTRE o SELECT inicial (passo 1)
    // e o UPDATE de vínculo (passo 4b) — tipicamente, clawbacks
    // criados por webhook PAYMENT_REFUNDED rodando em paralelo.
    //
    // Loop bounded: re-seleciona extras candidatos; tenta linkar ao
    // payout recém-criado; se algum rolou, incorpora. Repete até
    // esvaziar ou bater RECONCILE_MAX_ITERATIONS.
    // ────────────────────────────────────────────────────────────────

    let extraSum = 0;
    let extraCount = 0;
    let iter = 0;
    let converged = true;

    while (iter < RECONCILE_MAX_ITERATIONS) {
      iter += 1;

      const { data: extras, error: extrasErr } = await supabase
        .from("doctor_earnings")
        .select("id, amount_cents")
        .eq("doctor_id", doctorId)
        .eq("status", "available")
        .is("payout_id", null)
        .lt("available_at", monthStart);

      if (extrasErr) {
        // Falha na leitura: não sabemos se há extras. Registra error
        // mas não bloqueia — o payout original segue válido com o sum
        // capturado no SELECT inicial. Próximo ciclo reprocessa se
        // sobrar earning.
        result.errors += 1;
        result.errorDetails.push(
          `reconcile select ${doctorId}: ${extrasErr.message}`
        );
        converged = false;
        break;
      }

      const extraRows = (extras ?? []) as Array<{
        id: string;
        amount_cents: number;
      }>;
      if (extraRows.length === 0) break; // convergiu

      const extraIds = extraRows.map((e) => e.id);

      const { data: extraLinked, error: linkExtraErr } = await supabase
        .from("doctor_earnings")
        .update({
          payout_id: newPayoutId,
          status: "in_payout",
          updated_at: new Date().toISOString(),
        })
        .in("id", extraIds)
        .eq("status", "available")
        .is("payout_id", null)
        .select("id, amount_cents");

      if (linkExtraErr) {
        result.errors += 1;
        result.errorDetails.push(
          `reconcile link ${doctorId}: ${linkExtraErr.message}`
        );
        converged = false;
        break;
      }

      // Soma só do que EFETIVAMENTE foi linkado (concorrência pode ter
      // roubado parte pra outro payout — teoricamente impossível hoje,
      // mas o guard cobre de graça).
      const actualLinked = (extraLinked ?? []) as Array<{
        id: string;
        amount_cents: number;
      }>;

      if (actualLinked.length === 0) {
        // Vimos extras no SELECT mas nada foi linked — alguém mais rápido
        // pegou. Sai pra não loopar à toa; se ainda restarem, próximo
        // ciclo pega.
        break;
      }

      extraSum += actualLinked.reduce((a, r) => a + r.amount_cents, 0);
      extraCount += actualLinked.length;

      // Se o UPDATE linkou MENOS do que o SELECT viu, provavelmente há
      // mais chegando — próxima iter re-scaneia. Se linkou TUDO, próxima
      // iter confirma ausência e sai.
    }

    if (!converged) {
      // `reconcile select/link` error já foi registrado acima.
    } else if (iter >= RECONCILE_MAX_ITERATIONS) {
      // Potencialmente não convergiu — verifica de novo (barato).
      const { data: stillExtras } = await supabase
        .from("doctor_earnings")
        .select("id")
        .eq("doctor_id", doctorId)
        .eq("status", "available")
        .is("payout_id", null)
        .lt("available_at", monthStart)
        .limit(1);
      if ((stillExtras ?? []).length > 0) {
        log.warn("reconcile not converged", {
          doctor_id: doctorId,
          payout_id: newPayoutId,
          iterations: iter,
        });
        result.warnings.push({
          doctorId,
          doctorName,
          amountCents: 0,
          earningsCount: 0,
          reason: "reconcile_incomplete",
        });
      }
    }

    // ────────────────────────────────────────────────────────────────
    // 4d) Se houve extras, ajusta amount_cents + earnings_count do
    // payout. Guard `.eq("status", "draft")` evita sobrescrever um
    // payout que o admin tenha aprovado no meio tempo (cenário extremo
    // de corrida humana × cron — não deveria acontecer, mas cinto +
    // suspensório).
    // ────────────────────────────────────────────────────────────────

    if (extraCount > 0) {
      const finalAmount = agg.total + extraSum;
      const finalCount = linkedCount + extraCount;

      const { error: adjErr } = await supabase
        .from("doctor_payouts")
        .update({
          amount_cents: finalAmount,
          earnings_count: finalCount,
          updated_at: new Date().toISOString(),
        })
        .eq("id", newPayoutId)
        .eq("status", "draft");

      if (adjErr) {
        log.warn("payout amount adjust failed", {
          payout_id: newPayoutId,
          err: adjErr.message,
        });
        result.errors += 1;
        result.errorDetails.push(
          `reconcile adjust ${doctorId}: ${adjErr.message}`
        );
      } else {
        result.earningsLinked += extraCount;
        result.totalCentsDrafted += extraSum;
        result.warnings.push({
          doctorId,
          doctorName,
          amountCents: finalAmount,
          earningsCount: finalCount,
          reason: "clawback_reconciled",
        });
        log.info("payout reconciled", {
          payout_id: newPayoutId,
          initial_amount_cents: agg.total,
          final_amount_cents: finalAmount,
          extra_count: extraCount,
        });
      }
    }

    // ────────────────────────────────────────────────────────────────
    // 4e) Se a soma final ficou ≤ 0 (clawback dominante), cancela o
    // payout automaticamente e libera os earnings pro próximo ciclo.
    //
    // Cenário: médica teve +300 em earnings elegíveis, mas um
    // chargeback gerou um clawback de -400 que foi reconciliado. Payout
    // de -100 não faz sentido (médica não "deve" dinheiro pra nós via
    // PIX); o certo é deixar o saldo negativo acumular pro próximo mês
    // quando ela tiver earnings novas pra compensar.
    // ────────────────────────────────────────────────────────────────

    const finalAmountCheck = agg.total + extraSum;
    if (finalAmountCheck <= 0) {
      const { error: cancelErr } = await supabase
        .from("doctor_payouts")
        .update({
          status: "cancelled",
          cancelled_reason:
            "Auto-cancelado: soma final dos earnings vinculados ≤ 0 (clawback ≥ earnings positivos). Earnings liberados pra fila do próximo ciclo.",
          updated_at: new Date().toISOString(),
        })
        .eq("id", newPayoutId)
        .eq("status", "draft");

      if (cancelErr) {
        log.error("payout auto-cancel failed", {
          payout_id: newPayoutId,
          err: cancelErr.message,
        });
        result.errors += 1;
        result.errorDetails.push(
          `reconcile cancel ${doctorId}: ${cancelErr.message}`
        );
      } else {
        // Libera earnings: voltam pra available, unlinked.
        const { error: releaseErr } = await supabase
          .from("doctor_earnings")
          .update({
            payout_id: null,
            status: "available",
            updated_at: new Date().toISOString(),
          })
          .eq("payout_id", newPayoutId);

        if (releaseErr) {
          log.error("earnings release failed", {
            payout_id: newPayoutId,
            err: releaseErr.message,
          });
          result.errors += 1;
          result.errorDetails.push(
            `reconcile release ${doctorId}: ${releaseErr.message}`
          );
        }

        // Reverte stats: esse payout "não conta".
        result.payoutsCreated -= 1;
        result.totalCentsDrafted -= agg.total + extraSum;
        result.earningsLinked -= linkedCount + extraCount;

        // Substitui o warning `clawback_reconciled` (se houve) pelo
        // estado final `clawback_dominant_cancelled`.
        const lastIdx = result.warnings.findIndex(
          (w) =>
            w.doctorId === doctorId && w.reason === "clawback_reconciled"
        );
        if (lastIdx >= 0) result.warnings.splice(lastIdx, 1);

        result.warnings.push({
          doctorId,
          doctorName,
          amountCents: finalAmountCheck,
          earningsCount: linkedCount + extraCount,
          reason: "clawback_dominant_cancelled",
        });

        log.warn("payout auto-cancelled (clawback dominant)", {
          payout_id: newPayoutId,
          doctor_id: doctorId,
          final_amount_cents: finalAmountCheck,
        });
      }
    }
  }

  return result;
}
