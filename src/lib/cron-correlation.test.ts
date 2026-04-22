/**
 * Testes de `cron-correlation.ts` (PR-069 · D-077 · finding [17.5]).
 *
 * Foco:
 *   - clampWindowMinutes (bordas e defaults)
 *   - correlateErrorsInWindow: janela, exclusão, ordenação por
 *     proximidade, handling de datas inválidas, anchor inválido,
 *     bySource completo (todas as fontes com 0 ou mais).
 *   - formatCorrelationSummary (omissão de zeros, ordem determinística)
 */

import { describe, expect, it } from "vitest";
import {
  clampWindowMinutes,
  correlateErrorsInWindow,
  formatCorrelationSummary,
} from "./cron-correlation";
import type { ErrorEntry } from "./error-log";

function entry(
  reference: string,
  source: ErrorEntry["source"],
  occurredAt: string,
  label = reference
): ErrorEntry {
  return {
    occurredAt,
    source,
    label,
    message: "msg",
    reference,
    context: {},
  };
}

// ─── clampWindowMinutes ────────────────────────────────────────────────

describe("clampWindowMinutes", () => {
  it("default 15 pra undefined/NaN/Infinity", () => {
    expect(clampWindowMinutes(undefined)).toBe(15);
    expect(clampWindowMinutes(NaN)).toBe(15);
    expect(clampWindowMinutes(Infinity)).toBe(15);
    expect(clampWindowMinutes(-Infinity)).toBe(15);
  });

  it("arredonda valores fracionários", () => {
    expect(clampWindowMinutes(14.4)).toBe(14);
    expect(clampWindowMinutes(14.6)).toBe(15);
  });

  it("clampa em [1, 1440]", () => {
    expect(clampWindowMinutes(0)).toBe(1);
    expect(clampWindowMinutes(-5)).toBe(1);
    expect(clampWindowMinutes(1440)).toBe(1440);
    expect(clampWindowMinutes(10_000)).toBe(1440);
  });

  it("preserva valores válidos", () => {
    expect(clampWindowMinutes(1)).toBe(1);
    expect(clampWindowMinutes(15)).toBe(15);
    expect(clampWindowMinutes(60)).toBe(60);
  });
});

// ─── correlateErrorsInWindow ───────────────────────────────────────────

