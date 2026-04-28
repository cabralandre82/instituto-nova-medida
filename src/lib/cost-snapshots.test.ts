/**
 * Unit tests para os helpers puros de cost-snapshots — PR-045 · D-096.
 *
 * Foco: estimativas (Asaas, WhatsApp, Daily), formatação BRL,
 * helpers de data/mês, e detector de anomalia. As funções IO-bound
 * (computeDailySnapshot, upsertSnapshots, loadCostDashboard) ficam
 * cobertas pelos integration tests via `/admin/custos` em produção
 * (smoke) — unit aqui é o que IA pode acertar 100%.
 */

import { describe, it, expect } from "vitest";
import {
  centsToBRL,
  utcDateStringOf,
  utcMonthStringOf,
  dateRangeForUtcDay,
  daysInUtcMonth,
  previousMonth,
  monthRangeUtc,
  dailyShareOfMonthly,
  estimateAsaasCostCents,
  estimateWaCostCents,
  estimateDailyCostCents,
  detectCostAnomaly,
} from "./cost-snapshots";

describe("centsToBRL", () => {
  it("formata zero", () => {
    expect(centsToBRL(0)).toBe("R$ 0,00");
  });

  it("formata centavos pequenos", () => {
    expect(centsToBRL(1)).toBe("R$ 0,01");
    expect(centsToBRL(99)).toBe("R$ 0,99");
  });

  it("formata reais com separador de milhar", () => {
    expect(centsToBRL(123456)).toBe("R$ 1.234,56");
  });

  it("formata negativo (delta)", () => {
    expect(centsToBRL(-5000)).toContain("50,00");
  });

  it("formata NaN/Infinity como placeholder", () => {
    expect(centsToBRL(Number.NaN)).toBe("R$ —");
    expect(centsToBRL(Number.POSITIVE_INFINITY)).toBe("R$ —");
  });
});

describe("utcDateStringOf / utcMonthStringOf", () => {
  it("usa UTC, não timezone do servidor", () => {
    expect(utcDateStringOf("2026-04-20T23:30:00.000Z")).toBe("2026-04-20");
    expect(utcDateStringOf("2026-04-20T00:00:00.000Z")).toBe("2026-04-20");
  });

  it("month string 7 chars", () => {
    expect(utcMonthStringOf("2026-04-20T12:00:00.000Z")).toBe("2026-04");
  });

  it("aceita Date", () => {
    expect(utcDateStringOf(new Date("2026-12-31T23:59:59.999Z"))).toBe(
      "2026-12-31"
    );
  });

  it("rejeita data inválida", () => {
    expect(() => utcDateStringOf("not-a-date")).toThrow(/invalid/i);
  });
});

describe("dateRangeForUtcDay", () => {
  it("[T00, T+24)", () => {
    const r = dateRangeForUtcDay("2026-04-20");
    expect(r.fromIso).toBe("2026-04-20T00:00:00.000Z");
    expect(r.toIso).toBe("2026-04-21T00:00:00.000Z");
  });

  it("rejeita formato inválido", () => {
    expect(() => dateRangeForUtcDay("2026/04/20")).toThrow(/format/i);
    expect(() => dateRangeForUtcDay("20-04-2026")).toThrow(/format/i);
  });
});

describe("daysInUtcMonth", () => {
  it("janeiro=31", () => {
    expect(daysInUtcMonth(2026, 1)).toBe(31);
  });
  it("fevereiro não-bissexto=28", () => {
    expect(daysInUtcMonth(2026, 2)).toBe(28);
  });
  it("fevereiro bissexto=29", () => {
    expect(daysInUtcMonth(2024, 2)).toBe(29);
    expect(daysInUtcMonth(2000, 2)).toBe(29); // múltiplo de 400
    expect(daysInUtcMonth(1900, 2)).toBe(28); // múltiplo de 100, não 400
  });
  it("abril=30", () => {
    expect(daysInUtcMonth(2026, 4)).toBe(30);
  });
  it("rejeita mês inválido", () => {
    expect(() => daysInUtcMonth(2026, 0)).toThrow(/invalid/i);
    expect(() => daysInUtcMonth(2026, 13)).toThrow(/invalid/i);
  });
});

