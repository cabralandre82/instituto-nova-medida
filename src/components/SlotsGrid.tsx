"use client";

/**
 * src/components/SlotsGrid.tsx — PR-075-A · D-086 · PR-046 · D-095
 *
 * Grade de slots disponíveis agrupados por dia, em pt-BR e fuso de
 * Brasília. Genérico: o caller decide o que fazer no clique via
 * `onPick(startsAtIso, doctorId?)`. Sem dependência de plano (que é
 * resíduo do fluxo legado `/agendar/[plano]`).
 *
 * Suporte multi-médica (PR-046):
 *   - cada slot pode ter `doctorId` + `doctorLabel`;
 *   - quando `showDoctorLabel=true`, o botão exibe o rótulo curto
 *     da médica abaixo do horário (mobile-friendly);
 *   - empate exato no horário entre médicas distintas é renderizado
 *     como dois botões adjacentes (escolha do paciente vence).
 *
 * Uso típico:
 *   <SlotsGrid
 *     slots={slotsFromServer}
 *     onPick={(iso, doctorId) => router.push(
 *       `/agendar?slot=${encodeURIComponent(iso)}` +
 *       (doctorId ? `&doctorId=${encodeURIComponent(doctorId)}` : "")
 *     )}
 *   />
 */

import { useMemo, useState } from "react";

export type GridSlot = {
  startsAt: string;
  endsAt: string;
  startsAtMs: number;
  /** Opcional. Presente em slots multi-médica (PR-046). */
  doctorId?: string;
  /** Rótulo curto pra UI ("Dra Marta"). Server-side já normaliza. */
  doctorLabel?: string;
};

type DayGroup = {
  key: string;
  label: string;
  slots: GridSlot[];
};

const TZ = "America/Sao_Paulo";

const dayKeyFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const dayLabelFmt = new Intl.DateTimeFormat("pt-BR", {
  timeZone: TZ,
  weekday: "short",
  day: "2-digit",
  month: "short",
});
const timeFmt = new Intl.DateTimeFormat("pt-BR", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
});

function groupByDay(slots: GridSlot[]): DayGroup[] {
  const map = new Map<string, DayGroup>();
  for (const s of slots) {
    const d = new Date(s.startsAt);
    const key = dayKeyFmt.format(d);
    if (!map.has(key)) {
      const label = dayLabelFmt
        .format(d)
        .replace(/\.$/, "")
        .replace(/^([a-z])/, (m) => m.toUpperCase());
      map.set(key, { key, label, slots: [] });
    }
    map.get(key)!.slots.push(s);
  }
  return [...map.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}

export function SlotsGrid({
  slots,
  onPick,
  emptyMessage = "Sem horários nos próximos dias.",
  footnote = "Horários no fuso de Brasília (BRT). A consulta é online por vídeo.",
  showDoctorLabel = false,
}: {
  slots: GridSlot[];
  onPick: (startsAtIso: string, doctorId?: string) => void;
  emptyMessage?: string;
  footnote?: string;
  /** PR-046: quando true, mostra o rótulo da médica abaixo do horário. */
  showDoctorLabel?: boolean;
}) {
  // Quando múltiplas médicas têm slots no mesmo instante, a chave do
  // botão e do "submitting" precisa incluir o doctorId pra desambiguar.
  const [submittingKey, setSubmittingKey] = useState<string | null>(null);

  const groups = useMemo(() => groupByDay(slots), [slots]);

  if (groups.length === 0) {
    return (
      <div className="rounded-2xl border border-ink-100 bg-cream-50 p-6 text-center text-ink-500">
        {emptyMessage}
      </div>
    );
  }

  function keyFor(slot: GridSlot) {
    return slot.doctorId ? `${slot.startsAt}::${slot.doctorId}` : slot.startsAt;
  }

  function pick(slot: GridSlot) {
    setSubmittingKey(keyFor(slot));
    onPick(slot.startsAt, slot.doctorId);
  }

  return (
    <div className="space-y-7">
      {groups.map((g) => (
        <section
          key={g.key}
          className="rounded-2xl bg-white border border-ink-100 px-5 py-5 sm:px-6 sm:py-6"
        >
          <h2 className="font-serif text-[1.08rem] text-ink-800 mb-3">
            {g.label.replace(/,$/, "")}
          </h2>
          <div
            className={
              "grid gap-2 " +
              (showDoctorLabel
                ? "grid-cols-2 sm:grid-cols-3 md:grid-cols-4"
                : "grid-cols-3 sm:grid-cols-4 md:grid-cols-6")
            }
          >
            {g.slots.map((s) => {
              const k = keyFor(s);
              const isSubmitting = submittingKey === k;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => pick(s)}
                  disabled={submittingKey !== null}
                  className={
                    "rounded-xl border px-3 py-2 transition text-center " +
                    (isSubmitting
                      ? "border-sage-500 bg-sage-100 text-sage-800"
                      : "border-ink-200 bg-cream-50 text-ink-800 hover:border-sage-500 hover:bg-sage-50 disabled:opacity-50")
                  }
                >
                  <span className="block text-sm font-medium leading-tight">
                    {isSubmitting ? "…" : timeFmt.format(new Date(s.startsAt))}
                  </span>
                  {showDoctorLabel && s.doctorLabel && (
                    <span
                      className={
                        "mt-0.5 block text-[0.72rem] font-normal leading-tight truncate " +
                        (isSubmitting ? "text-sage-700" : "text-ink-500")
                      }
                      title={s.doctorLabel}
                    >
                      {s.doctorLabel}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      ))}
      {footnote && (
        <p className="text-xs text-ink-400 text-center">{footnote}</p>
      )}
    </div>
  );
}
