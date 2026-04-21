/**
 * Cron · auto-delivered fulfillments (D-045 · 3.C)
 *
 * Fecha fulfillments que ficaram em `shipped` por mais de
 * `SHIPPED_TO_DELIVERED_DAYS` dias sem o paciente confirmar recebimento.
 * Usa `transitionFulfillment` com `actor: 'system'` (idempotente por guard
 * de status) e notifica o paciente por WA (best-effort).
 *
 * Agendado via Vercel Cron (vercel.json) às 10:00 UTC ≈ 07:00 BRT.
 *
 * Debug manual:
 *
 *   curl -H "x-cron-secret: $CRON_SECRET" \
 *     "https://.../api/internal/cron/auto-deliver-fulfillments"
 */

import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { autoDeliverFulfillments } from "@/lib/auto-deliver-fulfillments";
import { startCronRun, finishCronRun } from "@/lib/cron-runs";
import { assertCronRequest } from "@/lib/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const unauth = assertCronRequest(req);
  if (unauth) return unauth;

  const supabase = getSupabaseAdmin();
  const startedAtMs = Date.now();
  const runId = await startCronRun(supabase, "auto_deliver_fulfillments");

  try {
    const report = await autoDeliverFulfillments(supabase);
    const hadErrors = report.errors > 0;

    await finishCronRun(supabase, runId, {
      status: hadErrors ? "error" : "ok",
      payload: {
        evaluated: report.evaluated,
        delivered: report.delivered,
        errors: report.errors,
        skipped: report.skipped,
        details: report.details.slice(0, 20),
      },
      startedAtMs,
      errorMessage: hadErrors
        ? report.details
            .filter(
              (d) => d.outcome === "transition_failed" || d.outcome === "error"
            )
            .slice(0, 3)
            .map((d) => `${d.fulfillmentId}: ${d.message ?? "?"}`)
            .join(" | ")
        : undefined,
    });

    console.info("[cron/auto-deliver-fulfillments]", {
      evaluated: report.evaluated,
      delivered: report.delivered,
      errors: report.errors,
      skipped: report.skipped,
    });

    return NextResponse.json({ ok: true, ...report });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[cron/auto-deliver-fulfillments] exception:", message);
    await finishCronRun(supabase, runId, {
      status: "error",
      errorMessage: message,
      startedAtMs,
    });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
