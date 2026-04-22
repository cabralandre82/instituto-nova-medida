import { describe, expect, it } from "vitest";

import {
  ALLOWED_APPOINTMENT_TRANSITIONS,
  APPOINTMENT_STATUSES,
  TERMINAL_APPOINTMENT_STATUSES,
  isAllowedAppointmentTransition,
  isTerminalAppointmentStatus,
  listForbiddenTransitionsFrom,
  type AppointmentStatus,
} from "./appointment-transitions";

describe("appointment-transitions · invariantes", () => {
  it("não tem entrada duplicada", () => {
    const seen = new Set<string>();
    for (const t of ALLOWED_APPOINTMENT_TRANSITIONS) {
      const key = `${t.from}>${t.to}`;
      expect(seen.has(key), `duplicado: ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it("não tem self-loop (from === to) na lista (reflexivos são tratados via isAllowed)", () => {
    for (const t of ALLOWED_APPOINTMENT_TRANSITIONS) {
      expect(t.from).not.toBe(t.to);
    }
  });

  it("nenhum estado terminal aparece como `from`", () => {
    const terminals = new Set<string>(TERMINAL_APPOINTMENT_STATUSES);
    for (const t of ALLOWED_APPOINTMENT_TRANSITIONS) {
      expect(
        terminals.has(t.from),
        `transição parte de terminal: ${t.from} → ${t.to}`
      ).toBe(false);
    }
  });

  it("APPOINTMENT_STATUSES contém todos os terminais", () => {
    for (const s of TERMINAL_APPOINTMENT_STATUSES) {
      expect(APPOINTMENT_STATUSES).toContain(s);
    }
  });

  it("toda entrada referencia status válidos", () => {
    const valid = new Set<string>(APPOINTMENT_STATUSES);
    for (const t of ALLOWED_APPOINTMENT_TRANSITIONS) {
      expect(valid.has(t.from), `from inválido: ${t.from}`).toBe(true);
      expect(valid.has(t.to), `to inválido: ${t.to}`).toBe(true);
    }
  });

  it("description não é vazia", () => {
    for (const t of ALLOWED_APPOINTMENT_TRANSITIONS) {
      expect(t.description.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("appointment-transitions · isAllowedAppointmentTransition", () => {
  it("self-loop é sempre permitido (no-op)", () => {
    for (const s of APPOINTMENT_STATUSES) {
      expect(isAllowedAppointmentTransition(s, s)).toBe(true);
    }
  });

  it("transições reais do código são permitidas", () => {
    // Estas duplicam os caminhos críticos que vivem no código real;
    // se alguma falhar, é porque alguém tirou a transição da seed
    // sem refatorar o caller correspondente.
    const cases: Array<[AppointmentStatus, AppointmentStatus, string]> = [
      ["pending_payment", "scheduled", "RPC activate_appointment_after_payment"],
      ["pending_payment", "cancelled_by_admin", "expire_abandoned_reservations"],
      ["scheduled", "in_progress", "daily-webhook meeting.started"],
      ["confirmed", "in_progress", "daily-webhook meeting.started"],
      ["scheduled", "completed", "appointment-finalize"],
      ["confirmed", "completed", "appointment-finalize"],
      ["in_progress", "completed", "reconcile (ambos entraram)"],
      ["scheduled", "no_show_patient", "reconcile"],
      ["scheduled", "no_show_doctor", "reconcile"],
      ["in_progress", "no_show_patient", "reconcile"],
      ["in_progress", "no_show_doctor", "reconcile"],
      ["in_progress", "cancelled_by_admin", "reconcile expired_no_one_joined"],
      ["scheduled", "cancelled_by_admin", "reconcile expired_no_one_joined"],
    ];
    for (const [from, to, ctx] of cases) {
      expect(
        isAllowedAppointmentTransition(from, to),
        `esperava transição permitida (${ctx}): ${from} → ${to}`
      ).toBe(true);
    }
  });

  it("transições impossíveis são bloqueadas", () => {
    // A partir de COMPLETED não pode pra lugar nenhum.
    expect(isAllowedAppointmentTransition("completed", "scheduled")).toBe(false);
    expect(isAllowedAppointmentTransition("completed", "in_progress")).toBe(false);
    expect(
      isAllowedAppointmentTransition("completed", "cancelled_by_admin")
    ).toBe(false);

    // Voltar de cancelled pra scheduled é proibido.
    expect(
      isAllowedAppointmentTransition("cancelled_by_patient", "scheduled")
    ).toBe(false);
    expect(
      isAllowedAppointmentTransition("cancelled_by_admin", "scheduled")
    ).toBe(false);

    // Pular completed direto de pending_payment → scheduled fora da RPC
    // é permitido pelo enum, mas pular de scheduled DIRETO pra confirmed
    // ↔ scheduled (ida e volta) não — confirmed → scheduled é proibido
    // (paciente desconfirmou? vira cancelled, não scheduled).
    expect(isAllowedAppointmentTransition("confirmed", "scheduled")).toBe(false);
    expect(
      isAllowedAppointmentTransition("in_progress", "scheduled")
    ).toBe(false);

    // pending_payment → in_progress só faz sentido via scheduled.
    expect(
      isAllowedAppointmentTransition("pending_payment", "in_progress")
    ).toBe(false);
    expect(
      isAllowedAppointmentTransition("pending_payment", "confirmed")
    ).toBe(false);
  });
});

describe("appointment-transitions · helpers", () => {
  it("isTerminalAppointmentStatus identifica os 6 terminais", () => {
    expect(isTerminalAppointmentStatus("completed")).toBe(true);
    expect(isTerminalAppointmentStatus("no_show_patient")).toBe(true);
    expect(isTerminalAppointmentStatus("no_show_doctor")).toBe(true);
    expect(isTerminalAppointmentStatus("cancelled_by_patient")).toBe(true);
    expect(isTerminalAppointmentStatus("cancelled_by_doctor")).toBe(true);
    expect(isTerminalAppointmentStatus("cancelled_by_admin")).toBe(true);

    expect(isTerminalAppointmentStatus("pending_payment")).toBe(false);
    expect(isTerminalAppointmentStatus("scheduled")).toBe(false);
    expect(isTerminalAppointmentStatus("confirmed")).toBe(false);
    expect(isTerminalAppointmentStatus("in_progress")).toBe(false);
  });

  it("listForbiddenTransitionsFrom('completed') retorna todos exceto completed", () => {
    const forbidden = listForbiddenTransitionsFrom("completed");
    expect(forbidden.length).toBe(APPOINTMENT_STATUSES.length - 1);
    expect(forbidden).not.toContain("completed");
  });

  it("listForbiddenTransitionsFrom('scheduled') exclui transições válidas", () => {
    const forbidden = listForbiddenTransitionsFrom("scheduled");
    // scheduled tem 8 saídas válidas + reflexivo, então 10-1-8 = 1 proibida.
    // pending_payment é a única saída proibida (não dá pra "voltar" pra
    // pending_payment uma vez que já pagou).
    expect(forbidden).toEqual(["pending_payment"]);
  });

  it("listForbiddenTransitionsFrom('pending_payment') exclui transições defensivas", () => {
    const forbidden = listForbiddenTransitionsFrom("pending_payment");
    // pending_payment tem 7 saídas válidas. APPOINTMENT_STATUSES.length=10.
    // self exclui 1, restam 9. 9 - 7 = 2 proibidas.
    // Faltam: confirmed, in_progress.
    expect([...forbidden].sort()).toEqual(["confirmed", "in_progress"].sort());
  });
});
