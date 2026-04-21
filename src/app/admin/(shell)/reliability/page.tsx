/**
 * /admin/reliability — Painel de confiabilidade das médicas (D-036).
 *
 * O que mostra:
 *
 *   1. Resumo: quantas médicas em pause, quantas em soft warn (2
 *      eventos ativos em 30d), quantas OK.
 *
 *   2. Tabela "Médicas pausadas" — quem está fora de `/agendar` agora,
 *      se o pause foi automático ou manual, quando, motivo. Botão
 *      "Reativar" por linha.
 *
 *   3. Tabela "Em alerta (soft warn)" — médicas que têm 2 eventos
 *      ativos e estão 1 incidente de serem auto-pausadas.
 *
 *   4. Feed de eventos recentes (últimos 50) — cada linha mostra
 *      médica, tipo, quando, se foi dispensado, e um botão
 *      "Dispensar" (pra eventos ativos).
 *
 * Regras vêm de src/lib/reliability.ts:
 *   - WINDOW = 30 dias
 *   - SOFT_WARN = 2 eventos ativos
 *   - HARD_BLOCK = 3 eventos ativos → auto-pause
 */

import {
  listDoctorReliabilityOverview,
  listRecentEvents,
  RELIABILITY_WINDOW_DAYS,
  RELIABILITY_SOFT_WARN,
  RELIABILITY_HARD_BLOCK,
} from "@/lib/reliability";
import { ReliabilityActions } from "./_Actions";
import { formatDateTimeBR } from "@/lib/datetime-br";

export const dynamic = "force-dynamic";

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return formatDateTimeBR(iso);
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "no_show_doctor":
      return "No-show médica";
    case "expired_no_one_joined":
      return "Sala expirou vazia";
    case "manual":
      return "Registrado manualmente";
    default:
      return kind;
  }
}

