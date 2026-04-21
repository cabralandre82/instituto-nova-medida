/**
 * Testes de prompt-redact.ts (PR-037 · D-056).
 */

import { describe, expect, it } from "vitest";
import { redactForLLM, redactForLog, redactPII } from "./prompt-redact";

describe("redactPII · CPF", () => {
  it("CPF pontuado", () => {
    expect(redactPII("CPF 123.456.789-01")).toBe("CPF [CPF]");
  });

  it("CPF sem pontuação", () => {
    expect(redactPII("CPF 12345678901")).toBe("CPF [CPF]");
  });

  it("não confunde com ID longo de 15 dígitos", () => {
    expect(redactPII("Order 123456789012345")).toBe("Order 123456789012345");
  });

  it("CPF em frase longa", () => {
    const out = redactPII(
      "Paciente Maria (CPF 111.222.333-44) atendida ontem."
    );
    expect(out).toBe("Paciente Maria (CPF [CPF]) atendida ontem.");
  });
});

describe("redactPII · CEP", () => {
  it("CEP com hífen", () => {
    expect(redactPII("CEP 01310-100")).toBe("CEP [CEP]");
  });
  it("CEP sem hífen", () => {
    expect(redactPII("CEP 01310100")).toBe("CEP [CEP]");
  });
});

describe("redactPII · e-mail", () => {
  it("e-mail simples", () => {
    expect(redactPII("mail: joao@exemplo.com")).toBe("mail: [EMAIL]");
  });
  it("e-mail com subdomínio e +", () => {
    expect(redactPII("contato: maria.silva+lgpd@ola.co.uk")).toBe(
      "contato: [EMAIL]"
    );
  });
});

describe("redactPII · telefone BR", () => {
  it("com DDI +55", () => {
    expect(redactPII("ligou +55 11 99999-9999")).toBe("ligou [PHONE]");
  });
  it("sem DDI, com parênteses", () => {
    expect(redactPII("tel (11) 99999-9999")).toBe("tel [PHONE]");
  });
  it("11 dígitos puros (ambíguo com CPF — ok, redige em qualquer categoria)", () => {
    // 11 dígitos sem separador coincide com CPF e com celular BR.
    // Qualquer redação é aceitável — o objetivo é NÃO vazar os dígitos.
    const out = redactPII("whats 11987654321");
    expect(out).not.toContain("11987654321");
    expect(out).toMatch(/^whats \[(CPF|PHONE)\]$/);
  });

  it("celular com separador vira PHONE (não CPF)", () => {
    expect(redactPII("whats 11 98765-4321")).toBe("whats [PHONE]");
  });
  it("8 dígitos (fixo antigo)", () => {
    expect(redactPII("fixo (11) 3333-4444")).toBe("fixo [PHONE]");
  });
});

describe("redactPII · UUID", () => {
  it("não redige UUID por default (uso em log)", () => {
    const uuid = "11111111-2222-3333-4444-555555555555";
    expect(redactPII(`customer ${uuid}`)).toBe(`customer ${uuid}`);
  });
  it("redige UUID quando opt-in", () => {
    const uuid = "11111111-2222-3333-4444-555555555555";
    expect(redactPII(`customer ${uuid}`, { uuid: true })).toBe(
      `customer [UUID]`
    );
  });
});

describe("redactPII · tokens", () => {
  it("redige token Asaas", () => {
    const t = "$aact_" + "A".repeat(50);
    expect(redactPII(`Auth: ${t}`)).toBe("Auth: [TOKEN]");
  });
  it("redige JWT", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM";
    expect(redactPII(`jwt: ${jwt}`)).toBe("jwt: [TOKEN]");
  });
});

describe("redactPII · combinado", () => {
  it("redige múltiplas classes em uma passada", () => {
    const raw =
      "Maria (CPF 111.222.333-44, email maria@ola.com, phone +55 11 98765-4321) mora no CEP 01310-100.";
    const out = redactPII(raw);
    expect(out).toBe(
      "Maria (CPF [CPF], email [EMAIL], phone [PHONE]) mora no CEP [CEP]."
    );
  });

  it("não deixa escapar CPF embutido em texto", () => {
    const out = redactPII("paciente123.456.789-01vazou");
    expect(out).toContain("[CPF]");
    expect(out).not.toContain("123.456.789-01");
  });
});

describe("redactForLog / redactForLLM presets", () => {
  it("redactForLog mantém UUID, remove PII", () => {
    const raw = "customer 11111111-2222-3333-4444-555555555555, CPF 111.222.333-44";
    const out = redactForLog(raw);
    expect(out).toContain("11111111-2222-3333-4444-555555555555");
    expect(out).toContain("[CPF]");
  });

  it("redactForLLM redige UUID também", () => {
    const raw = "customer 11111111-2222-3333-4444-555555555555, CPF 111.222.333-44";
    const out = redactForLLM(raw);
    expect(out).toContain("[UUID]");
    expect(out).toContain("[CPF]");
  });
});

describe("redactPII · edge cases", () => {
  it("string vazia passa", () => {
    expect(redactPII("")).toBe("");
  });

  it("texto sem PII passa inalterado", () => {
    const raw = "Olá, seu tratamento está pronto pra envio.";
    expect(redactPII(raw)).toBe(raw);
  });

  it("não muta o input original", () => {
    const raw = "CPF 111.222.333-44";
    redactPII(raw);
    expect(raw).toBe("CPF 111.222.333-44");
  });
});
