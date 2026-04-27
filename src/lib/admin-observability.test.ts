/**
 * Testes de admin-observability — PR-082 · D-094.
 *
 * Foco em funções puras (computePercentiles, computeMatchRate,
 * bucketCoverage, buildCoverageHistogram, computeDurationSeconds,
 * resolveWindowRange, resolveDoctorDisplayName, aggregateOnDemandStats,
 * aggregateFanOutStats, aggregateOnCallStats, formatDurationHuman,
 * formatPctFromRatio, formatCentsBR). I/O (loadObservabilityReport)
 * fica coberto em smoke E2E.
 */

import { describe, expect, it } from "vitest";
import {
  aggregateFanOutStats,
  aggregateOnCallStats,
  aggregateOnDemandStats,
  bucketCoverage,
  buildCoverageHistogram,
  computeDurationSeconds,
  computeMatchRate,
  computePercentiles,
  COVERAGE_BUCKETS,
  DEFAULT_OBSERVABILITY_WINDOW,
  formatCentsBR,
  formatDurationHuman,
  formatPctFromRatio,
  OBSERVABILITY_WINDOW_HOURS,
  OBSERVABILITY_WINDOWS,
  resolveDoctorDisplayName,
  resolveWindowRange,
  type DispatchRowForStats,
  type DoctorRowForStats,
  type OnDemandRequestRowForStats,
  type SettlementRowForStats,
} from "./admin-observability";

describe("constantes", () => {
  it("janelas em ordem crescente (24h → 90d)", () => {
    expect(OBSERVABILITY_WINDOWS).toEqual(["24h", "7d", "30d", "90d"]);
    let prev = 0;
    for (const w of OBSERVABILITY_WINDOWS) {
      const h = OBSERVABILITY_WINDOW_HOURS[w];
      expect(h).toBeGreaterThan(prev);
      prev = h;
    }
  });

  it("DEFAULT_OBSERVABILITY_WINDOW é uma das janelas", () => {
    expect(OBSERVABILITY_WINDOWS).toContain(DEFAULT_OBSERVABILITY_WINDOW);
  });

  it("coverage buckets são contíguos cobrindo [0, 1]", () => {
    expect(COVERAGE_BUCKETS[0]?.min).toBe(0);
    expect(COVERAGE_BUCKETS[COVERAGE_BUCKETS.length - 1]?.max).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < COVERAGE_BUCKETS.length; i += 1) {
      expect(COVERAGE_BUCKETS[i]?.min).toBe(COVERAGE_BUCKETS[i - 1]?.max);
    }
  });
});

describe("computePercentiles", () => {
  it("vazio → count 0 + nulls", () => {
    const r = computePercentiles([]);
    expect(r.count).toBe(0);
    expect(r.p50).toBeNull();
    expect(r.p95).toBeNull();
    expect(r.avg).toBeNull();
    expect(r.min).toBeNull();
    expect(r.max).toBeNull();
  });

  it("filtra NaN/Infinity/negativos", () => {
    const r = computePercentiles([1, 2, NaN, Infinity, -5, 3]);
    expect(r.count).toBe(3);
    expect(r.min).toBe(1);
    expect(r.max).toBe(3);
  });

  it("p50 mediana clássica em conjunto pequeno", () => {
    const r = computePercentiles([10, 20, 30, 40, 50]);
    expect(r.p50).toBe(30);
    expect(r.avg).toBe(30);
    expect(r.min).toBe(10);
    expect(r.max).toBe(50);
  });

  it("p95 nearest-rank em 100 valores", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    const r = computePercentiles(values);
    expect(r.p50).toBe(50);
    expect(r.p95).toBe(95);
    expect(r.p99).toBe(99);
    expect(r.max).toBe(100);
  });

  it("count=1 retorna o próprio valor pra todos os percentis", () => {
    const r = computePercentiles([42]);
    expect(r.count).toBe(1);
    expect(r.p50).toBe(42);
    expect(r.p95).toBe(42);
    expect(r.avg).toBe(42);
  });

  it("arredonda pra inteiro", () => {
    const r = computePercentiles([1.4, 2.6, 3.5]);
    expect(r.avg).toBe(3); // (1.4+2.6+3.5)/3 = 2.5 → arredondado
    expect(r.p50).toBe(3); // sorted: [1.4, 2.6, 3.5], rank ceil(0.5*3)=2 → 2.6 → 3
  });

  it("não muta input", () => {
    const orig = [3, 1, 2];
    const copy = [...orig];
    computePercentiles(orig);
    expect(orig).toEqual(copy);
  });
});

