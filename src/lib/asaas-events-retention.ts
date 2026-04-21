/**
 * src/lib/asaas-events-retention.ts — PR-052 · D-063 · finding 5.12
 *
 * Purge pós-retention de `asaas_events.payload`. Compõe com
 * `redactAsaasPayload()` (que limpa PII na entrada) pra formar a
 * política de LGPD dois-estágios:
 *
 *   1. INSERT-time redact (PII nunca fica crua no banco pra novos
 *      eventos). Em `asaas-event-redact.ts`.
 *   2. Purge após 180d (janela de chargeback Mastercard/Visa = 120d,
 *      +60d de folga operacional). Este arquivo.
 *
 * Threshold de 180 dias:
 *   - Chargeback dispute window Mastercard/Visa: 120 dias após a data
 *     do pagamento. Depois disso, o payload não tem valor operacional.
 *   - +60d de folga pra reconciliação tardia (contador cobrindo caso
 *     raro de conferência fiscal > 4 meses após o fato).
 *   - Em 365d+ o payload seria puro dead weight.
 *
 * O que acontece no purge:
 *   - `payload := '{}'::jsonb` (mantém NOT NULL constraint).
 *   - `payload_purged_at := now()`.
 *   - Preservados: `id`, `asaas_event_id`, `event_type`,
 *     `asaas_payment_id`, `processed_at`, `received_at`,
 *     `signature_valid`, `processing_error`.
 *
 * Dessa forma, auditoria fiscal ainda pode listar "quantos PAYMENT_RECEIVED
 * entre Jan e Mar de 2026", mas PII do payload está zero.
 *
 * Por que TS e não função SQL?
 *   - Batch limit + threshold são parâmetros que queremos variar sem
 *     migration.
 *   - Testar com mock Supabase é mais barato que pg_tap.
 *   - Report estruturado vai pro cron_runs.payload pra observability.
 *
 * Idempotência: guard `payload_purged_at IS NULL` no SELECT e no UPDATE.
 * Rodar 2× em sequência → segundo run pega zero candidatos.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "./logger";

const log = logger.with({ mod: "asaas-events-retention" });

export const DEFAULT_PURGE_THRESHOLD_DAYS = 180;
export const DEFAULT_PURGE_BATCH_LIMIT = 500;

/** Threshold mínimo aceito — proteção contra param acidental. */
export const MIN_PURGE_THRESHOLD_DAYS = 90;

/** Upper bound — acima disso, purge deixa de ter propósito. */
export const MAX_PURGE_THRESHOLD_DAYS = 3650; // 10 anos

export type PurgeAsaasEventsParams = {
  /** Default now(). */
  now?: Date;
  /** Default 180. */
  thresholdDays?: number;
  /** Default 500. */
  limit?: number;
  /** Default false. Se true, calcula mas não muta. */
  dryRun?: boolean;
};

export type PurgeAsaasEventsReport = {
  scannedAt: string;
  thresholdDays: number;
  dryRun: boolean;
  candidatesFound: number;
  purged: number;
  errors: number;
  errorDetails: string[];
  oldestPurgedAt: string | null;
  newestPurgedAt: string | null;
};

/**
 * Varre `asaas_events` em busca de eventos processados há mais que
 * `thresholdDays` dias cujo payload ainda não foi purgado, e esvazia
 * o payload em lote (single UPDATE).
 *
 * Estratégia em 2 passos (SELECT → UPDATE) vs `UPDATE ... RETURNING`
 * direto: SELECT primeiro dá:
 *   - limit determinístico (PostgREST não suporta LIMIT em UPDATE);
 *   - report com oldest/newest purgedAt sem round-trip extra;
 *   - possibilidade de dryRun honesto (mesmo SELECT sem o UPDATE).
 *
 * Concorrência: guard `.is("payload_purged_at", null)` no UPDATE
 * garante que se dois pod's rodarem o cron simultaneamente, só 1 tem
 * efeito em cada row. Vercel cron é single-instance em regra, mas o
 * guard é de graça.
 */
