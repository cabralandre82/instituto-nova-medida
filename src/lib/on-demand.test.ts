/**
 * Testes de on-demand — PR-079 · D-091.
 *
 * Foco em funções puras (helpers de TTL, presença, truncate). As
 * funções de I/O (createOnDemandRequest, fanOutToOnlineDoctors,
 * acceptOnDemandRequest, cancelOnDemandRequest, expireStaleRequests)
 * dependem de Supabase e ficam cobertas em smoke E2E.
 */

import { describe, expect, it } from "vitest";
import {
  computeSecondsUntilExpiry,
  isPresenceEligible,
  truncateChiefComplaintForWa,
  ON_DEMAND_DEFAULT_TTL_SECONDS,
  MAX_FANOUT_DOCTORS,
} from "./on-demand";

describe("ON_DEMAND_DEFAULT_TTL_SECONDS", () => {
  it("é 5 minutos (300s)", () => {
    expect(ON_DEMAND_DEFAULT_TTL_SECONDS).toBe(300);
  });
});

describe("MAX_FANOUT_DOCTORS", () => {
  it("é um número positivo razoável (≤ 50)", () => {
    expect(MAX_FANOUT_DOCTORS).toBeGreaterThan(0);
    expect(MAX_FANOUT_DOCTORS).toBeLessThanOrEqual(50);
  });
});

describe("computeSecondsUntilExpiry", () => {
  const now = new Date("2026-04-27T15:00:00Z");

  it("aceita Date e retorna positivo se futuro", () => {
    const res = computeSecondsUntilExpiry({
      expiresAt: new Date("2026-04-27T15:05:00Z"),
      now,
    });
    expect(res).toBe(300);
  });

  it("aceita string ISO", () => {
    const res = computeSecondsUntilExpiry({
      expiresAt: "2026-04-27T15:02:00Z",
      now,
    });
    expect(res).toBe(120);
  });

  it("retorna 0 se exatamente igual", () => {
    const res = computeSecondsUntilExpiry({
      expiresAt: new Date("2026-04-27T15:00:00Z"),
      now,
    });
    expect(res).toBe(0);
  });

  it("retorna negativo se já passou", () => {
    const res = computeSecondsUntilExpiry({
      expiresAt: new Date("2026-04-27T14:55:00Z"),
      now,
    });
    expect(res).toBeLessThan(0);
  });

  it("retorna -1 pra string inválida (sem crash)", () => {
    const res = computeSecondsUntilExpiry({
      expiresAt: "not-a-date",
      now,
    });
    expect(res).toBe(-1);
  });

  it("usa now() default se não passado", () => {
    const future = new Date(Date.now() + 60_000);
    const res = computeSecondsUntilExpiry({ expiresAt: future });
    expect(res).toBeGreaterThan(58);
    expect(res).toBeLessThanOrEqual(60);
  });
});

describe("isPresenceEligible", () => {
  const now = new Date("2026-04-27T15:00:00Z");

  it("status='offline' nunca é elegível", () => {
    expect(
      isPresenceEligible(
        {
          status: "offline",
          last_heartbeat_at: "2026-04-27T14:59:30Z",
        },
        now
      )
    ).toBe(false);
  });

  it("status='online' com heartbeat de 30s atrás → elegível", () => {
    expect(
      isPresenceEligible(
        {
          status: "online",
          last_heartbeat_at: "2026-04-27T14:59:30Z",
        },
        now
      )
    ).toBe(true);
  });

  it("status='busy' com heartbeat fresco → elegível (filtro de busy fica no caller)", () => {
    expect(
      isPresenceEligible(
        {
          status: "busy",
          last_heartbeat_at: "2026-04-27T14:59:30Z",
        },
        now
      )
    ).toBe(true);
  });

  it("status='online' com heartbeat > 120s → NÃO elegível", () => {
    expect(
      isPresenceEligible(
        {
          status: "online",
          last_heartbeat_at: "2026-04-27T14:55:00Z", // 5 min atrás
        },
        now
      )
    ).toBe(false);
  });

  it("status='online' com heartbeat exato em 120s → elegível (≤)", () => {
    expect(
      isPresenceEligible(
        {
          status: "online",
          last_heartbeat_at: "2026-04-27T14:58:00Z", // 120s
        },
        now
      )
    ).toBe(true);
  });

  it("heartbeat com string inválida → false (defensivo)", () => {
    expect(
      isPresenceEligible(
        {
          status: "online",
          last_heartbeat_at: "abc",
        },
        now
      )
    ).toBe(false);
  });
});

describe("truncateChiefComplaintForWa", () => {
  it("texto curto passa intacto", () => {
    expect(truncateChiefComplaintForWa("Dor de cabeça forte")).toBe(
      "Dor de cabeça forte"
    );
  });

  it("colapsa múltiplos espaços/quebras de linha em 1 espaço", () => {
    expect(truncateChiefComplaintForWa("Dor   de\ncabeça\n  forte")).toBe(
      "Dor de cabeça forte"
    );
  });

  it("trim leading/trailing", () => {
    expect(truncateChiefComplaintForWa("  Sintoma  ")).toBe("Sintoma");
  });

  it("trunca em 120 chars com … no fim", () => {
    const long = "a".repeat(200);
    const res = truncateChiefComplaintForWa(long);
    expect(res).toHaveLength(118); // 117 chars + "…" (ellipsis = 1 char)
    expect(res.endsWith("…")).toBe(true);
  });

  it("não trunca em 120 exatos (limite inclusivo)", () => {
    const exact = "a".repeat(120);
    expect(truncateChiefComplaintForWa(exact)).toBe(exact);
  });

  it("trunca em 121 (acima do limite)", () => {
    const justOver = "a".repeat(121);
    const res = truncateChiefComplaintForWa(justOver);
    expect(res).toHaveLength(118);
    expect(res.endsWith("…")).toBe(true);
  });

  it("normalização não quebra unicode (acentos preservados)", () => {
    expect(truncateChiefComplaintForWa("Náusea e vômito")).toBe(
      "Náusea e vômito"
    );
  });
});