describe("correlateErrorsInWindow", () => {
  const anchor = "2026-04-20T12:00:00.000Z";

  it("lista vazia → total 0, bySource todos zero", () => {
    const r = correlateErrorsInWindow([], { anchorAt: anchor });
    expect(r.total).toBe(0);
    expect(r.entries).toEqual([]);
    expect(r.bySource).toEqual({
      cron: 0,
      asaas_webhook: 0,
      daily_webhook: 0,
      notification: 0,
      whatsapp_delivery: 0,
    });
    expect(r.windowMinutes).toBe(15);
  });

  it("anchor inválido → no-op (total 0) sem lançar", () => {
    const e = entry("asaas_events:1", "asaas_webhook", anchor);
    const r = correlateErrorsInWindow([e], {
      anchorAt: "not-a-date",
      windowMinutes: 5,
    });
    expect(r.total).toBe(0);
    expect(r.entries).toEqual([]);
  });

  it("inclui apenas entries em ±windowMinutes", () => {
    const entries: ErrorEntry[] = [
      entry("a:1", "asaas_webhook", "2026-04-20T11:45:00.000Z"), // −15min — borda
      entry("a:2", "asaas_webhook", "2026-04-20T11:44:00.000Z"), // −16min — fora
      entry("d:1", "daily_webhook", "2026-04-20T12:10:00.000Z"), // +10min — in
      entry("n:1", "notification", "2026-04-20T12:16:00.000Z"), // +16min — fora
      entry("w:1", "whatsapp_delivery", anchor), // 0 — in
    ];
    const r = correlateErrorsInWindow(entries, {
      anchorAt: anchor,
      windowMinutes: 15,
    });
    expect(r.total).toBe(3);
    expect(r.bySource.asaas_webhook).toBe(1);
    expect(r.bySource.daily_webhook).toBe(1);
    expect(r.bySource.whatsapp_delivery).toBe(1);
    expect(r.bySource.notification).toBe(0);
    expect(r.bySource.cron).toBe(0);
  });

  it("ordena por proximidade, empates por occurredAt desc", () => {
    const entries: ErrorEntry[] = [
      entry("a:far", "asaas_webhook", "2026-04-20T12:10:00.000Z"), // +10min
      entry("a:close", "asaas_webhook", "2026-04-20T12:01:00.000Z"), // +1min
      entry("a:exact", "asaas_webhook", anchor), // 0
      entry("d:tie-later", "daily_webhook", "2026-04-20T12:05:00.000Z"), // +5min
      entry("d:tie-earlier", "daily_webhook", "2026-04-20T11:55:00.000Z"), // −5min (mesma distância)
    ];
    const r = correlateErrorsInWindow(entries, {
      anchorAt: anchor,
      windowMinutes: 30,
    });
    expect(r.entries.map((e) => e.reference)).toEqual([
      "a:exact",
      "a:close",
      "d:tie-later", // empate +5/−5 → ordena por occurredAt desc
      "d:tie-earlier",
      "a:far",
    ]);
  });

  it("excludeReference remove ocorrência própria", () => {
    const entries: ErrorEntry[] = [
      entry("cron_runs:self", "cron", anchor),
      entry("asaas_events:1", "asaas_webhook", anchor),
    ];
    const r = correlateErrorsInWindow(entries, {
      anchorAt: anchor,
      windowMinutes: 5,
      excludeReference: "cron_runs:self",
    });
    expect(r.total).toBe(1);
    expect(r.entries[0]?.reference).toBe("asaas_events:1");
    expect(r.bySource.cron).toBe(0);
  });

  it("exclude null → não filtra (caso default)", () => {
    const entries: ErrorEntry[] = [
      entry("cron_runs:x", "cron", anchor),
    ];
    const r = correlateErrorsInWindow(entries, {
      anchorAt: anchor,
      windowMinutes: 5,
      excludeReference: null,
    });
    expect(r.total).toBe(1);
  });

  it("ignora entries com occurredAt inválido (fail-safe)", () => {
    const entries: ErrorEntry[] = [
      entry("bad:1", "asaas_webhook", "not-a-date"),
      entry("bad:2", "asaas_webhook", ""),
      entry("good:1", "asaas_webhook", anchor),
    ];
    const r = correlateErrorsInWindow(entries, {
      anchorAt: anchor,
      windowMinutes: 5,
    });
    expect(r.total).toBe(1);
    expect(r.entries[0]?.reference).toBe("good:1");
  });

  it("clampa janela fora de limites", () => {
    const entries: ErrorEntry[] = [entry("a:1", "asaas_webhook", anchor)];
    const big = correlateErrorsInWindow(entries, {
      anchorAt: anchor,
      windowMinutes: 99_999,
    });
    expect(big.windowMinutes).toBe(1440);

    const small = correlateErrorsInWindow(entries, {
      anchorAt: anchor,
      windowMinutes: -1,
    });
    expect(small.windowMinutes).toBe(1);
  });

  it("aceita Date como anchor", () => {
    const entries: ErrorEntry[] = [entry("a:1", "asaas_webhook", anchor)];
    const r = correlateErrorsInWindow(entries, {
      anchorAt: new Date(anchor),
      windowMinutes: 5,
    });
    expect(r.total).toBe(1);
  });

  it("devolve sinceIso/untilIso coerentes com anchor ± janela", () => {
    const r = correlateErrorsInWindow([], {
      anchorAt: anchor,
      windowMinutes: 15,
    });
    expect(r.sinceIso).toBe("2026-04-20T11:45:00.000Z");
    expect(r.untilIso).toBe("2026-04-20T12:15:00.000Z");
  });

  it("não muta o input", () => {
    const entries: ErrorEntry[] = [
      entry("a:1", "asaas_webhook", "2026-04-20T12:05:00.000Z"),
      entry("a:2", "asaas_webhook", "2026-04-20T12:01:00.000Z"),
    ];
    const before = entries.map((e) => e.reference);
    correlateErrorsInWindow(entries, { anchorAt: anchor, windowMinutes: 10 });
    expect(entries.map((e) => e.reference)).toEqual(before);
  });

  it("conta múltiplos por source", () => {
    const entries: ErrorEntry[] = [
      entry("a:1", "asaas_webhook", "2026-04-20T12:01:00.000Z"),
      entry("a:2", "asaas_webhook", "2026-04-20T12:02:00.000Z"),
      entry("a:3", "asaas_webhook", "2026-04-20T12:03:00.000Z"),
      entry("n:1", "notification", "2026-04-20T12:04:00.000Z"),
    ];
    const r = correlateErrorsInWindow(entries, {
      anchorAt: anchor,
      windowMinutes: 10,
    });
    expect(r.bySource.asaas_webhook).toBe(3);
    expect(r.bySource.notification).toBe(1);
    expect(r.total).toBe(4);
  });
});

// ─── formatCorrelationSummary ──────────────────────────────────────────

describe("formatCorrelationSummary", () => {
  it("string vazia quando tudo zero", () => {
    expect(
      formatCorrelationSummary({
        cron: 0,
        asaas_webhook: 0,
        daily_webhook: 0,
        notification: 0,
        whatsapp_delivery: 0,
      })
    ).toBe("");
  });

  it("omite fontes com 0", () => {
    expect(
      formatCorrelationSummary({
        cron: 0,
        asaas_webhook: 2,
        daily_webhook: 0,
        notification: 1,
        whatsapp_delivery: 0,
      })
    ).toBe("2 Asaas · 1 envio WA");
  });

  it("preserva ordem determinística (cron, Asaas, Daily, WA envio, WA entrega)", () => {
    expect(
      formatCorrelationSummary({
        cron: 1,
        asaas_webhook: 1,
        daily_webhook: 1,
        notification: 1,
        whatsapp_delivery: 1,
      })
    ).toBe("1 cron · 1 Asaas · 1 Daily · 1 envio WA · 1 entrega WA");
  });

  it("pluraliza pela contagem numérica (sem 's' — labels enxutas)", () => {
    expect(
      formatCorrelationSummary({
        cron: 5,
        asaas_webhook: 10,
        daily_webhook: 0,
        notification: 0,
        whatsapp_delivery: 0,
      })
    ).toBe("5 cron · 10 Asaas");
  });
});
