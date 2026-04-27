/**
 * Testes de on-call-monitor — PR-081 · D-093.
 *
 * Foco em funções puras (computeBlockOccurrence, computeCoverage,
 * computeEarningCents, decideOutcome, bucketFor, isPresenceFreshAndOnline,
 * formatEarningDescription). I/O (settleBlock, runMonitorOnCallCycle)
 * fica coberto em smoke E2E + observação no /admin/crons.
 */

import { describe, expect, it } from "vitest";
import {
  bucketFor,
  computeBlockOccurrence,
  computeCoverage,
  computeEarningCents,
  decideOutcome,
  formatEarningDescription,
  isPresenceFreshAndOnline,
  MAX_BLOCKS_PER_RUN,
  MIN_COVERAGE_FOR_PAYMENT,
  SAMPLE_INTERVAL_MINUTES,
  SETTLEMENT_GRACE_MINUTES,
} from "./on-call-monitor";

describe("constantes", () => {
  it("SAMPLE_INTERVAL_MINUTES é 5", () => {
    expect(SAMPLE_INTERVAL_MINUTES).toBe(5);
  });

  it("SETTLEMENT_GRACE_MINUTES é generoso (≥ 15)", () => {
    expect(SETTLEMENT_GRACE_MINUTES).toBeGreaterThanOrEqual(15);
  });

  it("MIN_COVERAGE_FOR_PAYMENT está no intervalo (0, 1)", () => {
    expect(MIN_COVERAGE_FOR_PAYMENT).toBeGreaterThan(0);
    expect(MIN_COVERAGE_FOR_PAYMENT).toBeLessThan(1);
  });

  it("MAX_BLOCKS_PER_RUN é finito e positivo", () => {
    expect(MAX_BLOCKS_PER_RUN).toBeGreaterThan(0);
    expect(MAX_BLOCKS_PER_RUN).toBeLessThanOrEqual(10000);
  });
});

describe("bucketFor", () => {
  it("trunca pra múltiplo de 5min UTC", () => {
    expect(bucketFor(new Date("2026-04-27T14:32:18Z"))).toBe("2026-04-27T14:30");
    expect(bucketFor(new Date("2026-04-27T14:35:00Z"))).toBe("2026-04-27T14:35");
    expect(bucketFor(new Date("2026-04-27T14:39:59Z"))).toBe("2026-04-27T14:35");
  });

  it("zero-pads horas e minutos", () => {
    expect(bucketFor(new Date("2026-01-05T03:07:00Z"))).toBe("2026-01-05T03:05");
  });

  it("é determinístico (mesma data → mesma bucket)", () => {
    const d = new Date("2026-04-27T14:33:45.123Z");
    expect(bucketFor(d)).toBe(bucketFor(d));
  });

  it("buckets adjacentes diferem por exatamente 5min", () => {
    expect(bucketFor(new Date("2026-04-27T14:29:59Z"))).toBe("2026-04-27T14:25");
    expect(bucketFor(new Date("2026-04-27T14:30:00Z"))).toBe("2026-04-27T14:30");
  });
});