describe("computeMatchRate", () => {
  it("denominador zero → null", () => {
    expect(computeMatchRate({ accepted: 0, cancelled: 0, expired: 0 })).toBeNull();
  });

  it("100% match", () => {
    expect(computeMatchRate({ accepted: 10, cancelled: 0, expired: 0 })).toBe(1);
  });

  it("0% match (todos abandonados)", () => {
    expect(computeMatchRate({ accepted: 0, cancelled: 5, expired: 5 })).toBe(0);
  });

  it("50% match", () => {
    expect(computeMatchRate({ accepted: 5, cancelled: 3, expired: 2 })).toBe(0.5);
  });

  it("ignora pending no denominador (não é param)", () => {
    // Função só recebe accepted/cancelled/expired → comportamento garantido.
    expect(computeMatchRate({ accepted: 1, cancelled: 1, expired: 0 })).toBe(0.5);
  });
});

describe("bucketCoverage", () => {
  it("0 vai pro primeiro bucket (0-25%)", () => {
    expect(bucketCoverage(0)).toBe("0-25%");
  });

  it("0.5 vai pro bucket 50-75%", () => {
    expect(bucketCoverage(0.5)).toBe("50-75%");
  });

  it("1.0 vai pro bucket 75-100% (inclusivo)", () => {
    expect(bucketCoverage(1.0)).toBe("75-100%");
  });

  it("clampa valor fora de [0, 1]", () => {
    expect(bucketCoverage(-0.5)).toBe("0-25%");
    expect(bucketCoverage(2)).toBe("75-100%");
  });

  it("NaN vai pro primeiro bucket", () => {
    expect(bucketCoverage(NaN)).toBe("0-25%");
  });

  it("fronteiras exatas (0.25, 0.75)", () => {
    expect(bucketCoverage(0.25)).toBe("25-50%");
    expect(bucketCoverage(0.75)).toBe("75-100%");
  });
});

describe("buildCoverageHistogram", () => {
  it("vazio → 4 buckets com 0 e 0%", () => {
    const h = buildCoverageHistogram([]);
    expect(h).toHaveLength(4);
    for (const b of h) {
      expect(b.count).toBe(0);
      expect(b.pct).toBe(0);
    }
  });

  it("distribui corretamente em buckets + pct soma ~1", () => {
    const ratios = [0.1, 0.2, 0.4, 0.55, 0.6, 0.8, 0.9, 1.0];
    const h = buildCoverageHistogram(ratios);
    const sumPct = h.reduce((s, b) => s + b.pct, 0);
    expect(sumPct).toBeCloseTo(1, 6);
    const sumCount = h.reduce((s, b) => s + b.count, 0);
    expect(sumCount).toBe(8);
  });

  it("preserva ordem dos buckets", () => {
    const h = buildCoverageHistogram([0.1, 0.6]);
    expect(h.map((b) => b.label)).toEqual(["0-25%", "25-50%", "50-75%", "75-100%"]);
  });
});

describe("computeDurationSeconds", () => {
  it("aceita ISO strings", () => {
    expect(
      computeDurationSeconds({
        startIso: "2026-04-27T15:00:00Z",
        endIso: "2026-04-27T15:05:00Z",
      })
    ).toBe(300);
  });

  it("null em qualquer input vazio", () => {
    expect(
      computeDurationSeconds({ startIso: null, endIso: "2026-04-27T15:00:00Z" })
    ).toBeNull();
    expect(
      computeDurationSeconds({ startIso: "2026-04-27T15:00:00Z", endIso: undefined })
    ).toBeNull();
  });

  it("null em ISO inválido", () => {
    expect(
      computeDurationSeconds({ startIso: "abc", endIso: "2026-04-27T15:00:00Z" })
    ).toBeNull();
  });

  it("null em duração negativa (end antes de start)", () => {
    expect(
      computeDurationSeconds({
        startIso: "2026-04-27T15:05:00Z",
        endIso: "2026-04-27T15:00:00Z",
      })
    ).toBeNull();
  });

  it("aceita segundos fracionários", () => {
    const r = computeDurationSeconds({
      startIso: "2026-04-27T15:00:00.000Z",
      endIso: "2026-04-27T15:00:00.500Z",
    });
    expect(r).toBe(0.5);
  });
});

