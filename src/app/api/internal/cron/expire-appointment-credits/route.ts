/**
 * Cron diário de sweep pra materializar `appointment_credits` expirados
 * (PR-073-B · D-083 · follow-up do finding [2.4]).
 *
 * Contexto: o PR-073 · D-081 instalou `appointment_credits` com status
 * computado on-read via `computeCurrentStatus()` — ou seja, UI do paciente,
 * `/admin/reliability` e admin-inbox todos reconhecem um crédito `active`
 * cujo `expires_at` já passou como `expired` sem precisar do DB estar
 * consistente. Produção funciona sem este cron.
 *
 * Então o que este cron faz?
 *   Fecha o loop materializando a transição no DB:
 *
 *   - Relatórios SQL raw (`select count(*) where status='active'`)
 *     passam a contar a verdade.
 *   - Auditorias externas não precisam entender `WHERE status='active'
 *     AND expires_at > now()` em todo lugar.
 *   - Índice parcial `ix_appointment_credits_expiry_sweep`
 *     (`WHERE status='active'`) pára de carregar peso morto
 *     indefinidamente. Em 12-24 meses, rows expiradas dominariam o
 *     índice — sweep mantém o backlog baixo.
 *
 * Agendamento: diário, 12:00 UTC ≈ 09:00 BRT. Horário livre na grade
 * (ver tabela em `docs/RUNBOOK.md` §10). Rodar depois do admin-digest
 * (11:30 UTC) garante que o digest matinal viu o estado pré-sweep — não
 * faz diferença operacional (digest já usa compute-on-read), mas mantém
 * semântica cronológica limpa.
 *
 * Segurança:
 *   - `assertCronRequest` (igual aos demais crons).
 *   - Limit default 500, max 10_000 (`MAX_SWEEP_BATCH_LIMIT`).
 *   - Status `active` só. Rows `consumed`/`cancelled` nunca são tocadas.
 *
 * Manual / debug:
 *
 *   curl -H "x-cron-secret: $CRON_SECRET" \
 *     "https://.../api/internal/cron/expire-appointment-credits"
 *
 *   # Dry-run (reporta sem mutar):
 *   curl -H "x-cron-secret: $CRON_SECRET" \
 *     "https://.../api/internal/cron/expire-appointment-credits?dryRun=1"
 *
 *   # Batch menor (ex.: produção com load alto):
 *   curl -H "x-cron-secret: $CRON_SECRET" \
 *     "https://.../api/internal/cron/expire-appointment-credits?limit=100"
 */

import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { startCronRun, finishCronRun } from "@/lib/cron-runs";
import { assertCronRequest } from "@/lib/cron-auth";
import {
  sweepExpiredCredits,
  DEFAULT_SWEEP_BATCH_LIMIT,
} from "@/lib/appointment-credits";
import { logger } from "@/lib/logger";

const log = logger.with({
  route: "/api/internal/cron/expire-appointment-credits",
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const unauth = assertCronRequest(req);
  if (unauth) return unauth;

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") === "1";

  const limitParam = parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitParam)
    ? limitParam
    : DEFAULT_SWEEP_BATCH_LIMIT;

  const supabase = getSupabaseAdmin();
  const startedAtMs = Date.now();
  const runId = await startCronRun(supabase, "expire_appointment_credits");

  try {
    const report = await sweepExpiredCredits(supabase, {
      limit,
      dryRun,
    });

    const hadErrors = report.errors > 0;

    await finishCronRun(supabase, runId, {
      status: hadErrors ? "error" : "ok",
      payload: {
        dryRun: report.dryRun,
        candidatesFound: report.candidatesFound,
        expired: report.expired,
        errors: report.errors,
        errorDetails: report.errorDetails.slice(0, 3),
        oldestExpiredAt: report.oldestExpiredAt,
        newestExpiredAt: report.newestExpiredAt,
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
      expired: report.expired,
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
