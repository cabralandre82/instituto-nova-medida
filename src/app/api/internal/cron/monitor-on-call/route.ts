/**
 * Cron: monitor-on-call (PR-081 · D-093).
 *
 * Roda a cada 5 minutos.
 *
 * Faz duas coisas em uma execução (escopo unificado pra economia de
 * cold-starts / cron slots):
 *
 *   1. **Sample**: pra cada bloco `on_call` ativo AGORA com médica
 *      online/busy + heartbeat fresh, INSERT em `doctor_presence_samples`.
 *      Idempotente via bucket de 5min.
 *
 *   2. **Settle**: pra cada bloco recém-encerrado (≤ 30min) que ainda
 *      não foi liquidado, computa coverage_ratio, decide outcome
 *      (paid / no_show), gera earning OU reliability event, registra
 *      em `on_call_block_settlements`. Idempotente via unique
 *      (availability_id, block_start_utc).
 *
 * Manual / debug:
 *   curl -H "x-cron-secret: $CRON_SECRET" \
 *     "https://.../api/internal/cron/monitor-on-call"
 */

import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { startCronRun, finishCronRun } from "@/lib/cron-runs";
import { assertCronRequest } from "@/lib/cron-auth";
import { runMonitorOnCallCycle } from "@/lib/on-call-monitor";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/internal/cron/monitor-on-call" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const unauth = assertCronRequest(req);
  if (unauth) return unauth;

  const supabase = getSupabaseAdmin();
  const startedAtMs = Date.now();
  const runId = await startCronRun(supabase, "monitor_on_call");

  try {
    const report = await runMonitorOnCallCycle({
      supabase,
      cronRunId: runId,
    });

    await finishCronRun(supabase, runId, {
      status: report.errors.length > 0 ? "error" : "ok",
      payload: {
        blocks_considered: report.blocksConsidered,
        samples_inserted: report.samplesInserted,
        samples_skipped: report.samplesSkipped,
        settlements_created: report.settlementsCreated,
        settlements_skipped: report.settlementsSkipped,
        paid_count: report.paidCount,
        no_show_count: report.noShowCount,
        error_count: report.errors.length,
        first_error_reason: report.errors[0]?.reason ?? null,
      },
      errorMessage:
        report.errors.length > 0 ? `${report.errors.length} bloco(s) falharam` : undefined,
      startedAtMs,
    });

    log.info("run finished", {
      run_id: runId,
      duration_ms: Date.now() - startedAtMs,
      ...report,
    });

    return NextResponse.json({ ok: true, ...report });
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
