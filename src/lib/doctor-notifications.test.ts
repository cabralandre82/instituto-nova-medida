/**
 * Testes de doctor-notifications — PR-077 · D-089.
 *
 * Foco em partes puras (`tomorrowSPDateString`) e verificação leve do
 * registry `DOCTOR_KIND_TO_TEMPLATE`. As funções de I/O
 * (`enqueueDoctorNotification`, `processDuePendingDoctor`) batem em
 * Supabase e ficam cobertas por smoke E2E.
 */

import { describe, expect, it } from "vitest";
import { tomorrowSPDateString } from "./doctor-notifications";
import { DOCTOR_KIND_TO_TEMPLATE } from "./wa-templates";

describe("tomorrowSPDateString", () => {
  it("avança 1 dia em horário local SP típico (meio do dia UTC)", () => {
    const now = new Date("2026-04-20T15:00:00Z"); // 12:00 SP, 2026-04-20
    expect(tomorrowSPDateString(now)).toBe("2026-04-21");
  });

  it("não pula 2 dias na virada (23:30 SP de 20-Abr → amanhã = 21-Abr)", () => {
    const now = new Date("2026-04-21T02:30:00Z"); // 23:30 SP de 20-Abr
    expect(tomorrowSPDateString(now)).toBe("2026-04-21");
  });

  it("01:00 SP de 21-Abr → amanhã = 22-Abr", () => {
    const now = new Date("2026-04-21T04:00:00Z"); // 01:00 SP de 21-Abr
    expect(tomorrowSPDateString(now)).toBe("2026-04-22");
  });

  it("vira de mês corretamente (30-Abr → 01-Mai)", () => {
    const now = new Date("2026-04-30T15:00:00Z"); // 12:00 SP de 30-Abr
    expect(tomorrowSPDateString(now)).toBe("2026-05-01");
  });

  it("vira de ano corretamente (31-Dez → 01-Jan)", () => {
    const now = new Date("2026-12-31T15:00:00Z"); // 12:00 SP
    expect(tomorrowSPDateString(now)).toBe("2027-01-01");
  });

  it("retorna formato YYYY-MM-DD com zero padding", () => {
    const now = new Date("2026-01-05T15:00:00Z");
    const out = tomorrowSPDateString(now);
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(out).toBe("2026-01-06");
  });
});

describe("DOCTOR_KIND_TO_TEMPLATE", () => {
  it("cobre os 4 kinds canônicos", () => {
    expect(DOCTOR_KIND_TO_TEMPLATE.doctor_paid).toBe("medica_consulta_paga");
    expect(DOCTOR_KIND_TO_TEMPLATE.doctor_t_minus_15min).toBe(
      "medica_link_sala"
    );
    expect(DOCTOR_KIND_TO_TEMPLATE.doctor_daily_summary).toBe(
      "medica_resumo_amanha"
    );
    expect(DOCTOR_KIND_TO_TEMPLATE.doctor_on_call_t_minus_15min).toBe(
      "medica_plantao_iniciando"
    );
  });

  it("template names seguem snake_case sem prefixo de version", () => {
    for (const tpl of Object.values(DOCTOR_KIND_TO_TEMPLATE)) {
      expect(tpl).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tpl).not.toContain("v2");
    }
  });
});
