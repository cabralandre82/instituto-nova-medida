/**
 * Unit tests para os helpers puros de scheduling — PR-046 · D-095.
 *
 * Foco: aggregates multi-médica (`shortDoctorLabel`,
 * `mergeAndSortDoctorSlots`). As funções IO-bound (`listActiveDoctors`,
 * `listAvailableSlots`, `listAvailableSlotsForAllDoctors`) ficam
 * cobertas pelos testes de integração existentes (`/agendar`, fan-out
 * on-demand) e por contract tests futuros — não duplicam no unit.
 */

import { describe, it, expect } from "vitest";
import {
  shortDoctorLabel,
  mergeAndSortDoctorSlots,
  type AvailableSlotWithDoctor,
} from "./scheduling";

describe("shortDoctorLabel", () => {
  it("usa display_name quando preenchido", () => {
    expect(
      shortDoctorLabel({
        display_name: "Dra Marta",
        full_name: "Marta Silveira de Oliveira",
      })
    ).toBe("Dra Marta");
  });

  it("trima espaços do display_name antes de aceitar", () => {
    expect(
      shortDoctorLabel({
        display_name: "  Dra Helena  ",
        full_name: "Helena Costa",
      })
    ).toBe("Dra Helena");
  });

  it("cai pra full_name quando display_name é null", () => {
    expect(
      shortDoctorLabel({ display_name: null, full_name: "Ana Paula" })
    ).toBe("Ana Paula");
  });

  it("cai pra full_name quando display_name é string vazia", () => {
    expect(
      shortDoctorLabel({ display_name: "", full_name: "Ana Paula" })
    ).toBe("Ana Paula");
  });

  it("trunca full_name pras 2 primeiras palavras", () => {
    expect(
      shortDoctorLabel({
        display_name: null,
        full_name: "Marta Silveira de Oliveira",
      })
    ).toBe("Marta Silveira");
  });

  it("preserva full_name quando tem 1 ou 2 palavras", () => {
    expect(
      shortDoctorLabel({ display_name: null, full_name: "Maria" })
    ).toBe("Maria");
    expect(
      shortDoctorLabel({ display_name: null, full_name: "Maria Lima" })
    ).toBe("Maria Lima");
  });

  it("colapsa whitespace múltiplo no full_name", () => {
    expect(
      shortDoctorLabel({
        display_name: null,
        full_name: "Marta   Silveira    Oliveira",
      })
    ).toBe("Marta Silveira");
  });

  it('último fallback é "Médica" pra full_name vazio', () => {
    expect(shortDoctorLabel({ display_name: null, full_name: "" })).toBe(
      "Médica"
    );
    expect(shortDoctorLabel({ display_name: "", full_name: "   " })).toBe(
      "Médica"
    );
  });
});

describe("mergeAndSortDoctorSlots", () => {
  function slot(
    doctorId: string,
    startsAt: string,
    extras: Partial<AvailableSlotWithDoctor> = {}
  ): AvailableSlotWithDoctor {
    const ms = new Date(startsAt).getTime();
    return {
      startsAt,
      endsAt: new Date(ms + 30 * 60_000).toISOString(),
      startsAtMs: ms,
      doctorId,
      doctorLabel: extras.doctorLabel ?? `Dra ${doctorId}`,
      doctorDisplayName: extras.doctorDisplayName ?? `Dra ${doctorId}`,
      doctorConsultationMinutes: extras.doctorConsultationMinutes ?? 30,
      ...extras,
    };
  }

  it("retorna lista vazia para entrada vazia", () => {
    expect(mergeAndSortDoctorSlots([])).toEqual([]);
  });

  it("retorna lista vazia quando todas as médicas têm zero slots", () => {
    expect(mergeAndSortDoctorSlots([[], [], []])).toEqual([]);
  });

  it("passa por lista única quando só uma médica tem slots", () => {
    const a1 = slot("a", "2026-04-21T13:00:00.000Z");
    const a2 = slot("a", "2026-04-21T14:00:00.000Z");
    const out = mergeAndSortDoctorSlots([[a1, a2], []]);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(a1);
    expect(out[1]).toBe(a2);
  });

  it("merge entrelaça e ordena por startsAtMs ascendente", () => {
    const out = mergeAndSortDoctorSlots([
      [
        slot("a", "2026-04-21T15:00:00.000Z"),
        slot("a", "2026-04-21T13:00:00.000Z"),
      ],
      [
        slot("b", "2026-04-21T14:00:00.000Z"),
        slot("b", "2026-04-21T16:00:00.000Z"),
      ],
    ]);
    const ids = out.map((s) => `${s.doctorId}@${s.startsAt}`);
    expect(ids).toEqual([
      "a@2026-04-21T13:00:00.000Z",
      "b@2026-04-21T14:00:00.000Z",
      "a@2026-04-21T15:00:00.000Z",
      "b@2026-04-21T16:00:00.000Z",
    ]);
  });

  it("desempate em horário idêntico usa doctorId lexicográfico (estável entre renders)", () => {
    const out = mergeAndSortDoctorSlots([
      [slot("z-doctor", "2026-04-21T13:00:00.000Z")],
      [slot("a-doctor", "2026-04-21T13:00:00.000Z")],
    ]);
    expect(out.map((s) => s.doctorId)).toEqual(["a-doctor", "z-doctor"]);
  });

  it("preserva ambas as ofertas quando há empate exato (médicas distintas)", () => {
    // Dois slots no mesmo instante são duas reservas válidas — uma por
    // médica. UI mostra os dois botões adjacentes.
    const out = mergeAndSortDoctorSlots([
      [slot("a", "2026-04-21T13:00:00.000Z")],
      [slot("b", "2026-04-21T13:00:00.000Z")],
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].doctorId).toBe("a");
    expect(out[1].doctorId).toBe("b");
    expect(out[0].startsAtMs).toBe(out[1].startsAtMs);
  });

  it("não muta as listas de entrada", () => {
    const a = [
      slot("a", "2026-04-21T15:00:00.000Z"),
      slot("a", "2026-04-21T13:00:00.000Z"),
    ];
    const b = [slot("b", "2026-04-21T14:00:00.000Z")];
    const aBefore = [...a];
    const bBefore = [...b];
    mergeAndSortDoctorSlots([a, b]);
    expect(a).toEqual(aBefore);
    expect(b).toEqual(bBefore);
  });

  it("propaga decoração (label, displayName, duration) sem perda", () => {
    const decorated = slot("doc-1", "2026-04-21T13:00:00.000Z", {
      doctorLabel: "Dra Tati",
      doctorDisplayName: "Tatiana de Almeida",
      doctorConsultationMinutes: 45,
    });
    const out = mergeAndSortDoctorSlots([[decorated]]);
    expect(out[0].doctorLabel).toBe("Dra Tati");
    expect(out[0].doctorDisplayName).toBe("Tatiana de Almeida");
    expect(out[0].doctorConsultationMinutes).toBe(45);
  });
});
