/**
 * Testes de recalculateEarningsAvailability (D-040).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createSupabaseMock } from "@/test/mocks/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  recalculateEarningsAvailability,
  computeAvailableAt,
  RISK_WINDOW_DAYS,
} from "./earnings-availability";

describe("computeAvailableAt", () => {
  it("earnings sem payment_id → available_at = earned_at", () => {
    const earnedAt = "2026-03-10T12:00:00.000Z";
    const got = computeAvailableAt({
      payment_id: null,
      earned_at: earnedAt,
      payments: null,
    });
    expect(got).toBe(earnedAt);
  });

  it("earnings com PIX → paid_at + 7 dias", () => {
    const paidAt = "2026-03-10T12:00:00.000Z";
    const got = computeAvailableAt({
      payment_id: "p1",
      earned_at: "2026-03-10T12:00:00.000Z",
      payments: { paid_at: paidAt, billing_type: "PIX" },
    });
    const expected = new Date(
      new Date(paidAt).getTime() + 7 * 86400 * 1000
    ).toISOString();
    expect(got).toBe(expected);
  });

  it("earnings com BOLETO → paid_at + 3 dias", () => {
    const paidAt = "2026-03-10T12:00:00.000Z";
    const got = computeAvailableAt({
      payment_id: "p1",
      earned_at: paidAt,
      payments: { paid_at: paidAt, billing_type: "BOLETO" },
    });
    const expected = new Date(
      new Date(paidAt).getTime() + 3 * 86400 * 1000
    ).toISOString();
    expect(got).toBe(expected);
  });

  it("earnings com CREDIT_CARD → paid_at + 30 dias", () => {
    const paidAt = "2026-03-10T12:00:00.000Z";
    const got = computeAvailableAt({
      payment_id: "p1",
      earned_at: paidAt,
      payments: { paid_at: paidAt, billing_type: "CREDIT_CARD" },
    });
    const expected = new Date(
      new Date(paidAt).getTime() + 30 * 86400 * 1000
    ).toISOString();
    expect(got).toBe(expected);
  });

  it("earnings com UNDEFINED → trata como CREDIT_CARD (D+30, conservador)", () => {
    const paidAt = "2026-03-10T12:00:00.000Z";
    const got = computeAvailableAt({
      payment_id: "p1",
      earned_at: paidAt,
      payments: { paid_at: paidAt, billing_type: "UNDEFINED" },
    });
    const expected = new Date(
      new Date(paidAt).getTime() + 30 * 86400 * 1000
    ).toISOString();
    expect(got).toBe(expected);
    expect(RISK_WINDOW_DAYS.UNDEFINED).toBe(RISK_WINDOW_DAYS.CREDIT_CARD);
  });

  it("earnings com payment.paid_at null → null (continua pending sem data)", () => {
    const got = computeAvailableAt({
      payment_id: "p1",
      earned_at: "2026-03-10T12:00:00.000Z",
      payments: { paid_at: null, billing_type: "PIX" },
    });
    expect(got).toBeNull();
  });
});

describe("recalculateEarningsAvailability", () => {
  let supa: ReturnType<typeof createSupabaseMock>;

  beforeEach(() => {
    supa = createSupabaseMock();
  });

  it("zero earnings pending → no-op", async () => {
    supa.enqueue("doctor_earnings", { data: [], error: null });
    const r = await recalculateEarningsAvailability(
      supa.client as unknown as SupabaseClient
    );
    expect(r.inspected).toBe(0);
    expect(r.promoted).toBe(0);
    expect(r.scheduledFuture).toBe(0);
    expect(r.errors).toBe(0);
  });

  it("promove earning PIX cuja janela já venceu", async () => {
    const paidAtMs = Date.now() - 10 * 86400 * 1000; // 10 dias atrás (> 7)
    const paidAt = new Date(paidAtMs).toISOString();
    supa.enqueue("doctor_earnings", {
      data: [
        {
          id: "e1",
          doctor_id: "d1",
          payment_id: "p1",
          earned_at: paidAt,
          available_at: null,
          payments: { paid_at: paidAt, billing_type: "PIX" },
        },
      ],
      error: null,
    });
    supa.enqueue("doctor_earnings", { data: null, error: null }); // UPDATE

    const r = await recalculateEarningsAvailability(
      supa.client as unknown as SupabaseClient
    );
    expect(r.promoted).toBe(1);
    expect(r.scheduledFuture).toBe(0);
    expect(r.errors).toBe(0);

    const updateCall = supa.calls[1];
    expect(updateCall.chain).toContain("update");
    const updateArg = updateCall.args[updateCall.chain.indexOf("update")][0] as {
      status: string;
      available_at: string;
    };
    expect(updateArg.status).toBe("available");
    expect(updateArg.available_at).toBeDefined();
  });

  it("agenda earning futura quando janela ainda não venceu (PIX, 2 dias atrás)", async () => {
    const paidAtMs = Date.now() - 2 * 86400 * 1000; // 2 dias atrás (< 7)
    const paidAt = new Date(paidAtMs).toISOString();
    supa.enqueue("doctor_earnings", {
      data: [
        {
          id: "e1",
          doctor_id: "d1",
          payment_id: "p1",
          earned_at: paidAt,
          available_at: null,
          payments: { paid_at: paidAt, billing_type: "PIX" },
        },
      ],
      error: null,
    });
    supa.enqueue("doctor_earnings", { data: null, error: null }); // schedule UPDATE

    const r = await recalculateEarningsAvailability(
      supa.client as unknown as SupabaseClient
    );
    expect(r.promoted).toBe(0);
    expect(r.scheduledFuture).toBe(1);

    const upd = supa.calls[1];
    const payload = upd.args[upd.chain.indexOf("update")][0] as {
      status?: string;
      available_at: string;
    };
    expect(payload.status).toBeUndefined();
    expect(payload.available_at).toBeDefined();
  });

  it("promove earning sem payment_id (plantão/ajuste) imediatamente", async () => {
    const earnedAt = "2020-01-01T00:00:00.000Z";
    supa.enqueue("doctor_earnings", {
      data: [
        {
          id: "adj1",
          doctor_id: "d1",
          payment_id: null,
          earned_at: earnedAt,
          available_at: null,
          payments: null,
        },
      ],
      error: null,
    });
    supa.enqueue("doctor_earnings", { data: null, error: null });

    const r = await recalculateEarningsAvailability(
      supa.client as unknown as SupabaseClient
    );
    expect(r.promoted).toBe(1);
    expect(r.scheduledFuture).toBe(0);
  });

  it("pula earning cujo payment ainda não foi pago (paid_at null)", async () => {
    supa.enqueue("doctor_earnings", {
      data: [
        {
          id: "e1",
          doctor_id: "d1",
          payment_id: "p1",
          earned_at: "2026-03-10T12:00:00.000Z",
          available_at: null,
          payments: { paid_at: null, billing_type: "PIX" },
        },
      ],
      error: null,
    });
    const r = await recalculateEarningsAvailability(
      supa.client as unknown as SupabaseClient
    );
    expect(r.promoted).toBe(0);
    expect(r.scheduledFuture).toBe(0);
    expect(r.skippedMissingPaidAt).toBe(1);
    // Apenas 1 chamada (o select) — não deve ter havido UPDATE.
    expect(supa.calls).toHaveLength(1);
  });

  it("agrega múltiplas earnings com estados diferentes em uma execução", async () => {
    const oldPaid = new Date(Date.now() - 20 * 86400 * 1000).toISOString();
    const newPaid = new Date(Date.now() - 2 * 86400 * 1000).toISOString();
    supa.enqueue("doctor_earnings", {
      data: [
        {
          id: "ready",
          doctor_id: "d1",
          payment_id: "p1",
          earned_at: oldPaid,
          available_at: null,
          payments: { paid_at: oldPaid, billing_type: "PIX" },
        },
        {
          id: "future",
          doctor_id: "d1",
          payment_id: "p2",
          earned_at: newPaid,
          available_at: null,
          payments: { paid_at: newPaid, billing_type: "PIX" },
        },
        {
          id: "no-payment",
          doctor_id: "d1",
          payment_id: null,
          earned_at: oldPaid,
          available_at: null,
          payments: null,
        },
        {
          id: "no-paid",
          doctor_id: "d1",
          payment_id: "p3",
          earned_at: newPaid,
          available_at: null,
          payments: { paid_at: null, billing_type: "PIX" },
        },
      ],
      error: null,
    });
    supa.enqueue("doctor_earnings", { data: null, error: null }); // ready
    supa.enqueue("doctor_earnings", { data: null, error: null }); // future
    supa.enqueue("doctor_earnings", { data: null, error: null }); // no-payment

    const r = await recalculateEarningsAvailability(
      supa.client as unknown as SupabaseClient
    );
    expect(r.inspected).toBe(4);
    expect(r.promoted).toBe(2);          // "ready" + "no-payment"
    expect(r.scheduledFuture).toBe(1);   // "future"
    expect(r.skippedMissingPaidAt).toBe(1); // "no-paid"
    expect(r.errors).toBe(0);
  });

  it("registra erro se select falha e retorna cedo", async () => {
    supa.enqueue("doctor_earnings", {
      data: null,
      error: { message: "db down" },
    });
    const r = await recalculateEarningsAvailability(
      supa.client as unknown as SupabaseClient
    );
    expect(r.errors).toBe(1);
    expect(r.inspected).toBe(0);
    expect(r.errorDetails[0]).toContain("db down");
  });

  it("idempotência: segunda execução com estado já available não gera trabalho (select vazio)", async () => {
    supa.enqueue("doctor_earnings", { data: [], error: null });
    supa.enqueue("doctor_earnings", { data: [], error: null });

    const a = await recalculateEarningsAvailability(
      supa.client as unknown as SupabaseClient
    );
    const b = await recalculateEarningsAvailability(
      supa.client as unknown as SupabaseClient
    );
    expect(a.promoted).toBe(0);
    expect(b.promoted).toBe(0);
    expect(a.inspected).toBe(0);
    expect(b.inspected).toBe(0);
  });
});
