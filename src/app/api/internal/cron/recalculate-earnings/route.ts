/**
 * Cron diário de availability de earnings (D-040).
 *
 * Promove earnings `pending` → `available` conforme a janela de risco
 * do meio de pagamento (D+7 PIX, D+3 Boleto, D+30 Cartão).
 *
 * Agendado via Vercel Cron (vercel.json) todos os dias às 00:15 BRT
 * (03:15 UTC). Também pode ser chamado manualmente pra debug:
 *
 *   curl -H "x-cron-secret: $CRON_SECRET" \
 *     "https://.../api/internal/cron/recalculate-earnings"
 *
 * Filosofia (mesma das outras crons):
 *   - Autenticado por `CRON_SECRET` quando configurado. Sem = dev.
 *   - Idempotente: `recalculateEarningsAvailability` só toca em
 *     earnings `status='pending'`. Rodar N vezes no dia não gera efeito
 *     colateral.
 *   - Observabilidade: persiste métricas em `cron_runs` pra
 *     `/admin/health` mostrar a última execução.
 *
 * Coexistência com pg_cron:
 *   A RPC `recalculate_earnings_availability()` continua agendada no
 *   Postgres como backup. Ambas usam a mesma regra e UPDATE com guard
 *   de status, portanto a 2ª só gera no-ops.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { recalculateEarningsAvailability } from "@/lib/earnings-availability";
import { startCronRun, finishCronRun } from "@/lib/cron-runs";
import { assertCronRequest } from "@/lib/cron-auth";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/internal/cron/recalculate-earnings" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const unauth = assertCronRequest(req);
  if (unauth) return unauth;

  const supabase = getSupabaseAdmin();
  const startedAtMs = Date.now();
  const runId = await startCronRun(supabase, "recalc_earnings_availability");

  try {
    const report = await recalculateEarningsAvailability(supabase);
    const hadErrors = report.errors > 0;

    await finishCronRun(supabase, runId, {
      status: hadErrors ? "error" : "ok",
      payload: {
        inspected: report.inspected,
        scheduledFuture: report.scheduledFuture,
        promoted: report.promoted,
        skippedMissingPaidAt: report.skippedMissingPaidAt,
        errors: report.errors,
        errorDetails: report.errorDetails.slice(0, 10),
      },
      startedAtMs,
      errorMessage: hadErrors
        ? report.errorDetails.slice(0, 3).join(" | ")
        : undefined,
    });

    log.info("run finished", {
      run_id: runId,
      duration_ms: Date.now() - startedAtMs,
      inspected: report.inspected,
      promoted: report.promoted,
      scheduledFuture: report.scheduledFuture,
      errors: report.errors,
    });

    return NextResponse.json({ ...report });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.error("exception", { run_id: runId, err: e });
    await finishCronRun(supabase, runId, {
      status: "error",
      errorMessage: message,
      startedAtMs,
    });
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 }
    );
  }
}
