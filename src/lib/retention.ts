/**
 * src/lib/retention.ts — PR-033-A · D-052 · Onda 2B
 *
 * Política de retenção LGPD automática. Art. 16: dados pessoais devem
 * ser eliminados (ou anonimizados) após o término do tratamento, salvo
 * conservação para obrigação legal.
 *
 * O que é "término do tratamento" aqui?
 *
 * - **Ghost customers** (sem appointments, sem fulfillments, sem
 *   plan_acceptances — apenas cadastraram-se) cuja última atividade
 *   (`updated_at`, `created_at`) é anterior ao threshold. O threshold
 *   padrão é **24 meses** (730 dias) — conservador o bastante pra
 *   cobrir paciente que marcou consulta e só retornou 1 ano depois.
 *
 * - **Abandonados com histórico clínico** (tiveram appointments ou
 *   fulfillments): NÃO são anonimizados por este cron. CFM 1.821/2007
 *   exige prontuário por 20 anos após o último atendimento. Cobre-se
 *   em ADR futuro — por ora, esses ficam fora do escopo.
 *
 * - **Leads** (tabela `leads`): fora do escopo deste módulo. Lead sem
 *   `customer_id` e sem conversão passa por cron separado (PR futuro).
 *
 * Por que a lógica fica em TS e não em função SQL?
 *
 *   - Threshold, limite de batch e dry-run são parâmetros — queremos
 *     variar sem rodar migration.
 *   - Testes unitários no banco exigem infra (pg_tap etc). Testes TS
 *     com mock rodam no CI normal.
 *   - A parte "anonimização" reaproveita `anonymizePatient` (D-045),
 *     que já cobre placeholders + idempotência + bloqueio de FK ativo.
 *
 * Idempotência:
 *   `anonymizePatient` internamente faz o update com
 *   `.is("anonymized_at", null)`, então se o cron rodar duas vezes
 *   concorrentemente (improvável, mas possível em deploy Vercel), o
 *   segundo just no-op. O relatório distingue "anonimizados agora" de
 *   "já estavam anonimizados".
 *
 * Como distinguir "anonimização por retenção" vs "solicitação do
 * titular" (LGPD Art. 18, VI)?
 *
 *   Ambas marcam `customers.anonymized_at` e `customers.anonymized_ref`.
 *   A distinção fica no `admin_audit_log`/`patient_access_log`:
 *   actor_kind='system' + action='customer.retention_anonymize' (audit)
 *   ou action='retention_anonymize' (access). O operador pode buscar
 *   esses registros pra relatório de conformidade.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { anonymizePatient } from "./patient-lgpd";
import { logAdminAction } from "./admin-audit-log";
import { logPatientAccess } from "./patient-access-log";

export const RETENTION_SYSTEM_EMAIL = "system:retention";
export const DEFAULT_RETENTION_THRESHOLD_DAYS = 730; // 24 meses
export const DEFAULT_RETENTION_BATCH_LIMIT = 50;

/**
 * Representação do candidato à anonimização por retenção.
 * Não carrega PII do paciente — propositalmente — o helper só precisa
 * do `id` pra passar adiante ao `anonymizePatient`, que atualiza a
 * row in-place. O `updated_at` e `created_at` ficam no retorno só pra
 * logging e auditoria.
 */
export type RetentionCandidate = {
  id: string;
  createdAt: string;
  updatedAt: string;
};

export type FindCandidatesParams = {
  /** Timestamp de referência (default now()), facilita testes. */
  now?: Date;
  /** Idade mínima em dias pra ser elegível. Default 730 (24 meses). */
  thresholdDays?: number;
  /** Tamanho máximo da query. Default 50. */
  limit?: number;
};

export async function findCustomersEligibleForRetentionAnonymize(
  supabase: SupabaseClient,
  params: FindCandidatesParams = {}
): Promise<RetentionCandidate[]> {
  const now = params.now ?? new Date();
  const thresholdDays = params.thresholdDays ?? DEFAULT_RETENTION_THRESHOLD_DAYS;
  const limit = params.limit ?? DEFAULT_RETENTION_BATCH_LIMIT;
  const cutoff = new Date(now.getTime() - thresholdDays * 24 * 60 * 60 * 1000);
  const cutoffIso = cutoff.toISOString();

  // Passo 1: busca pool generoso de customers inativos há > threshold.
  // Overshooting aqui compensa rows que vão ser filtradas por terem
  // filhos (appointments/fulfillments/acceptances) no passo 2.
  // Fator 4x é suficiente na maioria dos cenários — se virar gargalo,
  // paginar. Nunca pega + que 500 por execução pra limitar custo.
  const oversample = Math.min(limit * 4, 500);

  const { data: candidates, error } = await supabase
    .from("customers")
    .select("id, created_at, updated_at")
    .is("anonymized_at", null)
    .lt("created_at", cutoffIso)
    .lt("updated_at", cutoffIso)
    .order("updated_at", { ascending: true })
    .limit(oversample);

  if (error) {
    console.error("[retention] find candidates failed:", error.message);
    return [];
  }
  if (!candidates || candidates.length === 0) return [];

  const candidateIds = (candidates as Array<{ id: string }>).map((c) => c.id);

  // Passo 2: filtra quem tem appointments/fulfillments/plan_acceptances.
  // Fazemos 3 queries paralelas com IN — simples, barato, cobre 100%
  // dos casos porque são PKs indexadas. Se virar N+1 perceptível,
  // substituir por RPC SQL com EXCEPT/NOT EXISTS.
  const [appsRes, ffsRes, accsRes] = await Promise.all([
    supabase
      .from("appointments")
      .select("customer_id")
      .in("customer_id", candidateIds),
    supabase
      .from("fulfillments")
      .select("customer_id")
      .in("customer_id", candidateIds),
    supabase
      .from("plan_acceptances")
      .select("customer_id")
      .in("customer_id", candidateIds),
  ]);

  const withHistory = new Set<string>();
  for (const res of [appsRes, ffsRes, accsRes]) {
    for (const row of (res.data ?? []) as Array<{ customer_id: string }>) {
      withHistory.add(row.customer_id);
    }
  }

  const ghosts = (candidates as Array<{
    id: string;
    created_at: string;
    updated_at: string;
  }>)
    .filter((c) => !withHistory.has(c.id))
    .slice(0, limit)
    .map((c) => ({
      id: c.id,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
    }));

  return ghosts;
}

