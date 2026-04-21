/**
 * Testes de financial-dashboard (D-045 · 3.F).
 *
 * Cobre:
 *   - Helpers puros: pctDelta, fillDailySeries, aggregateByPlan,
 *     bucket, groupByUtcDay.
 *   - Carregador principal: agregação end-to-end com mock de Supabase,
 *     janelas temporais corretas, propagação de erros.
 */

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseMock } from "@/test/mocks/supabase";
import {
  aggregateByPlan,
  bucket,
  fillDailySeries,
  groupByUtcDay,
  loadFinancialDashboard,
  pctDelta,
} from "./financial-dashboard";

describe("pctDelta", () => {
  it("zero prior → null", () => {
    expect(pctDelta(100, 0)).toBeNull();
    expect(pctDelta(0, 0)).toBeNull();
  });
  it("crescimento positivo arredondado", () => {
    expect(pctDelta(150, 100)).toBe(50);
    expect(pctDelta(133, 100)).toBe(33);
  });
  it("retração negativa", () => {
    expect(pctDelta(70, 100)).toBe(-30);
  });
});

describe("fillDailySeries", () => {
  it("preenche range sem dados com zeros", () => {
    const start = new Date("2026-04-10T00:00:00.000Z");
    const s = fillDailySeries(start, 3, new Map());
    expect(s).toHaveLength(3);
    expect(s[0]).toEqual({
      date: "2026-04-10",
      count: 0,
      totalCents: 0,
    });
    expect(s[2].date).toBe("2026-04-12");
    expect(s.every((p) => p.totalCents === 0)).toBe(true);
  });

  it("combina dias com dados e zeros", () => {
    const start = new Date("2026-04-10T00:00:00.000Z");
    const byDate = new Map([
      ["2026-04-11", { count: 2, totalCents: 5000 }],
    ]);
    const s = fillDailySeries(start, 3, byDate);
    expect(s[0].totalCents).toBe(0);
    expect(s[1].totalCents).toBe(5000);
    expect(s[2].totalCents).toBe(0);
  });
});

describe("aggregateByPlan", () => {
  it("agrupa, soma e ordena desc por total", () => {
    const rows = [
      {
        amount_cents: 10000,
        paid_at: null,
        created_at: "",
        plan_id: "p1",
        plans: { id: "p1", name: "Plano A" },
      },
      {
        amount_cents: 20000,
        paid_at: null,
        created_at: "",
        plan_id: "p2",
        plans: { id: "p2", name: "Plano B" },
      },
      {
        amount_cents: 5000,
        paid_at: null,
        created_at: "",
        plan_id: "p1",
        plans: { id: "p1", name: "Plano A" },
      },
    ];
    const agg = aggregateByPlan(rows);
    expect(agg).toHaveLength(2);
    expect(agg[0].planName).toBe("Plano B"); // maior total
    expect(agg[0].totalCents).toBe(20000);
    expect(agg[1].totalCents).toBe(15000); // 10k + 5k
    expect(agg[0].share + agg[1].share).toBeCloseTo(1.0, 4);
  });

  it("trata plan null como 'Sem plano associado'", () => {
    const rows = [
      {
        amount_cents: 1000,
        paid_at: null,
        created_at: "",
        plan_id: null,
        plans: null,
      },
    ];
    const agg = aggregateByPlan(rows);
    expect(agg).toHaveLength(1);
    expect(agg[0].planName).toContain("Sem plano");
    expect(agg[0].share).toBe(1);
  });

  it("trata plans como array (join Supabase)", () => {
    const rows = [
      {
        amount_cents: 1000,
        paid_at: null,
        created_at: "",
        plan_id: "p1",
        plans: [{ id: "p1", name: "Plano X" }],
      },
    ];
    const agg = aggregateByPlan(rows);
    expect(agg[0].planName).toBe("Plano X");
  });

  it("lista vazia → array vazio", () => {
    expect(aggregateByPlan([])).toEqual([]);
  });
});

describe("bucket", () => {
  it("soma corretamente", () => {
    const b = bucket([{ amount_cents: 100 }, { amount_cents: 250 }]);
    expect(b).toEqual({ count: 2, totalCents: 350 });
  });
  it("lista vazia → zeros", () => {
    expect(bucket([])).toEqual({ count: 0, totalCents: 0 });
  });
});

