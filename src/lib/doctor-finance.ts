/**
 * Agregadores financeiros read-only da médica (D-041).
 *
 * Centraliza o cálculo de saldo, estimativa do próximo payout e histórico
 * enriquecido pra que as páginas `/medico/*` e `/admin/doctors/[id]`
 * consumam sem reimplementar a regra.
 *
 * Fonte da verdade:
 *   - `doctor_earnings` (status: pending/available/in_payout/paid/cancelled)
 *   - `doctor_payouts` (status: draft/approved/pix_sent/confirmed/...)
 *   - `doctor_billing_documents` (NF-e por payout)
 *
 * Regra do "próximo payout":
 *   - Os crons de D-040 geram o draft mensal no dia 1 do mês seguinte.
 *   - Saldo elegível = sum(earnings.amount_cents) onde:
 *       status = 'available'
 *       payout_id IS NULL
 *       available_at < primeiro dia do mês corrente
 *   - Data estimada = próximo dia 1 em UTC 09:15 (cron agendado no vercel.json).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "./logger";

const log = logger.with({ mod: "doctor-finance" });

export type DoctorBalance = {
  /** earnings.status='pending' — ainda na janela de risco. */
  pendingCents: number;
  /** earnings.status='available' — já elegíveis pro próximo payout. */
  availableCents: number;
  /** earnings.status='in_payout' — já alocadas em payout draft/approved. */
  inPayoutCents: number;
  /** earnings.status='paid' — histórico pago. */
  paidCents: number;
  /** Soma bruta de cancelled ficar fora — não é "seu dinheiro". */
  counts: {
    pending: number;
    available: number;
    inPayout: number;
    paid: number;
  };
};

export type NextPayoutEstimate = {
  /** Primeiro dia do próximo mês (quando o cron roda), ISO UTC. */
  scheduledAt: string;
  /** Período de referência que o draft terá (YYYY-MM do mês corrente -1). */
  referencePeriod: string;
  /** Saldo elegível agora (se cron rodasse imediatamente). */
  eligibleCents: number;
  /** Earnings já available mas que ainda caem no mês seguinte. */
  eligibleCount: number;
  /** Earnings available com available_at >= mês atual (cairão no próximo ciclo). */
  deferredCents: number;
  deferredCount: number;
};

export type PayoutWithDocumentRow = {
  id: string;
  reference_period: string;
  amount_cents: number;
  earnings_count: number;
  status: string;
  paid_at: string | null;
  confirmed_at: string | null;
  auto_generated: boolean | null;
  created_at: string;
  /** Estado da NF-e pra este payout (camelCase pro consumo no UI). */
  document: {
    id: string;
    uploadedAt: string | null;
    validatedAt: string | null;
    documentNumber: string | null;
    documentAmountCents: number | null;
  } | null;
};

function monthStartIso(now: Date = new Date()): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0)
  ).toISOString();
}

