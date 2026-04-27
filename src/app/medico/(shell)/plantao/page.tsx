/**
 * /medico/plantao — PR-080 · D-092
 *
 * Painel operacional da médica em plantão. Junta 3 coisas no mesmo lugar:
 *
 *   1. Toggle de presença (online/busy/offline) + heartbeat
 *      automático a cada 30s. (Reusa infra D-087.)
 *   2. Indicador "tem plantão programado agora?" (D-088).
 *   3. Fila de requests on-demand pending — a primeira a clicar
 *      "Aceitar" cria appointment.
 *
 * Server component carrega o snapshot inicial (presença + agenda da
 * semana). Lista de requests é polled pelo client (3s), mesmo padrão
 * da UI do paciente.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { requireDoctor } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getCurrentPresence } from "@/lib/doctor-presence";
import { isOnCallNow, nextOnCallStartUtc } from "@/lib/admin-appointments";
import { formatDateTimeShortBR } from "@/lib/datetime-br";
import { PresencePanel } from "./_PresencePanel";
import { PendingRequestsClient } from "./_PendingRequestsClient";

const RECENT_SETTLEMENTS_LIMIT = 5;
const RECENT_SETTLEMENTS_WINDOW_DAYS = 30;

type SettlementRow = {
  id: string;
  block_start_utc: string;
  block_end_utc: string;
  block_minutes: number;
  coverage_minutes: number;
  coverage_ratio: number;
  outcome: "paid" | "no_show";
  amount_cents_snapshot: number | null;
};

export const metadata: Metadata = {
  title: "Plantão · Instituto Nova Medida",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

const NEXT_BLOCK_LOOKAHEAD_HOURS = 4;

type AvailabilityRow = {
  id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  active: boolean;
  type: string;
};

const WEEKDAY_LABEL = [
  "Domingo",
  "Segunda",
  "Terça",
  "Quarta",
  "Quinta",
  "Sexta",
  "Sábado",
] as const;

export default async function PlantaoMedicoPage() {
  const { doctorId } = await requireDoctor();
  const supabase = getSupabaseAdmin();
  const now = new Date();

  // Snapshot inicial de presença.
  const presence = await getCurrentPresence(doctorId);

  // Blocos on_call ativos da médica.
  const { data: avail } = await supabase
    .from("doctor_availability")
    .select("id, weekday, start_time, end_time, active, type")
    .eq("doctor_id", doctorId)
    .eq("active", true)
    .eq("type", "on_call");

  const onCallBlocks = (avail ?? []) as AvailabilityRow[];

  // Bloco ATIVO agora?
  const activeNow = onCallBlocks.find((b) =>
    isOnCallNow({
      weekday: b.weekday,
      startTime: b.start_time,
      endTime: b.end_time,
      now,
    })
  );

  // Histórico recente de plantões liquidados (PR-081 · D-093).
  const sinceIso = new Date(
    now.getTime() - RECENT_SETTLEMENTS_WINDOW_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const { data: settlementData } = await supabase
    .from("on_call_block_settlements")
    .select(
      "id, block_start_utc, block_end_utc, block_minutes, coverage_minutes, coverage_ratio, outcome, amount_cents_snapshot"
    )
    .eq("doctor_id", doctorId)
    .gte("settled_at", sinceIso)
    .order("settled_at", { ascending: false })
    .limit(RECENT_SETTLEMENTS_LIMIT);
  const recentSettlements = (settlementData ?? []) as SettlementRow[];
  const totalPaidCents = recentSettlements
    .filter((s) => s.outcome === "paid")
    .reduce((sum, s) => sum + (s.amount_cents_snapshot ?? 0), 0);

  // Próximo bloco nas próximas 4h?
  let nextBlock: { row: AvailabilityRow; startsAt: Date } | null = null;
  if (!activeNow) {
    let earliest: { row: AvailabilityRow; startsAt: Date } | null = null;
    for (const b of onCallBlocks) {
      const start = nextOnCallStartUtc({
        weekday: b.weekday,
        startTime: b.start_time,
        now,
        withinHours: NEXT_BLOCK_LOOKAHEAD_HOURS,
      });
      if (start && (!earliest || start < earliest.startsAt)) {
        earliest = { row: b, startsAt: start };
      }
    }
    nextBlock = earliest;
  }

  return (
    <div>
      <header className="mb-6">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-terracotta-700 font-medium mb-2">
          Atendimento agora
        </p>
        <h1 className="font-serif text-[1.85rem] sm:text-[2.2rem] leading-tight text-ink-800">
          Plantão
        </h1>
        <p className="mt-1 text-ink-500 max-w-2xl">
          Aqui você fica online pra atender pacientes que solicitam consulta
          imediata. A primeira que clicar em &ldquo;Aceitar&rdquo; abre a sala
          — sem agendamento prévio.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <PendingRequestsClient />

        <aside className="space-y-4">
          <PresencePanel
            initial={
              presence
                ? {
                    status: presence.status,
                    last_heartbeat_at: presence.last_heartbeat_at,
                    online_since: presence.online_since,
                  }
                : null
            }
          />

          <ScheduleCard
            activeNow={
              activeNow
                ? {
                    weekday: activeNow.weekday,
                    start: activeNow.start_time,
                    end: activeNow.end_time,
                  }
                : null
            }
            nextBlock={
              nextBlock
                ? {
                    weekday: nextBlock.row.weekday,
                    start: nextBlock.row.start_time,
                    end: nextBlock.row.end_time,
                    startsAtIso: nextBlock.startsAt.toISOString(),
                  }
                : null
            }
            blocksCount={onCallBlocks.length}
          />

          <RecentSettlementsCard
            settlements={recentSettlements}
            totalPaidCents={totalPaidCents}
          />
        </aside>
      </div>
    </div>
  );
}

function RecentSettlementsCard({
  settlements,
  totalPaidCents,
}: {
  settlements: SettlementRow[];
  totalPaidCents: number;
}) {
  return (
    <div className="rounded-2xl border border-ink-100 bg-white p-5">
      <p className="text-[0.78rem] uppercase tracking-wider text-ink-500 font-medium">
        Plantões liquidados
      </p>
      <p className="text-[0.72rem] text-ink-400 mt-0.5">
        Últimos {RECENT_SETTLEMENTS_WINDOW_DAYS} dias
      </p>

      {settlements.length === 0 ? (
        <p className="mt-3 text-sm text-ink-500 leading-relaxed">
          Nenhum plantão liquidado ainda. Plantões cumpridos viram earnings
          automaticamente após o fim do bloco (cron a cada 5min).
        </p>
      ) : (
        <>
          {totalPaidCents > 0 && (
            <p className="mt-3 text-sm text-ink-700">
              Total pago:{" "}
              <span className="font-medium text-sage-700">
                {formatCentsBR(totalPaidCents)}
              </span>
            </p>
          )}
          <ul className="mt-3 space-y-2.5">
            {settlements.map((s) => {
              const start = new Date(s.block_start_utc);
              const end = new Date(s.block_end_utc);
              const pct = Math.round(s.coverage_ratio * 100);
              return (
                <li
                  key={s.id}
                  className="text-xs border-l-2 pl-2.5 py-0.5"
                  style={{
                    borderColor:
                      s.outcome === "paid" ? "var(--sage-500, #4f7a4a)" : "var(--terracotta-400, #d68b6e)",
                  }}
                >
                  <p className="text-ink-700">
                    {formatDateTimeShortBR(start)} → {formatDateTimeShortBR(end)}
                  </p>
                  <p className="text-ink-500 mt-0.5">
                    {s.outcome === "paid"
                      ? `Pago · ${pct}% · ${formatCentsBR(s.amount_cents_snapshot ?? 0)}`
                      : `No-show · ${pct}% cobertura`}
                  </p>
                </li>
              );
            })}
          </ul>
          <Link
            href="/medico/ganhos"
            className="mt-3 inline-flex items-center gap-1 text-sm text-ink-500 hover:text-ink-800"
          >
            Ver todos os ganhos →
          </Link>
        </>
      )}
    </div>
  );
}

function formatCentsBR(cents: number): string {
  return `R$ ${(cents / 100).toFixed(2).replace(".", ",")}`;
}

function ScheduleCard({
  activeNow,
  nextBlock,
  blocksCount,
}: {
  activeNow: { weekday: number; start: string; end: string } | null;
  nextBlock: {
    weekday: number;
    start: string;
    end: string;
    startsAtIso: string;
  } | null;
  blocksCount: number;
}) {
  return (
    <div className="rounded-2xl border border-ink-100 bg-white p-5">
      <p className="text-[0.78rem] uppercase tracking-wider text-ink-500 font-medium">
        Plantões programados
      </p>

      {activeNow ? (
        <div className="mt-3 rounded-xl border border-sage-200 bg-sage-50 px-4 py-3">
          <p className="text-sm text-sage-800 font-medium">
            Você está em plantão programado agora.
          </p>
          <p className="mt-1 text-xs text-sage-700">
            {WEEKDAY_LABEL[activeNow.weekday]} ·{" "}
            {timeShort(activeNow.start)} – {timeShort(activeNow.end)}
          </p>
        </div>
      ) : nextBlock ? (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm text-amber-900 font-medium">
            Próximo plantão começa em breve.
          </p>
          <p className="mt-1 text-xs text-amber-800">
            {WEEKDAY_LABEL[nextBlock.weekday]} ·{" "}
            {timeShort(nextBlock.start)} – {timeShort(nextBlock.end)}
          </p>
        </div>
      ) : blocksCount === 0 ? (
        <p className="mt-3 text-sm text-ink-600 leading-relaxed">
          Você ainda não cadastrou plantões recorrentes. Você pode atender
          mesmo sem isso (basta ficar online), mas plantões dão
          previsibilidade pra plataforma.
        </p>
      ) : (
        <p className="mt-3 text-sm text-ink-600 leading-relaxed">
          Sem plantões nas próximas {NEXT_BLOCK_LOOKAHEAD_HOURS} horas. Você
          tem {blocksCount} bloco{blocksCount === 1 ? "" : "s"} cadastrado
          {blocksCount === 1 ? "" : "s"} em outros dias.
        </p>
      )}

      <Link
        href="/medico/horarios"
        className="mt-3 inline-flex items-center gap-1 text-sm text-ink-500 hover:text-ink-800"
      >
        Editar plantões →
      </Link>
    </div>
  );
}

function timeShort(t: string): string {
  // "HH:MM:SS" → "HH:MM"
  return t.slice(0, 5);
}
