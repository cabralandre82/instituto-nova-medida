/**
 * Testes — lead-cookie.ts (PR-075-A · D-086).
 *
 * Cobertura:
 *   - Build/clear cookie produz formato canônico.
 *   - Modo prod adiciona `Secure`; dev não.
 *   - Parser extrai apenas o nome certo, ignora similares, valida UUID.
 *   - Build rejeita leadId não-UUID.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LEAD_COOKIE_MAX_AGE_SECONDS,
  LEAD_COOKIE_NAME,
  buildLeadCookieClearHeader,
  buildLeadCookieHeader,
  readLeadIdFromCookieHeader,
} from "@/lib/lead-cookie";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const ANOTHER_UUID = "11111111-2222-3333-4444-555555555555";

describe("lead-cookie", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("buildLeadCookieHeader", () => {
    it("formata cookie httpOnly com max-age e path em dev (sem Secure)", () => {
      vi.stubEnv("NODE_ENV", "development");
      const header = buildLeadCookieHeader(VALID_UUID);
      expect(header).toContain(`${LEAD_COOKIE_NAME}=${VALID_UUID}`);
      expect(header).toContain("Path=/");
      expect(header).toContain("HttpOnly");
      expect(header).toContain("SameSite=Lax");
      expect(header).toContain(`Max-Age=${LEAD_COOKIE_MAX_AGE_SECONDS}`);
      expect(header).not.toContain("Secure");
    });

    it("adiciona Secure em produção", () => {
      vi.stubEnv("NODE_ENV", "production");
      const header = buildLeadCookieHeader(VALID_UUID);
      expect(header).toContain("Secure");
    });

    it("rejeita leadId não-UUID", () => {
      expect(() => buildLeadCookieHeader("not-a-uuid")).toThrow();
      expect(() => buildLeadCookieHeader("")).toThrow();
      expect(() => buildLeadCookieHeader("123" as unknown as string)).toThrow();
    });
  });

  describe("buildLeadCookieClearHeader", () => {
    it("emite cookie com Max-Age=0 (apaga) e mesmo path/atributos básicos", () => {
      vi.stubEnv("NODE_ENV", "production");
      const header = buildLeadCookieClearHeader();
      expect(header).toContain(`${LEAD_COOKIE_NAME}=`);
      expect(header).toContain("Max-Age=0");
      expect(header).toContain("Path=/");
      expect(header).toContain("HttpOnly");
      expect(header).toContain("SameSite=Lax");
      expect(header).toContain("Secure");
    });
  });

  describe("readLeadIdFromCookieHeader", () => {
    it("extrai o lead UUID do header de cookies (único)", () => {
      const cookie = `${LEAD_COOKIE_NAME}=${VALID_UUID}`;
      expect(readLeadIdFromCookieHeader(cookie)).toBe(VALID_UUID);
    });

    it("extrai mesmo com outros cookies presentes em qualquer ordem", () => {
      const before = `theme=dark; ${LEAD_COOKIE_NAME}=${VALID_UUID}; sb-access-token=xyz`;
      const after = `${LEAD_COOKIE_NAME}=${ANOTHER_UUID}; theme=light`;
      expect(readLeadIdFromCookieHeader(before)).toBe(VALID_UUID);
      expect(readLeadIdFromCookieHeader(after)).toBe(ANOTHER_UUID);
    });

    it("retorna null se header vazio/ausente", () => {
      expect(readLeadIdFromCookieHeader("")).toBeNull();
      expect(readLeadIdFromCookieHeader(null)).toBeNull();
      expect(readLeadIdFromCookieHeader(undefined)).toBeNull();
    });

    it("retorna null se nome aparece como prefixo de outro cookie", () => {
      const cookie = `inm_lead_id_x=${VALID_UUID}`;
      expect(readLeadIdFromCookieHeader(cookie)).toBeNull();
    });

    it("retorna null se valor não é UUID válido (defesa contra cookie tamperado)", () => {
      expect(readLeadIdFromCookieHeader(`${LEAD_COOKIE_NAME}=hacker`)).toBeNull();
      expect(
        readLeadIdFromCookieHeader(`${LEAD_COOKIE_NAME}=${VALID_UUID}aaaa`),
      ).toBeNull();
      expect(readLeadIdFromCookieHeader(`${LEAD_COOKIE_NAME}=`)).toBeNull();
    });
  });
});