function nextMonthStartIso(now: Date = new Date()): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 9, 15, 0, 0)
  ).toISOString();
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function currentMonthPeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}`;
}

/**
 * Saldo total da médica, agregado por status de earning. Não filtra
 * por período: é "tudo que aconteceu na história" categorizado pelo
 * status atual.
 */
export async function getDoctorBalance(
  supabase: SupabaseClient,
  doctorId: string
): Promise<DoctorBalance> {
  const { data, error } = await supabase
    .from("doctor_earnings")
    .select("amount_cents, status")
    .eq("doctor_id", doctorId)
    .in("status", ["pending", "available", "in_payout", "paid"]);

  const balance: DoctorBalance = {
    pendingCents: 0,
    availableCents: 0,
    inPayoutCents: 0,
    paidCents: 0,
    counts: { pending: 0, available: 0, inPayout: 0, paid: 0 },
  };

  if (error) {
    log.error("getDoctorBalance", { err: error });
    return balance;
  }

  const rows =
    (data ?? []) as unknown as Array<{ amount_cents: number; status: string }>;

  for (const row of rows) {
    switch (row.status) {
      case "pending":
        balance.pendingCents += row.amount_cents;
        balance.counts.pending += 1;
        break;
      case "available":
        balance.availableCents += row.amount_cents;
        balance.counts.available += 1;
        break;
      case "in_payout":
        balance.inPayoutCents += row.amount_cents;
        balance.counts.inPayout += 1;
        break;
      case "paid":
        balance.paidCents += row.amount_cents;
        balance.counts.paid += 1;
        break;
    }
  }

  return balance;
}

/**
 * Estimativa do próximo payout. "Eligible" = entraria no draft se o cron
 * rodasse agora. "Deferred" = vai sobrar pro ciclo seguinte.
 */
export async function estimateNextPayout(
  supabase: SupabaseClient,
  doctorId: string,
  now: Date = new Date()
): Promise<NextPayoutEstimate> {
  const monthStart = monthStartIso(now);
  const referencePeriod = currentMonthPeriod(now); // o draft nascerá como mês anterior ao NEXT cron
  // mas do ponto de vista da médica, "próximo" é "o que tá chegando"

  const { data, error } = await supabase
    .from("doctor_earnings")
    .select("amount_cents, available_at")
    .eq("doctor_id", doctorId)
    .eq("status", "available")
    .is("payout_id", null);

  const estimate: NextPayoutEstimate = {
    scheduledAt: nextMonthStartIso(now),
    referencePeriod,
    eligibleCents: 0,
    eligibleCount: 0,
    deferredCents: 0,
    deferredCount: 0,
  };

  if (error) {
    log.error("estimateNextPayout", { err: error });
    return estimate;
  }

  const rows =
    (data ?? []) as unknown as Array<{
      amount_cents: number;
      available_at: string | null;
    }>;

  for (const row of rows) {
    const availableAt = row.available_at;
    if (!availableAt) continue;
    if (availableAt < monthStart) {
      estimate.eligibleCents += row.amount_cents;
      estimate.eligibleCount += 1;
    } else {
      estimate.deferredCents += row.amount_cents;
      estimate.deferredCount += 1;
    }
  }

  return estimate;
}

/**
 * Lista os N payouts mais recentes da médica, já com o estado da NF-e
 * associada (se houver).
 */
export async function listPayoutsWithDocuments(
  supabase: SupabaseClient,
  doctorId: string,
  limit: number = 24
): Promise<PayoutWithDocumentRow[]> {
  const { data: payouts, error } = await supabase
    .from("doctor_payouts")
    .select(
      "id, reference_period, amount_cents, earnings_count, status, paid_at, confirmed_at, auto_generated, created_at"
    )
    .eq("doctor_id", doctorId)
    .order("reference_period", { ascending: false })
    .limit(limit);

  if (error) {
    log.error("listPayoutsWithDocuments", { err: error });
    return [];
  }

  const ids = (payouts ?? []).map((p) => (p as { id: string }).id);
  if (ids.length === 0) return [];

  const { data: docs } = await supabase
    .from("doctor_billing_documents")
    .select(
      "id, payout_id, uploaded_at, validated_at, document_number, document_amount_cents"
    )
    .in("payout_id", ids);

  const docsByPayout = new Map<
    string,
    {
      id: string;
      uploaded_at: string;
      validated_at: string | null;
      document_number: string | null;
      document_amount_cents: number | null;
    }
  >();
  for (const d of (docs ?? []) as unknown as Array<{
    id: string;
    payout_id: string;
    uploaded_at: string;
    validated_at: string | null;
    document_number: string | null;
    document_amount_cents: number | null;
  }>) {
    docsByPayout.set(d.payout_id, {
      id: d.id,
      uploaded_at: d.uploaded_at,
      validated_at: d.validated_at,
      document_number: d.document_number,
      document_amount_cents: d.document_amount_cents,
    });
  }

  return ((payouts ?? []) as unknown as Array<{
    id: string;
    reference_period: string;
    amount_cents: number;
    earnings_count: number;
    status: string;
    paid_at: string | null;
    confirmed_at: string | null;
    auto_generated: boolean | null;
    created_at: string;
  }>).map((p) => {
    const doc = docsByPayout.get(p.id) ?? null;
    return {
      id: p.id,
      reference_period: p.reference_period,
      amount_cents: p.amount_cents,
      earnings_count: p.earnings_count,
      status: p.status,
      paid_at: p.paid_at,
      confirmed_at: p.confirmed_at,
      auto_generated: p.auto_generated,
      created_at: p.created_at,
      document: doc
        ? {
            id: doc.id,
            uploadedAt: doc.uploaded_at,
            validatedAt: doc.validated_at,
            documentNumber: doc.document_number,
            documentAmountCents: doc.document_amount_cents,
          }
        : null,
    };
  });
}

/**
 * Conta quantos payouts da médica precisam de NF-e (status='confirmed'
 * sem documento ou com documento sem validated_at). Usado no banner
 * do dashboard da médica e no card do admin.
 */
export async function countPendingBillingDocuments(
  supabase: SupabaseClient,
  doctorId?: string
): Promise<{ pendingUpload: number; awaitingValidation: number }> {
  const base = supabase
    .from("doctor_payouts")
    .select(
      "id, doctor_id, doctor_billing_documents ( id, validated_at )"
    )
    .eq("status", "confirmed");

  const query = doctorId ? base.eq("doctor_id", doctorId) : base;
  const { data, error } = await query;

  if (error) {
    log.error("countPendingBillingDocuments", { err: error });
    return { pendingUpload: 0, awaitingValidation: 0 };
  }

  const rows =
    (data ?? []) as unknown as Array<{
      id: string;
      doctor_id: string;
      doctor_billing_documents:
        | Array<{ id: string; validated_at: string | null }>
        | null;
    }>;

  let pendingUpload = 0;
  let awaitingValidation = 0;
  for (const row of rows) {
    const docs = row.doctor_billing_documents ?? [];
    if (docs.length === 0) {
      pendingUpload += 1;
    } else if (docs.every((d) => d.validated_at == null)) {
      awaitingValidation += 1;
    }
  }
  return { pendingUpload, awaitingValidation };
}
