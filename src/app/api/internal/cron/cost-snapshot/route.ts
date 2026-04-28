/**
 * Cron diário de cost-snapshot — PR-045 · D-096.
 *
 * Computa proxy de uso por provider externo no dia anterior (UTC)
 * e persiste em `cost_snapshots`. UI `/admin/custos` consome a tabela.
 *
 * Agendamento: diário, 06:00 UTC ≈ 03:00 BRT. Horário livre na grade
 * de crons (ver tabela em `docs/RUNBOOK.md` §10). Roda DEPOIS de:
 *   - daily-reconcile (5min) já estabilizou pagamentos do dia anterior.
 *   - retention-anonymize (semanal, dom 04:00 UTC) — mas concorrência
 *     é benigna: tabelas diferentes.
 *   - asaas-events-purge (semanal, dom 05:00 UTC) — idem.
 *
 * Idempotência:
 *   - `computeDailySnapshot` produz exatamente 5 rows (uma por provider).
 *   - `upsertSnapshots` faz ON CONFLICT (snapshot_date, provider)
 *     DO UPDATE — re-runs no mesmo dia atualizam estimated_cents.
 *   - Trigger DB atualiza `computed_at`.
 *
 * Manual / debug:
 *
 *   # snapshot do dia anterior (default)
 *   curl -H "x-cron-secret: $CRON_SECRET" \
 *     "https://.../api/internal/cron/cost-snapshot"
 *
 *   # backfill de uma data específica
 *   curl -H "x-cron-secret: $CRON_SECRET" \
 *     "https://.../api/internal/cron/cost-snapshot?date=2026-04-19"
 *
 *   # dry-run (computa mas não persiste)
 *   curl -H "x-cron-secret: $CRON_SECRET" \
 *     "https://.../api/internal/cron/cost-snapshot?dryRun=1"
 */

import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { startCronRun, finishCronRun } from "@/lib/cron-runs";
import { assertCronRequest } from "@/lib/cron-auth";
import {
  computeDailySnapshot,
  upsertSnapshots,
  utcDateStringOf,
} from "@/lib/cost-snapshots";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/internal/cron/cost-snapshot" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Resolve a data alvo:
 *   - `?date=YYYY-MM-DD` se fornecido (backfill).
 *   - Senão, dia anterior em UTC (cron diário roda às 06:00 UTC,
 *     então "yesterday" é o dia inteiro mais recentemente fechado).
 */
function resolveTargetDate(req: NextRequest): {
  date: string;
  source: "param" | "yesterday";
} | null {
  const url = new URL(req.url);
  const param = url.searchParams.get("date");
  if (param) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(param)) return null;
    return { date: param, source: "param" };
  }
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return { date: utcDateStringOf(yesterday), source: "yesterday" };
}

export async function GET(req: NextRequest) {
  const unauth = assertCronRequest(req);
  if (unauth) return unauth;

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") === "1";

  const target = resolveTargetDate(req);
  if (!target) {
    return NextResponse.json(
      { ok: false, error: "invalid_date_format_expected_yyyy_mm_dd" },
      { status: 400 }
    );
  }

  const supabase = getSupabaseAdmin();
  const startedAtMs = Date.now();
  const runId = await startCronRun(supabase, "cost_snapshot");

  try {
    const snapshots = await computeDailySnapshot(supabase, {
      date: target.date,
    });

    const totalCents = snapshots.reduce(
      (acc, s) => acc + s.estimated_cents,
      0
    );

    const upsertReport = dryRun
      ? { inserted: 0, updated: 0, errors: [] as string[] }
      : await upsertSnapshots(supabase, snapshots);

    const hadErrors = upsertReport.errors.length > 0;

    await finishCronRun(supabase, runId, {
      status: hadErrors ? "error" : "ok",
      payload: {
        date: target.date,
        date_source: target.source,
        dryRun,
        providers: snapshots.length,
        total_cents: totalCents,
        upsert_inserted: upsertReport.inserted,
        upsert_updated: upsertReport.updated,
        // Per-provider summary fica no payload também — admin pode
        // inspecionar no /admin/crons sem ter que ir no /admin/custos.
        per_provider: snapshots.map((s) => ({
          provider: s.provider,
          units: s.units,
          unit_label: s.unit_label,
          estimated_cents: s.estimated_cents,
        })),
      },
      startedAtMs,
      errorMessage: hadErrors ? upsertReport.errors.join(" | ") : undefined,
    });

    log.info("run finished", {
      run_id: runId,
      date: target.date,
      duration_ms: Date.now() - startedAtMs,
      providers: snapshots.length,
      total_cents: totalCents,
      dryRun,
      upsert_inserted: upsertReport.inserted,
      upsert_updated: upsertReport.updated,
    });

    return NextResponse.json({
      ok: !hadErrors,
      date: target.date,
      date_source: target.source,
      dryRun,
      total_cents: totalCents,
      providers: snapshots.length,
      upsert: upsertReport,
      snapshots,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.error("exception", { run_id: runId, err: e });
    await finishCronRun(supabase, runId, {
      status: "error",
      errorMessage: message,
      startedAtMs,
    });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
