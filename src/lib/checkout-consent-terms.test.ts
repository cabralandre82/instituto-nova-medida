/**
 * Testes de `checkout-consent-terms.ts` (PR-053 · D-064).
 *
 * Cobre:
 *   - Versão vigente está em `KNOWN_...`.
 *   - `isKnownCheckoutConsentVersion` aceita vigente, rejeita inventada.
 *   - `getCheckoutConsentText` retorna string não-vazia pra vigente,
 *     throw pra desconhecida.
 *   - Texto menciona LGPD (marca legal) — guardrail contra refactor
 *     acidental que afrouxe o texto.
 *   - Imutabilidade de versões já publicadas (snapshot).
 */

import { describe, it, expect } from "vitest";
import {
  CHECKOUT_CONSENT_TEXT_VERSION,
  KNOWN_CHECKOUT_CONSENT_VERSIONS,
  getCheckoutConsentText,
  isKnownCheckoutConsentVersion,
} from "./checkout-consent-terms";

describe("checkout-consent-terms", () => {
  it("versão vigente está em KNOWN_CHECKOUT_CONSENT_VERSIONS", () => {
    expect(KNOWN_CHECKOUT_CONSENT_VERSIONS).toContain(
      CHECKOUT_CONSENT_TEXT_VERSION
    );
  });

  it("isKnownCheckoutConsentVersion aceita vigente", () => {
    expect(
      isKnownCheckoutConsentVersion(CHECKOUT_CONSENT_TEXT_VERSION)
    ).toBe(true);
  });

  it("isKnownCheckoutConsentVersion rejeita inventada", () => {
    expect(isKnownCheckoutConsentVersion("v99-fake")).toBe(false);
    expect(isKnownCheckoutConsentVersion("")).toBe(false);
  });

  it("getCheckoutConsentText retorna string não-vazia pra vigente", () => {
    const text = getCheckoutConsentText(CHECKOUT_CONSENT_TEXT_VERSION);
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(50);
  });

  it("getCheckoutConsentText throw pra versão desconhecida", () => {
    expect(() => getCheckoutConsentText("v99-fake")).toThrow(
      /desconhecida/
    );
  });

  it("texto v1 menciona LGPD + finalidade + farmácia", () => {
    const text = getCheckoutConsentText("v1-2026-05");
    expect(text).toMatch(/LGPD|13\.709/);
    expect(text).toMatch(/contratação/i);
    expect(text).toMatch(/farmácia/i);
  });

  it("v1 é imutável (snapshot) — mudar exige nova versão", () => {
    // Se este teste falhar, você editou o template v1 sem bump.
    // Crie v2 em vez disso.
    const text = getCheckoutConsentText("v1-2026-05");
    expect(text).toBe(
      "Li e concordo com os Termos de Uso e a Política de Privacidade do " +
        "Instituto Nova Medida. Autorizo, nos termos do art. 11, II, \"a\", " +
        "da Lei nº 13.709/2018 (LGPD), o tratamento dos meus dados pessoais " +
        "e de saúde para a finalidade da contratação deste plano e sua " +
        "execução operacional, incluindo o compartilhamento estritamente " +
        "necessário com a farmácia de manipulação parceira e com " +
        "prestadores de serviço logístico contratados pelo Instituto."
    );
  });
});
