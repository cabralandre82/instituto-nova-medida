/**
 * Cron · doctor-daily-summary (PR-077 · D-089)
 *
 * Roda 1x ao dia às ~20h Brasília (`0 23 * * *` UTC) e enfileira
 * `doctor_daily_summary` pra cada médica com ≥ 1 consulta agendada
 * pro próximo dia (em America/Sao_Paulo).
 *
 * Idempotência: a tabela `doctor_notifications` tem unique parcial
 * por (doctor_id, summary_date, kind) — re-rodar no mesmo dia não
 * duplica.
 *
 * Debug manual:
 *
 *   curl -H "x-cron-secret: $CRON_SECRET" \
 *     "https://.../api/internal/cron/doctor-daily-summary"
 */

import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { startCronRun, finishCronRun } from "@/lib/cron-runs";
import { assertCronRequest } from "@/lib/cron-auth";
import {
  enqueueDoctorNotification,
  tomorrowSPDateString,
} from "@/lib/doctor-notifications";
import { formatTime } from "@/lib/wa-templates";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/internal/cron/doctor-daily-summary" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TZ = "America/Sao_Paulo";

/**
 * Calcula início e fim do dia "amanhã" em America/Sao_Paulo, devolvido
 * em ISO UTC. Usado pelo SELECT de appointments por janela.
 */
function tomorrowSPRange(now: Date): { startUtc: string; endUtc: string } {
  // Strategy: parse partes y/m/d em SP a partir de now+1d, então
  // construir Date em UTC equivalente a 00:00 SP. SP é UTC-3 fixo
  // (sem DST desde 2019).
  const sp = new Date(now.toLocaleString("en-US", { timeZone: TZ }));
  sp.setDate(sp.getDate() + 1);
  const y = sp.getFullYear();
  const m = sp.getMonth();
  const d = sp.getDate();
  // 00:00 SP = 03:00 UTC. 23:59:59.999 SP = 02:59:59.999 UTC do dia
  // seguinte.
  const startUtc = new Date(Date.UTC(y, m, d, 3, 0, 0, 0));
  const endUtc = new Date(Date.UTC(y, m, d + 1, 2, 59, 59, 999));
  return { startUtc: startUtc.toISOString(), endUtc: endUtc.toISOString() };
}

export async function GET(req: NextRequest) {
  const unauth = assertCronRequest(req);
  if (unauth) return unauth;

  const supabase = getSupabaseAdmin();
  const startedAtMs = Date.now();
  const runId = await startCronRun(supabase, "doctor_daily_summary");

  try {
    const now = new Date();
    const { startUtc, endUtc } = tomorrowSPRange(now);
    const summaryDate = tomorrowSPDateString(now);

    const { data: appts, error } = await supabase
      .from("appointments")
      .select("doctor_id, scheduled_at")
      .gte("scheduled_at", startUtc)
      .lte("scheduled_at", endUtc)
      .in("status", ["scheduled", "confirmed", "in_progress"])
      .order("scheduled_at", { ascending: true });

    if (error) {
      log.error("query appts", { err: error });
      await finishCronRun(supabase, runId, {
        status: "error",
        errorMessage: `query: ${error.message}`,
        startedAtMs,
      });
      return NextResponse.json(
        { ok: false, error: "query_failed" },
        { status: 500 }
      );
    }

    type Aggregate = {
      total: number;
      first: Date;
      last: Date;
    };
    const byDoctor = new Map<string, Aggregate>();

    for (const a of (appts ?? []) as Array<{
      doctor_id: string;
      scheduled_at: string;
    }>) {
      const at = new Date(a.scheduled_at);
      const cur = byDoctor.get(a.doctor_id);
      if (!cur) {
        byDoctor.set(a.doctor_id, { total: 1, first: at, last: at });
      } else {
        cur.total += 1;
        if (at < cur.first) cur.first = at;
        if (at > cur.last) cur.last = at;
      }
    }

    let enqueued = 0;
    let alreadyExisting = 0;
    for (const [doctorId, agg] of byDoctor.entries()) {
      const id = await enqueueDoctorNotification({
        doctorId,
        kind: "doctor_daily_summary",
        summaryDate,
        scheduledFor: now,
        payload: {
          total_consultas: agg.total,
          primeiro_horario: formatTime(agg.first),
          ultimo_horario: formatTime(agg.last),
          summary_date: summaryDate,
        },
      });
      if (id) enqueued += 1;
      else alreadyExisting += 1;
    }

    await finishCronRun(supabase, runId, {
      status: "ok",
      payload: {
        summary_date: summaryDate,
        doctors_with_appts: byDoctor.size,
        enqueued,
        already_existing: alreadyExisting,
        appointments_considered: appts?.length ?? 0,
      },
      startedAtMs,
    });

    log.info("run finished", {
      run_id: runId,
      duration_ms: Date.now() - startedAtMs,
      summary_date: summaryDate,
      doctors: byDoctor.size,
      enqueued,
    });

    return NextResponse.json({
      ok: true,
      summary_date: summaryDate,
      doctors_with_appts: byDoctor.size,
      enqueued,
      already_existing: alreadyExisting,
    });
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
