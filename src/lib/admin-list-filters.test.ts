import { describe, expect, it } from "vitest";
import {
  buildAdminListUrl,
  escapeIlike,
  escapeOrValue,
  hasActiveFilters,
  parseDateRange,
  parsePeriodFilter,
  parseSearch,
  parseStatusFilter,
} from "./admin-list-filters";

describe("parseSearch", () => {
  it("retorna null para undefined", () => {
    expect(parseSearch(undefined)).toBeNull();
  });

  it("retorna null para string vazia ou só espaços", () => {
    expect(parseSearch("")).toBeNull();
    expect(parseSearch("   ")).toBeNull();
  });

  it("trim e devolve string", () => {
    expect(parseSearch("  Maria  ")).toBe("Maria");
  });

  it("aceita primeira posição se vier array", () => {
    expect(parseSearch(["Maria", "ignorado"])).toBe("Maria");
  });

  it("trunca em 80 caracteres (defesa contra DoS)", () => {
    const long = "a".repeat(120);
    expect(parseSearch(long)?.length).toBe(80);
  });

  it("rejeita tipos não-string sem crashar", () => {
    expect(parseSearch(123 as unknown as string)).toBeNull();
  });
});

describe("parseStatusFilter", () => {
  const allow = ["draft", "approved", "confirmed"] as const;

  it("aceita valor da allowlist", () => {
    expect(parseStatusFilter("approved", allow)).toBe("approved");
  });

  it("rejeita valor fora da allowlist (sem erro)", () => {
    expect(parseStatusFilter("hacker", allow)).toBeNull();
  });

  it("rejeita undefined", () => {
    expect(parseStatusFilter(undefined, allow)).toBeNull();
  });

  it("trim antes de comparar", () => {
    expect(parseStatusFilter("  draft  ", allow)).toBe("draft");
  });

  it("não faz lowercase (status são canônicos)", () => {
    expect(parseStatusFilter("DRAFT", allow)).toBeNull();
  });

  it("rejeita string vazia", () => {
    expect(parseStatusFilter("", allow)).toBeNull();
  });

  it("aceita array (pega primeiro)", () => {
    expect(parseStatusFilter(["draft", "approved"], allow)).toBe("draft");
  });
});

describe("parseDateRange", () => {
  it("retorna null,null se ambos vazios", () => {
    const r = parseDateRange(undefined, undefined);
    expect(r.fromIso).toBeNull();
    expect(r.toIso).toBeNull();
    expect(r.invertedRange).toBe(false);
  });

  it("converte from como 00:00 BRT (= 03:00 UTC)", () => {
    const r = parseDateRange("2026-04-20", undefined);
    expect(r.fromIso).toBe("2026-04-20T03:00:00.000Z");
    expect(r.toIso).toBeNull();
  });

  it("converte to como 23:59:59.999 BRT (= 02:59:59.999Z do dia seguinte)", () => {
    const r = parseDateRange(undefined, "2026-04-20");
    expect(r.toIso).toBe("2026-04-21T02:59:59.999Z");
  });

  it("aceita range válido sem inversão", () => {
    const r = parseDateRange("2026-04-01", "2026-04-30");
    expect(r.invertedRange).toBe(false);
    expect(r.fromIso).toBe("2026-04-01T03:00:00.000Z");
    expect(r.toIso).toBe("2026-05-01T02:59:59.999Z");
  });

  it("flag invertedRange quando from > to", () => {
    const r = parseDateRange("2026-04-30", "2026-04-01");
    expect(r.invertedRange).toBe(true);
  });

  it("rejeita formato inválido (sem hífens)", () => {
    expect(parseDateRange("20260420", undefined).fromIso).toBeNull();
  });

  it("rejeita mês 13", () => {
    expect(parseDateRange("2026-13-01", undefined).fromIso).toBeNull();
  });

  it("rejeita dia 32", () => {
    expect(parseDateRange("2026-04-32", undefined).fromIso).toBeNull();
  });

  it("rejeita 31 de fevereiro (rollover)", () => {
    expect(parseDateRange("2026-02-31", undefined).fromIso).toBeNull();
  });

  it("rejeita ano fora da janela 2020–2100", () => {
    expect(parseDateRange("1999-01-01", undefined).fromIso).toBeNull();
    expect(parseDateRange("2999-01-01", undefined).fromIso).toBeNull();
  });
});

describe("parsePeriodFilter", () => {
  it("aceita YYYY-MM válido", () => {
    expect(parsePeriodFilter("2026-04")).toBe("2026-04");
  });

  it("rejeita YYYY-MM-DD", () => {
    expect(parsePeriodFilter("2026-04-20")).toBeNull();
  });

  it("rejeita mês 13", () => {
    expect(parsePeriodFilter("2026-13")).toBeNull();
  });

  it("rejeita ano fora da janela", () => {
    expect(parsePeriodFilter("1999-04")).toBeNull();
  });

  it("trim antes de validar", () => {
    expect(parsePeriodFilter("  2026-04  ")).toBe("2026-04");
  });

  it("rejeita strings vazias e undefined", () => {
    expect(parsePeriodFilter("")).toBeNull();
    expect(parsePeriodFilter(undefined)).toBeNull();
  });
});

describe("escapeIlike", () => {
  it("escapa % e _", () => {
    expect(escapeIlike("100%")).toBe("100\\%");
    expect(escapeIlike("a_b")).toBe("a\\_b");
  });

  it("escapa backslash literal", () => {
    expect(escapeIlike("a\\b")).toBe("a\\\\b");
  });

  it("preserva texto normal", () => {
    expect(escapeIlike("Maria")).toBe("Maria");
  });
});

describe("escapeOrValue", () => {
  it("substitui virgulas e parenteses por espaço", () => {
    expect(escapeOrValue("Maria, José")).toBe("Maria  José");
    expect(escapeOrValue("(11)999")).toBe(" 11 999");
  });

  it("descarta aspas duplas", () => {
    expect(escapeOrValue('Maria"')).toBe("Maria");
  });
});

describe("buildAdminListUrl", () => {
  it("retorna apenas base sem params", () => {
    expect(buildAdminListUrl("/admin/payouts", {})).toBe("/admin/payouts");
  });

  it("ignora valores null/undefined/vazios", () => {
    expect(
      buildAdminListUrl("/admin/payouts", {
        q: null,
        status: undefined,
        period: "",
      })
    ).toBe("/admin/payouts");
  });

  it("monta query-string canônica", () => {
    expect(
      buildAdminListUrl("/admin/payouts", {
        q: "Maria",
        status: "draft",
      })
    ).toBe("/admin/payouts?q=Maria&status=draft");
  });

  it("URL-encoda valores com espaço", () => {
    expect(
      buildAdminListUrl("/admin/fulfillments", { q: "João Silva" })
    ).toBe("/admin/fulfillments?q=Jo%C3%A3o+Silva");
  });
});

describe("hasActiveFilters", () => {
  it("retorna false sem filtros", () => {
    expect(hasActiveFilters({})).toBe(false);
    expect(
      hasActiveFilters({ q: null, status: undefined, period: "" })
    ).toBe(false);
  });

  it("retorna true com pelo menos um filtro", () => {
    expect(hasActiveFilters({ q: "Maria" })).toBe(true);
    expect(hasActiveFilters({ status: "draft" })).toBe(true);
    expect(
      hasActiveFilters({ fromIso: "2026-04-20T03:00:00.000Z" })
    ).toBe(true);
  });
});