describe("groupByUtcDay", () => {
  it("agrupa por data UTC do paid_at", () => {
    const rows = [
      { amount_cents: 100, paid_at: "2026-04-10T09:00:00.000Z" },
      { amount_cents: 200, paid_at: "2026-04-10T23:59:00.000Z" },
      { amount_cents: 300, paid_at: "2026-04-11T00:00:00.000Z" },
    ];
    const g = groupByUtcDay(rows);
    expect(g.get("2026-04-10")).toEqual({ count: 2, totalCents: 300 });
    expect(g.get("2026-04-11")).toEqual({ count: 1, totalCents: 300 });
  });
  it("ignora linhas sem paid_at", () => {
    const rows = [{ amount_cents: 100, paid_at: null }];
    expect(groupByUtcDay(rows).size).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Integração (mock Supabase)
// ────────────────────────────────────────────────────────────────────────

describe("loadFinancialDashboard", () => {
  const NOW = new Date("2026-04-20T15:00:00.000Z");

  function enqueueAll(supa: ReturnType<typeof createSupabaseMock>, o: {
    mtd?: unknown[];
    prior?: unknown[];
    series?: unknown[];
    payoutsMtd?: unknown[];
    payoutsDraft?: unknown[];
    payoutsApproved?: unknown[];
    refundsMtd?: unknown[];
    refundsPending?: unknown[];
  }) {
    supa.enqueue("payments", { data: o.mtd ?? [], error: null });
    supa.enqueue("payments", { data: o.prior ?? [], error: null });
    supa.enqueue("payments", { data: o.series ?? [], error: null });
    supa.enqueue("doctor_payouts", { data: o.payoutsMtd ?? [], error: null });
    supa.enqueue("doctor_payouts", {
      data: o.payoutsDraft ?? [],
      error: null,
    });
    supa.enqueue("doctor_payouts", {
      data: o.payoutsApproved ?? [],
      error: null,
    });
    supa.enqueue("appointments", { data: o.refundsMtd ?? [], error: null });
    supa.enqueue("appointments", {
      data: o.refundsPending ?? [],
      error: null,
    });
  }

  it("agrega receita, saídas e pendências num report coerente", async () => {
    const supa = createSupabaseMock();
    enqueueAll(supa, {
      mtd: [
        {
          amount_cents: 120000,
          paid_at: "2026-04-05T10:00:00.000Z",
          created_at: "2026-04-05T10:00:00.000Z",
          plan_id: "p1",
          plans: { id: "p1", name: "Plano A" },
        },
        {
          amount_cents: 80000,
          paid_at: "2026-04-15T10:00:00.000Z",
          created_at: "2026-04-15T10:00:00.000Z",
          plan_id: "p1",
          plans: { id: "p1", name: "Plano A" },
        },
      ],
      prior: [
        { amount_cents: 100000, paid_at: "2026-03-10T10:00:00.000Z", created_at: "" },
      ],
      series: [
        { amount_cents: 120000, paid_at: "2026-04-05T10:00:00.000Z", created_at: "" },
        { amount_cents: 80000, paid_at: "2026-04-15T10:00:00.000Z", created_at: "" },
      ],
      payoutsMtd: [{ amount_cents: 30000, paid_at: "2026-04-10T10:00:00.000Z", status: "confirmed" }],
      payoutsDraft: [{ amount_cents: 15000, status: "draft" }],
      payoutsApproved: [],
      refundsMtd: [{ refund_processed_at: "2026-04-08T10:00:00.000Z", refund_required: true }],
      refundsPending: [
        { refund_required: true, refund_processed_at: null },
        { refund_required: true, refund_processed_at: null },
      ],
    });

    const r = await loadFinancialDashboard(
      supa.client as unknown as SupabaseClient,
      { now: NOW }
    );

    expect(r.revenue.mtd).toEqual({ count: 2, totalCents: 200000 });
    expect(r.revenue.priorSamePeriod.totalCents).toBe(100000);
    expect(r.revenue.deltaPct).toBe(100); // 100k → 200k
    expect(r.revenue.byPlan[0].planName).toBe("Plano A");
    expect(r.revenue.byPlan[0].share).toBeCloseTo(1.0, 4);

    expect(r.outflow.payoutsMtd.totalCents).toBe(30000);
    expect(r.outflow.refundsMtd.count).toBe(1);
    expect(r.outflow.netMtd).toBe(200000 - 30000);

    expect(r.pending.payoutsDraft.count).toBe(1);
    expect(r.pending.payoutsDraft.totalCents).toBe(15000);
    expect(r.pending.payoutsApproved.count).toBe(0);
    expect(r.pending.refundsRequired.count).toBe(2);

    expect(r.dailySeries).toHaveLength(30);
    const apr5 = r.dailySeries.find((p) => p.date === "2026-04-05");
    const apr15 = r.dailySeries.find((p) => p.date === "2026-04-15");
    expect(apr5?.totalCents).toBe(120000);
    expect(apr15?.totalCents).toBe(80000);
  });

  it("deltaPct=null quando prior period está zerado", async () => {
    const supa = createSupabaseMock();
    enqueueAll(supa, {
      mtd: [
        {
          amount_cents: 50000,
          paid_at: "2026-04-10T10:00:00.000Z",
          created_at: "",
          plan_id: null,
          plans: null,
        },
      ],
      prior: [],
    });

    const r = await loadFinancialDashboard(
      supa.client as unknown as SupabaseClient,
      { now: NOW }
    );

    expect(r.revenue.priorSamePeriod.totalCents).toBe(0);
    expect(r.revenue.deltaPct).toBeNull();
  });

  it("propaga erro do primeiro fetch", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("payments", {
      data: null,
      error: { message: "boom" },
    });
    // resto enfileirado com data vazia pra caso Promise.all queira
    for (let i = 0; i < 7; i++) {
      supa.enqueue("_any", { data: [], error: null });
    }

    await expect(
      loadFinancialDashboard(supa.client as unknown as SupabaseClient, {
        now: NOW,
      })
    ).rejects.toThrow(/boom/);
  });

  it("rangeDays respeita clamp [7, 180]", async () => {
    const supa = createSupabaseMock();
    enqueueAll(supa, {});

    const r = await loadFinancialDashboard(
      supa.client as unknown as SupabaseClient,
      { now: NOW, rangeDays: 500 }
    );
    expect(r.dailySeries).toHaveLength(180);

    const supa2 = createSupabaseMock();
    enqueueAll(supa2, {});

    const r2 = await loadFinancialDashboard(
      supa2.client as unknown as SupabaseClient,
      { now: NOW, rangeDays: 3 }
    );
    expect(r2.dailySeries).toHaveLength(7);
  });
});
