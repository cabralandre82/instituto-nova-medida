/**
 * Testes de text-sanitize.ts (PR-036 · D-054 + PR-036-B · D-055).
 */

import { describe, expect, it } from "vitest";
import {
  cleanFreeText,
  cleanText,
  hasControlChars,
  hasEvilControlChars,
  normalizeInternalPath,
  sanitizeFreeText,
  sanitizeShortText,
  TEXT_PATTERNS,
} from "./text-sanitize";

describe("hasControlChars", () => {
  it("detecta newline, CR, tab, NULL, ESC", () => {
    expect(hasControlChars("ok\n")).toBe(true);
    expect(hasControlChars("ok\r\n")).toBe(true);
    expect(hasControlChars("ok\t")).toBe(true);
    expect(hasControlChars("ok\0foo")).toBe(true);
    expect(hasControlChars("ok\x1b[30m")).toBe(true);
    expect(hasControlChars("ok\x7f")).toBe(true);
  });

  it("detecta separadores Unicode U+2028/U+2029", () => {
    expect(hasControlChars("ok\u2028")).toBe(true);
    expect(hasControlChars("ok\u2029")).toBe(true);
  });

  it("não alarma texto normal", () => {
    expect(hasControlChars("Maria Silva")).toBe(false);
    expect(hasControlChars("São João del-Rei")).toBe(false);
    expect(hasControlChars("D'Ávila")).toBe(false);
    expect(hasControlChars("")).toBe(false);
  });
});

describe("cleanText", () => {
  it("trim + colapsa whitespace + NFC", () => {
    expect(cleanText("  foo   bar  ")).toBe("foo bar");
    expect(cleanText("Maria\tda\nSilva")).toBe("Maria da Silva");
  });

  it("NFC: normaliza composição de acentos", () => {
    // "á" decomposto: U+0061 + U+0301 → U+00E1
    const decomposed = "a\u0301";
    const composed = "\u00e1";
    expect(cleanText(decomposed)).toBe(composed);
  });
});

