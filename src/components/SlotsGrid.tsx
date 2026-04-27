"use client";

/**
 * src/components/SlotsGrid.tsx — PR-075-A · D-086
 *
 * Grade de slots disponíveis agrupados por dia, em pt-BR e fuso de
 * Brasília. Genérico: o caller decide o que fazer no clique via
 * `onPick(startsAtIso)`. Sem dependência de plano (que é resíduo do
 * fluxo legado `/agendar/[plano]`).
 *
 * Uso típico:
 *   <SlotsGrid
 *     slots={slotsFromServer}
 *     onPick={(iso) => router.push(`/agendar?slot=${encodeURIComponent(iso)}`)}
 *   />
 */

import { useMemo, useState } from "react";

export type GridSlot = {
  startsAt: string;
  endsAt: string;
  startsAtMs: number;
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
}: {
  slots: GridSlot[];
  onPick: (startsAtIso: string) => void;
  emptyMessage?: string;
  footnote?: string;
}) {
  const [submitting, setSubmitting] = useState<string | null>(null);

  const groups = useMemo(() => groupByDay(slots), [slots]);

  if (groups.length === 0) {
    return (
      <div className="rounded-2xl border border-ink-100 bg-cream-50 p-6 text-center text-ink-500">
        {emptyMessage}
      </div>
    );
  }

  function pick(slot: GridSlot) {
    setSubmitting(slot.startsAt);
    onPick(slot.startsAt);
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
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
            {g.slots.map((s) => {
              const isSubmitting = submitting === s.startsAt;
              return (
                <button
                  key={s.startsAt}
                  type="button"
                  onClick={() => pick(s)}
                  disabled={submitting !== null}
                  className={
                    "rounded-xl border px-3 py-2.5 text-sm font-medium transition " +
                    (isSubmitting
                      ? "border-sage-500 bg-sage-100 text-sage-800"
                      : "border-ink-200 bg-cream-50 text-ink-800 hover:border-sage-500 hover:bg-sage-50 disabled:opacity-50")
                  }
                >
                  {isSubmitting ? "…" : timeFmt.format(new Date(s.startsAt))}
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