// ────────────────────────────────────────────────────────────────────────

export type RunRetentionParams = {
  /** Default agora. */
  now?: Date;
  /** Default 730. */
  thresholdDays?: number;
  /** Default 50. */
  limit?: number;
  /**
   * Se true, calcula candidatos mas não executa anonimização. Útil em
   * ambiente de stage pra validar o conjunto antes de ativar o cron.
   */
  dryRun?: boolean;
};

export type RetentionRunReport = {
  scannedAt: string;
  thresholdDays: number;
  dryRun: boolean;
  totalCandidates: number;
  anonymized: number;
  skippedAlreadyAnonymized: number;
  skippedHasActiveFulfillment: number;
  errors: number;
  details: RetentionDetail[];
};

export type RetentionDetail =
  | {
      customerId: string;
      outcome: "anonymized";
      anonymizedRef: string;
      anonymizedAt: string;
    }
  | {
      customerId: string;
      outcome: "already_anonymized" | "has_active_fulfillment" | "not_found";
    }
  | {
      customerId: string;
      outcome: "error";
      message: string;
    };

export async function runRetentionAnonymization(
  supabase: SupabaseClient,
  params: RunRetentionParams = {}
): Promise<RetentionRunReport> {
  const now = params.now ?? new Date();
  const thresholdDays = params.thresholdDays ?? DEFAULT_RETENTION_THRESHOLD_DAYS;
  const limit = params.limit ?? DEFAULT_RETENTION_BATCH_LIMIT;
  const dryRun = params.dryRun === true;

  const candidates = await findCustomersEligibleForRetentionAnonymize(
    supabase,
    { now, thresholdDays, limit }
  );

  const report: RetentionRunReport = {
    scannedAt: now.toISOString(),
    thresholdDays,
    dryRun,
    totalCandidates: candidates.length,
    anonymized: 0,
    skippedAlreadyAnonymized: 0,
    skippedHasActiveFulfillment: 0,
    errors: 0,
    details: [],
  };

  if (dryRun || candidates.length === 0) {
    // Em dryRun ainda loga no detail com outcome sintético pra
    // admin_digest poder exibir o que iria rodar.
    report.details = candidates.map((c) => ({
      customerId: c.id,
      outcome: "error" as const,
      message: "dryRun=true — não executado",
    }));
    return report;
  }

  for (const candidate of candidates) {
    // Como o cron é o único caller desta função, ignoramos `force`
    // deliberadamente: se houver fulfillment ativo, o candidato não é
    // "ghost" pra começar (teria histórico); mas pra paranóia sobre
    // race condition (ex.: paciente volta a comprar segundos antes
    // do cron rodar), respeitamos o bloqueio do `anonymizePatient`.
    const result = await anonymizePatient(supabase, candidate.id, { now });

    if (!result.ok) {
      if (result.code === "already_anonymized") {
        report.skippedAlreadyAnonymized += 1;
        report.details.push({
          customerId: candidate.id,
          outcome: "already_anonymized",
        });
        continue;
      }
      if (result.code === "has_active_fulfillment") {
        report.skippedHasActiveFulfillment += 1;
        report.details.push({
          customerId: candidate.id,
          outcome: "has_active_fulfillment",
        });
        continue;
      }
      if (result.code === "customer_not_found") {
        report.errors += 1;
        report.details.push({
          customerId: candidate.id,
          outcome: "not_found",
        });
        continue;
      }
      report.errors += 1;
      report.details.push({
        customerId: candidate.id,
        outcome: "error",
        message: result.message,
      });
      continue;
    }

    report.anonymized += 1;
    report.details.push({
      customerId: candidate.id,
      outcome: "anonymized",
      anonymizedRef: result.anonymizedRef,
      anonymizedAt: result.anonymizedAt,
    });

    // Ambas as trilhas (best-effort, failSoft): mutação já foi
    // commitada, log perdido é problema de observabilidade, não de
    // integridade. O relatório do cron (cron_runs.payload) preserva a
    // lista de ids anonimizados.
    await logAdminAction(supabase, {
      actorKind: "system",
      actorEmail: RETENTION_SYSTEM_EMAIL,
      action: "customer.retention_anonymize",
      entityType: "customer",
      entityId: candidate.id,
      after: {
        anonymized_at: result.anonymizedAt,
        anonymized_ref: result.anonymizedRef,
      },
      metadata: {
        thresholdDays,
        candidateCreatedAt: candidate.createdAt,
        candidateUpdatedAt: candidate.updatedAt,
      },
    });

    await logPatientAccess(supabase, {
      adminUserId: null,
      adminEmail: RETENTION_SYSTEM_EMAIL,
      actorKind: "system",
      customerId: candidate.id,
      action: "retention_anonymize",
      metadata: {
        thresholdDays,
        anonymizedRef: result.anonymizedRef,
        candidateCreatedAt: candidate.createdAt,
        candidateUpdatedAt: candidate.updatedAt,
      },
    });
  }

  return report;
}
