/**
 * Conciliação financeira (D-037) — Instituto Nova Medida.
 *
 * Detecta divergências entre as três tabelas que movimentam dinheiro
 * no sistema:
 *
 *   - `payments`         → cobranças geradas no Asaas
 *   - `doctor_earnings`  → ganhos imutáveis da médica (+/- clawbacks)
 *   - `doctor_payouts`   → lotes mensais que viram PIX pra médica
 *
 * A ideia é rodar os checks on-demand na página `/admin/financeiro`
 * e destacar no dashboard global quando houver itens CRÍTICOS (dinheiro
 * que saiu ou entrou e não bateu) vs WARNINGs (pode ser ação humana
 * legítima mas tá parado há muito tempo).
 *
 * Filosofia:
 *   - READ-ONLY. Nenhuma função aqui altera dados. Conciliação reporta,
 *     humano decide.
 *   - Sem cron automático nesta versão. Admin abre a página quando
 *     quiser (recomendação: toda sexta-feira antes de fechar o mês).
 *   - Cada discrepância tem contexto suficiente pra admin agir sem
 *     precisar abrir SQL (IDs + valores + link sugerido).
 *
 * Checks implementados:
 *
 *   Críticos (requerem ação imediata):
 *     1. consultation_without_earning
 *        — appointment completed há >1h sem earning type='consultation'
 *     2. no_show_doctor_without_clawback
 *        — no-show da médica com payment_id, policy aplicada, sem clawback
 *     3. payout_paid_earnings_not_paid
 *        — payout confirmed/paid com earnings ainda em status != 'paid'
 *     4. payout_amount_drift
 *        — soma das earnings do payout != payout.amount_cents
 *
 *   Warnings (suspeitos mas podem ser legítimos):
 *     5. earning_available_stale
 *        — earning status='available' há >45d sem vincular a payout
 *     6. refund_required_stale
 *        — refund_required=true há >7d sem processar (D-033 já lista,
 *          aqui escala a urgência)
 *
 * Performance:
 *   Cada check roda em 1-2 queries. N queries no total (N=6).
 *   A tabela de appointments tem índices suficientes; o escaneamento
 *   de earnings e payouts é pequeno (volume mensal).
 *   Cada check limita a 100 rows pra UI não ficar pesada — se tiver
 *   mais que isso, é sinal de operação fora de controle e o próprio
 *   limite vira alarme.
 */

import { getSupabaseAdmin } from "@/lib/supabase";

const HARD_LIMIT_PER_CHECK = 100;
const COMPLETED_MIN_AGE_HOURS = 1;
const REFUND_STALE_DAYS = 7;
const EARNING_STALE_DAYS = 45;

export type Severity = "critical" | "warning";

export type DiscrepancyKind =
  | "consultation_without_earning"
  | "no_show_doctor_without_clawback"
  | "payout_paid_earnings_not_paid"
  | "payout_amount_drift"
  | "earning_available_stale"
  | "refund_required_stale";

export type Discrepancy = {
  kind: DiscrepancyKind;
  severity: Severity;
  /** ID do objeto primário referenciado (appointment, payout, earning). */
  primaryId: string;
  /** Tipo do objeto primário pra UI linkar corretamente. */
  primaryType: "appointment" | "payout" | "earning" | "payment";
  /** Descrição curta legível. */
  headline: string;
  /** Detalhes estruturados (valores, IDs relacionados, idade). */
  details: Record<string, string | number | null>;
  /** Sugestão de ação pro admin. */
  actionHint: string;
  /** Timestamp usado pra ordenação (quando o problema "nasceu"). */
  observedAt: string;
};

export type ReconciliationReport = {
  runAt: string;
  totalCritical: number;
  totalWarning: number;
  byKind: Record<DiscrepancyKind, number>;
  truncated: DiscrepancyKind[];
  discrepancies: Discrepancy[];
};

// ────────────────────────────────────────────────────────────────────────────
// Runner
// ────────────────────────────────────────────────────────────────────────────

