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
import { startCronRun, finishCronRun } from "@/lib/cron-runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers.get("authorization") || "";
  if (auth === `Bearer ${secret}`) return true;
  if (req.headers.get("x-cron-secret") === secret) return true;
  return false;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 }
    );
  }

  const supabase = getSupabaseAdmin();
  const startedAtMs = Date.now();
  const runId = await startCronRun(supabase, "notify_pending_documents");

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

    console.info("[cron/notify-pending-documents]", {
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
    console.error("[cron/notify-pending-documents] exception:", message);
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
