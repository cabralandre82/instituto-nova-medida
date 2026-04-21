/**
 * Cron diário de cobrança de NF-e pendente (D-041).
 *
 * Para cada payout `confirmed` cujo PIX saiu há ≥ 7 dias e ainda não
 * tem NF-e validada, envia WhatsApp `medica_documento_pendente`.
 * Idempotente via `doctor_payouts.last_nf_reminder_at` (só cobra
 * 1x/dia).
 *
 * Agendado via Vercel Cron (vercel.json) às 09:00 UTC ≈ 06:00 BRT.
 * Debug manual:
 *
 *   curl -H "x-cron-secret: $CRON_SECRET" \
 *     "https://.../api/internal/cron/notify-pending-documents"
 */

import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { notifyPendingDocuments } from "@/lib/notify-pending-documents";
import { CIRCUIT_KEYS } from "@/lib/circuit-breaker";
import { skipIfCircuitOpen } from "@/lib/cron-guard";
import { startCronRun, finishCronRun } from "@/lib/cron-runs";
import { assertCronRequest } from "@/lib/cron-auth";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/internal/cron/notify-pending-documents" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const unauth = assertCronRequest(req);
  if (unauth) return unauth;

  const supabase = getSupabaseAdmin();
  const startedAtMs = Date.now();
  const runId = await startCronRun(supabase, "notify_pending_documents");

  const gate = await skipIfCircuitOpen(supabase, runId, {
    circuitKey: CIRCUIT_KEYS.whatsapp,
    jobName: "notify_pending_documents",
    startedAtMs,
  });
  if (gate.skipped) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "whatsapp_circuit_open",
      retry_at: gate.retryAt ? new Date(gate.retryAt).toISOString() : null,
    });
  }

  try {
    const report = await notifyPendingDocuments(supabase);
    const hadErrors = report.errors > 0;

    await finishCronRun(supabase, runId, {
      status: hadErrors ? "error" : "ok",
      payload: {
        evaluated: report.evaluated,
        notified: report.notified,
        skippedInterval: report.skippedInterval,
        skippedTemplate: report.skippedTemplate,
        skippedMissingPhone: report.skippedMissingPhone,
        skippedMissingName: report.skippedMissingName,
        errors: report.errors,
        details: report.details.slice(0, 20),
      },
      startedAtMs,
      errorMessage: hadErrors
        ? report.details
            .filter((d) => d.outcome === "error")
            .slice(0, 3)
            .map((d) => `${d.payoutId}: ${d.message ?? "?"}`)
            .join(" | ")
        : undefined,
    });

    log.info("run finished", {
      run_id: runId,
      duration_ms: Date.now() - startedAtMs,
      evaluated: report.evaluated,
      notified: report.notified,
      skippedInterval: report.skippedInterval,
      skippedTemplate: report.skippedTemplate,
      skippedMissingPhone: report.skippedMissingPhone,
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
