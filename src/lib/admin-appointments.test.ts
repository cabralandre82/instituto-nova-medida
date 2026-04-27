/**
 * Testes de admin-appointments — PR-078 · D-090.
 *
 * Foco em funções puras: labels, buckets temporais, próximas ocorrências
 * de plantão recorrente. Sem IO.
 */

import { describe, expect, it } from "vitest";
import {
  ALL_APPOINTMENT_STATUSES,
  adminLabelForAppointmentStatus,
  adminToneForAppointmentStatus,
  bucketForAppointment,
  isOnCallNow,
  nextOnCallStartUtc,
  type AppointmentStatusValue,
} from "./admin-appointments";

describe("ALL_APPOINTMENT_STATUSES", () => {
  it("cobre os 10 valores do enum appointment_status (com pending_payment legado)", () => {
    expect(ALL_APPOINTMENT_STATUSES).toHaveLength(10);
    expect(ALL_APPOINTMENT_STATUSES).toContain("pending_payment");
    expect(ALL_APPOINTMENT_STATUSES).toContain("scheduled");
    expect(ALL_APPOINTMENT_STATUSES).toContain("in_progress");
    expect(ALL_APPOINTMENT_STATUSES).toContain("completed");
  });
});

describe("adminLabelForAppointmentStatus", () => {
  it("diferencia origens de cancelamento", () => {
    expect(adminLabelForAppointmentStatus("cancelled_by_patient")).toContain(
      "paciente"
    );
    expect(adminLabelForAppointmentStatus("cancelled_by_doctor")).toContain(
      "médica"
    );
    expect(adminLabelForAppointmentStatus("cancelled_by_admin")).toContain(
      "admin"
    );
  });

  it("diferencia tipos de no-show", () => {
    expect(adminLabelForAppointmentStatus("no_show_patient")).toContain(
      "paciente"
    );
    expect(adminLabelForAppointmentStatus("no_show_doctor")).toContain(
      "médica"
    );
  });

  it("marca pending_payment como legado", () => {
    expect(adminLabelForAppointmentStatus("pending_payment")).toContain(
      "legado"
    );
  });

  it("fallback retorna o próprio status pra valores desconhecidos", () => {
    expect(adminLabelForAppointmentStatus("unknown_status")).toBe(
      "unknown_status"
    );
  });
});

describe("adminToneForAppointmentStatus", () => {
  it("in_progress vira 'active'", () => {
    expect(adminToneForAppointmentStatus("in_progress")).toBe("active");
  });

  it("completed vira 'ok'", () => {
    expect(adminToneForAppointmentStatus("completed")).toBe("ok");
  });

  it("no_show e cancelled_by_admin viram 'warn'", () => {
    expect(adminToneForAppointmentStatus("no_show_patient")).toBe("warn");
    expect(adminToneForAppointmentStatus("no_show_doctor")).toBe("warn");
    expect(adminToneForAppointmentStatus("cancelled_by_admin")).toBe("warn");
  });

  it("scheduled e confirmed viram 'neutral'", () => {
    expect(adminToneForAppointmentStatus("scheduled")).toBe("neutral");
    expect(adminToneForAppointmentStatus("confirmed")).toBe("neutral");
  });
});

describe("bucketForAppointment", () => {
  const now = new Date("2026-04-27T15:00:00Z"); // 12:00 SP

  it("status='in_progress' sempre é 'live' independente do horário", () => {
    expect(
      bucketForAppointment({
        status: "in_progress",
        scheduledAt: new Date("2025-01-01T00:00:00Z"),
        now,
      })
    ).toBe("live");
  });

  it("status='scheduled' nos próximos 30min é 'live'", () => {
    expect(
      bucketForAppointment({
        status: "scheduled",
        scheduledAt: new Date(now.getTime() + 10 * 60_000),
        now,
      })
    ).toBe("live");
  });

  it("status='confirmed' há 30min atrás (em consulta atrasada) ainda é 'live'", () => {
    expect(
      bucketForAppointment({
        status: "confirmed",
        scheduledAt: new Date(now.getTime() - 30 * 60_000),
        now,
      })
    ).toBe("live");
  });

  it("status='scheduled' daqui a 2h é 'next_24h'", () => {
    expect(
      bucketForAppointment({
        status: "scheduled",
        scheduledAt: new Date(now.getTime() + 2 * 60 * 60_000),
        now,
      })
    ).toBe("next_24h");
  });

  it("status='confirmed' em 3 dias é 'next_7d'", () => {
    expect(
      bucketForAppointment({
        status: "confirmed",
        scheduledAt: new Date(now.getTime() + 3 * 24 * 60 * 60_000),
        now,
      })
    ).toBe("next_7d");
  });

  it("status='completed' há 2 dias é 'recent_finished'", () => {
    expect(
      bucketForAppointment({
        status: "completed",
        scheduledAt: new Date(now.getTime() - 2 * 24 * 60 * 60_000),
        now,
      })
    ).toBe("recent_finished");
  });

  it("status='cancelled_by_admin' há 30 dias é 'older' (não polui default)", () => {
    expect(
      bucketForAppointment({
        status: "cancelled_by_admin",
        scheduledAt: new Date(now.getTime() - 30 * 24 * 60 * 60_000),
        now,
      })
    ).toBe("older");
  });

  it("status terminal no futuro é 'older' (cenário improvável mas defendido)", () => {
    expect(
      bucketForAppointment({
        status: "completed",
        scheduledAt: new Date(now.getTime() + 60 * 60_000),
        now,
      })
    ).toBe("older");
  });
});

