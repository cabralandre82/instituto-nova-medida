/**
 * Testes de doctor-availability — PR-076 · D-088.
 *
 * Foco nas partes puras (`validateAvailabilityInput`, `hasOverlap`).
 * As funções de I/O (`createAvailability`, `deactivateAvailability`,
 * `reactivateAvailability`) são wrappers triviais; cobertas por
 * smoke E2E em ambiente staging.
 */

import { describe, expect, it } from "vitest";
import {
  hasOverlap,
  validateAvailabilityInput,
  WEEKDAY_LABELS_PT,
  TYPE_LABELS_PT,
} from "./doctor-availability";

describe("validateAvailabilityInput", () => {
  it("bloco válido com tipo canônico 'scheduled' passa", () => {
    const r = validateAvailabilityInput({
      weekday: 2,
      start_time: "14:00",
      end_time: "18:00",
      type: "scheduled",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.weekday).toBe(2);
      expect(r.start_time).toBe("14:00:00");
      expect(r.end_time).toBe("18:00:00");
      expect(r.type).toBe("scheduled");
    }
  });

  it("bloco com tipo legado 'agendada' é normalizado pra 'scheduled'", () => {
    const r = validateAvailabilityInput({
      weekday: 1,
      start_time: "08:30",
      end_time: "12:00",
      type: "agendada",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.type).toBe("scheduled");
  });

  it("bloco com tipo legado 'plantao' é normalizado pra 'on_call'", () => {
    const r = validateAvailabilityInput({
      weekday: 5,
      start_time: "20:00",
      end_time: "23:00",
      type: "plantao",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.type).toBe("on_call");
  });

  it("aceita HH:MM:SS no input e normaliza", () => {
    const r = validateAvailabilityInput({
      weekday: 0,
      start_time: "07:30:45",
      end_time: "08:30:00",
      type: "scheduled",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.start_time).toBe("07:30:45");
      expect(r.end_time).toBe("08:30:00");
    }
  });

  it("rejeita weekday fora de [0..6]", () => {
    expect(validateAvailabilityInput({
      weekday: 7,
      start_time: "10:00",
      end_time: "11:00",
      type: "scheduled",
    })).toEqual({ ok: false, error: "weekday_invalid" });
    expect(validateAvailabilityInput({
      weekday: -1,
      start_time: "10:00",
      end_time: "11:00",
      type: "scheduled",
    })).toEqual({ ok: false, error: "weekday_invalid" });
  });

  it("rejeita weekday não-inteiro", () => {
    expect(validateAvailabilityInput({
      weekday: 1.5,
      start_time: "10:00",
      end_time: "11:00",
      type: "scheduled",
    })).toEqual({ ok: false, error: "weekday_invalid" });
  });

  it("rejeita weekday não-numérico", () => {
    expect(validateAvailabilityInput({
      weekday: "segunda",
      start_time: "10:00",
      end_time: "11:00",
      type: "scheduled",
    })).toEqual({ ok: false, error: "weekday_invalid" });
  });

  it("rejeita start_time inválido", () => {
    expect(validateAvailabilityInput({
      weekday: 1,
      start_time: "25:00",
      end_time: "26:00",
      type: "scheduled",
    })).toEqual({ ok: false, error: "start_time_invalid" });
    expect(validateAvailabilityInput({
      weekday: 1,
      start_time: "abc",
      end_time: "11:00",
      type: "scheduled",
    })).toEqual({ ok: false, error: "start_time_invalid" });
    expect(validateAvailabilityInput({
      weekday: 1,
      start_time: null,
      end_time: "11:00",
      type: "scheduled",
    })).toEqual({ ok: false, error: "start_time_invalid" });
  });

  it("rejeita end_time inválido", () => {
    expect(validateAvailabilityInput({
      weekday: 1,
      start_time: "10:00",
      end_time: "10:62",
      type: "scheduled",
    })).toEqual({ ok: false, error: "end_time_invalid" });
  });

  it("rejeita end <= start", () => {
    expect(validateAvailabilityInput({
      weekday: 1,
      start_time: "12:00",
      end_time: "12:00",
      type: "scheduled",
    })).toEqual({ ok: false, error: "end_before_start" });
    expect(validateAvailabilityInput({
      weekday: 1,
      start_time: "13:00",
      end_time: "12:00",
      type: "scheduled",
    })).toEqual({ ok: false, error: "end_before_start" });
  });

  it("rejeita type desconhecido", () => {
    expect(validateAvailabilityInput({
      weekday: 1,
      start_time: "10:00",
      end_time: "11:00",
      type: "remote",
    })).toEqual({ ok: false, error: "type_invalid" });
    expect(validateAvailabilityInput({
      weekday: 1,
      start_time: "10:00",
      end_time: "11:00",
      type: null,
    })).toEqual({ ok: false, error: "type_invalid" });
  });
});

describe("hasOverlap", () => {
  const existing = [
    { id: "a", weekday: 1, start_time: "10:00:00", end_time: "12:00:00", active: true },
    { id: "b", weekday: 1, start_time: "14:00:00", end_time: "16:00:00", active: true },
    { id: "c", weekday: 2, start_time: "10:00:00", end_time: "12:00:00", active: true },
    { id: "d", weekday: 1, start_time: "08:00:00", end_time: "09:00:00", active: false },
  ];

  it("retorna false quando candidato cai em weekday sem nenhum bloco", () => {
    expect(hasOverlap(existing, {
      weekday: 3,
      start_time: "10:00:00",
      end_time: "11:00:00",
    })).toBe(false);
  });

  it("retorna false quando candidato cai num horário livre do mesmo weekday", () => {
    expect(hasOverlap(existing, {
      weekday: 1,
      start_time: "12:00:00",
      end_time: "14:00:00",
    })).toBe(false);
  });

  it("retorna true quando candidato cruza início de bloco existente", () => {
    expect(hasOverlap(existing, {
      weekday: 1,
      start_time: "09:00:00",
      end_time: "10:30:00",
    })).toBe(true);
  });

  it("retorna true quando candidato cruza fim de bloco existente", () => {
    expect(hasOverlap(existing, {
      weekday: 1,
      start_time: "11:30:00",
      end_time: "12:30:00",
    })).toBe(true);
  });

  it("retorna true quando candidato é subset estrito de existente", () => {
    expect(hasOverlap(existing, {
      weekday: 1,
      start_time: "10:30:00",
      end_time: "11:00:00",
    })).toBe(true);
  });

  it("retorna true quando candidato é superset de existente", () => {
    expect(hasOverlap(existing, {
      weekday: 1,
      start_time: "09:00:00",
      end_time: "13:00:00",
    })).toBe(true);
  });

  it("retorna false quando candidato encosta exatamente no fim de existente (boundary aberto)", () => {
    expect(hasOverlap(existing, {
      weekday: 1,
      start_time: "12:00:00",
      end_time: "13:00:00",
    })).toBe(false);
  });

  it("retorna false quando candidato encosta exatamente no início de existente (boundary aberto)", () => {
    expect(hasOverlap(existing, {
      weekday: 1,
      start_time: "13:00:00",
      end_time: "14:00:00",
    })).toBe(false);
  });

  it("ignora blocos inativos (active=false)", () => {
    expect(hasOverlap(existing, {
      weekday: 1,
      start_time: "08:30:00",
      end_time: "09:30:00",
    })).toBe(false);
  });

  it("excludeId remove o próprio bloco da checagem (caso update)", () => {
    expect(hasOverlap(existing, {
      weekday: 1,
      start_time: "10:30:00",
      end_time: "11:30:00",
    }, "a")).toBe(false);
  });
});

describe("constantes de UI", () => {
  it("WEEKDAY_LABELS_PT cobre 0..6", () => {
    for (let i = 0; i <= 6; i += 1) {
      expect(WEEKDAY_LABELS_PT[i]).toBeDefined();
      expect(typeof WEEKDAY_LABELS_PT[i]).toBe("string");
    }
  });

  it("TYPE_LABELS_PT cobre os 2 tipos canônicos", () => {
    expect(TYPE_LABELS_PT.scheduled).toBeTruthy();
    expect(TYPE_LABELS_PT.on_call).toBeTruthy();
  });
});