describe("resolveWindowRange", () => {
  it("calcula since corretamente", () => {
    const now = new Date("2026-04-27T15:00:00Z");
    const r = resolveWindowRange({ windowHours: 24, now });
    expect(r.untilIso).toBe("2026-04-27T15:00:00.000Z");
    expect(r.sinceIso).toBe("2026-04-26T15:00:00.000Z");
  });

  it("usa now() default se não passado", () => {
    const r = resolveWindowRange({ windowHours: 1 });
    const since = new Date(r.sinceIso);
    const until = new Date(r.untilIso);
    expect(until.getTime() - since.getTime()).toBe(60 * 60 * 1000);
  });
});

describe("resolveDoctorDisplayName", () => {
  it("usa display_name se preenchido", () => {
    expect(
      resolveDoctorDisplayName({ display_name: "Dra. Joana", full_name: "Joana Silva" })
    ).toBe("Dra. Joana");
  });

  it("fallback pra full_name se display_name vazio", () => {
    expect(
      resolveDoctorDisplayName({ display_name: "", full_name: "Joana Silva" })
    ).toBe("Joana Silva");
    expect(
      resolveDoctorDisplayName({ display_name: null, full_name: "Joana Silva" })
    ).toBe("Joana Silva");
  });

  it("fallback final pra 'Médica' se ambos vazios", () => {
    expect(resolveDoctorDisplayName({ display_name: null, full_name: null })).toBe("Médica");
    expect(resolveDoctorDisplayName({ display_name: "  ", full_name: "" })).toBe("Médica");
  });
});

describe("aggregateOnDemandStats", () => {
  const now = new Date("2026-04-27T15:00:00Z");

  it("conjunto vazio retorna estrutura sã", () => {
    const r = aggregateOnDemandStats({ rows: [], windowHours: 24, now });
    expect(r.total).toBe(0);
    expect(r.byOutcome.accepted).toBe(0);
    expect(r.matchRate).toBeNull();
    expect(r.timeToMatch.count).toBe(0);
    expect(r.pendingNow.count).toBe(0);
    expect(r.pendingNow.oldestAgeSeconds).toBeNull();
  });

  it("calcula TTM somente pra accepted", () => {
    const rows: OnDemandRequestRowForStats[] = [
      {
        id: "r1",
        status: "accepted",
        created_at: "2026-04-27T14:50:00Z",
        accepted_at: "2026-04-27T14:51:00Z", // 60s
        cancelled_at: null,
        expires_at: "2026-04-27T14:55:00Z",
        updated_at: "2026-04-27T14:51:00Z",
      },
      {
        id: "r2",
        status: "accepted",
        created_at: "2026-04-27T14:40:00Z",
        accepted_at: "2026-04-27T14:42:00Z", // 120s
        cancelled_at: null,
        expires_at: "2026-04-27T14:45:00Z",
        updated_at: "2026-04-27T14:42:00Z",
      },
    ];
    const r = aggregateOnDemandStats({ rows, windowHours: 24, now });
    expect(r.byOutcome.accepted).toBe(2);
    expect(r.matchRate).toBe(1);
    expect(r.timeToMatch.count).toBe(2);
    expect(r.timeToMatch.min).toBe(60);
    expect(r.timeToMatch.max).toBe(120);
  });

  it("calcula timeToAbandon pra cancelled e expired", () => {
    const rows: OnDemandRequestRowForStats[] = [
      {
        id: "c1",
        status: "cancelled",
        created_at: "2026-04-27T14:50:00Z",
        accepted_at: null,
        cancelled_at: "2026-04-27T14:52:00Z", // 120s
        expires_at: "2026-04-27T14:55:00Z",
        updated_at: "2026-04-27T14:52:00Z",
      },
      {
        id: "e1",
        status: "expired",
        created_at: "2026-04-27T14:50:00Z",
        accepted_at: null,
        cancelled_at: null,
        expires_at: "2026-04-27T14:55:00Z", // 300s
        updated_at: "2026-04-27T14:55:00Z",
      },
    ];
    const r = aggregateOnDemandStats({ rows, windowHours: 24, now });
    expect(r.timeToAbandon.count).toBe(2);
    expect(r.timeToAbandon.min).toBe(120);
    expect(r.timeToAbandon.max).toBe(300);
    expect(r.matchRate).toBe(0);
  });

  it("pendingNow calcula oldest age", () => {
    const rows: OnDemandRequestRowForStats[] = [
      {
        id: "p1",
        status: "pending",
        created_at: "2026-04-27T14:55:00Z", // 5min ago
        accepted_at: null,
        cancelled_at: null,
        expires_at: "2026-04-27T15:00:00Z",
        updated_at: "2026-04-27T14:55:00Z",
      },
      {
        id: "p2",
        status: "pending",
        created_at: "2026-04-27T14:50:00Z", // 10min ago — mais antigo
        accepted_at: null,
        cancelled_at: null,
        expires_at: "2026-04-27T14:55:00Z",
        updated_at: "2026-04-27T14:50:00Z",
      },
    ];
    const r = aggregateOnDemandStats({ rows, windowHours: 24, now });
    expect(r.pendingNow.count).toBe(2);
    expect(r.pendingNow.oldestAgeSeconds).toBe(600); // 10min
  });
});