describe("nextOnCallStartUtc", () => {
  // 2026-04-27 12:00 BRT = 15:00 UTC. weekday SP = 1 (segunda).
  const now = new Date("2026-04-27T15:00:00Z");

  it("retorna ocorrência hoje à tarde (mesmo weekday, depois de now)", () => {
    const next = nextOnCallStartUtc({
      weekday: 1, // segunda
      startTime: "14:00",
      now,
      withinHours: 168,
    });
    expect(next).not.toBeNull();
    // 14:00 BRT = 17:00 UTC, mesmo dia
    expect(next?.toISOString()).toBe("2026-04-27T17:00:00.000Z");
  });

  it("se start_time já passou hoje, salta pra próximo weekday", () => {
    const next = nextOnCallStartUtc({
      weekday: 1, // segunda
      startTime: "08:00", // 08:00 BRT = 11:00 UTC, antes de 15:00
      now,
      withinHours: 168,
    });
    expect(next).not.toBeNull();
    // próxima segunda-feira: 2026-05-04
    expect(next?.toISOString()).toBe("2026-05-04T11:00:00.000Z");
  });

  it("retorna null se a próxima ocorrência está além de withinHours", () => {
    const next = nextOnCallStartUtc({
      weekday: 1,
      startTime: "08:00",
      now,
      withinHours: 4, // só olha próximas 4h
    });
    expect(next).toBeNull();
  });

  it("rejeita weekday inválido", () => {
    expect(nextOnCallStartUtc({ weekday: 7, startTime: "10:00", now })).toBeNull();
    expect(nextOnCallStartUtc({ weekday: -1, startTime: "10:00", now })).toBeNull();
  });

  it("rejeita startTime inválido", () => {
    expect(
      nextOnCallStartUtc({ weekday: 1, startTime: "not-a-time", now })
    ).toBeNull();
  });

  it("retorna ocorrência no próximo weekday quando weekday=hoje mas todos start_time já passaram", () => {
    const next = nextOnCallStartUtc({
      weekday: 2, // terça (amanhã)
      startTime: "10:00",
      now,
    });
    expect(next).not.toBeNull();
    // Terça 2026-04-28, 10:00 BRT = 13:00 UTC
    expect(next?.toISOString()).toBe("2026-04-28T13:00:00.000Z");
  });
});

describe("isOnCallNow", () => {
  const now = new Date("2026-04-27T15:00:00Z"); // 12:00 SP segunda

  it("dentro da janela [start, end) e weekday match → true", () => {
    expect(
      isOnCallNow({
        weekday: 1,
        startTime: "08:00",
        endTime: "18:00",
        now,
      })
    ).toBe(true);
  });

  it("weekday diferente → false", () => {
    expect(
      isOnCallNow({
        weekday: 2,
        startTime: "08:00",
        endTime: "18:00",
        now,
      })
    ).toBe(false);
  });

  it("antes do start → false", () => {
    expect(
      isOnCallNow({
        weekday: 1,
        startTime: "13:00",
        endTime: "18:00",
        now,
      })
    ).toBe(false);
  });

  it("end exclusivo: now == end → false", () => {
    expect(
      isOnCallNow({
        weekday: 1,
        startTime: "08:00",
        endTime: "12:00", // 12:00 SP; now é exatamente 12:00 SP
        now,
      })
    ).toBe(false);
  });

  it("start inclusivo: now == start → true", () => {
    expect(
      isOnCallNow({
        weekday: 1,
        startTime: "12:00",
        endTime: "13:00",
        now,
      })
    ).toBe(true);
  });

  it("start_time inválido → false (defensivo)", () => {
    expect(
      isOnCallNow({
        weekday: 1,
        startTime: "abc",
        endTime: "13:00",
        now,
      })
    ).toBe(false);
  });
});

describe("integração: ALL_APPOINTMENT_STATUSES vs adminToneForAppointmentStatus", () => {
  it("toda entrada do enum tem um tone definido (exhaustividade estática)", () => {
    for (const s of ALL_APPOINTMENT_STATUSES) {
      const tone = adminToneForAppointmentStatus(s as AppointmentStatusValue);
      expect(["active", "ok", "warn", "muted", "neutral"]).toContain(tone);
    }
  });
});
