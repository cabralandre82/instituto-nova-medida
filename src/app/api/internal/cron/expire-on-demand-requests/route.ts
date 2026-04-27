/**
 * Cron: expire-on-demand-requests (PR-079 · D-091).
 *
 * Roda a cada 1 minuto. Marca como `expired` qualquer
 * `on_demand_requests` em status `pending` cujo `expires_at <= now()`.
 *
 * Por que existe
 * ──────────────
 * Quando o paciente solicita atendimento on-demand, o request fica
 * pending até que (a) uma médica aceite, (b) o paciente cancele, ou
 * (c) o TTL acabe. Sem este cron, requests órfãos ficariam pending
 * pra sempre, bloqueando o paciente de criar novo (constraint
 * unique parcial em customer_id WHERE status='pending').
 *
 * Idempotente: o sweep só toca rows pending, então rodar 2x em
 * sequência produz 0 expired no segundo run.
 *
 * Manual / debug:
 *   curl -H "x-cron-secret: $CRON_SECRET" \
 *     "https://.../api/internal/cron/expire-on-demand-requests"
 *
 *   # Limit custom:
 *   curl -H "x-cron-secret: $CRON_SECRET" \
 *     "https://.../api/internal/cron/expire-on-demand-requests?limit=50"
 */

import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { startCronRun, finishCronRun } from "@/lib/cron-runs";
import { assertCronRequest } from "@/lib/cron-auth";
import { expireStaleRequests } from "@/lib/on-demand";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/internal/cron/expire-on-demand-requests" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 200;
const MIN_LIMIT = 1;
const MAX_LIMIT = 5000;

export async function GET(req: NextRequest) {
  const unauth = assertCronRequest(req);
  if (unauth) return unauth;

  const url = new URL(req.url);
  const limitParam = parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitParam)
    ? Math.max(MIN_LIMIT, Math.min(limitParam, MAX_LIMIT))
    : DEFAULT_LIMIT;

  const supabase = getSupabaseAdmin();
  const startedAtMs = Date.now();
  const runId = await startCronRun(supabase, "expire_on_demand_requests");

  try {
    const report = await expireStaleRequests({ limit, supabase });

    await finishCronRun(supabase, runId, {
      status: "ok",
      payload: {
        expired_count: report.expiredCount,
        limit,
      },
      startedAtMs,
    });

    log.info("run finished", {
      run_id: runId,
      duration_ms: Date.now() - startedAtMs,
      expired_count: report.expiredCount,
    });

    return NextResponse.json({ ok: true, expiredCount: report.expiredCount });
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
