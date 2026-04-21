/**
 * Cron · nudge-reconsulta (D-045 · 3.C)
 *
 * Avisa pacientes cujo ciclo tá terminando pra agendarem reconsulta.
 * Idempotente via `fulfillments.reconsulta_nudged_at`.
 *
 * Agendado via Vercel Cron (vercel.json) às 11:00 UTC ≈ 08:00 BRT
 * (1h depois do auto-deliver, pra cada run ter estado limpo).
 *
 * Debug manual:
 *
 *   curl -H "x-cron-secret: $CRON_SECRET" \
 *     "https://.../api/internal/cron/nudge-reconsulta"
 */

import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { nudgeReconsulta } from "@/lib/nudge-reconsulta";
import { startCronRun, finishCronRun } from "@/lib/cron-runs";
import { assertCronRequest } from "@/lib/cron-auth";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/internal/cron/nudge-reconsulta" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const unauth = assertCronRequest(req);
  if (unauth) return unauth;

  const supabase = getSupabaseAdmin();
  const startedAtMs = Date.now();
  const runId = await startCronRun(supabase, "nudge_reconsulta");

  try {
    const report = await nudgeReconsulta(supabase);
    const hadErrors = report.errors > 0;

    await finishCronRun(supabase, runId, {
      status: hadErrors ? "error" : "ok",
      payload: {
        evaluated: report.evaluated,
        nudged: report.nudged,
        skipped: report.skipped,
        errors: report.errors,
        details: report.details.slice(0, 20),
      },
      startedAtMs,
      errorMessage: hadErrors
        ? report.details
            .filter(
              (d) =>
                d.outcome === "error" ||
                d.outcome === "db_error" ||
                d.outcome === "wa_failed"
            )
            .slice(0, 3)
            .map((d) => `${d.fulfillmentId}: ${d.message ?? "?"}`)
            .join(" | ")
        : undefined,
    });

    log.info("run finished", {
      run_id: runId,
      duration_ms: Date.now() - startedAtMs,
      evaluated: report.evaluated,
      nudged: report.nudged,
      skipped: report.skipped,
      errors: report.errors,
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