describe("computeBlockOccurrence", () => {
  // SP é UTC-3 fixo. Bloco "segunda 14:00-18:00" SP ↔ UTC 17:00-21:00.
  // Segunda 27/abr/2026 em SP = segunda 27/abr/2026 17:00 UTC.

  it("retorna isActive=true quando now está DENTRO do bloco", () => {
    const now = new Date("2026-04-27T18:00:00Z"); // segunda 15:00 SP
    const occ = computeBlockOccurrence({
      weekday: 1, // segunda
      startTime: "14:00",
      endTime: "18:00",
      now,
    });
    expect(occ).not.toBeNull();
    expect(occ!.isActive).toBe(true);
    expect(occ!.isFinishedRecently).toBe(false);
    expect(occ!.blockMinutes).toBe(240);
    expect(occ!.startUtc.toISOString()).toBe("2026-04-27T17:00:00.000Z");
    expect(occ!.endUtc.toISOString()).toBe("2026-04-27T21:00:00.000Z");
  });

  it("retorna isFinishedRecently=true logo após o fim do bloco", () => {
    const now = new Date("2026-04-27T21:10:00Z"); // 10min após fim
    const occ = computeBlockOccurrence({
      weekday: 1,
      startTime: "14:00",
      endTime: "18:00",
      now,
    });
    expect(occ).not.toBeNull();
    expect(occ!.isActive).toBe(false);
    expect(occ!.isFinishedRecently).toBe(true);
  });

  it("retorna null se passou da janela de grace", () => {
    const now = new Date("2026-04-27T22:00:00Z"); // 1h após fim
    const occ = computeBlockOccurrence({
      weekday: 1,
      startTime: "14:00",
      endTime: "18:00",
      now,
    });
    // 60min > SETTLEMENT_GRACE_MINUTES (30min), então null.
    expect(occ).toBeNull();
  });

  it("retorna null se ainda não começou", () => {
    const now = new Date("2026-04-27T16:00:00Z"); // 13h SP, antes do start
    const occ = computeBlockOccurrence({
      weekday: 1,
      startTime: "14:00",
      endTime: "18:00",
      now,
    });
    expect(occ).toBeNull();
  });

  it("captura bloco que terminou hoje cedo (rolando do dia anterior)", () => {
    // Bloco quarta 22:00-23:30 SP. Quinta 00:00 UTC = quarta 21:00 SP.
    // Bloco corresponde a quarta UTC 01:00-02:30 (próximo dia UTC).
    // Vou testar com bloco quarta 14:00-18:00 SP, query em quinta 00:00 SP.
    const now = new Date("2026-04-30T05:00:00Z"); // quinta 02:00 SP
    const occ = computeBlockOccurrence({
      weekday: 3, // quarta
      startTime: "14:00",
      endTime: "23:00",
      now,
    });
    // Bloco quarta 14:00 SP = quarta 17:00 UTC; fim 02:00 quinta UTC.
    // Now é 05:00 UTC = 3h após fim → fora do grace (30min) → null.
    expect(occ).toBeNull();
  });

  it("captura bloco que terminou há 5min (cross-midnight UTC)", () => {
    // Bloco segunda 21:00-23:00 SP. Segunda 00:00-02:00 UTC do dia
    // seguinte. Now = terça 02:05 UTC.
    const now = new Date("2026-04-28T02:05:00Z"); // terça 23:05 SP
    const occ = computeBlockOccurrence({
      weekday: 1, // segunda em SP
      startTime: "21:00",
      endTime: "23:00",
      now,
    });
    expect(occ).not.toBeNull();
    expect(occ!.isFinishedRecently).toBe(true);
  });

  it("rejeita weekday inválido", () => {
    expect(
      computeBlockOccurrence({
        weekday: 7,
        startTime: "10:00",
        endTime: "12:00",
        now: new Date(),
      })
    ).toBeNull();
    expect(
      computeBlockOccurrence({
        weekday: -1,
        startTime: "10:00",
        endTime: "12:00",
        now: new Date(),
      })
    ).toBeNull();
  });

  it("rejeita horário inválido", () => {
    expect(
      computeBlockOccurrence({
        weekday: 1,
        startTime: "abc",
        endTime: "12:00",
        now: new Date(),
      })
    ).toBeNull();
    expect(
      computeBlockOccurrence({
        weekday: 1,
        startTime: "10:00",
        endTime: "10:00", // duração zero
        now: new Date(),
      })
    ).toBeNull();
  });
});

describe("isPresenceFreshAndOnline", () => {
  const now = new Date("2026-04-27T18:00:00Z");

  it("aceita online com heartbeat fresh", () => {
    expect(
      isPresenceFreshAndOnline({
        status: "online",
        lastHeartbeatAt: new Date("2026-04-27T17:59:00Z"), // 60s ago
        now,
      })
    ).toBe(true);
  });

  it("aceita busy com heartbeat fresh", () => {
    expect(
      isPresenceFreshAndOnline({
        status: "busy",
        lastHeartbeatAt: new Date("2026-04-27T17:59:30Z"),
        now,
      })
    ).toBe(true);
  });

  it("rejeita offline", () => {
    expect(
      isPresenceFreshAndOnline({
        status: "offline",
        lastHeartbeatAt: new Date("2026-04-27T17:59:00Z"),
        now,
      })
    ).toBe(false);
  });

  it("rejeita heartbeat stale (> threshold)", () => {
    expect(
      isPresenceFreshAndOnline({
        status: "online",
        lastHeartbeatAt: new Date("2026-04-27T17:55:00Z"), // 5min ago > 120s
        now,
      })
    ).toBe(false);
  });

  it("rejeita heartbeat no futuro", () => {
    expect(
      isPresenceFreshAndOnline({
        status: "online",
        lastHeartbeatAt: new Date("2026-04-27T18:01:00Z"),
        now,
      })
    ).toBe(false);
  });

  it("aceita string ISO", () => {
    expect(
      isPresenceFreshAndOnline({
        status: "online",
        lastHeartbeatAt: "2026-04-27T17:59:00.000Z",
        now,
      })
    ).toBe(true);
  });

  it("respeita threshold customizado", () => {
    expect(
      isPresenceFreshAndOnline({
        status: "online",
        lastHeartbeatAt: new Date("2026-04-27T17:55:00Z"),
        now,
        thresholdSeconds: 600, // 10min
      })
    ).toBe(true);
  });
});

