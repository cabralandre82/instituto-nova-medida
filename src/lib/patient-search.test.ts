/**
 * Testes de patient-search (D-045 · 3.B).
 *
 * Cobertura:
 *   - classifyQuery (detecta CPF/email/phone/name)
 *   - digitsOnly, normalizeQuery, escapeIlike, escapeOrValue
 *   - searchCustomers: input vazio retorna [] sem query; dispatcher
 *     escolhe a query correta; mapeia resultado; propaga erro.
 */

import { describe, expect, it } from "vitest";
import { createSupabaseMock } from "../test/mocks/supabase";
import {
  classifyQuery,
  digitsOnly,
  escapeIlike,
  escapeOrValue,
  normalizeQuery,
  searchCustomers,
} from "./patient-search";

describe("normalizeQuery", () => {
  it("retorna string vazia pra null/undefined/'' ", () => {
    expect(normalizeQuery(null)).toBe("");
    expect(normalizeQuery(undefined)).toBe("");
    expect(normalizeQuery("")).toBe("");
    expect(normalizeQuery("   ")).toBe("");
  });
  it("faz trim mas não altera case", () => {
    expect(normalizeQuery("  Maria  ")).toBe("Maria");
    expect(normalizeQuery("AnA@X.com")).toBe("AnA@X.com");
  });
});

describe("digitsOnly", () => {
  it("extrai só dígitos", () => {
    expect(digitsOnly("(11) 99999-1234")).toBe("11999991234");
    expect(digitsOnly("123.456.789-00")).toBe("12345678900");
    expect(digitsOnly("abc")).toBe("");
    expect(digitsOnly("")).toBe("");
  });
});

describe("classifyQuery", () => {
  it("vazio", () => {
    expect(classifyQuery("")).toBe("empty");
    expect(classifyQuery(null)).toBe("empty");
    expect(classifyQuery("   ")).toBe("empty");
  });

  it("CPF: 11 dígitos com ou sem máscara", () => {
    expect(classifyQuery("12345678900")).toBe("cpf");
    expect(classifyQuery("123.456.789-00")).toBe("cpf");
  });

  it("email: tem @", () => {
    expect(classifyQuery("ana@instituto.com")).toBe("email");
    expect(classifyQuery("@incomplete")).toBe("email");
    expect(classifyQuery("something@")).toBe("email");
  });

  it("phone: 7+ dígitos não-CPF (ou com máscara / DDI)", () => {
    expect(classifyQuery("(21) 99999-1234")).toBe("phone");
    expect(classifyQuery("5521999991234")).toBe("phone"); // 13 dígitos
    expect(classifyQuery("21 999")).toBe("phone"); // 5+espaço
  });

  it("11 dígitos puros são ambíguos → priorizamos CPF (chave única, busca exata)", () => {
    // Decisão: 11 dígitos exatos batem CPF. Operador pode buscar celular
    // acrescentando "55" (DDI) ou deixando a máscara.
    expect(classifyQuery("11999991234")).toBe("cpf");
  });

  it("nome: texto com poucos ou zero dígitos", () => {
    expect(classifyQuery("Maria")).toBe("name");
    expect(classifyQuery("Maria Silva")).toBe("name");
    expect(classifyQuery("João 2")).toBe("name"); // só 1 dígito
  });

  it("mistura de nome com alguns dígitos ainda é nome", () => {
    // 7 caracteres com 2 dígitos = 28% numérico → name
    expect(classifyQuery("Ana 99")).toBe("name");
  });
});

describe("escapeIlike", () => {
  it("escapa %, _, \\", () => {
    expect(escapeIlike("100%")).toBe("100\\%");
    expect(escapeIlike("a_b")).toBe("a\\_b");
    expect(escapeIlike("c:\\x")).toBe("c:\\\\x");
  });
  it("deixa texto normal intacto", () => {
    expect(escapeIlike("Maria Silva")).toBe("Maria Silva");
  });
});

describe("escapeOrValue", () => {
  it("remove vírgulas, parênteses e aspas duplas", () => {
    expect(escapeOrValue('(11) 9999,"evil"')).toBe(" 11  9999 evil");
  });
});

// ────────────────────────────────────────────────────────────────────────
// searchCustomers
// ────────────────────────────────────────────────────────────────────────

