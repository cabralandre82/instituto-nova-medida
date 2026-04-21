/**
 * Cron semanal de purge de PII em `asaas_events.payload` (PR-052 · D-063).
 *
 * Finding 5.12 do audit: webhooks Asaas acumulavam payloads crus com
 * PII (CPF, email, phone, endereço) indefinidamente. Violação LGPD
 * Art. 16 + princípio da necessidade.
 *
 * Complementa `redactAsaasPayload()` no webhook (que redacta PII no
 * INSERT). Este cron fecha o loop esvaziando o payload (→ `{}`) após
 * 180 dias de processado — acima do prazo máximo de chargeback
 * Mastercard/Visa (120d) + 60d de folga operacional.
 *
 * Agendamento: semanal, domingo 05:00 UTC ≈ 02:00 BRT.
 * Depois do retention-anonymize (04:00 UTC) — mantém o domingo como
 * janela de housekeeping LGPD.
 *
 * Segurança:
 *   - `assertCronRequest`.
 *   - Limit default 500, max 10_000.
 *   - Threshold min 90d, max 3650d (bounds em `asaas-events-retention.ts`).
 *
 * Manual / debug:
 *
 *   curl -H "x-cron-secret: $CRON_SECRET" \
 *     "https://.../api/internal/cron/asaas-events-purge"
 *
 *   # Dry-run:
 *   curl -H "x-cron-secret: $CRON_SECRET" \
 *     "https://.../api/internal/cron/asaas-events-purge?dryRun=1"
 *
 *   # Threshold customizado:
 *   curl -H "x-cron-secret: $CRON_SECRET" \
 *     "https://.../api/internal/cron/asaas-events-purge?thresholdDays=365"
 */

import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { startCronRun, finishCronRun } from "@/lib/cron-runs";
import { assertCronRequest } from "@/lib/cron-auth";
import {
  purgeAsaasEventsPayload,
  DEFAULT_PURGE_THRESHOLD_DAYS,
  DEFAULT_PURGE_BATCH_LIMIT,
} from "@/lib/asaas-events-retention";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/internal/cron/asaas-events-purge" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const unauth = assertCronRequest(req);
  if (unauth) return unauth;

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") === "1";

  const thresholdDaysParam = parseInt(
    url.searchParams.get("thresholdDays") ?? "",
    10
  );
  const thresholdDays = Number.isFinite(thresholdDaysParam)
    ? thresholdDaysParam
    : DEFAULT_PURGE_THRESHOLD_DAYS;

  const limitParam = parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitParam)
    ? limitParam
    : DEFAULT_PURGE_BATCH_LIMIT;

  const supabase = getSupabaseAdmin();
  const startedAtMs = Date.now();
  const runId = await startCronRun(supabase, "asaas_events_purge");

  try {
    const report = await purgeAsaasEventsPayload(supabase, {
      thresholdDays,
      limit,
      dryRun,
    });

    const hadErrors = report.errors > 0;

    await finishCronRun(supabase, runId, {
      status: hadErrors ? "error" : "ok",
      payload: {
        dryRun: report.dryRun,
        thresholdDays: report.thresholdDays,
        candidatesFound: report.candidatesFound,
        purged: report.purged,
        errors: report.errors,
        errorDetails: report.errorDetails.slice(0, 3),
        oldestPurgedAt: report.oldestPurgedAt,
        newestPurgedAt: report.newestPurgedAt,
      },
      startedAtMs,
      errorMessage: hadErrors
        ? report.errorDetails.slice(0, 3).join(" | ")
        : undefined,
    });

    log.info("run finished", {
      run_id: runId,
      duration_ms: Date.now() - startedAtMs,
      dryRun: report.dryRun,
      thresholdDays: report.thresholdDays,
      candidatesFound: report.candidatesFound,
      purged: report.purged,
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
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 }
    );
  }
}
