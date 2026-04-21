/**
 * Cron de reconciliação Daily (D-035) — Instituto Nova Medida.
 *
 * Fallback do webhook Daily (D-029). Polling da REST API do Daily
 * pra fechar o ciclo de appointments que deveriam ter terminado mas
 * continuam sem status terminal por que o webhook não disparou
 * (bug conhecido: cliente `superagent` do Daily não consegue
 * registrar webhook contra hosts do Vercel).
 *
 * Agendado via Vercel Cron a cada 5 minutos (vercel.json). Também pode
 * ser chamado manualmente:
 *
 *   curl -H "x-cron-secret: $CRON_SECRET" \
 *     "https://.../api/internal/cron/daily-reconcile?limit=100"
 *
 * Filosofia (mesma do wa-reminders e expire-reservations):
 *   - Autenticado por `CRON_SECRET` quando configurado (Bearer ou
 *     x-cron-secret). Sem secret = ambiente dev/local.
 *   - Idempotente: `reconcileAppointmentFromMeetings` tem guards
 *     próprios em `reconciled_at` e no status terminal.
 *   - Janela: appointments cujo `end_estimated_at = scheduled_at +
 *     consultation_minutes` está entre `now() - 2h` e `now() - 5min`,
 *     E `status` ainda não é terminal, E `video_room_name IS NOT NULL`.
 *     Margem de 5min pra dar chance do paciente/médica ainda estar na
 *     sala depois do horário oficial.
 *   - Lookback de 2h é margem ampla pra cobrir webhook que chegaria
 *     atrasado (se D-029 voltar) + retry do próprio cron em caso de
 *     falha transiente da API do Daily.
 *
 * Coexistência com webhook:
 *   Quando D-029 voltar, webhook e cron rodam em paralelo. Isso é
 *   intencional — defesa em profundidade. Ambos chamam o mesmo
 *   `reconcileAppointmentFromMeetings`, que é idempotente via
 *   `reconciled_at`. Quem chega primeiro marca o source ('daily_webhook'
 *   ou 'daily_cron'); o segundo vira noop na audit trail.
 *
 * Custos:
 *   - Uma requisição à Daily /meetings por appointment vencido
 *     na janela. Em regime normal (poucos appointments/dia), são
 *     1-5 chamadas por execução, muito abaixo da quota do Daily.
 *   - MAX_LIMIT evita explosão em cenário patológico (backlog grande).
 *
 * Observabilidade:
 *   - Log estruturado por execução (processed, reconciled, errors).
 *   - Dashboard admin (D-033 extendido) vai mostrar a última execução
 *     e contagem de appointments reconciliados na última hora.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getVideoProvider } from "@/lib/video";
import {
  reconcileAppointmentFromMeetings,
  type ReconcileAction,
} from "@/lib/reconcile";
import { assertCronRequest } from "@/lib/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;
const MIN_AGE_MINUTES = 5; // só reconcilia após 5 min do fim previsto
const MAX_AGE_HOURS = 2; // não volta > 2h pra trás

function parseLimit(req: NextRequest): number {
  const raw = req.nextUrl.searchParams.get("limit");
  if (!raw) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

type CandidateRow = {
  id: string;
  video_room_name: string;
  scheduled_at: string;
  doctor_id: string;
  doctors:
    | {
        consultation_minutes: number | null;
        display_name: string | null;
        full_name: string | null;
      }
    | null;
};

type ReportCounters = {
  processed: number;
  by_action: Record<ReconcileAction, number>;
  errors: number;
  empty_meetings: number;
};

function newCounters(): ReportCounters {
  return {
    processed: 0,
    by_action: {
      already_terminal: 0,
      not_found: 0,
      completed: 0,
      no_show_patient: 0,
      no_show_doctor: 0,
      cancelled_expired: 0,
    },
    errors: 0,
    empty_meetings: 0,
  };
}

export async function GET(req: NextRequest) {
  const unauth = assertCronRequest(req);
  if (unauth) return unauth;

  const limit = parseLimit(req);
  const supabase = getSupabaseAdmin();

  // Janela: scheduled_at + consultation_minutes (estimativa do fim)
  // entre [now - 2h, now - 5min]. SQL complicaria; filtramos em duas
  // etapas: primeira query traz candidatos "vencidos há pouco", depois
  // Node filtra por consultation_minutes do doctor.
  //
  // Simplificação: puxamos appointments com scheduled_at entre
  // (now - 2h - 60min) e (now - 5min). O "-60min" extra cobre a
  // duração máxima razoável de uma consulta (60 min). Node refina.
  const nowMs = Date.now();
  const minScheduledAt = new Date(
    nowMs - (MAX_AGE_HOURS * 60 + 60) * 60 * 1000
  ).toISOString();
  const maxScheduledAt = new Date(nowMs - MIN_AGE_MINUTES * 60 * 1000).toISOString();

  const { data: candidates, error: selectErr } = await supabase
    .from("appointments")
    .select(
      "id, video_room_name, scheduled_at, doctor_id, doctors ( consultation_minutes, display_name, full_name )"
    )
    .in("status", ["scheduled", "confirmed", "in_progress"])
    .not("video_room_name", "is", null)
    .gte("scheduled_at", minScheduledAt)
    .lte("scheduled_at", maxScheduledAt)
    .is("reconciled_at", null)
    .order("scheduled_at", { ascending: true })
    .limit(limit * 2); // oversize pra sobrar após filtro de idade real

  if (selectErr) {
    console.error("[cron/daily-reconcile] select candidatos falhou:", selectErr);
    return NextResponse.json(
      { ok: false, error: selectErr.message },
      { status: 500 }
    );
  }

  const now = nowMs;
  const refined = (candidates ?? [])
    .map((row) => row as unknown as CandidateRow)
    .filter((row) => {
      const durationMin = row.doctors?.consultation_minutes ?? 30;
      const endEstimated =
        new Date(row.scheduled_at).getTime() + durationMin * 60 * 1000;
      const ageMs = now - endEstimated;
      return (
        ageMs >= MIN_AGE_MINUTES * 60 * 1000 &&
        ageMs <= MAX_AGE_HOURS * 60 * 60 * 1000
      );
    })
    .slice(0, limit);

  const report = newCounters();

  if (refined.length === 0) {
    console.log("[cron/daily-reconcile] nada pra reconciliar");
    return NextResponse.json({ ok: true, ...report });
  }

  let provider;
  try {
    provider = getVideoProvider();
  } catch (e) {
    console.error("[cron/daily-reconcile] provider indisponível:", e);
    return NextResponse.json(
      { ok: false, error: "video_provider_unavailable" },
      { status: 503 }
    );
  }

  for (const row of refined) {
    report.processed += 1;
    try {
      const meetings = await provider.listMeetingsForRoom({
        roomName: row.video_room_name,
      });
      if (meetings.length === 0) {
        report.empty_meetings += 1;
      }

      const doctorName =
        row.doctors?.display_name || row.doctors?.full_name || null;

      const result = await reconcileAppointmentFromMeetings({
        appointmentId: row.id,
        meetings,
        doctorNameOverride: doctorName,
        source: "daily_cron",
      });

      report.by_action[result.action] =
        (report.by_action[result.action] ?? 0) + 1;
    } catch (e) {
      report.errors += 1;
      console.error(
        "[cron/daily-reconcile] reconcile falhou:",
        row.id,
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  console.info("[cron/daily-reconcile]", report);
  return NextResponse.json({ ok: true, ...report });
}