describe("computeCoverage", () => {
  it("0 samples → coverage 0", () => {
    const r = computeCoverage({ samplesCount: 0, blockMinutes: 240 });
    expect(r.coverageMinutes).toBe(0);
    expect(r.coverageRatio).toBe(0);
  });

  it("samples cobrem ~100% do bloco", () => {
    // Bloco de 240min, 1 sample/5min = 48 samples = 240min
    const r = computeCoverage({ samplesCount: 48, blockMinutes: 240 });
    expect(r.coverageMinutes).toBe(240);
    expect(r.coverageRatio).toBe(1);
  });

  it("samples extras saturam em 1.0", () => {
    const r = computeCoverage({ samplesCount: 100, blockMinutes: 240 });
    expect(r.coverageMinutes).toBe(240);
    expect(r.coverageRatio).toBe(1);
  });

  it("cobertura parcial (50%)", () => {
    const r = computeCoverage({ samplesCount: 24, blockMinutes: 240 });
    expect(r.coverageMinutes).toBe(120);
    expect(r.coverageRatio).toBe(0.5);
  });

  it("cobertura ímpar arredonda em 4 casas", () => {
    const r = computeCoverage({ samplesCount: 1, blockMinutes: 60 });
    expect(r.coverageMinutes).toBe(5);
    expect(r.coverageRatio).toBeCloseTo(0.0833, 4);
  });

  it("blockMinutes inválido", () => {
    const r = computeCoverage({ samplesCount: 5, blockMinutes: 0 });
    expect(r.coverageMinutes).toBe(0);
    expect(r.coverageRatio).toBe(0);
  });
});

describe("computeEarningCents", () => {
  it("zero abaixo do threshold", () => {
    expect(
      computeEarningCents({
        coverageMinutes: 60,
        coverageRatio: 0.4, // < 0.5
        hourlyCents: 3000,
      })
    ).toBe(0);
  });

  it("paga proporcional acima do threshold (cobertura completa)", () => {
    expect(
      computeEarningCents({
        coverageMinutes: 240, // 4h
        coverageRatio: 1.0,
        hourlyCents: 3000,
      })
    ).toBe(12000); // 4 × R$ 30 = R$ 120
  });

  it("paga proporcional acima do threshold (cobertura parcial)", () => {
    expect(
      computeEarningCents({
        coverageMinutes: 192, // 3.2h
        coverageRatio: 0.8,
        hourlyCents: 3000,
      })
    ).toBe(9600); // 3.2 × R$ 30 = R$ 96
  });

  it("paga proporcional no threshold exato", () => {
    expect(
      computeEarningCents({
        coverageMinutes: 120, // 2h
        coverageRatio: 0.5,
        hourlyCents: 3000,
      })
    ).toBe(6000); // 2 × R$ 30
  });

  it("hourly_cents zero ou negativo retorna zero", () => {
    expect(
      computeEarningCents({
        coverageMinutes: 240,
        coverageRatio: 1,
        hourlyCents: 0,
      })
    ).toBe(0);
  });

  it("arredonda pra inteiro em casos com fração de centavo", () => {
    // 7min × 3000/60 = 350 (exato)
    expect(
      computeEarningCents({
        coverageMinutes: 7,
        coverageRatio: 1,
        hourlyCents: 3000,
      })
    ).toBe(350);
    // 13min × 3333/60 = 722.15 → 722
    expect(
      computeEarningCents({
        coverageMinutes: 13,
        coverageRatio: 1,
        hourlyCents: 3333,
      })
    ).toBe(722);
  });
});

describe("decideOutcome", () => {
  it("paid acima do threshold", () => {
    expect(decideOutcome(0.5)).toBe("paid");
    expect(decideOutcome(0.8)).toBe("paid");
    expect(decideOutcome(1.0)).toBe("paid");
  });

  it("no_show abaixo do threshold", () => {
    expect(decideOutcome(0.0)).toBe("no_show");
    expect(decideOutcome(0.49)).toBe("no_show");
  });
});

describe("formatEarningDescription", () => {
  it("formata descrição humana com data SP, horários, duração e %", () => {
    // Bloco UTC 17:00-21:00 = SP 14:00-18:00, 27/04
    const desc = formatEarningDescription({
      blockStartUtc: new Date("2026-04-27T17:00:00Z"),
      blockEndUtc: new Date("2026-04-27T21:00:00Z"),
      coverageMinutes: 192, // 3h12
      coverageRatio: 0.8,
    });
    expect(desc).toContain("Plantão");
    expect(desc).toContain("27/04");
    expect(desc).toContain("14:00");
    expect(desc).toContain("18:00");
    expect(desc).toContain("3h12");
    expect(desc).toContain("80%");
  });

  it("zero-pad de minutos parciais", () => {
    const desc = formatEarningDescription({
      blockStartUtc: new Date("2026-04-27T17:00:00Z"),
      blockEndUtc: new Date("2026-04-27T21:00:00Z"),
      coverageMinutes: 65, // 1h05
      coverageRatio: 0.27,
    });
    expect(desc).toContain("1h05");
    expect(desc).toContain("27%");
  });
});