describe("sanitizeShortText · happy paths", () => {
  it("texto legítimo passa", () => {
    const r = sanitizeShortText("Maria Silva", { maxLen: 100 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("Maria Silva");
  });

  it("colapsa whitespace", () => {
    const r = sanitizeShortText("  Maria  Silva  ", { maxLen: 100 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("Maria Silva");
  });

  it("aceita dígitos com pattern default", () => {
    const r = sanitizeShortText("27 anos", { maxLen: 100 });
    expect(r.ok).toBe(true);
  });

  it("rejeita dígitos com personName pattern", () => {
    const r = sanitizeShortText("Maria 2", {
      maxLen: 100,
      pattern: TEXT_PATTERNS.personName,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("charset");
  });

  it("allowEmpty devolve string vazia sem erro", () => {
    const r = sanitizeShortText("   ", { maxLen: 100, allowEmpty: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("");
  });

  it("non-string com allowEmpty = vazio ok", () => {
    const r = sanitizeShortText(undefined, { maxLen: 100, allowEmpty: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("");
  });

  it("non-string sem allowEmpty = reason empty", () => {
    const r = sanitizeShortText(undefined, { maxLen: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("empty");
  });
});

describe("sanitizeShortText · rejeições de segurança", () => {
  it("controlChars (newline)", () => {
    const r = sanitizeShortText("Maria\nfoo", { maxLen: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("control_chars");
  });

  it("controlChars (tab)", () => {
    const r = sanitizeShortText("Maria\tfoo", { maxLen: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("control_chars");
  });

  it("too_long acima do maxLen", () => {
    const r = sanitizeShortText("x".repeat(200), { maxLen: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too_long");
  });

  it("charset: < > tags", () => {
    const r = sanitizeShortText("<script>alert(1)</script>", { maxLen: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("charset");
  });

  it("charset: template handlebars", () => {
    const r = sanitizeShortText("Maria {{evil}}", { maxLen: 100 });
    expect(r.ok).toBe(false);
  });

  it("charset: shell meta chars", () => {
    const r = sanitizeShortText("foo; rm -rf /", { maxLen: 100 });
    expect(r.ok).toBe(false);
  });

  it("minLen rejeita strings curtas", () => {
    const r = sanitizeShortText("a", { maxLen: 100, minLen: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("empty");
  });
});

describe("TEXT_PATTERNS.utmToken", () => {
  it("aceita source/medium típicos", () => {
    expect(TEXT_PATTERNS.utmToken.test("google")).toBe(true);
    expect(TEXT_PATTERNS.utmToken.test("cpc")).toBe(true);
    expect(TEXT_PATTERNS.utmToken.test("brand-awareness_q3")).toBe(true);
    expect(TEXT_PATTERNS.utmToken.test("abc+123")).toBe(true);
  });

  it("rejeita espaço, <, >, {", () => {
    expect(TEXT_PATTERNS.utmToken.test("brand awareness")).toBe(false);
    expect(TEXT_PATTERNS.utmToken.test("<script>")).toBe(false);
    expect(TEXT_PATTERNS.utmToken.test("{{x}}")).toBe(false);
  });
});

describe("normalizeInternalPath", () => {
  it("aceita path interno normal", () => {
    expect(normalizeInternalPath("/emagrecer")).toBe("/emagrecer");
    expect(normalizeInternalPath("/planos/tirzepatida")).toBe(
      "/planos/tirzepatida"
    );
    expect(normalizeInternalPath("/quiz?src=ad")).toBe("/quiz?src=ad");
  });

  it("rejeita protocol-relative (//evil.com)", () => {
    expect(normalizeInternalPath("//evil.com/pwn")).toBe("/");
  });

  it("rejeita URL absoluta", () => {
    expect(normalizeInternalPath("http://evil.com")).toBe("/");
    expect(normalizeInternalPath("https://x.y")).toBe("/");
    expect(normalizeInternalPath("javascript:alert(1)")).toBe("/");
    expect(normalizeInternalPath("data:text/html,<x>")).toBe("/");
  });

  it("rejeita backslash (Windows path)", () => {
    expect(normalizeInternalPath("/foo\\bar")).toBe("/");
  });

  it("rejeita controle", () => {
    expect(normalizeInternalPath("/foo\nbar")).toBe("/");
  });

  it("default pra '/' quando não começa com '/'", () => {
    expect(normalizeInternalPath("emagrecer")).toBe("/");
    expect(normalizeInternalPath("")).toBe("/");
    expect(normalizeInternalPath("   ")).toBe("/");
  });

  it("default pra '/' em input não-string", () => {
    expect(normalizeInternalPath(undefined)).toBe("/");
    expect(normalizeInternalPath(null)).toBe("/");
    expect(normalizeInternalPath(42)).toBe("/");
  });

  it("rejeita path acima do maxLen", () => {
    const big = "/" + "a".repeat(300);
    expect(normalizeInternalPath(big, 200)).toBe("/");
  });
});

describe("hasEvilControlChars", () => {
  it("ACEITA newline, CR e tab (texto livre legítimo)", () => {
    expect(hasEvilControlChars("linha 1\nlinha 2")).toBe(false);
    expect(hasEvilControlChars("linha 1\r\nlinha 2")).toBe(false);
    expect(hasEvilControlChars("coluna1\tcoluna2")).toBe(false);
  });

  it("rejeita NULL, ESC, DEL", () => {
    expect(hasEvilControlChars("ok\0bad")).toBe(true);
    expect(hasEvilControlChars("ok\x1b[30mbad")).toBe(true);
    expect(hasEvilControlChars("ok\x7fbad")).toBe(true);
  });

  it("rejeita VT e FF (whitespace obsoleto)", () => {
    expect(hasEvilControlChars("a\x0bb")).toBe(true);
    expect(hasEvilControlChars("a\x0cb")).toBe(true);
  });

  it("rejeita SO–US (0x0E–0x1F)", () => {
    expect(hasEvilControlChars("a\x0eb")).toBe(true);
    expect(hasEvilControlChars("a\x1fb")).toBe(true);
  });

  it("rejeita zero-width (U+200B–U+200F, U+FEFF)", () => {
    expect(hasEvilControlChars("IGN\u200BORE PREVIOUS")).toBe(true);
    expect(hasEvilControlChars("ok\u200Cbad")).toBe(true);
    expect(hasEvilControlChars("ok\ufeffbad")).toBe(true);
  });

  it("rejeita bidi override (CVE Trojan Source)", () => {
    expect(hasEvilControlChars("ok\u202Ebad")).toBe(true);
    expect(hasEvilControlChars("ok\u2066bad")).toBe(true);
  });

  it("rejeita line/paragraph separator Unicode", () => {
    expect(hasEvilControlChars("ok\u2028bad")).toBe(true);
    expect(hasEvilControlChars("ok\u2029bad")).toBe(true);
  });

  it("texto clínico legítimo passa", () => {
    const anamnese = `Paciente relata:
- Ganho de 15kg nos últimos 2 anos.
- Dieta livre.
- HAS controlada com losartana 50mg.

Conduta:
- Iniciar tirzepatida 2.5mg SC semanal.`;
    expect(hasEvilControlChars(anamnese)).toBe(false);
  });
});

describe("cleanFreeText", () => {
  it("preserva quebras de linha", () => {
    expect(cleanFreeText("linha 1\nlinha 2")).toBe("linha 1\nlinha 2");
  });

  it("unifica CRLF e CR pra LF", () => {
    expect(cleanFreeText("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("tab vira espaço simples", () => {
    expect(cleanFreeText("foo\tbar")).toBe("foo bar");
  });

  it("trim right em cada linha", () => {
    expect(cleanFreeText("foo   \nbar   ")).toBe("foo\nbar");
  });

  it("colapsa 3+ linhas em branco em 2", () => {
    const input = "foo\n\n\n\n\nbar";
    expect(cleanFreeText(input)).toBe("foo\n\n\nbar");
  });

  it("NFC normaliza acentos decompostos", () => {
    const decomposed = "a\u0301"; // á decomposto
    expect(cleanFreeText(decomposed)).toBe("\u00e1");
  });

  it("trim global nas extremidades", () => {
    expect(cleanFreeText("\n\n foo \n\n")).toBe("foo");
  });
});

describe("sanitizeFreeText · happy paths", () => {
  it("texto clínico multi-linha passa", () => {
    const input = `Paciente refere:
- dor abdominal leve
- IMC 32`;
    const r = sanitizeFreeText(input, { maxLen: 4000 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toContain("IMC 32");
  });

  it("trim + normaliza newlines e tabs", () => {
    const r = sanitizeFreeText("  linha 1\r\nlinha 2\tcoluna  ", {
      maxLen: 100,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("linha 1\nlinha 2 coluna");
  });

  it("allowEmpty com string vazia", () => {
    const r = sanitizeFreeText("", { maxLen: 100, allowEmpty: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("");
  });

  it("allowEmpty com null/undefined", () => {
    expect(sanitizeFreeText(null, { maxLen: 100, allowEmpty: true })).toEqual({
      ok: true,
      value: "",
    });
    expect(
      sanitizeFreeText(undefined, { maxLen: 100, allowEmpty: true })
    ).toEqual({ ok: true, value: "" });
  });

  it("aceita símbolos clínicos (↑ ↓ µ mg/dL %)", () => {
    const r = sanitizeFreeText("glicose ↑ 180 mg/dL (90% acima do normal)", {
      maxLen: 500,
    });
    expect(r.ok).toBe(true);
  });

  it("aceita unicode arbitrário (não usa allowlist de charset)", () => {
    const r = sanitizeFreeText("Paciente 日本人 — falante de português", {
      maxLen: 500,
    });
    expect(r.ok).toBe(true);
  });
});

describe("sanitizeFreeText · rejeições", () => {
  it("empty sem allowEmpty", () => {
    expect(sanitizeFreeText("", { maxLen: 100 })).toEqual({
      ok: false,
      reason: "empty",
    });
    expect(sanitizeFreeText("   \n  \n", { maxLen: 100 })).toEqual({
      ok: false,
      reason: "empty",
    });
    expect(sanitizeFreeText(null, { maxLen: 100 })).toEqual({
      ok: false,
      reason: "empty",
    });
    expect(sanitizeFreeText(42, { maxLen: 100 })).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("minLen", () => {
    const r = sanitizeFreeText("ab", { maxLen: 100, minLen: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("empty");
  });

  it("too_long", () => {
    const big = "x".repeat(200);
    const r = sanitizeFreeText(big, { maxLen: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too_long");
  });

  it("too_many_lines", () => {
    const manyLines = Array.from({ length: 20 }, (_, i) => `linha ${i}`).join(
      "\n"
    );
    const r = sanitizeFreeText(manyLines, { maxLen: 4000, maxLines: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too_many_lines");
  });

  it("control_chars: NULL", () => {
    const r = sanitizeFreeText("ok\0bad", { maxLen: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("control_chars");
  });

  it("control_chars: ESC", () => {
    const r = sanitizeFreeText("ok\x1b[30mbad", { maxLen: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("control_chars");
  });

  it("control_chars: zero-width (bypass de filtro naïve)", () => {
    const r = sanitizeFreeText("IGN\u200BORE PREVIOUS", { maxLen: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("control_chars");
  });

  it("control_chars: bidi override (Trojan Source)", () => {
    const r = sanitizeFreeText("ok\u202Ebad", { maxLen: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("control_chars");
  });

  it("control_chars: U+2028 (line separator)", () => {
    const r = sanitizeFreeText("ok\u2028bad", { maxLen: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("control_chars");
  });

  it("rejeita BOM (U+FEFF) no meio", () => {
    const r = sanitizeFreeText("ok\ufeffbad", { maxLen: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("control_chars");
  });
});
