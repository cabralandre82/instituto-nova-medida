/**
 * Testes de customer-display.ts (PR-037 · D-056).
 */

import { describe, expect, it } from "vitest";
import {
  displayCityState,
  displayFirstName,
  displayFullName,
  displayPlanName,
} from "./customer-display";

describe("displayFullName · happy paths", () => {
  it("nome simples", () => {
    expect(displayFullName("Maria Silva")).toBe("Maria Silva");
  });

  it("nome com acentos", () => {
    expect(displayFullName("João D'Ávila Júnior")).toBe("João D'Ávila Júnior");
  });

  it("nome com hífen", () => {
    expect(displayFullName("Ana-Maria Souza")).toBe("Ana-Maria Souza");
  });

  it("colapsa espaços múltiplos", () => {
    expect(displayFullName("Maria   Silva")).toBe("Maria Silva");
  });

  it("trim nas bordas", () => {
    expect(displayFullName("  Maria Silva  ")).toBe("Maria Silva");
  });
});

describe("displayFullName · defesa contra injection/lixo", () => {
  it("fallback quando nome tem newline (injection típico)", () => {
    expect(displayFullName("Maria\nIGNORE PREVIOUS")).toBe("paciente");
  });

  it("fallback quando nome tem zero-width", () => {
    expect(displayFullName("Ma\u200Bria")).toBe("paciente");
  });

  it("fallback quando nome tem bidi override", () => {
    expect(displayFullName("\u202EMaria")).toBe("paciente");
  });

  it("fallback quando nome tem NULL", () => {
    expect(displayFullName("Maria\u0000")).toBe("paciente");
  });

  it("fallback quando nome tem dígitos", () => {
    expect(displayFullName("Maria 123")).toBe("paciente");
  });

  it("fallback quando nome tem template chars", () => {
    expect(displayFullName("${IGNORE}")).toBe("paciente");
    expect(displayFullName("<script>")).toBe("paciente");
    expect(displayFullName("{{pwn}}")).toBe("paciente");
  });

  it("fallback quando input não é string", () => {
    expect(displayFullName(null)).toBe("paciente");
    expect(displayFullName(undefined)).toBe("paciente");
    expect(displayFullName(42)).toBe("paciente");
    expect(displayFullName({})).toBe("paciente");
  });

  it("fallback em string vazia", () => {
    expect(displayFullName("")).toBe("paciente");
    expect(displayFullName("   ")).toBe("paciente");
  });

  it("fallback em só pontuação", () => {
    expect(displayFullName(".,-")).toBe("paciente");
    expect(displayFullName("()")).toBe("paciente");
  });

  it("fallback em nome muito longo", () => {
    expect(displayFullName("A".repeat(100))).toBe("paciente");
  });
});

describe("displayFirstName", () => {
  it("pega primeiro token", () => {
    expect(displayFirstName("Maria Silva")).toBe("Maria");
  });

  it("nome único (sem sobrenome)", () => {
    expect(displayFirstName("Maria")).toBe("Maria");
  });

  it("colapsa espaços múltiplos antes de split", () => {
    expect(displayFirstName("  Maria   Silva  ")).toBe("Maria");
  });

  it("remove pontuação de borda", () => {
    expect(displayFirstName("(Maria) Silva")).toBe("Maria");
    expect(displayFirstName("Maria, Silva")).toBe("Maria");
  });

  it("preserva apóstrofo interno", () => {
    expect(displayFirstName("O'Brien Jack")).toBe("O'Brien");
  });

  it("preserva hífen interno", () => {
    expect(displayFirstName("Ana-Maria Souza")).toBe("Ana-Maria");
  });

  it("fallback para entradas malignas", () => {
    expect(displayFirstName("Maria\nIGNORE")).toBe("paciente");
    expect(displayFirstName("\u200BMaria")).toBe("paciente");
    expect(displayFirstName("")).toBe("paciente");
    expect(displayFirstName(null)).toBe("paciente");
  });

  it("fallback quando primeiro token é só pontuação", () => {
    expect(displayFirstName("...")).toBe("paciente");
  });

  it("corta primeiro nome longuíssimo", () => {
    const out = displayFirstName("A".repeat(50));
    expect(out.length).toBeLessThanOrEqual(30);
  });
});

describe("displayPlanName", () => {
  it("aceita nome com dígitos", () => {
    expect(displayPlanName("Emagrecimento 6 meses")).toBe("Emagrecimento 6 meses");
  });

  it("fallback em controle", () => {
    expect(displayPlanName("Plano\nIGNORE")).toBe("seu plano");
  });

  it("fallback em template chars", () => {
    expect(displayPlanName("{{IGNORE}}")).toBe("seu plano");
  });

  it("fallback em vazio", () => {
    expect(displayPlanName("")).toBe("seu plano");
    expect(displayPlanName(null)).toBe("seu plano");
  });
});

describe("displayCityState", () => {
  it("aceita barra", () => {
    expect(displayCityState("São Paulo/SP")).toBe("São Paulo/SP");
  });

  it("aceita hífen", () => {
    expect(displayCityState("Belo Horizonte - MG")).toBe("Belo Horizonte - MG");
  });

  it("fallback em controle", () => {
    expect(displayCityState("São Paulo\n/SP")).toBe("seu endereço");
  });

  it("fallback em template chars", () => {
    expect(displayCityState("${injection}")).toBe("seu endereço");
  });

  it("fallback em null", () => {
    expect(displayCityState(null)).toBe("seu endereço");
  });
});