describe("previousMonth", () => {
  it("desconta 1 mês no mesmo ano", () => {
    expect(previousMonth(2026, 4)).toEqual({ year: 2026, month: 3 });
  });
  it("ano anterior em janeiro", () => {
    expect(previousMonth(2026, 1)).toEqual({ year: 2025, month: 12 });
  });
  it("rejeita mês inválido", () => {
    expect(() => previousMonth(2026, 13)).toThrow(/invalid/i);
  });
});

describe("monthRangeUtc", () => {
  it("range típico abril 2026", () => {
    expect(monthRangeUtc(2026, 4)).toEqual({
      fromDate: "2026-04-01",
      toDate: "2026-05-01",
    });
  });
  it("transição dezembro -> janeiro", () => {
    expect(monthRangeUtc(2026, 12)).toEqual({
      fromDate: "2026-12-01",
      toDate: "2027-01-01",
    });
  });
});

describe("dailyShareOfMonthly", () => {
  it("rateio com round", () => {
    expect(dailyShareOfMonthly(10000, "2026-04-15")).toBe(
      Math.round(10000 / 30)
    );
  });
  it("zero quando custo zero", () => {
    expect(dailyShareOfMonthly(0, "2026-04-15")).toBe(0);
  });
  it("rejeita data malformada", () => {
    expect(() => dailyShareOfMonthly(10000, "abril")).toThrow(/invalid/i);
  });
  it("fevereiro não-bissexto rateia por 28", () => {
    expect(dailyShareOfMonthly(280, "2026-02-15")).toBe(10);
  });
});

describe("estimateAsaasCostCents", () => {
  const rates = { asaas_fee_fixed_cents: 99, asaas_fee_pct_bps: 250 };

  it("zero transações = zero custo", () => {
    const r = estimateAsaasCostCents({
      transactions: 0,
      grossCents: 0,
      rates,
    });
    expect(r.totalCents).toBe(0);
    expect(r.breakdown.feeFixedCents).toBe(0);
    expect(r.breakdown.feePctCents).toBe(0);
  });

  it("1 transação R$ 100,00 = 99 fixo + 250 (2.5%) = 349", () => {
    const r = estimateAsaasCostCents({
      transactions: 1,
      grossCents: 10000,
      rates,
    });
    expect(r.breakdown.feeFixedCents).toBe(99);
    expect(r.breakdown.feePctCents).toBe(250);
    expect(r.totalCents).toBe(349);
  });

  it("10 transações, R$ 1.000 cada = 990 fixo + 2500 = 3490 cents", () => {
    const r = estimateAsaasCostCents({
      transactions: 10,
      grossCents: 100000,
      rates,
    });
    expect(r.breakdown.feeFixedCents).toBe(990);
    expect(r.breakdown.feePctCents).toBe(2500);
    expect(r.totalCents).toBe(3490);
  });

  it("normaliza inputs negativos a zero (defensivo)", () => {
    const r = estimateAsaasCostCents({
      transactions: -5,
      grossCents: -100,
      rates,
    });
    expect(r.totalCents).toBe(0);
    expect(r.breakdown.transactions).toBe(0);
    expect(r.breakdown.grossCents).toBe(0);
  });

  it("aceita rate zerada (provider em teste)", () => {
    const r = estimateAsaasCostCents({
      transactions: 100,
      grossCents: 1000000,
      rates: { asaas_fee_fixed_cents: 0, asaas_fee_pct_bps: 0 },
    });
    expect(r.totalCents).toBe(0);
  });
});

describe("estimateWaCostCents", () => {
  const rates = { wa_cents_per_message: 10 };

  it("soma 3 fontes × rate", () => {
    const r = estimateWaCostCents({
      appointment_msgs: 5,
      doctor_msgs: 3,
      on_demand_msgs: 2,
      rates,
    });
    expect(r.breakdown.total_msgs).toBe(10);
    expect(r.totalCents).toBe(100);
  });

  it("zero msgs", () => {
    const r = estimateWaCostCents({
      appointment_msgs: 0,
      doctor_msgs: 0,
      on_demand_msgs: 0,
      rates,
    });
    expect(r.totalCents).toBe(0);
  });

  it("normaliza negativos", () => {
    const r = estimateWaCostCents({
      appointment_msgs: -5,
      doctor_msgs: 10,
      on_demand_msgs: -1,
      rates,
    });
    expect(r.breakdown.total_msgs).toBe(10);
  });
});

