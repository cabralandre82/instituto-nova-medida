/**
 * Unit tests pra `src/lib/batched.ts` — PR-049 · D-098.
 *
 * Foco: ordem preservada, isolamento de erros, concorrência respeitada,
 * envIntInRange defensivo, fallback concurrency=1.
 */

import { describe, it, expect, vi } from "vitest";
import {
  processInBatches,
  envIntInRange,
  type BatchedOutcome,
} from "./batched";

describe("envIntInRange", () => {
  it("retorna fallback quando env não setada", () => {
    delete process.env.__INM_TEST_BATCHED;
    expect(envIntInRange("__INM_TEST_BATCHED", 8, 1, 32)).toBe(8);
  });

  it("retorna fallback quando env vazia", () => {
    process.env.__INM_TEST_BATCHED = "";
    expect(envIntInRange("__INM_TEST_BATCHED", 8, 1, 32)).toBe(8);
    delete process.env.__INM_TEST_BATCHED;
  });

  it("aceita valor dentro do range", () => {
    process.env.__INM_TEST_BATCHED = "16";
    expect(envIntInRange("__INM_TEST_BATCHED", 8, 1, 32)).toBe(16);
    delete process.env.__INM_TEST_BATCHED;
  });

  it("clampa abaixo do mínimo", () => {
    process.env.__INM_TEST_BATCHED = "0";
    expect(envIntInRange("__INM_TEST_BATCHED", 8, 1, 32)).toBe(1);
    delete process.env.__INM_TEST_BATCHED;
  });

  it("clampa acima do máximo", () => {
    process.env.__INM_TEST_BATCHED = "100";
    expect(envIntInRange("__INM_TEST_BATCHED", 8, 1, 32)).toBe(32);
    delete process.env.__INM_TEST_BATCHED;
  });

  it("retorna fallback quando env é não-numérica", () => {
    process.env.__INM_TEST_BATCHED = "abc";
    expect(envIntInRange("__INM_TEST_BATCHED", 8, 1, 32)).toBe(8);
    delete process.env.__INM_TEST_BATCHED;
  });

  it("trunca decimais", () => {
    process.env.__INM_TEST_BATCHED = "5.7";
    expect(envIntInRange("__INM_TEST_BATCHED", 8, 1, 32)).toBe(5);
    delete process.env.__INM_TEST_BATCHED;
  });
});