describe("aggregateFanOutStats", () => {
  it("vazio retorna estrutura sã", () => {
    const r = aggregateFanOutStats({
      dispatches: [],
      requestsTotal: 0,
      windowHours: 24,
    });
    expect(r.totalDispatched).toBe(0);
    expect(r.uniqueDoctorsReached).toBe(0);
    expect(r.requestsWithFanOut).toBe(0);
    expect(r.avgDispatchesPerRequest).toBeNull();
    expect(r.requestsWithZeroOnline).toBe(0);
    expect(r.zeroOnlineRate).toBeNull();
  });

  it("conta dispatches sent + únicos + zero online", () => {
    const dispatches: DispatchRowForStats[] = [
      { request_id: "r1", doctor_id: "d1", dispatch_status: "sent", doctor_was_online: true },
      { request_id: "r1", doctor_id: "d2", dispatch_status: "sent", doctor_was_online: true },
      { request_id: "r1", doctor_id: "d3", dispatch_status: "failed", doctor_was_online: true },
      { request_id: "r2", doctor_id: "d1", dispatch_status: "sent", doctor_was_online: true },
    ];
    const r = aggregateFanOutStats({
      dispatches,
      requestsTotal: 5, // 3 não tiveram fan-out
      windowHours: 24,
    });
    expect(r.totalDispatched).toBe(3); // 2 em r1 + 1 em r2 (failed exclui)
    expect(r.uniqueDoctorsReached).toBe(2); // d1, d2
    expect(r.requestsWithFanOut).toBe(2); // r1, r2
    expect(r.avgDispatchesPerRequest).toBe(1.5); // 3/2
    expect(r.requestsWithZeroOnline).toBe(3); // 5 - 2
    expect(r.zeroOnlineRate).toBe(3 / 5);
  });

  it("requestsTotal=0 → zeroOnlineRate null", () => {
    const r = aggregateFanOutStats({
      dispatches: [],
      requestsTotal: 0,
      windowHours: 24,
    });
    expect(r.zeroOnlineRate).toBeNull();
  });
});

