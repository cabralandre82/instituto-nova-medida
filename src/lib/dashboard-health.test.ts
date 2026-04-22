import { describe, expect, it } from "vitest";
import { evaluateUnknownSourceRatio } from "./dashboard-health";

describe("evaluateUnknownSourceRatio", () => {
  it("retorna alert=false para amostra vazia", () => {
    const r = evaluateUnknownSourceRatio({});
    expect(r).toEqual({ total: 0, unknown: 0, ratio: 0, alert: false });
  });

  it("retorna alert=false quando 100% conhecido", () => {
    const r = evaluateUnknownSourceRatio({
      daily_webhook: 30,
      daily_cron: 10,
    });
    expect(r.total).toBe(40);
    expect(r.unknown).toBe(0);
    expect(r.ratio).toBe(0);
    expect(r.alert).toBe(false);
  });

  it("não alerta abaixo de 20 reconciliações mesmo com unknown alto", () => {
    // 5/19 = 26% — passaria do threshold, mas amostra é volátil demais.
    const r = evaluateUnknownSourceRatio({
      daily_webhook: 14,
      unknown: 5,
    });
    expect(r.total).toBe(19);
    expect(r.alert).toBe(false);
  });

  it("alerta quando unknown > 5% e total ≥ 20", () => {
    // 2/20 = 10% > 5%
    const r = evaluateUnknownSourceRatio({
      daily_webhook: 18,
      unknown: 2,
    });
    expect(r.total).toBe(20);
    expect(r.unknown).toBe(2);
    expect(r.alert).toBe(true);
  });

  it("não alerta quando unknown <= 5%", () => {
    // 1/50 = 2%
    const r = evaluateUnknownSourceRatio({
      daily_webhook: 49,
      unknown: 1,
    });
    expect(r.total).toBe(50);
    expect(r.alert).toBe(false);
  });

  it("alerta no caso degenerado 100% unknown com amostra grande", () => {
    const r = evaluateUnknownSourceRatio({ unknown: 25 });
    expect(r.total).toBe(25);
    expect(r.ratio).toBe(1);
    expect(r.alert).toBe(true);
  });

  it("ignora chaves espúrias somando todas no total", () => {
    const r = evaluateUnknownSourceRatio({
      daily_webhook: 10,
      daily_cron: 5,
      admin_manual: 4,
      foo_source: 1,
      unknown: 0,
    });
    expect(r.total).toBe(20);
    expect(r.alert).toBe(false);
  });
});