describe("estimateDailyCostCents", () => {
  const rates = { daily_cents_per_minute: 4 };

  it("zero rooms = zero custo", () => {
    const r = estimateDailyCostCents({
      rooms: 0,
      totalMinutes: 0,
      rates,
    });
    expect(r.totalCents).toBe(0);
    expect(r.breakdown.avgMinutesPerRoom).toBe(0);
  });

  it("10 consultas × 30min = 1200 cents (R$ 12)", () => {
    const r = estimateDailyCostCents({
      rooms: 10,
      totalMinutes: 300,
      rates,
    });
    expect(r.totalCents).toBe(1200);
    expect(r.breakdown.avgMinutesPerRoom).toBe(30);
  });

  it("avg arredonda corretamente", () => {
    const r = estimateDailyCostCents({
      rooms: 3,
      totalMinutes: 100, // avg 33.33
      rates,
    });
    expect(r.breakdown.avgMinutesPerRoom).toBe(33);
  });
});

describe("detectCostAnomaly", () => {
  it("não detecta quando série < windowDays + 1", () => {
    const r = detectCostAnomaly({
      series: [100, 100, 1000],
      windowDays: 7,
    });
    expect(r.isAnomaly).toBe(false);
  });

  it("detecta pico óbvio (10× baseline)", () => {
    const baseline = [100, 110, 105, 100, 95, 110, 100];
    const series = [...baseline, 1500];
    const r = detectCostAnomaly({ series, windowDays: 7 });
    expect(r.isAnomaly).toBe(true);
    expect(r.latestCents).toBe(1500);
    expect(r.baselineCents).toBeGreaterThan(0);
    expect(r.ratio).toBeGreaterThan(2);
  });

  it("não detecta quando latest está dentro do limite", () => {
    const series = [100, 110, 105, 100, 95, 110, 100, 180];
    const r = detectCostAnomaly({ series, windowDays: 7, factor: 2 });
    expect(r.isAnomaly).toBe(false);
  });

  it("não alerta quando latest é absoluto pequeno mesmo com ratio alto", () => {
    // baseline=0 ou ~zero, latest=50 cents → ratio explode mas valor
    // absoluto é insignificante.
    const series = [0, 0, 0, 0, 0, 0, 0, 50];
    const r = detectCostAnomaly({
      series,
      windowDays: 7,
      minCentsTrigger: 100,
    });
    expect(r.isAnomaly).toBe(false);
  });

  it("alerta quando baseline=0 mas latest grande", () => {
    const series = [0, 0, 0, 0, 0, 0, 0, 50000];
    const r = detectCostAnomaly({
      series,
      windowDays: 7,
      minCentsTrigger: 100,
    });
    expect(r.isAnomaly).toBe(true);
    expect(r.ratio).toBe(Number.POSITIVE_INFINITY);
  });

  it("respeita factor customizado", () => {
    const series = [100, 100, 100, 100, 100, 100, 100, 350];
    const lenient = detectCostAnomaly({ series, windowDays: 7, factor: 5 });
    const strict = detectCostAnomaly({ series, windowDays: 7, factor: 2 });
    expect(lenient.isAnomaly).toBe(false);
    expect(strict.isAnomaly).toBe(true);
  });

  it("ratio=1 quando estável", () => {
    const series = [100, 100, 100, 100, 100, 100, 100, 100];
    const r = detectCostAnomaly({ series, windowDays: 7 });
    expect(r.ratio).toBeCloseTo(1, 5);
    expect(r.isAnomaly).toBe(false);
  });

  it("trata série vazia", () => {
    const r = detectCostAnomaly({ series: [] });
    expect(r.isAnomaly).toBe(false);
    expect(r.latestCents).toBe(0);
    expect(r.baselineCents).toBe(0);
  });
});