describe("processInBatches", () => {
  it("array vazio → retorna []", async () => {
    const out = await processInBatches([], async (x) => x);
    expect(out).toEqual([]);
  });

  it("preserva ordem do input no output", async () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const out = await processInBatches(
      items,
      async (n) => {
        // Tempos randomizados pra forçar reordenação se houvesse bug
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        return n * 2;
      },
      { concurrency: 4 }
    );
    expect(out).toHaveLength(10);
    out.forEach((o, idx) => {
      expect(o.ok).toBe(true);
      if (o.ok) {
        expect(o.value).toBe(items[idx] * 2);
        expect(o.index).toBe(idx);
        expect(o.item).toBe(items[idx]);
      }
    });
  });

  it("isola erros — uma falha não derruba o batch", async () => {
    const items = [1, 2, 3, 4, 5];
    const out = await processInBatches(
      items,
      async (n) => {
        if (n === 3) throw new Error("boom-3");
        return n * 10;
      },
      { concurrency: 2 }
    );

    const failed = out.filter((o): o is Extract<typeof o, { ok: false }> => !o.ok);
    expect(failed).toHaveLength(1);
    expect(failed[0].item).toBe(3);
    expect(failed[0].error.message).toBe("boom-3");

    const ok = out.filter((o): o is Extract<typeof o, { ok: true }> => o.ok);
    expect(ok.map((o) => o.value).sort((a, b) => a - b)).toEqual([
      10, 20, 40, 50,
    ]);
  });

  it("respeita concurrency máxima", async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    let active = 0;
    let maxActive = 0;
    const out = await processInBatches(
      items,
      async (n) => {
        active += 1;
        if (active > maxActive) maxActive = active;
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return n;
      },
      { concurrency: 3 }
    );
    expect(out).toHaveLength(20);
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("concurrency=1 é equivalente a sequential", async () => {
    const items = [10, 20, 30];
    const sequence: number[] = [];
    const out = await processInBatches(
      items,
      async (n) => {
        sequence.push(n);
        return n;
      },
      { concurrency: 1 }
    );
    expect(sequence).toEqual([10, 20, 30]);
    expect(out).toHaveLength(3);
    expect(out.every((o) => o.ok)).toBe(true);
  });

  it("clampa concurrency < 1 a 1", async () => {
    const items = [1, 2, 3];
    const out = await processInBatches(items, async (n) => n, {
      concurrency: 0,
    });
    expect(out).toHaveLength(3);
    expect(out.every((o) => o.ok)).toBe(true);
  });

  it("clampa concurrency > 64 a 64", async () => {
    const items = Array.from({ length: 5 }, (_, i) => i);
    let active = 0;
    let maxActive = 0;
    await processInBatches(
      items,
      async (n) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 1));
        active -= 1;
        return n;
      },
      { concurrency: 9999 }
    );
    expect(maxActive).toBeLessThanOrEqual(64);
  });

  it("onBatchComplete recebe metadata correta por batch", async () => {
    const items = [1, 2, 3, 4, 5];
    const reports: Array<{
      batchIndex: number;
      completed: number;
      total: number;
      okCount: number;
      errorCount: number;
    }> = [];
    await processInBatches(
      items,
      async (n) => {
        if (n === 3) throw new Error("x");
        return n;
      },
      {
        concurrency: 2,
        onBatchComplete: (info) => reports.push(info),
      }
    );
    expect(reports).toHaveLength(3); // 5 itens / batches de 2 = ⌈5/2⌉=3
    expect(reports[0]).toMatchObject({
      batchIndex: 0,
      completed: 2,
      total: 5,
      okCount: 2,
      errorCount: 0,
    });
    expect(reports[1]).toMatchObject({
      batchIndex: 1,
      completed: 4,
      total: 5,
      okCount: 1,
      errorCount: 1,
    });
    expect(reports[2]).toMatchObject({
      batchIndex: 2,
      completed: 5,
      total: 5,
      okCount: 1,
      errorCount: 0,
    });
  });

  it("hook onBatchComplete que lança não derruba o cron", async () => {
    const items = [1, 2];
    const out = await processInBatches(items, async (n) => n, {
      concurrency: 2,
      onBatchComplete: () => {
        throw new Error("hook bug");
      },
    });
    expect(out).toHaveLength(2);
    expect(out.every((o) => o.ok)).toBe(true);
  });

  it("erro não-Error vira Error string-coerced", async () => {
    const out = await processInBatches(
      [1],
      async () => {
        throw "raw string error" as unknown as Error;
      },
      { concurrency: 1 }
    );
    expect(out[0].ok).toBe(false);
    if (!out[0].ok) {
      expect(out[0].error).toBeInstanceOf(Error);
      expect(out[0].error.message).toBe("raw string error");
    }
  });

  it("BatchedOutcome.index reflete idx original mesmo com concurrency", async () => {
    const items = ["a", "b", "c", "d", "e"];
    const out = await processInBatches(
      items,
      async (s, idx) => `${s}-${idx}`,
      { concurrency: 3 }
    );
    expect(out.map((o) => (o.ok ? o.value : null))).toEqual([
      "a-0",
      "b-1",
      "c-2",
      "d-3",
      "e-4",
    ]);
  });

  it("processa item único", async () => {
    const fn = vi.fn(async (n: number) => n * 100);
    const out = await processInBatches([7], fn, { concurrency: 8 });
    expect(out).toHaveLength(1);
    expect(out[0].ok).toBe(true);
    if (out[0].ok) expect(out[0].value).toBe(700);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("BatchedOutcome shape (type-level smoke)", () => {
  it("ok=true → value disponível, ok=false → error disponível", () => {
    const ok: BatchedOutcome<number, string> = {
      ok: true,
      item: 1,
      index: 0,
      value: "x",
    };
    const err: BatchedOutcome<number, string> = {
      ok: false,
      item: 1,
      index: 0,
      error: new Error("y"),
    };
    expect(ok.ok ? ok.value : null).toBe("x");
    expect(!err.ok ? err.error.message : null).toBe("y");
  });
});
