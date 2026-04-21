/**
 * Cron · admin-digest (D-045 · 3.D)
 *
 * Envia um WhatsApp matinal pro operador solo com o rollup da inbox.
 * Fonte: `loadAdminInbox` (mesma que o dashboard /admin).
 *
 * Agendado via Vercel Cron (vercel.json) às 11:30 UTC ≈ 08:30 BRT.
 *
 * Debug manual:
 *
 *   curl -H "x-cron-secret: $CRON_SECRET" \
 *     "https://.../api/internal/cron/admin-digest"
 */

import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { sendAdminDigest } from "@/lib/admin-digest";
import { startCronRun, finishCronRun } from "@/lib/cron-runs";
import { assertCronRequest } from "@/lib/cron-auth";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/internal/cron/admin-digest" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const unauth = assertCronRequest(req);
  if (unauth) return unauth;

  const supabase = getSupabaseAdmin();
  const startedAtMs = Date.now();
  const runId = await startCronRun(supabase, "admin_digest");

  try {
    const report = await sendAdminDigest(supabase);
    const hadErrors = report.reason === "wa_failed";

    await finishCronRun(supabase, runId, {
      status: hadErrors ? "error" : "ok",
      payload: {
        sent: report.sent,
        reason: report.reason,
        inboxCounts: report.inboxCounts,
        waCode: report.waCode ?? null,
      },
      startedAtMs,
      errorMessage: hadErrors
        ? `wa_failed: ${report.waMessage ?? "?"}`
        : undefined,
    });

    log.info("run finished", {
      run_id: runId,
      duration_ms: Date.now() - startedAtMs,
      sent: report.sent,
      reason: report.reason,
      inboxCounts: report.inboxCounts,
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
