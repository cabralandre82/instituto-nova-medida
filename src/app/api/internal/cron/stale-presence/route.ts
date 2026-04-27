/**
 * Cron: stale-presence (PR-075-B · D-087).
 *
 * Roda a cada 1 minuto. Marca como `offline` qualquer
 * `doctor_presence` em status `online`|`busy` cujo
 * `last_heartbeat_at` é anterior a `now() - STALE_THRESHOLD` (120s
 * por padrão).
 *
 * Por que existe:
 *   - UI da médica fecha aba sem clicar "sair" → presença fica
 *     fantasma como `online`, paciente em on-demand entra em fila
 *     vazia.
 *   - Cron fecha a janela em ≤ 1min depois do timeout.
 *
 * Idempotente: sweep não opera em rows já offline. Rodar 2x em
 * sequência produz 0 candidatos no segundo run.
 *
 * Manual / debug:
 *   curl -H "x-cron-secret: $CRON_SECRET" \
 *     "https://.../api/internal/cron/stale-presence"
 *
 *   # Dry-run (lista candidatos sem mutar):
 *   curl -H "x-cron-secret: $CRON_SECRET" \
 *     "https://.../api/internal/cron/stale-presence?dryRun=1"
 *
 *   # Threshold custom (em segundos):
 *   curl -H "x-cron-secret: $CRON_SECRET" \
 *     "https://.../api/internal/cron/stale-presence?staleSeconds=60"
 */

import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { startCronRun, finishCronRun } from "@/lib/cron-runs";
import { assertCronRequest } from "@/lib/cron-auth";
import {
  sweepStalePresence,
  STALE_PRESENCE_THRESHOLD_SECONDS,
  DEFAULT_STALE_SWEEP_LIMIT,
  MIN_STALE_SWEEP_LIMIT,
  MAX_STALE_SWEEP_LIMIT,
} from "@/lib/doctor-presence";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/internal/cron/stale-presence" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const unauth = assertCronRequest(req);
  if (unauth) return unauth;

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") === "1";

  const limitParam = parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitParam)
    ? Math.max(MIN_STALE_SWEEP_LIMIT, Math.min(limitParam, MAX_STALE_SWEEP_LIMIT))
    : DEFAULT_STALE_SWEEP_LIMIT;

  const staleParam = parseInt(url.searchParams.get("staleSeconds") ?? "", 10);
  const staleThreshold = Number.isFinite(staleParam) && staleParam > 0
    ? staleParam
    : STALE_PRESENCE_THRESHOLD_SECONDS;

  const supabase = getSupabaseAdmin();
  const startedAtMs = Date.now();
  const runId = await startCronRun(supabase, "stale_presence");

  try {
    const report = await sweepStalePresence(supabase, {
      staleThresholdSeconds: staleThreshold,
      limit,
      dryRun,
    });

    const hadErrors = report.errors > 0;

    await finishCronRun(supabase, runId, {
      status: hadErrors ? "error" : "ok",
      payload: {
        dryRun: report.dryRun,
        candidatesFound: report.candidatesFound,
        forcedOffline: report.forcedOffline,
        errors: report.errors,
        errorDetails: report.errorDetails.slice(0, 3),
        oldestStaleHeartbeatAt: report.oldestStaleHeartbeatAt,
        newestStaleHeartbeatAt: report.newestStaleHeartbeatAt,
        staleThresholdSeconds: staleThreshold,
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
      candidatesFound: report.candidatesFound,
      forcedOffline: report.forcedOffline,
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
