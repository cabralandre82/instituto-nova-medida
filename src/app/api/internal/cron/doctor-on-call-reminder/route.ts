/**
 * Cron · doctor-on-call-reminder (PR-077 · D-089)
 *
 * Roda a cada minuto. Procura blocos `on_call` recorrentes ativos
 * cuja PRÓXIMA OCORRÊNCIA começa nos próximos 15-16 minutos (em
 * America/Sao_Paulo) e enfileira `doctor_on_call_t_minus_15min`.
 *
 * Idempotência: unique parcial por (doctor_id, availability_id,
 * kind, scheduled_for) — re-rodar no mesmo minuto não duplica.
 *
 * Estratégia (sem trigonometria):
 *   1. Calcula o "instante alvo" T = now + 15 min (em SP).
 *   2. SELECT availability ativos `type=on_call` cujo weekday=T.weekday.
 *   3. Filtra app-side: start_time igual a T.HH:MM (truncado ao minuto).
 *      Aceita ±1 min de tolerância pra cobrir desvios de schedule
 *      do Vercel (que raramente roda exatamente em :00).
 *   4. Pra cada match, calcula scheduled_for = T - 15min (= now,
 *      truncado ao minuto) e enqueue.
 *
 * Esta lógica é aproximada por design — o objetivo é "avisar a
 * médica antes do plantão começar", não precisar disparar
 * exatamente 15min antes ao segundo.
 *
 * Debug manual:
 *
 *   curl -H "x-cron-secret: $CRON_SECRET" \
 *     "https://.../api/internal/cron/doctor-on-call-reminder?dryRun=true"
 */

import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { startCronRun, finishCronRun } from "@/lib/cron-runs";
import { assertCronRequest } from "@/lib/cron-auth";
import { enqueueDoctorNotification } from "@/lib/doctor-notifications";
import { logger } from "@/lib/logger";

const log = logger.with({
  route: "/api/internal/cron/doctor-on-call-reminder",
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TZ = "America/Sao_Paulo";
const TOLERANCE_MIN = 1;

type AvailabilityLite = {
  id: string;
  doctor_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
};

/**
 * Quebra um Date em partes locais de America/Sao_Paulo (sem DST,
 * fixo UTC-3) usando `toLocaleString`. Retorna weekday (0=domingo)
 * e hh:mm:00.
 */
function spParts(d: Date): {
  weekday: number;
  hh: number;
  mm: number;
  iso: string;
} {
  const sp = new Date(d.toLocaleString("en-US", { timeZone: TZ }));
  return {
    weekday: sp.getDay(),
    hh: sp.getHours(),
    mm: sp.getMinutes(),
    iso: sp.toISOString(),
  };
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function timeMatchesWithin(
  startTime: string,
  targetHH: number,
  targetMM: number,
  toleranceMin: number
): boolean {
  const [h, m] = startTime.split(":").map((v) => Number.parseInt(v, 10));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return false;
  const startMin = h * 60 + m;
  const targetMin = targetHH * 60 + targetMM;
  const delta = Math.abs(startMin - targetMin);
  return delta <= toleranceMin;
}

/**
 * Constrói o Date que representa o início da próxima ocorrência do
 * bloco no fuso SP, truncado ao minuto. Usado pra escrever `scheduled_for
 * + 15min = shift_start` na payload.
 */
function buildShiftStartUtc(
  now: Date,
  startTime: string
): Date {
  const sp = new Date(now.toLocaleString("en-US", { timeZone: TZ }));
  const [h, m] = startTime.split(":").map((v) => Number.parseInt(v, 10));
  // Substitui hora/minuto preservando data SP.
  const y = sp.getFullYear();
  const mo = sp.getMonth();
  const d = sp.getDate();
  // SP fixo UTC-3 (sem DST).
  return new Date(Date.UTC(y, mo, d, h + 3, m, 0, 0));
}

export async function GET(req: NextRequest) {
  const unauth = assertCronRequest(req);
  if (unauth) return unauth;

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "true";

  const supabase = getSupabaseAdmin();
  const startedAtMs = Date.now();
  const runId = await startCronRun(supabase, "doctor_on_call_reminder");

  try {
    const now = new Date();
    const target = new Date(now.getTime() + 15 * 60_000);
    const tParts = spParts(target);

    // Carrega todos os blocos on_call ativos do weekday alvo.
    const { data, error } = await supabase
      .from("doctor_availability")
      .select("id, doctor_id, weekday, start_time, end_time, type, active")
      .eq("active", true)
      .eq("type", "on_call")
      .eq("weekday", tParts.weekday);

    if (error) {
      log.error("query availability", { err: error });
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

    const candidates: AvailabilityLite[] = ((data ?? []) as Array<
      AvailabilityLite & { type: string; active: boolean }
    >).filter((row) =>
      timeMatchesWithin(row.start_time, tParts.hh, tParts.mm, TOLERANCE_MIN)
    );

    let enqueued = 0;
    let alreadyExisting = 0;
    const detail: Array<{ doctor_id: string; availability_id: string }> = [];

    if (!dryRun) {
      for (const c of candidates) {
        // scheduled_for = início do bloco - 15min, truncado ao minuto.
        const shiftStart = buildShiftStartUtc(now, c.start_time);
        const scheduledFor = new Date(shiftStart.getTime() - 15 * 60_000);
        const id = await enqueueDoctorNotification({
          doctorId: c.doctor_id,
          kind: "doctor_on_call_t_minus_15min",
          availabilityId: c.id,
          scheduledFor,
          payload: {
            shift_start_iso: shiftStart.toISOString(),
            weekday: c.weekday,
            start_time: c.start_time,
            end_time: c.end_time,
          },
        });
        if (id) {
          enqueued += 1;
          detail.push({ doctor_id: c.doctor_id, availability_id: c.id });
        } else {
          alreadyExisting += 1;
        }
      }
    }

    await finishCronRun(supabase, runId, {
      status: "ok",
      payload: {
        target_weekday: tParts.weekday,
        target_time: `${pad2(tParts.hh)}:${pad2(tParts.mm)}`,
        candidates_total: data?.length ?? 0,
        candidates_matched: candidates.length,
        enqueued,
        already_existing: alreadyExisting,
        dry_run: dryRun,
      },
      startedAtMs,
    });

    if (enqueued > 0) {
      log.info("run finished", {
        run_id: runId,
        duration_ms: Date.now() - startedAtMs,
        candidates: candidates.length,
        enqueued,
        details: detail,
      });
    }

    return NextResponse.json({
      ok: true,
      target_weekday: tParts.weekday,
      target_time: `${pad2(tParts.hh)}:${pad2(tParts.mm)}`,
      candidates_matched: candidates.length,
      enqueued,
      already_existing: alreadyExisting,
      dry_run: dryRun,
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
