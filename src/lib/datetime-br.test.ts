/**
 * Testes de src/lib/datetime-br.ts · PR-021 / audit [2.1].
 *
 * Objetivo: provar que toda formatação passa por America/Sao_Paulo,
 * independente do TZ do processo.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  formatDateBR,
  formatDateLongBR,
  formatDateShortMonthBR,
  formatDateTimeBR,
  formatDateTimeShortBR,
  formatTimeBR,
  formatWeekdayLongBR,
  formatCurrencyBRL,
} from "./datetime-br";

// Isso reproduz o cenário de produção (Vercel == UTC).
// Um valor problemático: 2026-04-15 às 02:30 UTC == 2026-04-14 23:30 BR.
const EARLY_MORNING_UTC = "2026-04-15T02:30:00.000Z";

beforeEach(() => {
  vi.stubEnv("TZ", "UTC");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("formatDateBR", () => {
  it("formata ISO como dd/MM/yyyy em TZ BR (mesmo com processo em UTC)", () => {
    // Em UTC é dia 15, mas em BR ainda é dia 14 (02:30 UTC = 23:30 -03).
    expect(formatDateBR(EARLY_MORNING_UTC)).toBe("14/04/2026");
  });

  it("retorna string vazia para null/undefined", () => {
    expect(formatDateBR(null)).toBe("");
    expect(formatDateBR(undefined)).toBe("");
  });

  it("retorna string vazia para ISO inválido", () => {
    expect(formatDateBR("not-a-date")).toBe("");
  });

  it("respeita options extras sem perder TZ", () => {
    const out = formatDateBR("2026-04-15T02:30:00.000Z", {
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
    });
    // ter., 14/04 — variantes aceitáveis pelo locale
    expect(out).toMatch(/ter/i);
    expect(out).toContain("14");
  });
});

describe("formatDateLongBR", () => {
  it('retorna "14 de abril de 2026"', () => {
    expect(formatDateLongBR(EARLY_MORNING_UTC)).toBe("14 de abril de 2026");
  });
});

describe("formatDateShortMonthBR", () => {
  it('retorna "14 de abr." (formato compacto pt-BR)', () => {
    const out = formatDateShortMonthBR(EARLY_MORNING_UTC);
    expect(out).toMatch(/14/);
    expect(out.toLowerCase()).toMatch(/abr/);
  });
});

describe("formatWeekdayLongBR", () => {
  it("contém dia e mês por extenso", () => {
    const out = formatWeekdayLongBR(EARLY_MORNING_UTC);
    expect(out.toLowerCase()).toMatch(/terça/);
    expect(out.toLowerCase()).toMatch(/abril/);
  });
});

describe("formatTimeBR", () => {
  it("formata hora em TZ BR (UTC 02:30 → 23:30 BR)", () => {
    expect(formatTimeBR(EARLY_MORNING_UTC)).toBe("23:30");
  });
});

describe("formatDateTimeBR", () => {
  it('retorna "14/04/2026 23:30"', () => {
    const out = formatDateTimeBR(EARLY_MORNING_UTC);
    expect(out).toContain("14/04/2026");
    expect(out).toContain("23:30");
  });

  it("Date instance também funciona", () => {
    const d = new Date("2026-04-15T02:30:00.000Z");
    const out = formatDateTimeBR(d);
    expect(out).toContain("14/04/2026");
    expect(out).toContain("23:30");
  });
});

describe("formatDateTimeShortBR", () => {
  it("não contém ano, só dd/MM HH:mm", () => {
    const out = formatDateTimeShortBR(EARLY_MORNING_UTC);
    expect(out).not.toMatch(/2026/);
    expect(out).toContain("14/04");
    expect(out).toContain("23:30");
  });
});

describe("formatCurrencyBRL", () => {
  it("formata centavos como BRL", () => {
    expect(formatCurrencyBRL(179700)).toMatch(/R\$\s*1\.797,00/);
  });

  it("trata null/undefined como string vazia", () => {
    expect(formatCurrencyBRL(null)).toBe("");
    expect(formatCurrencyBRL(undefined)).toBe("");
  });
});

// Regressão dirigida: o cenário "à meia-noite UTC" que o audit
// identifica como bug. Se alguém remover o timeZone de novo, este
// teste quebra.
describe("regressão audit [2.1] · meia-noite UTC", () => {
  it("nunca renderiza dia UTC quando o dia BR é outro", () => {
    // 2026-01-01T01:00:00Z → 2025-12-31T22:00:00 BR.
    const iso = "2026-01-01T01:00:00.000Z";
    expect(formatDateBR(iso)).toBe("31/12/2025");
    expect(formatDateTimeBR(iso)).toContain("31/12/2025");
  });
});
