/**
 * Cron semanal de anonimização por política de retenção (PR-033-A · D-052).
 *
 * Escopo: `customers` "ghost" (sem appointments, fulfillments ou
 * plan_acceptances) criados há mais de `RETENTION_THRESHOLD_DAYS` dias.
 * Fundamento LGPD: Art. 16 — dados pessoais devem ser eliminados após
 * o término de seu tratamento.
 *
 * Por quê "ghost" só e não pacientes com histórico?
 *
 *   Pacientes que tiveram ao menos uma consulta ou fulfillment
 *   carregam obrigação CFM 1.821/2007 de prontuário por 20 anos. Essa
 *   janela é coberta por outro cron (a ser implementado quando chegar
 *   a hora — 2045+). Este cron é só sobre quem cadastrou-se e sumiu
 *   sem gerar nenhum vínculo assistencial.
 *
 * Agendamento: semanal, domingo 04:00 UTC ≈ 01:00 BRT. Intervalo curto
 * o suficiente pra manter o backlog baixo; baixa frequência pra não
 * consumir computação desnecessária.
 *
 * Segurança:
 *   - `assertCronRequest` garante que só Vercel Cron (ou operador com
 *     CRON_SECRET em manual debug) dispara.
 *   - `limit=50` por execução (default de `runRetentionAnonymization`).
 *     Evita anonimização em massa por bug. Se o backlog ficar > 50/dia,
 *     ajustar manualmente ou escalar.
 *
 * Manual / debug:
 *
 *   curl -H "x-cron-secret: $CRON_SECRET" \
 *     "https://.../api/internal/cron/retention-anonymize"
 *
 *   # Dry-run (não muta, só reporta quem seria anonimizado):
 *   curl -H "x-cron-secret: $CRON_SECRET" \
 *     "https://.../api/internal/cron/retention-anonymize?dryRun=1"
 *
 *   # Threshold customizado em dias (ex.: para teste em stage):
 *   curl -H "x-cron-secret: $CRON_SECRET" \
 *     "https://.../api/internal/cron/retention-anonymize?thresholdDays=365"
 */

import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { startCronRun, finishCronRun } from "@/lib/cron-runs";
import { assertCronRequest } from "@/lib/cron-auth";
import {
  runRetentionAnonymization,
  DEFAULT_RETENTION_THRESHOLD_DAYS,
  DEFAULT_RETENTION_BATCH_LIMIT,
} from "@/lib/retention";

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
  const limitParam = parseInt(url.searchParams.get("limit") ?? "", 10);

  // Bounds defensivos: threshold nunca abaixo de 90 dias (evita acidente
  // catastrófico tipo query-string com `thresholdDays=1`), nunca acima
  // de 3650 (>10 anos — faz a query ficar trivialmente vazia).
  const thresholdDays =
    Number.isFinite(thresholdDaysParam) && thresholdDaysParam >= 90
      ? Math.min(thresholdDaysParam, 3650)
      : DEFAULT_RETENTION_THRESHOLD_DAYS;

  // Limite: 1–500. Default 50.
  const limit =
    Number.isFinite(limitParam) && limitParam >= 1
      ? Math.min(limitParam, 500)
      : DEFAULT_RETENTION_BATCH_LIMIT;

  const supabase = getSupabaseAdmin();
  const startedAtMs = Date.now();
  const runId = await startCronRun(supabase, "retention_anonymize");

  try {
    const report = await runRetentionAnonymization(supabase, {
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
        totalCandidates: report.totalCandidates,
        anonymized: report.anonymized,
        skippedAlreadyAnonymized: report.skippedAlreadyAnonymized,
        skippedHasActiveFulfillment: report.skippedHasActiveFulfillment,
        errors: report.errors,
        // Guardamos só os 20 primeiros detalhes pra não bloatear o
        // cron_runs.payload em execuções grandes.
        details: report.details.slice(0, 20),
      },
      startedAtMs,
      errorMessage: hadErrors
        ? report.details
            .flatMap((d) =>
              d.outcome === "error"
                ? [`${d.customerId}: ${d.message}`]
                : []
            )
            .slice(0, 3)
            .join(" | ")
        : undefined,
    });

    console.info("[cron/retention-anonymize]", {
      dryRun: report.dryRun,
      thresholdDays: report.thresholdDays,
      totalCandidates: report.totalCandidates,
      anonymized: report.anonymized,
      skippedAlreadyAnonymized: report.skippedAlreadyAnonymized,
      skippedHasActiveFulfillment: report.skippedHasActiveFulfillment,
      errors: report.errors,
    });

    return NextResponse.json({ ok: true, ...report });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[cron/retention-anonymize] exception:", message);
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
