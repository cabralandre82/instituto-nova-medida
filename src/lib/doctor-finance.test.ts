/**
 * Testes de doctor-finance (D-041).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createSupabaseMock } from "@/test/mocks/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getDoctorBalance,
  estimateNextPayout,
  listPayoutsWithDocuments,
  countPendingBillingDocuments,
} from "./doctor-finance";

describe("getDoctorBalance", () => {
  let supa: ReturnType<typeof createSupabaseMock>;
  beforeEach(() => {
    supa = createSupabaseMock();
  });

  it("retorna zeros quando não há earnings", async () => {
    supa.enqueue("doctor_earnings", { data: [], error: null });
    const balance = await getDoctorBalance(
      supa.client as unknown as SupabaseClient,
      "doc1"
    );
    expect(balance.pendingCents).toBe(0);
    expect(balance.availableCents).toBe(0);
    expect(balance.inPayoutCents).toBe(0);
    expect(balance.paidCents).toBe(0);
    expect(balance.counts.pending).toBe(0);
  });

  it("agrega corretamente cada status", async () => {
    supa.enqueue("doctor_earnings", {
      data: [
        { amount_cents: 10000, status: "pending" },
        { amount_cents: 5000, status: "pending" },
        { amount_cents: 20000, status: "available" },
        { amount_cents: 30000, status: "in_payout" },
        { amount_cents: 40000, status: "paid" },
        { amount_cents: 15000, status: "paid" },
      ],
      error: null,
    });
    const balance = await getDoctorBalance(
      supa.client as unknown as SupabaseClient,
      "doc1"
    );
    expect(balance.pendingCents).toBe(15000);
    expect(balance.availableCents).toBe(20000);
    expect(balance.inPayoutCents).toBe(30000);
    expect(balance.paidCents).toBe(55000);
    expect(balance.counts).toEqual({
      pending: 2,
      available: 1,
      inPayout: 1,
      paid: 2,
    });
  });

  it("ignora valores negativos corretamente (clawback em pending)", async () => {
    supa.enqueue("doctor_earnings", {
      data: [
        { amount_cents: 10000, status: "available" },
        { amount_cents: -3000, status: "available" },
      ],
      error: null,
    });
    const balance = await getDoctorBalance(
      supa.client as unknown as SupabaseClient,
      "doc1"
    );
    expect(balance.availableCents).toBe(7000);
    expect(balance.counts.available).toBe(2);
  });

  it("em caso de erro, retorna zeros (fail-safe)", async () => {
    supa.enqueue("doctor_earnings", {
      data: null,
      error: { message: "db down" },
    });
    const balance = await getDoctorBalance(
      supa.client as unknown as SupabaseClient,
      "doc1"
    );
    expect(balance.availableCents).toBe(0);
    expect(balance.paidCents).toBe(0);
  });
});

describe("estimateNextPayout", () => {
  let supa: ReturnType<typeof createSupabaseMock>;
  beforeEach(() => {
    supa = createSupabaseMock();
  });

  it("separa eligible (mês passado) de deferred (mês corrente)", async () => {
    // Rodando "agora" = 2026-03-15
    const now = new Date("2026-03-15T12:00:00.000Z");
    supa.enqueue("doctor_earnings", {
      data: [
        { amount_cents: 10000, available_at: "2026-02-25T10:00:00.000Z" }, // eligible
        { amount_cents: 20000, available_at: "2026-02-28T10:00:00.000Z" }, // eligible
        { amount_cents: 30000, available_at: "2026-03-10T10:00:00.000Z" }, // deferred (mês atual)
      ],
      error: null,
    });
    const estimate = await estimateNextPayout(
      supa.client as unknown as SupabaseClient,
      "doc1",
      now
    );
    expect(estimate.eligibleCents).toBe(30000);
    expect(estimate.eligibleCount).toBe(2);
    expect(estimate.deferredCents).toBe(30000);
    expect(estimate.deferredCount).toBe(1);
    expect(estimate.referencePeriod).toBe("2026-03");
    // scheduledAt → próximo dia 1 em UTC às 09:15
    expect(estimate.scheduledAt).toBe("2026-04-01T09:15:00.000Z");
  });

  it("trata dezembro → janeiro do próximo ano", async () => {
    const now = new Date("2026-12-20T12:00:00.000Z");
    supa.enqueue("doctor_earnings", {
      data: [
        { amount_cents: 5000, available_at: "2026-11-30T10:00:00.000Z" },
      ],
      error: null,
    });
    const estimate = await estimateNextPayout(
      supa.client as unknown as SupabaseClient,
      "doc1",
      now
    );
    expect(estimate.scheduledAt).toBe("2027-01-01T09:15:00.000Z");
    expect(estimate.eligibleCents).toBe(5000);
  });

  it("earnings com available_at null são ignoradas", async () => {
    const now = new Date("2026-03-15T12:00:00.000Z");
    supa.enqueue("doctor_earnings", {
      data: [
        { amount_cents: 10000, available_at: null },
        { amount_cents: 7000, available_at: "2026-02-10T00:00:00.000Z" },
      ],
      error: null,
    });
    const estimate = await estimateNextPayout(
      supa.client as unknown as SupabaseClient,
      "doc1",
      now
    );
    expect(estimate.eligibleCents).toBe(7000);
    expect(estimate.eligibleCount).toBe(1);
  });
});

describe("listPayoutsWithDocuments", () => {
  let supa: ReturnType<typeof createSupabaseMock>;
  beforeEach(() => {
    supa = createSupabaseMock();
  });

  it("retorna lista vazia quando não há payouts", async () => {
    supa.enqueue("doctor_payouts", { data: [], error: null });
    const rows = await listPayoutsWithDocuments(
      supa.client as unknown as SupabaseClient,
      "doc1"
    );
    expect(rows).toEqual([]);
  });

  it("junta documento pelo payout_id", async () => {
    supa.enqueue("doctor_payouts", {
      data: [
        {
          id: "p1",
          reference_period: "2026-02",
          amount_cents: 10000,
          earnings_count: 3,
          status: "confirmed",
          paid_at: "2026-03-02T09:00:00.000Z",
          confirmed_at: "2026-03-02T15:00:00.000Z",
          auto_generated: true,
          created_at: "2026-03-01T09:15:00.000Z",
        },
        {
          id: "p2",
          reference_period: "2026-01",
          amount_cents: 5000,
          earnings_count: 1,
          status: "confirmed",
          paid_at: "2026-02-02T09:00:00.000Z",
          confirmed_at: "2026-02-02T15:00:00.000Z",
          auto_generated: false,
          created_at: "2026-02-01T09:15:00.000Z",
        },
      ],
      error: null,
    });
    supa.enqueue("doctor_billing_documents", {
      data: [
        {
          id: "d1",
          payout_id: "p1",
          uploaded_at: "2026-03-05T10:00:00.000Z",
          validated_at: null,
          document_number: "001",
          document_amount_cents: 10000,
        },
      ],
      error: null,
    });

    const rows = await listPayoutsWithDocuments(
      supa.client as unknown as SupabaseClient,
      "doc1"
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe("p1");
    expect(rows[0].document?.documentNumber).toBe("001");
    expect(rows[0].document?.validatedAt).toBeNull();
    expect(rows[1].id).toBe("p2");
    expect(rows[1].document).toBeNull();
  });
});

describe("countPendingBillingDocuments", () => {
  let supa: ReturnType<typeof createSupabaseMock>;
  beforeEach(() => {
    supa = createSupabaseMock();
  });

  it("distingue pendingUpload (sem doc) de awaitingValidation (doc sem validated_at)", async () => {
    supa.enqueue("doctor_payouts", {
      data: [
        {
          id: "p1",
          doctor_id: "doc1",
          doctor_billing_documents: [],
        },
        {
          id: "p2",
          doctor_id: "doc1",
          doctor_billing_documents: null,
        },
        {
          id: "p3",
          doctor_id: "doc1",
          doctor_billing_documents: [
            { id: "d1", validated_at: null },
          ],
        },
        {
          id: "p4",
          doctor_id: "doc1",
          doctor_billing_documents: [
            { id: "d2", validated_at: "2026-04-05T10:00:00.000Z" },
          ],
        },
      ],
      error: null,
    });

    const counts = await countPendingBillingDocuments(
      supa.client as unknown as SupabaseClient,
      "doc1"
    );
    expect(counts.pendingUpload).toBe(2);
    expect(counts.awaitingValidation).toBe(1);
  });

  it("retorna zero quando todos payouts já têm NF validada", async () => {
    supa.enqueue("doctor_payouts", {
      data: [
        {
          id: "p1",
          doctor_id: "doc1",
          doctor_billing_documents: [
            { id: "d1", validated_at: "2026-03-10T00:00:00.000Z" },
          ],
        },
      ],
      error: null,
    });
    const counts = await countPendingBillingDocuments(
      supa.client as unknown as SupabaseClient
    );
    expect(counts.pendingUpload).toBe(0);
    expect(counts.awaitingValidation).toBe(0);
  });
});