describe("searchCustomers", () => {
  it("input vazio retorna [] sem chamar o supabase", async () => {
    const supa = createSupabaseMock();
    const result = await searchCustomers(supa.client as never, "");
    expect(result).toEqual([]);
    expect(supa.calls.length).toBe(0);
  });

  it("CPF com máscara busca exato com or ambas representações", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("customers", {
      data: [
        {
          id: "c1",
          name: "Ana",
          email: "a@x.com",
          phone: "11",
          cpf: "12345678900",
          created_at: "2026-04-10T00:00:00Z",
        },
      ],
      error: null,
    });
    const result = await searchCustomers(
      supa.client as never,
      "123.456.789-00"
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("c1");
    const firstCall = supa.calls[0];
    expect(firstCall.chain).toContain("or");
    const orArgs = firstCall.args[firstCall.chain.indexOf("or")][0] as string;
    expect(orArgs).toContain("12345678900");
  });

  it("email usa ilike e aceita resultado vazio", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("customers", { data: [], error: null });
    const result = await searchCustomers(
      supa.client as never,
      "maria@example.com"
    );
    expect(result).toEqual([]);
    const call = supa.calls[0];
    expect(call.chain).toContain("ilike");
    const ilikeArgs = call.args[call.chain.indexOf("ilike")];
    expect(ilikeArgs[0]).toBe("email");
    expect(ilikeArgs[1]).toBe("%maria@example.com%");
  });

  it("nome usa ilike com %%", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("customers", { data: [], error: null });
    await searchCustomers(supa.client as never, "Maria");
    const call = supa.calls[0];
    const ilikeArgs = call.args[call.chain.indexOf("ilike")];
    expect(ilikeArgs[0]).toBe("name");
    expect(ilikeArgs[1]).toBe("%Maria%");
  });

  it("phone: usa or com raw e digits-only quando diferem", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("customers", { data: [], error: null });
    await searchCustomers(supa.client as never, "(11) 9999-1234");
    const call = supa.calls[0];
    expect(call.chain).toContain("or");
    const orArgs = call.args[call.chain.indexOf("or")][0] as string;
    // Parênteses viraram espaço via escapeOrValue → " 11  9999-1234"
    expect(orArgs).toContain("% 11  9999-1234%");
    // Digits (cobre phone salvo sem máscara)
    expect(orArgs).toContain("%11999912");
  });

  it("phone com 10 dígitos puros não duplica ilike (raw == digits)", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("customers", { data: [], error: null });
    await searchCustomers(supa.client as never, "1199991234");
    const call = supa.calls[0];
    const orArgs = call.args[call.chain.indexOf("or")][0] as string;
    // só 1 parte — não tem vírgula (a não ser que tenha outra parte)
    const parts = orArgs.split(",");
    expect(parts.length).toBe(1);
    expect(parts[0]).toBe("phone.ilike.%1199991234%");
  });

  it("limit é clamped em [1, 50]", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("customers", { data: [], error: null });
    await searchCustomers(supa.client as never, "ana", { limit: 100 });
    const call = supa.calls[0];
    const limitArgs = call.args[call.chain.indexOf("limit")];
    expect(limitArgs[0]).toBe(50);

    supa.reset();
    supa.enqueue("customers", { data: [], error: null });
    await searchCustomers(supa.client as never, "ana", { limit: 0 });
    const call2 = supa.calls[0];
    const limitArgs2 = call2.args[call2.chain.indexOf("limit")];
    expect(limitArgs2[0]).toBe(1);
  });

  it("propaga erro do supabase", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("customers", {
      data: null,
      error: { message: "relation does not exist" },
    });
    await expect(
      searchCustomers(supa.client as never, "ana")
    ).rejects.toThrow(/relation does not exist/);
  });

  it("mapeia createdAt do created_at", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("customers", {
      data: [
        {
          id: "c1",
          name: "Ana",
          email: "a@x.com",
          phone: "11999991234",
          cpf: "12345678900",
          created_at: "2026-04-15T10:00:00Z",
        },
      ],
      error: null,
    });
    const result = await searchCustomers(supa.client as never, "Ana");
    expect(result[0].createdAt).toBe("2026-04-15T10:00:00Z");
    expect(result[0]).not.toHaveProperty("created_at");
  });
});
