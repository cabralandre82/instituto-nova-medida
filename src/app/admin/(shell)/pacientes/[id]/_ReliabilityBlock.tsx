/**
 * _ReliabilityBlock — PR-068 · D-076 · finding [17.6]
 *
 * Seção "Confiabilidade" da ficha do paciente em /admin/pacientes/[id].
 * Mostra:
 *   - Status atual: soft-warn / hard-flag / neutro + contagem ativa.
 *   - Breakdown por kind (quantos no-shows, reservas abandonadas etc.).
 *   - Lista completa de eventos (ativos + dispensados).
 *
 * Sem ações interativas no MVP — dispensar evento e registrar manual
 * fica pra PR-068-B (precisa de API routes novas). Este PR entrega
 * APENAS observabilidade, que já é a parte de maior valor: hoje o
 * admin não tem NENHUMA visão desses incidentes.
 */

import {
  type PatientReliabilityEvent,
  type PatientReliabilitySnapshot,
  PATIENT_RELIABILITY_KIND_LABEL,
} from "@/lib/patient-reliability";
import { formatDateBR, formatTimeBR } from "@/lib/datetime-br";

type Props = {
  snapshot: PatientReliabilitySnapshot | null;
  events: ReadonlyArray<PatientReliabilityEvent>;
};

export function ReliabilityBlock({ snapshot, events }: Props) {
  if (!snapshot) {
    return (
      <section className="rounded-2xl border border-ink-100 bg-white p-6 mb-8">
        <h2 className="font-serif text-[1.25rem] text-ink-800 mb-2">
          Confiabilidade
        </h2>
        <p className="text-sm text-ink-500">
          Não foi possível carregar o snapshot de confiabilidade.
        </p>
      </section>
    );
  }

  const { activeEventsInWindow, byKind, isInSoftWarn, isAtHardFlag } = snapshot;

  const level = isAtHardFlag ? "hard" : isInSoftWarn ? "soft" : "ok";
  const levelCls =
    level === "hard"
      ? "bg-terracotta-50 border-terracotta-300 text-terracotta-900"
      : level === "soft"
      ? "bg-amber-50 border-amber-300 text-amber-900"
      : "bg-sage-50 border-sage-200 text-sage-900";
  const levelLabel =
    level === "hard"
      ? "Atenção crítica"
      : level === "soft"
      ? "Em observação"
      : "Sem incidentes";

  const activeEvents = events.filter((e) => e.dismissed_at === null);
  const dismissedEvents = events.filter((e) => e.dismissed_at !== null);

  return (
    <section className="rounded-2xl border border-ink-100 bg-white p-6 mb-8">
      <div className="flex items-baseline justify-between flex-wrap gap-2 mb-4">
        <h2 className="font-serif text-[1.25rem] text-ink-800">
          Confiabilidade
        </h2>
        <span className="text-xs text-ink-400">
          Janela: últimos {snapshot.windowDays} dias
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_2fr] mb-6">
        <div
          className={`rounded-xl border p-4 ${levelCls}`}
          data-testid="reliability-level"
        >
          <div className="text-[0.72rem] uppercase tracking-[0.14em] opacity-70">
            Status
          </div>
          <div className="text-xl font-serif mt-1">{levelLabel}</div>
          <div className="text-sm opacity-80 mt-1">
            {activeEventsInWindow} evento
            {activeEventsInWindow === 1 ? "" : "s"} ativo
            {activeEventsInWindow === 1 ? "" : "s"} na janela
          </div>
          <div className="text-xs opacity-70 mt-2">
            Soft warn: {snapshot.softWarn}+ · Hard flag: {snapshot.hardFlag}+
          </div>
        </div>

        <div>
          <div className="text-[0.72rem] uppercase tracking-[0.14em] text-ink-500 mb-2">
            Breakdown (ativos na janela)
          </div>
          <ul className="grid gap-1 text-sm">
            {(
              Object.entries(byKind) as [
                keyof typeof byKind,
                number
              ][]
            ).map(([kind, n]) => (
              <li
                key={kind}
                className="flex items-center justify-between border-b border-ink-100 last:border-0 py-1.5"
              >
                <span className="text-ink-700">
                  {PATIENT_RELIABILITY_KIND_LABEL[kind]}
                </span>
                <span
                  className={
                    "font-mono text-sm " +
                    (n > 0 ? "text-ink-800 font-medium" : "text-ink-400")
                  }
                >
                  {n}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {activeEvents.length === 0 && dismissedEvents.length === 0 ? (
        <p className="text-sm text-ink-500">
          Nenhum evento registrado até agora.
        </p>
      ) : (
        <>
          <h3 className="text-[0.78rem] uppercase tracking-[0.18em] text-ink-500 font-medium mb-2 mt-2">
            Histórico ({events.length})
          </h3>
          <ul className="space-y-2">
            {events.slice(0, 20).map((e) => (
              <li
                key={e.id}
                className={
                  "rounded-lg border p-3 text-sm " +
                  (e.dismissed_at
                    ? "border-ink-100 bg-cream-50 text-ink-500"
                    : "border-ink-200 bg-white text-ink-800")
                }
              >
                <div className="flex items-baseline justify-between flex-wrap gap-x-3 gap-y-1">
                  <span className="font-medium">
                    {PATIENT_RELIABILITY_KIND_LABEL[e.kind]}
                  </span>
                  <span className="text-xs text-ink-500">
                    {formatDateBR(e.occurred_at)} ·{" "}
                    {formatTimeBR(e.occurred_at)}
                  </span>
                </div>
                {e.notes && (
                  <p className="text-xs text-ink-500 mt-1 whitespace-pre-wrap">
                    {e.notes}
                  </p>
                )}
                {e.dismissed_at && (
                  <p className="text-xs text-ink-400 italic mt-1">
                    Dispensado em {formatDateBR(e.dismissed_at)}
                    {e.dismissed_reason ? ` · ${e.dismissed_reason}` : ""}
                  </p>
                )}
              </li>
            ))}
          </ul>
          {events.length > 20 && (
            <p className="text-xs text-ink-400 mt-3">
              Mostrando 20 eventos mais recentes de {events.length} totais.
            </p>
          )}
        </>
      )}
    </section>
  );
}
