/**
 * Testes de `checkout-consent.ts` (PR-053 · D-064).
 *
 * Cobre:
 *   - `computeCheckoutConsentHash`: determinístico, sensível a qualquer
 *     campo, normaliza whitespace/NFC.
 *   - `recordCheckoutConsent`: versão conhecida → insert + hash
 *     esperado; versão desconhecida → rejeitada; insert falha → retorna
 *     `insert_failed`.
 *   - `extractClientIp`: ordem de precedência dos headers Vercel/CF/XFF.
 */

import { describe, it, expect } from "vitest";
import { createSupabaseMock } from "@/test/mocks/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeCheckoutConsentHash,
  extractClientIp,
  recordCheckoutConsent,
} from "./checkout-consent";
import {
  CHECKOUT_CONSENT_TEXT_VERSION,
  getCheckoutConsentText,
} from "./checkout-consent-terms";

const CUST = "11111111-1111-1111-1111-111111111111";
const PAY = "22222222-2222-2222-2222-222222222222";

describe("computeCheckoutConsentHash", () => {
  it("determinístico: mesmo input → mesmo hash", () => {
    const a = computeCheckoutConsentHash({
      customerId: CUST,
      paymentId: PAY,
      textVersion: "v1-2026-05",
      textSnapshot: "Li e aceito",
    });
    const b = computeCheckoutConsentHash({
      customerId: CUST,
      paymentId: PAY,
      textVersion: "v1-2026-05",
      textSnapshot: "Li e aceito",
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("mudar customer_id → hash diferente", () => {
    const a = computeCheckoutConsentHash({
      customerId: CUST,
      paymentId: PAY,
      textVersion: "v1",
      textSnapshot: "x",
    });
    const b = computeCheckoutConsentHash({
      customerId: CUST + "0",
      paymentId: PAY,
      textVersion: "v1",
      textSnapshot: "x",
    });
    expect(a).not.toBe(b);
  });

  it("mudar payment_id → hash diferente", () => {
    const a = computeCheckoutConsentHash({
      customerId: CUST,
      paymentId: PAY,
      textVersion: "v1",
      textSnapshot: "x",
    });
    const b = computeCheckoutConsentHash({
      customerId: CUST,
      paymentId: PAY + "0",
      textVersion: "v1",
      textSnapshot: "x",
    });
    expect(a).not.toBe(b);
  });

  it("mudar version → hash diferente", () => {
    const a = computeCheckoutConsentHash({
      customerId: CUST,
      paymentId: PAY,
      textVersion: "v1",
      textSnapshot: "x",
    });
    const b = computeCheckoutConsentHash({
      customerId: CUST,
      paymentId: PAY,
      textVersion: "v2",
      textSnapshot: "x",
    });
    expect(a).not.toBe(b);
  });

  it("mudar 1 vírgula no snapshot → hash diferente", () => {
    const a = computeCheckoutConsentHash({
      customerId: CUST,
      paymentId: PAY,
      textVersion: "v1",
      textSnapshot: "Aceito termos.",
    });
    const b = computeCheckoutConsentHash({
      customerId: CUST,
      paymentId: PAY,
      textVersion: "v1",
      textSnapshot: "Aceito termos,",
    });
    expect(a).not.toBe(b);
  });

  it("whitespace colapsado: 'a  b' ≡ 'a b' ≡ ' a b '", () => {
    const h1 = computeCheckoutConsentHash({
      customerId: CUST,
      paymentId: PAY,
      textVersion: "v1",
      textSnapshot: "a  b",
    });
    const h2 = computeCheckoutConsentHash({
      customerId: CUST,
      paymentId: PAY,
      textVersion: "v1",
      textSnapshot: "a b",
    });
    const h3 = computeCheckoutConsentHash({
      customerId: CUST,
      paymentId: PAY,
      textVersion: "v1",
      textSnapshot: " a b ",
    });
    expect(h1).toBe(h2);
    expect(h2).toBe(h3);
  });
});

describe("recordCheckoutConsent", () => {
  it("happy path: versão vigente → insert com hash esperado", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("checkout_consents", {
      data: { id: "cc-1" },
      error: null,
    });

    const r = await recordCheckoutConsent(
      supa.client as unknown as SupabaseClient,
      {
        customerId: CUST,
        paymentId: PAY,
        textVersion: CHECKOUT_CONSENT_TEXT_VERSION,
        ipAddress: "200.200.200.200",
        userAgent: "Mozilla/5.0",
        paymentMethod: "pix",
      }
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.consentId).toBe("cc-1");
    expect(r.textVersion).toBe(CHECKOUT_CONSENT_TEXT_VERSION);
    // Snapshot é sempre server-authoritative
    expect(r.textSnapshot).toBe(
      getCheckoutConsentText(CHECKOUT_CONSENT_TEXT_VERSION)
    );
    // Hash determinístico
    const expected = computeCheckoutConsentHash({
      customerId: CUST,
      paymentId: PAY,
      textVersion: CHECKOUT_CONSENT_TEXT_VERSION,
      textSnapshot: r.textSnapshot,
    });
    expect(r.textHash).toBe(expected);

    // Verifica payload do insert
    const insertCall = supa.calls.find(
      (c) =>
        c.table === "checkout_consents" && c.chain.includes("insert")
    );
    expect(insertCall).toBeDefined();
    const payload = insertCall!.args[insertCall!.chain.indexOf("insert")][0];
    expect(payload).toMatchObject({
      customer_id: CUST,
      payment_id: PAY,
      text_version: CHECKOUT_CONSENT_TEXT_VERSION,
      text_hash: expected,
      ip_address: "200.200.200.200",
      user_agent: "Mozilla/5.0",
      payment_method: "pix",
    });
  });

  it("versão desconhecida → unknown_version, sem insert", async () => {
    const supa = createSupabaseMock();

    const r = await recordCheckoutConsent(
      supa.client as unknown as SupabaseClient,
      {
        customerId: CUST,
        paymentId: PAY,
        textVersion: "v99-fake",
        ipAddress: null,
        userAgent: null,
        paymentMethod: "pix",
      }
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("unknown_version");
    expect(
      supa.calls.filter(
        (c) =>
          c.table === "checkout_consents" && c.chain.includes("insert")
      )
    ).toHaveLength(0);
  });

  it("customerId vazio → invalid_input", async () => {
    const supa = createSupabaseMock();

    const r = await recordCheckoutConsent(
      supa.client as unknown as SupabaseClient,
      {
        customerId: "",
        paymentId: PAY,
        textVersion: CHECKOUT_CONSENT_TEXT_VERSION,
        ipAddress: null,
        userAgent: null,
        paymentMethod: "pix",
      }
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_input");
  });

  it("insert falha → insert_failed, com mensagem propagada", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("checkout_consents", {
      data: null,
      error: { message: "FK violation" },
    });

    const r = await recordCheckoutConsent(
      supa.client as unknown as SupabaseClient,
      {
        customerId: CUST,
        paymentId: PAY,
        textVersion: CHECKOUT_CONSENT_TEXT_VERSION,
        ipAddress: null,
        userAgent: null,
        paymentMethod: "boleto",
      }
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("insert_failed");
    expect(r.message).toContain("FK violation");
  });
});

describe("extractClientIp", () => {
  function makeReq(headers: Record<string, string>): Request {
    return new Request("http://localhost/api/checkout", {
      method: "POST",
      headers: new Headers(headers),
    });
  }

  it("x-vercel-forwarded-for tem precedência sobre o resto", () => {
    const r = makeReq({
      "x-vercel-forwarded-for": "10.1.1.1, 10.2.2.2",
      "cf-connecting-ip": "20.20.20.20",
      "x-forwarded-for": "30.30.30.30",
    });
    expect(extractClientIp(r)).toBe("10.1.1.1");
  });

  it("sem Vercel, usa cf-connecting-ip", () => {
    const r = makeReq({
      "cf-connecting-ip": "20.20.20.20",
      "x-forwarded-for": "30.30.30.30",
    });
    expect(extractClientIp(r)).toBe("20.20.20.20");
  });

  it("fallback x-forwarded-for primeiro hop", () => {
    const r = makeReq({ "x-forwarded-for": "30.30.30.30, 40.40.40.40" });
    expect(extractClientIp(r)).toBe("30.30.30.30");
  });

  it("sem nenhum header → null", () => {
    const r = makeReq({});
    expect(extractClientIp(r)).toBeNull();
  });
});