export default async function ReliabilityPage() {
  const [overview, events] = await Promise.all([
    listDoctorReliabilityOverview(),
    listRecentEvents(50),
  ]);

  const paused = overview.filter((r) => r.isPaused);
  const softWarn = overview.filter((r) => !r.isPaused && r.isInSoftWarn);
  const ok = overview.filter(
    (r) => !r.isPaused && !r.isInSoftWarn && r.status === "active"
  );

  const activeEvents = events.filter((e) => !e.dismissed_at);

  return (
    <div>
      <header className="mb-6">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Equipe clínica
        </p>
        <h1 className="font-serif text-[1.85rem] sm:text-[2.2rem] leading-tight text-ink-800">
          Confiabilidade
        </h1>
        <p className="mt-1 text-ink-500 max-w-2xl">
          No-shows da médica e cancelamentos de sala expirada entram aqui
          automaticamente (D-036). Com {RELIABILITY_SOFT_WARN} eventos
          ativos em {RELIABILITY_WINDOW_DAYS} dias a médica entra em alerta;
          com {RELIABILITY_HARD_BLOCK} ela é auto-pausada e some do
          agendamento público até você reativar. Appointments já marcadas
          seguem o curso normal.
        </p>
      </header>

      {/* Resumo */}
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        <Card
          label="Pausadas"
          value={String(paused.length)}
          hint={
            paused.length > 0
              ? paused.filter((p) => p.pausedAuto).length + " auto · " +
                paused.filter((p) => !p.pausedAuto).length + " manual"
              : "ninguém bloqueado"
          }
          tone={paused.length > 0 ? "terracotta" : "ink"}
        />
        <Card
          label="Em alerta"
          value={String(softWarn.length)}
          hint={`≥${RELIABILITY_SOFT_WARN} eventos em ${RELIABILITY_WINDOW_DAYS}d`}
          tone={softWarn.length > 0 ? "terracotta" : "ink"}
        />
        <Card
          label="OK"
          value={String(ok.length)}
          hint="ativas sem incidentes recentes"
          tone="sage"
        />
        <Card
          label="Eventos ativos (total)"
          value={String(activeEvents.length)}
          hint={`janela ${RELIABILITY_WINDOW_DAYS}d · ` +
            (events.length - activeEvents.length) + " dispensados"}
          tone="ink"
        />
      </section>

      {/* Pausadas */}
      <section className="mb-10">
        <h2 className="font-serif text-[1.3rem] text-ink-800 mb-4">
          Pausadas ({paused.length})
        </h2>
        {paused.length === 0 ? (
          <p className="text-ink-500">Nenhuma médica pausada no momento.</p>
        ) : (
          <div className="rounded-2xl bg-white border border-terracotta-200 overflow-hidden">
            <table className="w-full">
              <thead className="bg-terracotta-50 border-b border-terracotta-200">
                <tr className="text-left text-[0.72rem] uppercase tracking-[0.12em] text-ink-500 font-medium">
                  <th className="px-5 py-2.5">Médica</th>
                  <th className="px-5 py-2.5">Pausada em</th>
                  <th className="px-5 py-2.5">Tipo</th>
                  <th className="px-5 py-2.5">Motivo</th>
                  <th className="px-5 py-2.5 text-right">Ação</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-terracotta-100">
                {paused.map((row) => (
                  <tr key={row.doctorId} className="align-top">
                    <td className="px-5 py-3 text-sm text-ink-800 font-medium">
                      {row.doctorName}
                      <div className="text-[0.7rem] text-ink-400 font-normal">
                        {row.activeEvents} evento
                        {row.activeEvents === 1 ? "" : "s"} ativo
                        {row.activeEvents === 1 ? "" : "s"}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-sm text-ink-600 font-mono">
                      {fmtDateTime(row.pausedAt)}
                    </td>
                    <td className="px-5 py-3 text-sm">
                      {row.pausedAuto ? (
                        <span className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full bg-terracotta-100 text-terracotta-800 border border-terracotta-300">
                          Automático
                        </span>
                      ) : (
                        <span className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full bg-cream-100 text-ink-700 border border-ink-200">
                          Manual
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-sm text-ink-600 italic max-w-md">
                      {row.pausedReason ?? "—"}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <ReliabilityActions
                        kind="unpause"
                        doctorId={row.doctorId}
                        doctorName={row.doctorName}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Em alerta */}
      <section className="mb-10">
        <h2 className="font-serif text-[1.3rem] text-ink-800 mb-4">
          Em alerta ({softWarn.length})
        </h2>
        {softWarn.length === 0 ? (
          <p className="text-ink-500">Nenhuma médica em alerta.</p>
        ) : (
          <div className="rounded-2xl bg-white border border-ink-100 overflow-hidden">
            <table className="w-full">
              <thead className="bg-cream-50 border-b border-ink-100">
                <tr className="text-left text-[0.72rem] uppercase tracking-[0.12em] text-ink-500 font-medium">
                  <th className="px-5 py-2.5">Médica</th>
                  <th className="px-5 py-2.5 text-right">Eventos ativos</th>
                  <th className="px-5 py-2.5">Último evento</th>
                  <th className="px-5 py-2.5 text-right">Ação</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {softWarn.map((row) => (
                  <tr key={row.doctorId} className="hover:bg-cream-50">
                    <td className="px-5 py-3 text-sm text-ink-800 font-medium">
                      {row.doctorName}
                    </td>
                    <td className="px-5 py-3 text-sm text-right font-mono text-terracotta-700">
                      {row.activeEvents} / {RELIABILITY_HARD_BLOCK}
                    </td>
                    <td className="px-5 py-3 text-sm text-ink-600 font-mono">
                      {fmtDateTime(row.lastEventAt)}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <ReliabilityActions
                        kind="pause"
                        doctorId={row.doctorId}
                        doctorName={row.doctorName}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Eventos recentes */}
      <section>
        <h2 className="font-serif text-[1.3rem] text-ink-800 mb-4">
          Eventos recentes
        </h2>
        {events.length === 0 ? (
          <p className="text-ink-500">
            Nenhum evento de confiabilidade registrado ainda.
          </p>
        ) : (
          <div className="rounded-2xl bg-white border border-ink-100 overflow-hidden">
            <table className="w-full">
              <thead className="bg-cream-50 border-b border-ink-100">
                <tr className="text-left text-[0.72rem] uppercase tracking-[0.12em] text-ink-500 font-medium">
                  <th className="px-5 py-2.5">Médica</th>
                  <th className="px-5 py-2.5">Tipo</th>
                  <th className="px-5 py-2.5">Quando</th>
                  <th className="px-5 py-2.5">Appointment</th>
                  <th className="px-5 py-2.5">Status</th>
                  <th className="px-5 py-2.5 text-right">Ação</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {events.map((ev) => (
                  <tr
                    key={ev.id}
                    className={`align-top ${
                      ev.dismissed_at ? "bg-cream-50/50" : "hover:bg-cream-50"
                    }`}
                  >
                    <td className="px-5 py-3 text-sm text-ink-800">
                      {ev.doctor_name ?? "—"}
                    </td>
                    <td className="px-5 py-3 text-sm text-ink-600">
                      {kindLabel(ev.kind)}
                    </td>
                    <td className="px-5 py-3 text-sm text-ink-600 font-mono">
                      {fmtDateTime(ev.occurred_at)}
                    </td>
                    <td className="px-5 py-3 text-xs text-ink-500 font-mono">
                      {ev.appointment_id ? (
                        <span
                          className="truncate inline-block max-w-[200px] align-bottom"
                          title={ev.appointment_id}
                        >
                          {ev.appointment_id.slice(0, 8)}
                          …
                          <br />
                          <span className="text-ink-400">
                            {fmtDateTime(ev.appointment_scheduled_at)}
                          </span>
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-5 py-3 text-sm">
                      {ev.dismissed_at ? (
                        <span className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full bg-ink-100 text-ink-600 border border-ink-200">
                          Dispensado
                        </span>
                      ) : (
                        <span className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full bg-terracotta-50 text-terracotta-700 border border-terracotta-200">
                          Ativo
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right">
                      {ev.dismissed_at ? (
                        <span
                          className="text-[0.7rem] text-ink-400 italic"
                          title={ev.dismissed_reason ?? ""}
                        >
                          {ev.dismissed_reason
                            ? ev.dismissed_reason.slice(0, 40) +
                              (ev.dismissed_reason.length > 40 ? "…" : "")
                            : "—"}
                        </span>
                      ) : (
                        <ReliabilityActions
                          kind="dismiss"
                          eventId={ev.id}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Card({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone: "sage" | "terracotta" | "ink";
}) {
  const toneClasses = {
    sage: "border-sage-200 bg-sage-50",
    terracotta: "border-terracotta-200 bg-terracotta-50",
    ink: "border-ink-100 bg-white",
  }[tone];
  const valueClasses = {
    sage: "text-sage-800",
    terracotta: "text-terracotta-700",
    ink: "text-ink-800",
  }[tone];
  return (
    <div className={`rounded-2xl border p-4 ${toneClasses}`}>
      <p className="text-[0.72rem] uppercase tracking-[0.14em] text-ink-500 font-medium mb-2">
        {label}
      </p>
      <p className={`font-serif text-[1.6rem] leading-none ${valueClasses}`}>
        {value}
      </p>
      <p className="mt-2 text-xs text-ink-500">{hint}</p>
    </div>
  );
}