export async function purgeAsaasEventsPayload(
  supabase: SupabaseClient,
  params: PurgeAsaasEventsParams = {}
): Promise<PurgeAsaasEventsReport> {
  const now = params.now ?? new Date();
  const thresholdDays = clampThreshold(
    params.thresholdDays ?? DEFAULT_PURGE_THRESHOLD_DAYS
  );
  const limit = clampLimit(params.limit ?? DEFAULT_PURGE_BATCH_LIMIT);
  const dryRun = params.dryRun === true;

  const cutoff = new Date(now.getTime() - thresholdDays * 24 * 60 * 60 * 1000);
  const cutoffIso = cutoff.toISOString();

  const report: PurgeAsaasEventsReport = {
    scannedAt: now.toISOString(),
    thresholdDays,
    dryRun,
    candidatesFound: 0,
    purged: 0,
    errors: 0,
    errorDetails: [],
    oldestPurgedAt: null,
    newestPurgedAt: null,
  };

  // 1) SELECT candidatos. Ordenados por processed_at ASC — se hit no
  // limit, purgamos os mais antigos primeiro (maior pressão de LGPD).
  const { data: candidates, error: selErr } = await supabase
    .from("asaas_events")
    .select("id, processed_at")
    .is("payload_purged_at", null)
    .not("processed_at", "is", null)
    .lt("processed_at", cutoffIso)
    .order("processed_at", { ascending: true })
    .limit(limit);

  if (selErr) {
    log.error("select candidates failed", { error: selErr.message });
    report.errors += 1;
    report.errorDetails.push(`select: ${selErr.message}`);
    return report;
  }

  const rows = (candidates ?? []) as Array<{
    id: string;
    processed_at: string;
  }>;
  report.candidatesFound = rows.length;

  if (rows.length === 0 || dryRun) {
    if (rows.length > 0) {
      report.oldestPurgedAt = rows[0]?.processed_at ?? null;
      report.newestPurgedAt = rows[rows.length - 1]?.processed_at ?? null;
    }
    return report;
  }

  // 2) UPDATE em lote: guard `payload_purged_at IS NULL` protege
  // contra concorrência.
  const ids = rows.map((r) => r.id);
  const nowIso = now.toISOString();

  const { data: updated, error: updErr } = await supabase
    .from("asaas_events")
    .update({
      payload: {}, // `{}::jsonb` — mantém NOT NULL
      payload_purged_at: nowIso,
    })
    .in("id", ids)
    .is("payload_purged_at", null)
    .select("id");

  if (updErr) {
    log.error("update failed", { error: updErr.message });
    report.errors += 1;
    report.errorDetails.push(`update: ${updErr.message}`);
    return report;
  }

  const purgedRows = (updated ?? []) as Array<{ id: string }>;
  report.purged = purgedRows.length;
  report.oldestPurgedAt = rows[0]?.processed_at ?? null;
  report.newestPurgedAt = rows[rows.length - 1]?.processed_at ?? null;

  if (report.purged !== report.candidatesFound) {
    // Diferença indica concorrência (outro pod purgou algumas entre
    // SELECT e UPDATE) — não é erro, mas vale logar info.
    log.info("purge partial (race com outra instancia?)", {
      candidates: report.candidatesFound,
      purged: report.purged,
    });
  }

  log.info("purge concluido", {
    purged: report.purged,
    threshold_days: thresholdDays,
    oldest: report.oldestPurgedAt,
    newest: report.newestPurgedAt,
    dry_run: dryRun,
  });

  return report;
}

function clampThreshold(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_PURGE_THRESHOLD_DAYS;
  if (v < MIN_PURGE_THRESHOLD_DAYS) return MIN_PURGE_THRESHOLD_DAYS;
  if (v > MAX_PURGE_THRESHOLD_DAYS) return MAX_PURGE_THRESHOLD_DAYS;
  return Math.floor(v);
}

function clampLimit(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_PURGE_BATCH_LIMIT;
  if (v < 1) return 1;
  if (v > 10_000) return 10_000;
  return Math.floor(v);
}