export async function runReconciliation(): Promise<ReconciliationReport> {
  const start = Date.now();

  const [check1, check2, check3, check4, check5, check6] = await Promise.all([
    findConsultationsWithoutEarning(),
    findNoShowsWithoutClawback(),
    findPaidPayoutsWithUnpaidEarnings(),
    findPayoutAmountDrift(),
    findStaleAvailableEarnings(),
    findStaleRefundRequired(),
  ]);

  const allGroups = [check1, check2, check3, check4, check5, check6];
  const all: Discrepancy[] = allGroups.flatMap((g) => g.items);
  const truncated = allGroups.filter((g) => g.truncated).map((g) => g.kind);

  const byKind: Record<DiscrepancyKind, number> = {
    consultation_without_earning: 0,
    no_show_doctor_without_clawback: 0,
    payout_paid_earnings_not_paid: 0,
    payout_amount_drift: 0,
    earning_available_stale: 0,
    refund_required_stale: 0,
  };
  let critical = 0;
  let warning = 0;
  for (const d of all) {
    byKind[d.kind] += 1;
    if (d.severity === "critical") critical += 1;
    else warning += 1;
  }

  all.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
    return b.observedAt.localeCompare(a.observedAt);
  });

  console.log("[reconciliation] report:", {
    run_ms: Date.now() - start,
    critical,
    warning,
    truncated,
  });

  return {
    runAt: new Date().toISOString(),
    totalCritical: critical,
    totalWarning: warning,
    byKind,
    truncated,
    discrepancies: all,
  };
}

/**
 * Versão leve: só os contadores, pra dashboard global chamar sem
 * puxar o payload completo. Reusa os mesmos checks (são a fonte da
 * verdade) mas descarta os detalhes.
 */
