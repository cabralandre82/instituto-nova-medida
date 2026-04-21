/**
 * Testes — cron-auth.ts (PR-026).
 *
 * Garante o contrato crítico do helper:
 *   - Prod sem CRON_SECRET ⇒ 503 misconfigured (fail-fast).
 *   - Dev sem CRON_SECRET ⇒ null (permite passar).
 *   - Secret correta via `Authorization: Bearer` ⇒ null.
 *   - Secret correta via `x-cron-secret` ⇒ null.
 *   - Secret errada ⇒ 401.
 *   - Sem header ⇒ 401.
 *   - Comparação timing-safe (mesmo tamanho, bytes diferentes) ⇒ 401.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertCronRequest,
  __resetCronAuthWarningForTests,
} from "@/lib/cron-auth";
import { NextRequest } from "next/server";

function makeReq(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://example.com/api/internal/cron/foo", {
    headers,
  });
}

describe("assertCronRequest", () => {
  beforeEach(() => {
    __resetCronAuthWarningForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("produção sem CRON_SECRET", () => {
    it("retorna 503 misconfigured (fail-fast)", async () => {
      vi.stubEnv("CRON_SECRET", "");
      vi.stubEnv("NODE_ENV", "production");

      const res = assertCronRequest(makeReq());
      expect(res).not.toBeNull();
      expect(res!.status).toBe(503);

      const body = await res!.json();
      expect(body).toMatchObject({
        ok: false,
        error: "misconfigured",
      });
      expect(body.hint).toContain("CRON_SECRET");
    });

    it("loga erro explícito no console.error", () => {
      vi.stubEnv("CRON_SECRET", "");
      vi.stubEnv("NODE_ENV", "production");
      const errSpy = vi.spyOn(console, "error");

      assertCronRequest(makeReq());
      expect(errSpy).toHaveBeenCalled();
      const firstCall = errSpy.mock.calls[0]?.[0];
      expect(String(firstCall)).toContain("CRON_SECRET missing");
    });
  });

  describe("dev sem CRON_SECRET", () => {
    it("permite a chamada (retorna null)", () => {
      vi.stubEnv("CRON_SECRET", "");
      vi.stubEnv("NODE_ENV", "development");

      const res = assertCronRequest(makeReq());
      expect(res).toBeNull();
    });

    it("avisa no console.warn só uma vez por processo", () => {
      vi.stubEnv("CRON_SECRET", "");
      vi.stubEnv("NODE_ENV", "development");
      const warnSpy = vi.spyOn(console, "warn");

      assertCronRequest(makeReq());
      assertCronRequest(makeReq());
      assertCronRequest(makeReq());

      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it("em test silencia o warn também", () => {
      vi.stubEnv("CRON_SECRET", "");
      vi.stubEnv("NODE_ENV", "test");
      const warnSpy = vi.spyOn(console, "warn");

      assertCronRequest(makeReq());
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe("CRON_SECRET definida", () => {
    beforeEach(() => {
      vi.stubEnv("CRON_SECRET", "super-secret-value");
      vi.stubEnv("NODE_ENV", "production");
    });

    it("autoriza via Authorization: Bearer", () => {
      const req = makeReq({
        authorization: "Bearer super-secret-value",
      });
      expect(assertCronRequest(req)).toBeNull();
    });

    it("autoriza via x-cron-secret", () => {
      const req = makeReq({ "x-cron-secret": "super-secret-value" });
      expect(assertCronRequest(req)).toBeNull();
    });

    it("rejeita secret errada com 401", async () => {
      const req = makeReq({ authorization: "Bearer wrong-value" });
      const res = assertCronRequest(req);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(401);
      const body = await res!.json();
      expect(body).toMatchObject({ ok: false, error: "unauthorized" });
    });

    it("rejeita request sem header com 401", () => {
      const res = assertCronRequest(makeReq());
      expect(res).not.toBeNull();
      expect(res!.status).toBe(401);
    });

    it("rejeita Bearer com prefixo correto mas secret errada", () => {
      const req = makeReq({
        authorization: "Bearer super-secret-valueX",
      });
      const res = assertCronRequest(req);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(401);
    });

    it("comparação timing-safe: strings de mesmo tamanho diferindo em 1 byte também rejeita", () => {
      // Garante que não caímos em fast-fail por short-circuit óbvio
      // (ambos Bearer + secret mesmo comprimento, diferem em 1 char no meio).
      const req = makeReq({
        authorization: "Bearer super-secret-valuX", // 1 char trocado
      });
      const res = assertCronRequest(req);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(401);
    });

    it("rejeita header x-cron-secret com case diferente no valor", () => {
      const req = makeReq({ "x-cron-secret": "SUPER-SECRET-VALUE" });
      const res = assertCronRequest(req);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(401);
    });
  });
});