describe("aggregateOnCallStats", () => {
  const doctors: DoctorRowForStats[] = [
    { id: "d1", full_name: "Dra. Ana", display_name: "Dra. Ana" },
    { id: "d2", full_name: "Dra. Bia", display_name: null },
  ];

  it("vazio retorna estrutura sã", () => {
    const r = aggregateOnCallStats({
      settlements: [],
      doctors,
      windowHours: 24 * 7,
    });
    expect(r.total).toBe(0);
    expect(r.fulfillRate).toBeNull();
    expect(r.totalPaidCents).toBe(0);
    expect(r.coverage.count).toBe(0);
    expect(r.histogram).toHaveLength(4);
    expect(r.byDoctor).toEqual([]);
  });

  it("agrega outcomes, valores e histograma", () => {
    const settlements: SettlementRowForStats[] = [
      {
        doctor_id: "d1",
        outcome: "paid",
        coverage_ratio: 0.9,
        coverage_minutes: 216,
        amount_cents_snapshot: 10800,
      },
      {
        doctor_id: "d1",
        outcome: "paid",
        coverage_ratio: 1.0,
        coverage_minutes: 240,
        amount_cents_snapshot: 12000,
      },
      {
        doctor_id: "d2",
        outcome: "no_show",
        coverage_ratio: 0.2,
        coverage_minutes: 48,
        amount_cents_snapshot: null,
      },
    ];
    const r = aggregateOnCallStats({
      settlements,
      doctors,
      windowHours: 24 * 7,
    });
    expect(r.total).toBe(3);
    expect(r.byOutcome.paid).toBe(2);
    expect(r.byOutcome.noShow).toBe(1);
    expect(r.fulfillRate).toBeCloseTo(2 / 3, 6);
    expect(r.totalPaidCents).toBe(22800);
    expect(r.totalCoverageMinutes).toBe(504);
    expect(r.coverage.count).toBe(3);
    // Min=20%, max=100%
    expect(r.coverage.min).toBe(20);
    expect(r.coverage.max).toBe(100);

    // Histograma: 1 em 0-25 (0.2), 0 em 25-50, 0 em 50-75, 2 em 75-100
    const histMap = new Map(r.histogram.map((h) => [h.label, h.count]));
    expect(histMap.get("0-25%")).toBe(1);
    expect(histMap.get("25-50%")).toBe(0);
    expect(histMap.get("50-75%")).toBe(0);
    expect(histMap.get("75-100%")).toBe(2);

    // byDoctor ordenado por totalCents desc
    expect(r.byDoctor).toHaveLength(2);
    expect(r.byDoctor[0]?.doctorId).toBe("d1");
    expect(r.byDoctor[0]?.paid).toBe(2);
    expect(r.byDoctor[0]?.noShow).toBe(0);
    expect(r.byDoctor[0]?.totalCents).toBe(22800);
    expect(r.byDoctor[0]?.fulfillRate).toBe(1);
    expect(r.byDoctor[1]?.doctorId).toBe("d2");
    expect(r.byDoctor[1]?.fulfillRate).toBe(0);
  });

  it("usa fallback de display_name quando médica órfã", () => {
    const settlements: SettlementRowForStats[] = [
      {
        doctor_id: "d-unknown",
        outcome: "paid",
        coverage_ratio: 0.8,
        coverage_minutes: 192,
        amount_cents_snapshot: 9600,
      },
    ];
    const r = aggregateOnCallStats({ settlements, doctors, windowHours: 24 * 7 });
    expect(r.byDoctor[0]?.doctorName).toBe("Médica");
  });
});

describe("formatDurationHuman", () => {
  it("null/inválido → —", () => {
    expect(formatDurationHuman(null)).toBe("—");
    expect(formatDurationHuman(NaN)).toBe("—");
    expect(formatDurationHuman(-5)).toBe("—");
  });

  it("< 60s → Xs", () => {
    expect(formatDurationHuman(0)).toBe("0s");
    expect(formatDurationHuman(45)).toBe("45s");
  });

  it("60s-1h → Xm Ys", () => {
    expect(formatDurationHuman(60)).toBe("1m");
    expect(formatDurationHuman(125)).toBe("2m 5s");
    expect(formatDurationHuman(3540)).toBe("59m");
  });

  it("≥ 1h → Xh YmYs", () => {
    expect(formatDurationHuman(3600)).toBe("1h");
    expect(formatDurationHuman(3725)).toBe("1h 2m");
    expect(formatDurationHuman(7200)).toBe("2h");
  });
});

describe("formatPctFromRatio", () => {
  it("null/NaN → —", () => {
    expect(formatPctFromRatio(null)).toBe("—");
    expect(formatPctFromRatio(NaN)).toBe("—");
  });

  it("formata com 1 casa decimal", () => {
    expect(formatPctFromRatio(0)).toBe("0.0%");
    expect(formatPctFromRatio(0.5)).toBe("50.0%");
    expect(formatPctFromRatio(0.987)).toBe("98.7%");
    expect(formatPctFromRatio(1)).toBe("100.0%");
  });
});

describe("formatCentsBR", () => {
  it("null/NaN → —", () => {
    expect(formatCentsBR(null)).toBe("—");
    expect(formatCentsBR(undefined)).toBe("—");
    expect(formatCentsBR(NaN)).toBe("—");
  });

  it("formata em R$ com vírgula decimal", () => {
    expect(formatCentsBR(0)).toBe("R$ 0,00");
    expect(formatCentsBR(100)).toBe("R$ 1,00");
    expect(formatCentsBR(12345)).toBe("R$ 123,45");
    expect(formatCentsBR(-500)).toBe("R$ -5,00");
  });
});