export async function getReconciliationCounts(): Promise<{
  totalCritical: number;
  totalWarning: number;
}> {
  const report = await runReconciliation();
  return {
    totalCritical: report.totalCritical,
    totalWarning: report.totalWarning,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Checks individuais
// ────────────────────────────────────────────────────────────────────────────

type CheckResult = {
  kind: DiscrepancyKind;
  items: Discrepancy[];
  truncated: boolean;
};

/**
 * Check 1 — consultation_without_earning (CRÍTICO)
 *
 * Appointment completed há mais de 1h mas nenhuma earning
 * `type='consultation'` foi criada com esse appointment_id.
 *
 * Por quê 1h:
 *   Webhook Daily + cron D-035 têm tolerância máxima de ~5min. 1h
 *   dá margem folgada pra retries transientes sem gerar ruído.
 *   Passou de 1h, é bug real.
 *
 * Causas possíveis:
 *   - Handler que cria earning pulou por erro e não retentou
 *   - Doctor deleted (on delete restrict) bloqueou
 *   - Bug em `handleEarningsLifecycle` do webhook Asaas
 *
 * Ação:
 *   Criar earning manualmente via SQL + investigar logs.
 */
async function findConsultationsWithoutEarning(): Promise<CheckResult> {
  const supabase = getSupabaseAdmin();
  const cutoff = new Date(
    Date.now() - COMPLETED_MIN_AGE_HOURS * 60 * 60 * 1000
  ).toISOString();

  const { data, error } = await supabase
    .from("appointments")
    .select(
      "id, doctor_id, payment_id, scheduled_at, ended_at, payments ( amount_cents ), doctors ( display_name, full_name )"
    )
    .eq("status", "completed")
    .lt("ended_at", cutoff)
    .limit(HARD_LIMIT_PER_CHECK + 1);

  if (error) {
    console.error("[reconciliation] check1 select:", error);
    return { kind: "consultation_without_earning", items: [], truncated: false };
  }

  const rows = (data ?? []) as unknown as Array<{
    id: string;
    doctor_id: string;
    payment_id: string | null;
    scheduled_at: string;
    ended_at: string | null;
    payments: { amount_cents: number } | null;
    doctors: { display_name: string | null; full_name: string } | null;
  }>;

  if (rows.length === 0) {
    return { kind: "consultation_without_earning", items: [], truncated: false };
  }

  const apptIds = rows.map((r) => r.id);
  const { data: earnings } = await supabase
    .from("doctor_earnings")
    .select("appointment_id")
    .eq("type", "consultation")
    .in("appointment_id", apptIds);

  const withEarning = new Set(
    (earnings ?? []).map((e) => (e as { appointment_id: string }).appointment_id)
  );

  const items: Discrepancy[] = [];
  for (const r of rows) {
    if (withEarning.has(r.id)) continue;
    items.push({
      kind: "consultation_without_earning",
      severity: "critical",
      primaryId: r.id,
      primaryType: "appointment",
      headline: `Consulta completada sem earning: ${
        r.doctors?.display_name ?? r.doctors?.full_name ?? "médica"
      }`,
      details: {
        doctor_id: r.doctor_id,
        payment_id: r.payment_id,
        payment_amount_cents: r.payments?.amount_cents ?? null,
        scheduled_at: r.scheduled_at,
        ended_at: r.ended_at,
      },
      actionHint:
        "Verificar logs de handleEarningsLifecycle no webhook Asaas. Criar earning manualmente se a médica tiver prestado o serviço.",
      observedAt: r.ended_at ?? r.scheduled_at,
    });
  }

  const truncated = items.length > HARD_LIMIT_PER_CHECK;
  return {
    kind: "consultation_without_earning",
    items: items.slice(0, HARD_LIMIT_PER_CHECK),
    truncated,
  };
}

/**
 * Check 2 — no_show_doctor_without_clawback (CRÍTICO)
 *
 * Policy de no-show aplicada (`no_show_policy_applied_at` preenchido),
 * status é `no_show_doctor` ou `cancelled_by_admin` com `payment_id`,
 * mas não existe earning `type='refund_clawback'` com esse
 * appointment_id. Significa que a médica pode ter ficado com o
 * dinheiro de uma consulta que não realizou.
 *
 * Causas possíveis:
 *   - `createClawback` retornou erro silencioso em `applyNoShowPolicy`
 *     (ela loga mas segue — por design, pra não travar o fluxo)
 *   - Race: earning original ainda estava `pending`, clawback criado
 *     com amount=0 (checar se existe mas amount==0)
 *
 * Ação:
 *   Investigar logs de applyNoShowPolicy; criar clawback manualmente
 *   se necessário.
 */
async function findNoShowsWithoutClawback(): Promise<CheckResult> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("appointments")
    .select(
      "id, doctor_id, payment_id, status, cancelled_reason, no_show_policy_applied_at, payments ( amount_cents ), doctors ( display_name, full_name )"
    )
    .not("no_show_policy_applied_at", "is", null)
    .not("payment_id", "is", null)
    .in("status", ["no_show_doctor", "cancelled_by_admin"])
    .order("no_show_policy_applied_at", { ascending: false })
    .limit(HARD_LIMIT_PER_CHECK + 1);

  if (error) {
    console.error("[reconciliation] check2 select:", error);
    return {
      kind: "no_show_doctor_without_clawback",
      items: [],
      truncated: false,
    };
  }

  const rows = (data ?? []) as unknown as Array<{
    id: string;
    doctor_id: string;
    payment_id: string | null;
    status: string;
    cancelled_reason: string | null;
    no_show_policy_applied_at: string;
    payments: { amount_cents: number } | null;
    doctors: { display_name: string | null; full_name: string } | null;
  }>;

  // Filtra só cancelled_by_admin com motivo expired_no_one_joined
  // (outros cancelled_by_admin não geram clawback — admin cancelou
  // por razão legítima como médica doente antes da consulta).
  const eligible = rows.filter(
    (r) =>
      r.status === "no_show_doctor" ||
      (r.status === "cancelled_by_admin" &&
        r.cancelled_reason === "expired_no_one_joined")
  );

  if (eligible.length === 0) {
    return {
      kind: "no_show_doctor_without_clawback",
      items: [],
      truncated: false,
    };
  }

  const apptIds = eligible.map((r) => r.id);
  const { data: clawbacks } = await supabase
    .from("doctor_earnings")
    .select("appointment_id, amount_cents")
    .eq("type", "refund_clawback")
    .in("appointment_id", apptIds);

  const clawbackByAppt = new Map<string, number>();
  for (const cb of clawbacks ?? []) {
    const row = cb as { appointment_id: string; amount_cents: number };
    clawbackByAppt.set(
      row.appointment_id,
      (clawbackByAppt.get(row.appointment_id) ?? 0) + row.amount_cents
    );
  }

  const items: Discrepancy[] = [];
  for (const r of eligible) {
    const cbSum = clawbackByAppt.get(r.id);
    if (cbSum != null && cbSum !== 0) continue; // tem clawback consistente
    items.push({
      kind: "no_show_doctor_without_clawback",
      severity: "critical",
      primaryId: r.id,
      primaryType: "appointment",
      headline: `No-show médica sem clawback: ${
        r.doctors?.display_name ?? r.doctors?.full_name ?? "médica"
      }`,
      details: {
        doctor_id: r.doctor_id,
        status: r.status,
        cancelled_reason: r.cancelled_reason,
        payment_id: r.payment_id,
        payment_amount_cents: r.payments?.amount_cents ?? null,
        clawback_sum_cents: cbSum ?? 0,
        policy_applied_at: r.no_show_policy_applied_at,
      },
      actionHint:
        "createClawback deveria ter criado earning negativa. Verificar logs de applyNoShowPolicy; criar clawback manual se confirmada a falha.",
      observedAt: r.no_show_policy_applied_at,
    });
  }

  const truncated = items.length > HARD_LIMIT_PER_CHECK;
  return {
    kind: "no_show_doctor_without_clawback",
    items: items.slice(0, HARD_LIMIT_PER_CHECK),
    truncated,
  };
}

/**
 * Check 3 — payout_paid_earnings_not_paid (CRÍTICO)
 *
 * Payout com `status IN ('paid','confirmed')` (dinheiro saiu pra
 * médica) mas tem earnings com `payout_id=esse_payout` e status
 * diferente de 'paid'. Indica que o fluxo de confirmação parou no
 * meio — médica recebeu mas nosso lado ainda considera as earnings
 * como não-pagas, o que distorce saldo disponível e pode gerar
 * pagamento duplicado no próximo payout.
 *
 * Ação:
 *   Rodar update manual: `update doctor_earnings set status='paid',
 *   paid_at=payout.paid_at where payout_id='...' and status != 'paid'`
 *   + investigar por que `confirm` não propagou.
 */
async function findPaidPayoutsWithUnpaidEarnings(): Promise<CheckResult> {
  const supabase = getSupabaseAdmin();

  const { data: payouts, error } = await supabase
    .from("doctor_payouts")
    .select(
      "id, doctor_id, reference_period, amount_cents, paid_at, status, doctors ( display_name, full_name )"
    )
    .in("status", ["paid", "confirmed"])
    .limit(HARD_LIMIT_PER_CHECK + 1);

  if (error) {
    console.error("[reconciliation] check3 select:", error);
    return {
      kind: "payout_paid_earnings_not_paid",
      items: [],
      truncated: false,
    };
  }

  const rows = (payouts ?? []) as unknown as Array<{
    id: string;
    doctor_id: string;
    reference_period: string;
    amount_cents: number;
    paid_at: string | null;
    status: string;
    doctors: { display_name: string | null; full_name: string } | null;
  }>;

  if (rows.length === 0) {
    return {
      kind: "payout_paid_earnings_not_paid",
      items: [],
      truncated: false,
    };
  }

  const payoutIds = rows.map((r) => r.id);
  const { data: earningsInPayouts } = await supabase
    .from("doctor_earnings")
    .select("payout_id, status")
    .in("payout_id", payoutIds);

  const unpaidByPayout = new Map<string, number>();
  for (const e of earningsInPayouts ?? []) {
    const row = e as { payout_id: string; status: string };
    if (row.status !== "paid") {
      unpaidByPayout.set(
        row.payout_id,
        (unpaidByPayout.get(row.payout_id) ?? 0) + 1
      );
    }
  }

  const items: Discrepancy[] = [];
  for (const p of rows) {
    const unpaid = unpaidByPayout.get(p.id);
    if (!unpaid) continue;
    items.push({
      kind: "payout_paid_earnings_not_paid",
      severity: "critical",
      primaryId: p.id,
      primaryType: "payout",
      headline: `Payout ${p.status} com ${unpaid} earning(s) ainda não marcada(s) como paid`,
      details: {
        doctor_id: p.doctor_id,
        doctor_name:
          p.doctors?.display_name ?? p.doctors?.full_name ?? null,
        reference_period: p.reference_period,
        amount_cents: p.amount_cents,
        payout_status: p.status,
        unpaid_earnings_count: unpaid,
        paid_at: p.paid_at,
      },
      actionHint:
        "Rodar update nas earnings do payout: status='paid' + paid_at=payout.paid_at. Verificar por que o handler de confirm() não propagou.",
      observedAt: p.paid_at ?? new Date().toISOString(),
    });
  }

  const truncated = items.length > HARD_LIMIT_PER_CHECK;
  return {
    kind: "payout_paid_earnings_not_paid",
    items: items.slice(0, HARD_LIMIT_PER_CHECK),
    truncated,
  };
}

/**
 * Check 4 — payout_amount_drift (CRÍTICO)
 *
 * `doctor_payouts.amount_cents` != sum(doctor_earnings.amount_cents)
 * onde `payout_id = payout.id`. Indica que:
 *   - Uma earning foi adicionada/removida depois da geração do payout
 *   - `earnings_count` tá errado também
 *   - Update manual bagunçou
 *
 * Só analisa payouts não-cancelled (cancelled legitimamente zera
 * amount_cents mas deixa earnings com payout_id; seria falso positivo).
 *
 * Ação:
 *   Decidir se corrige o amount_cents do payout ou se desvincula
 *   as earnings extras. Depende do contexto (payout já pago ou não).
 */
async function findPayoutAmountDrift(): Promise<CheckResult> {
  const supabase = getSupabaseAdmin();

  const { data: payouts, error } = await supabase
    .from("doctor_payouts")
    .select(
      "id, doctor_id, reference_period, amount_cents, earnings_count, status, doctors ( display_name, full_name )"
    )
    .not("status", "in", "(cancelled,failed)")
    .limit(HARD_LIMIT_PER_CHECK + 1);

  if (error) {
    console.error("[reconciliation] check4 select:", error);
    return { kind: "payout_amount_drift", items: [], truncated: false };
  }

  const rows = (payouts ?? []) as unknown as Array<{
    id: string;
    doctor_id: string;
    reference_period: string;
    amount_cents: number;
    earnings_count: number;
    status: string;
    doctors: { display_name: string | null; full_name: string } | null;
  }>;

  if (rows.length === 0) {
    return { kind: "payout_amount_drift", items: [], truncated: false };
  }

  const payoutIds = rows.map((r) => r.id);
  const { data: earningsInPayouts } = await supabase
    .from("doctor_earnings")
    .select("payout_id, amount_cents")
    .in("payout_id", payoutIds);

  const sumByPayout = new Map<string, { sum: number; count: number }>();
  for (const e of earningsInPayouts ?? []) {
    const row = e as { payout_id: string; amount_cents: number };
    const cur = sumByPayout.get(row.payout_id) ?? { sum: 0, count: 0 };
    cur.sum += row.amount_cents;
    cur.count += 1;
    sumByPayout.set(row.payout_id, cur);
  }

  const items: Discrepancy[] = [];
  for (const p of rows) {
    const agg = sumByPayout.get(p.id) ?? { sum: 0, count: 0 };
    const matches =
      agg.sum === p.amount_cents && agg.count === p.earnings_count;
    if (matches) continue;
    items.push({
      kind: "payout_amount_drift",
      severity: "critical",
      primaryId: p.id,
      primaryType: "payout",
      headline: `Payout ${p.reference_period} tem valor em drift`,
      details: {
        doctor_id: p.doctor_id,
        doctor_name:
          p.doctors?.display_name ?? p.doctors?.full_name ?? null,
        payout_status: p.status,
        payout_amount_cents: p.amount_cents,
        earnings_sum_cents: agg.sum,
        diff_cents: agg.sum - p.amount_cents,
        payout_earnings_count: p.earnings_count,
        actual_earnings_count: agg.count,
      },
      actionHint:
        "Investigar histórico (logs de approve/pay/confirm). Corrigir amount_cents+earnings_count OU desvincular earnings extras, dependendo do estágio do payout.",
      observedAt: new Date().toISOString(),
    });
  }

  const truncated = items.length > HARD_LIMIT_PER_CHECK;
  return {
    kind: "payout_amount_drift",
    items: items.slice(0, HARD_LIMIT_PER_CHECK),
    truncated,
  };
}

/**
 * Check 5 — earning_available_stale (WARNING)
 *
 * Earnings com `status='available'` + `earned_at < now() - 45d` +
 * `payout_id IS NULL`. Cenário esperado: cron de geração mensal de
 * payouts roda, agrega as earnings available do mês anterior em
 * draft, admin revisa, aprova. Se earning ficou 45+ dias órfã, o
 * cron não pegou (ou ainda não foi implementado — na Sprint 4.1 foi
 * marcado como pendente).
 *
 * Ação:
 *   Rodar geração manual de payouts OR confirmar que o cron está
 *   agendado e funcionando.
 */
async function findStaleAvailableEarnings(): Promise<CheckResult> {
  const supabase = getSupabaseAdmin();
  const cutoff = new Date(
    Date.now() - EARNING_STALE_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const { data, error } = await supabase
    .from("doctor_earnings")
    .select(
      "id, doctor_id, type, amount_cents, earned_at, available_at, description, doctors ( display_name, full_name )"
    )
    .eq("status", "available")
    .is("payout_id", null)
    .lt("earned_at", cutoff)
    .order("earned_at", { ascending: true })
    .limit(HARD_LIMIT_PER_CHECK + 1);

  if (error) {
    console.error("[reconciliation] check5 select:", error);
    return { kind: "earning_available_stale", items: [], truncated: false };
  }

  const rows = (data ?? []) as unknown as Array<{
    id: string;
    doctor_id: string;
    type: string;
    amount_cents: number;
    earned_at: string;
    available_at: string | null;
    description: string;
    doctors: { display_name: string | null; full_name: string } | null;
  }>;

  const items: Discrepancy[] = rows.map((r) => ({
    kind: "earning_available_stale" as const,
    severity: "warning" as const,
    primaryId: r.id,
    primaryType: "earning" as const,
    headline: `Earning disponível há 45+ dias sem payout: ${
      r.doctors?.display_name ?? r.doctors?.full_name ?? "médica"
    }`,
    details: {
      doctor_id: r.doctor_id,
      type: r.type,
      amount_cents: r.amount_cents,
      earned_at: r.earned_at,
      available_at: r.available_at,
      description: r.description,
    },
    actionHint:
      "Agregar em payout mensal. Confirmar se o cron generate_monthly_payouts() está ativo (pendente na Sprint 4.1).",
    observedAt: r.earned_at,
  }));

  const truncated = items.length > HARD_LIMIT_PER_CHECK;
  return {
    kind: "earning_available_stale",
    items: items.slice(0, HARD_LIMIT_PER_CHECK),
    truncated,
  };
}

/**
 * Check 6 — refund_required_stale (WARNING)
 *
 * Appointment com `refund_required=true` + `refund_processed_at IS
 * NULL` + `no_show_policy_applied_at < now() - 7d`. D-033 já lista
 * todos pendentes em `/admin/refunds`; aqui destacamos os antigos
 * como urgência crescente (paciente está esperando o estorno há
 * muito tempo — risco jurídico/reputacional).
 *
 * Ação:
 *   Abrir `/admin/refunds` e processar. Se a flag `REFUNDS_VIA_ASAAS`
 *   estiver ON (D-034), basta clicar "Estornar no Asaas".
 */
async function findStaleRefundRequired(): Promise<CheckResult> {
  const supabase = getSupabaseAdmin();
  const cutoff = new Date(
    Date.now() - REFUND_STALE_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const { data, error } = await supabase
    .from("appointments")
    .select(
      "id, doctor_id, scheduled_at, no_show_policy_applied_at, status, payments ( amount_cents ), customers ( name ), doctors ( display_name, full_name )"
    )
    .eq("refund_required", true)
    .is("refund_processed_at", null)
    .lt("no_show_policy_applied_at", cutoff)
    .order("no_show_policy_applied_at", { ascending: true })
    .limit(HARD_LIMIT_PER_CHECK + 1);

  if (error) {
    console.error("[reconciliation] check6 select:", error);
    return { kind: "refund_required_stale", items: [], truncated: false };
  }

  const rows = (data ?? []) as unknown as Array<{
    id: string;
    doctor_id: string;
    scheduled_at: string;
    no_show_policy_applied_at: string;
    status: string;
    payments: { amount_cents: number } | null;
    customers: { name: string } | null;
    doctors: { display_name: string | null; full_name: string } | null;
  }>;

  const items: Discrepancy[] = rows.map((r) => {
    const daysOpen = Math.floor(
      (Date.now() - new Date(r.no_show_policy_applied_at).getTime()) /
        (24 * 60 * 60 * 1000)
    );
    return {
      kind: "refund_required_stale" as const,
      severity: "warning" as const,
      primaryId: r.id,
      primaryType: "appointment" as const,
      headline: `Refund pendente há ${daysOpen} dia(s): ${
        r.customers?.name ?? "paciente"
      }`,
      details: {
        doctor_id: r.doctor_id,
        doctor_name:
          r.doctors?.display_name ?? r.doctors?.full_name ?? null,
        status: r.status,
        amount_cents: r.payments?.amount_cents ?? null,
        days_open: daysOpen,
        policy_applied_at: r.no_show_policy_applied_at,
        scheduled_at: r.scheduled_at,
      },
      actionHint:
        "Abrir /admin/refunds e processar. Se REFUNDS_VIA_ASAAS=true, basta 1 clique.",
      observedAt: r.no_show_policy_applied_at,
    };
  });

  const truncated = items.length > HARD_LIMIT_PER_CHECK;
  return {
    kind: "refund_required_stale",
    items: items.slice(0, HARD_LIMIT_PER_CHECK),
    truncated,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Metadata pra UI
// ────────────────────────────────────────────────────────────────────────────

export const KIND_LABELS: Record<
  DiscrepancyKind,
  { label: string; severity: Severity; description: string }
> = {
  consultation_without_earning: {
    label: "Consulta sem earning",
    severity: "critical",
    description:
      "Consulta foi marcada como completed mas não gerou earning pra médica.",
  },
  no_show_doctor_without_clawback: {
    label: "No-show médica sem clawback",
    severity: "critical",
    description:
      "Política de no-show aplicada, mas earning negativa (clawback) não foi criada.",
  },
  payout_paid_earnings_not_paid: {
    label: "Payout pago com earnings não marcadas",
    severity: "critical",
    description:
      "Payout está paid/confirmed mas tem earnings ainda em status != 'paid'.",
  },
  payout_amount_drift: {
    label: "Drift de valor em payout",
    severity: "critical",
    description:
      "Soma das earnings do payout não bate com amount_cents.",
  },
  earning_available_stale: {
    label: "Earning disponível há 45+ dias",
    severity: "warning",
    description:
      "Earning está available sem payout vinculado há muito tempo.",
  },
  refund_required_stale: {
    label: "Refund pendente há 7+ dias",
    severity: "warning",
    description:
      "Paciente tem direito a estorno há mais de 7 dias sem processamento.",
  },
};
