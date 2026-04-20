/**
 * Cron mensal de geração de payouts (D-040).
 *
 * Agenda (vercel.json): dia 1 de cada mês às 09:15 UTC (06:15 BRT).
 * Promove earnings `available` anteriores ao mês corrente em drafts de
 * `doctor_payouts` por médica+mês, marcados `auto_generated=true`.
 *
 * Call manual (backfill / debug):
 *
 *   curl -H "x-cron-secret: $CRON_SECRET" \
 *     "https://.../api/internal/cron/generate-payouts?period=2026-04"
 *
 * Filosofia:
 *   - Autenticado por `CRON_SECRET` quando configurado. Sem = dev.
 *   - Idempotente: UNIQUE(doctor_id, reference_period) + handler 23505
 *     fazem rodadas repetidas resultarem em 0 payouts criados.
 *   - Observabilidade rica: warnings pra médicas sem PIX ativo/config,
 *     registradas no payload de `cron_runs` pra o admin agir.
 *
 * O cron NÃO aprova nem envia PIX — só gera o draft. Admin revisa em
 * `/admin/payouts`, aprova (`approve`), envia PIX manual e confirma.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { generateMonthlyPayouts } from "@/lib/monthly-payouts";
import { startCronRun, finishCronRun } from "@/lib/cron-runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PERIOD_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers.get("authorization") || "";
  if (auth === `Bearer ${secret}`) return true;
  if (req.headers.get("x-cron-secret") === secret) return true;
  return false;
}

function parsePeriod(req: NextRequest): string | undefined {
  const raw = req.nextUrl.searchParams.get("period");
  if (!raw) return undefined;
  if (!PERIOD_REGEX.test(raw)) return undefined;
  return raw;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 }
    );
  }

  const supabase = getSupabaseAdmin();
  const referencePeriod = parsePeriod(req);
  const startedAtMs = Date.now();
  const runId = await startCronRun(supabase, "generate_monthly_payouts");

  try {
    const report = await generateMonthlyPayouts(supabase, {
      referencePeriod,
    });
    const hadErrors = report.errors > 0;

    await finishCronRun(supabase, runId, {
      status: hadErrors ? "error" : "ok",
      payload: {
        referencePeriod: report.referencePeriod,
        doctorsEvaluated: report.doctorsEvaluated,
        payoutsCreated: report.payoutsCreated,
        payoutsSkippedExisting: report.payoutsSkippedExisting,
        payoutsSkippedMissingPix: report.payoutsSkippedMissingPix,
        earningsLinked: report.earningsLinked,
        totalCentsDrafted: report.totalCentsDrafted,
        warnings: report.warnings.slice(0, 20),
        errors: report.errors,
        errorDetails: report.errorDetails.slice(0, 10),
      },
      startedAtMs,
      errorMessage: hadErrors
        ? report.errorDetails.slice(0, 3).join(" | ")
        : undefined,
    });

    console.info("[cron/generate-payouts]", {
      referencePeriod: report.referencePeriod,
      payoutsCreated: report.payoutsCreated,
      payoutsSkippedMissingPix: report.payoutsSkippedMissingPix,
      totalCentsDrafted: report.totalCentsDrafted,
      warnings: report.warnings.length,
      errors: report.errors,
    });

    return NextResponse.json({ ...report });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[cron/generate-payouts] exception:", message);
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
