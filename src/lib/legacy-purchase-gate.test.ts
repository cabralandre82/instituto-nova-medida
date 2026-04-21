/**
 * Testes — legacy-purchase-gate.ts (PR-020 / audit [1.1]).
 *
 * Garante o contrato do gate: produção fecha por padrão; dev/test abre
 * por padrão; override explícito (`true`/`false`) funciona em qualquer
 * ambiente.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isLegacyPurchaseEnabled } from "@/lib/legacy-purchase-gate";

describe("isLegacyPurchaseEnabled", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("em produção", () => {
    beforeEach(() => {
      vi.stubEnv("NODE_ENV", "production");
    });

    it("default (sem LEGACY_PURCHASE_ENABLED): false", () => {
      vi.stubEnv("LEGACY_PURCHASE_ENABLED", "");
      expect(isLegacyPurchaseEnabled()).toBe(false);
    });

    it("LEGACY_PURCHASE_ENABLED=true: true (admin habilitou explicitamente)", () => {
      vi.stubEnv("LEGACY_PURCHASE_ENABLED", "true");
      expect(isLegacyPurchaseEnabled()).toBe(true);
    });

    it("LEGACY_PURCHASE_ENABLED=false: false", () => {
      vi.stubEnv("LEGACY_PURCHASE_ENABLED", "false");
      expect(isLegacyPurchaseEnabled()).toBe(false);
    });

    it.each(["1", "yes", "True", "TRUE", "on"])(
      "valores ambíguos (%s) caem no default false — strict",
      (v) => {
        vi.stubEnv("LEGACY_PURCHASE_ENABLED", v);
        expect(isLegacyPurchaseEnabled()).toBe(false);
      }
    );
  });

  describe("em desenvolvimento", () => {
    beforeEach(() => {
      vi.stubEnv("NODE_ENV", "development");
    });

    it("default (sem env): true", () => {
      vi.stubEnv("LEGACY_PURCHASE_ENABLED", "");
      expect(isLegacyPurchaseEnabled()).toBe(true);
    });

    it("pode ser desligado explicitamente com LEGACY_PURCHASE_ENABLED=false", () => {
      vi.stubEnv("LEGACY_PURCHASE_ENABLED", "false");
      expect(isLegacyPurchaseEnabled()).toBe(false);
    });
  });

  describe("em test", () => {
    beforeEach(() => {
      vi.stubEnv("NODE_ENV", "test");
    });

    it("default: true (pra não quebrar testes existentes)", () => {
      vi.stubEnv("LEGACY_PURCHASE_ENABLED", "");
      expect(isLegacyPurchaseEnabled()).toBe(true);
    });
  });
});
