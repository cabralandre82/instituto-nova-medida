/**
 * Testes de generateMonthlyPayouts (D-040).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createSupabaseMock } from "@/test/mocks/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  generateMonthlyPayouts,
  defaultReferencePeriod,
  currentMonthStartIso,
} from "./monthly-payouts";

describe("defaultReferencePeriod", () => {
  it("mês atual fevereiro → retorna YYYY-01", () => {
    const got = defaultReferencePeriod(new Date(Date.UTC(2026, 1, 15)));
    expect(got).toBe("2026-01");
  });

  it("janeiro → retorna dezembro do ano anterior", () => {
    const got = defaultReferencePeriod(new Date(Date.UTC(2026, 0, 5)));
    expect(got).toBe("2025-12");
  });

  it("dezembro → retorna novembro do mesmo ano", () => {
    const got = defaultReferencePeriod(new Date(Date.UTC(2026, 11, 1)));
    expect(got).toBe("2026-11");
  });

  it("formato sempre YYYY-MM com zero à esquerda", () => {
    const got = defaultReferencePeriod(new Date(Date.UTC(2026, 9, 1)));
    expect(got).toBe("2026-09");
  });
});

describe("currentMonthStartIso", () => {
  it("retorna primeiro dia do mês UTC às 00:00", () => {
    const got = currentMonthStartIso(new Date(Date.UTC(2026, 3, 20, 15, 30)));
    expect(got).toBe("2026-04-01T00:00:00.000Z");
  });
});

describe("generateMonthlyPayouts", () => {
  let supa: ReturnType<typeof createSupabaseMock>;

  beforeEach(() => {
    supa = createSupabaseMock();
  });

  it("zero earnings available → retorna sem fazer nada", async () => {
    supa.enqueue("doctor_earnings", { data: [], error: null });
    const r = await generateMonthlyPayouts(
      supa.client as unknown as SupabaseClient,
      { referencePeriod: "2026-03" }
    );
    expect(r.doctorsEvaluated).toBe(0);
    expect(r.payoutsCreated).toBe(0);
    expect(r.totalCentsDrafted).toBe(0);
    expect(r.errors).toBe(0);
  });

  it("happy path: 1 médica ativa com earnings + PIX → cria 1 payout draft", async () => {
    supa.enqueue("doctor_earnings", {
      data: [
        { id: "e1", doctor_id: "d1", amount_cents: 20000 },
        { id: "e2", doctor_id: "d1", amount_cents: 4000 },
      ],
      error: null,
    });
    supa.enqueue("doctors", {
      data: [
        {
          id: "d1",
          full_name: "Dra. A",
          display_name: "Dra. A",
          status: "active",
        },
      ],
      error: null,
    });
    supa.enqueue("doctor_payment_methods", {
      data: [
        {
          doctor_id: "d1",
          pix_key: "chave",
          pix_key_type: "EMAIL",
          pix_key_holder: "Dra. A",
        },
      ],
      error: null,
    });
    supa.enqueue("doctor_payouts", {
      data: { id: "p-new" },
      error: null,
    });
    supa.enqueue("doctor_earnings", {
      data: [{ id: "e1" }, { id: "e2" }],
      error: null,
    });

    const r = await generateMonthlyPayouts(
      supa.client as unknown as SupabaseClient,
      { referencePeriod: "2026-03" }
    );

    expect(r.payoutsCreated).toBe(1);
    expect(r.payoutsSkippedExisting).toBe(0);
    expect(r.payoutsSkippedMissingPix).toBe(0);
    expect(r.earningsLinked).toBe(2);
    expect(r.totalCentsDrafted).toBe(24000);
    expect(r.warnings).toHaveLength(0);

    const insertCall = supa.calls.find(
      (c) => c.table === "doctor_payouts" && c.chain.includes("insert")
    );
    expect(insertCall).toBeDefined();
    const payload = insertCall!.args[insertCall!.chain.indexOf("insert")][0] as {
      auto_generated: boolean;
      amount_cents: number;
      status: string;
      reference_period: string;
    };
    expect(payload.auto_generated).toBe(true);
    expect(payload.status).toBe("draft");
    expect(payload.reference_period).toBe("2026-03");
    expect(payload.amount_cents).toBe(24000);
  });

  it("médica sem pix_key ativo → pula com warning pix missing", async () => {
    supa.enqueue("doctor_earnings", {
      data: [{ id: "e1", doctor_id: "d1", amount_cents: 20000 }],
      error: null,
    });
    supa.enqueue("doctors", {
      data: [
        {
          id: "d1",
          full_name: "Dra. A",
          display_name: null,
          status: "active",
        },
      ],
      error: null,
    });
    supa.enqueue("doctor_payment_methods", { data: [], error: null });

    const r = await generateMonthlyPayouts(
      supa.client as unknown as SupabaseClient,
      { referencePeriod: "2026-03" }
    );

    expect(r.payoutsCreated).toBe(0);
    expect(r.payoutsSkippedMissingPix).toBe(1);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].reason).toBe("missing_pix_active");
    expect(r.warnings[0].amountCents).toBe(20000);
  });

  it("pix_key vazia → reason pix_key_empty", async () => {
    supa.enqueue("doctor_earnings", {
      data: [{ id: "e1", doctor_id: "d1", amount_cents: 20000 }],
      error: null,
    });
    supa.enqueue("doctors", {
      data: [
        {
          id: "d1",
          full_name: "Dra. A",
          display_name: null,
          status: "active",
        },
      ],
      error: null,
    });
    supa.enqueue("doctor_payment_methods", {
      data: [
        {
          doctor_id: "d1",
          pix_key: "   ",
          pix_key_type: "EMAIL",
          pix_key_holder: null,
        },
      ],
      error: null,
    });

    const r = await generateMonthlyPayouts(
      supa.client as unknown as SupabaseClient,
      { referencePeriod: "2026-03" }
    );
    expect(r.payoutsCreated).toBe(0);
    expect(r.payoutsSkippedMissingPix).toBe(1);
    expect(r.warnings[0].reason).toBe("pix_key_empty");
  });

  it("médica inativa → pula com warning doctor_inactive", async () => {
    supa.enqueue("doctor_earnings", {
      data: [{ id: "e1", doctor_id: "d1", amount_cents: 20000 }],
      error: null,
    });
    supa.enqueue("doctors", {
      data: [
        {
          id: "d1",
          full_name: "Dra. A",
          display_name: null,
          status: "paused",
        },
      ],
      error: null,
    });
    supa.enqueue("doctor_payment_methods", {
      data: [
        {
          doctor_id: "d1",
          pix_key: "chave",
          pix_key_type: "EMAIL",
          pix_key_holder: "Dra. A",
        },
      ],
      error: null,
    });

    const r = await generateMonthlyPayouts(
      supa.client as unknown as SupabaseClient,
      { referencePeriod: "2026-03" }
    );
    expect(r.payoutsCreated).toBe(0);
    expect(r.payoutsSkippedMissingPix).toBe(1);
    expect(r.warnings[0].reason).toBe("doctor_inactive");
  });

  it("sum zero (clawback total) → descarta médica antes de criar payout", async () => {
    supa.enqueue("doctor_earnings", {
      data: [
        { id: "e1", doctor_id: "d1", amount_cents: 20000 },
        { id: "e2", doctor_id: "d1", amount_cents: -20000 },
      ],
      error: null,
    });

    const r = await generateMonthlyPayouts(
      supa.client as unknown as SupabaseClient,
      { referencePeriod: "2026-03" }
    );
    expect(r.doctorsEvaluated).toBe(0);
    expect(r.payoutsCreated).toBe(0);
    // Não deve ter consultado doctors nem payment_methods.
    expect(supa.calls.some((c) => c.table === "doctors")).toBe(false);
  });

  it("idempotência: unique violation (23505) → conta como skippedExisting, sem erro", async () => {
    supa.enqueue("doctor_earnings", {
      data: [{ id: "e1", doctor_id: "d1", amount_cents: 20000 }],
      error: null,
    });
    supa.enqueue("doctors", {
      data: [
        {
          id: "d1",
          full_name: "Dra. A",
          display_name: null,
          status: "active",
        },
      ],
      error: null,
    });
    supa.enqueue("doctor_payment_methods", {
      data: [
        {
          doctor_id: "d1",
          pix_key: "chave",
          pix_key_type: "EMAIL",
          pix_key_holder: "Dra. A",
        },
      ],
      error: null,
    });
    supa.enqueue("doctor_payouts", {
      data: null,
      error: { code: "23505", message: "duplicate key" },
    });

    const r = await generateMonthlyPayouts(
      supa.client as unknown as SupabaseClient,
      { referencePeriod: "2026-03" }
    );
    expect(r.payoutsCreated).toBe(0);
    expect(r.payoutsSkippedExisting).toBe(1);
    expect(r.errors).toBe(0);
    expect(r.warnings[0].reason).toBe("existing_payout");
  });

  it("erro real no insert (não 23505) → conta como errors, sem derrubar execução", async () => {
    supa.enqueue("doctor_earnings", {
      data: [
        { id: "e1", doctor_id: "d1", amount_cents: 20000 },
        { id: "e2", doctor_id: "d2", amount_cents: 20000 },
      ],
      error: null,
    });
    supa.enqueue("doctors", {
      data: [
        { id: "d1", full_name: "A", display_name: null, status: "active" },
        { id: "d2", full_name: "B", display_name: null, status: "active" },
      ],
      error: null,
    });
    supa.enqueue("doctor_payment_methods", {
      data: [
        {
          doctor_id: "d1",
          pix_key: "k1",
          pix_key_type: "EMAIL",
          pix_key_holder: "A",
        },
        {
          doctor_id: "d2",
          pix_key: "k2",
          pix_key_type: "EMAIL",
          pix_key_holder: "B",
        },
      ],
      error: null,
    });
    // Ordem determinística: Map preserva ordem de inserção. d1 primeiro.
    supa.enqueue("doctor_payouts", {
      data: null,
      error: { code: "XX000", message: "server broke" },
    });
    // d2 vai dar sucesso
    supa.enqueue("doctor_payouts", { data: { id: "p2" }, error: null });
    supa.enqueue("doctor_earnings", { data: [{ id: "e2" }], error: null });

    const r = await generateMonthlyPayouts(
      supa.client as unknown as SupabaseClient,
      { referencePeriod: "2026-03" }
    );
    expect(r.errors).toBeGreaterThanOrEqual(1);
    expect(r.payoutsCreated).toBe(1); // d2 passou
    expect(r.errorDetails.some((e) => e.includes("server broke"))).toBe(true);
  });

  it("2 médicas distintas com earnings válidas → cria 2 payouts", async () => {
    supa.enqueue("doctor_earnings", {
      data: [
        { id: "e1", doctor_id: "d1", amount_cents: 20000 },
        { id: "e2", doctor_id: "d2", amount_cents: 30000 },
      ],
      error: null,
    });
    supa.enqueue("doctors", {
      data: [
        { id: "d1", full_name: "A", display_name: null, status: "active" },
        { id: "d2", full_name: "B", display_name: null, status: "active" },
      ],
      error: null,
    });
    supa.enqueue("doctor_payment_methods", {
      data: [
        {
          doctor_id: "d1",
          pix_key: "k1",
          pix_key_type: "EMAIL",
          pix_key_holder: "A",
        },
        {
          doctor_id: "d2",
          pix_key: "k2",
          pix_key_type: "EMAIL",
          pix_key_holder: "B",
        },
      ],
      error: null,
    });
    supa.enqueue("doctor_payouts", { data: { id: "p1" }, error: null });
    supa.enqueue("doctor_earnings", { data: [{ id: "e1" }], error: null });
    supa.enqueue("doctor_payouts", { data: { id: "p2" }, error: null });
    supa.enqueue("doctor_earnings", { data: [{ id: "e2" }], error: null });

    const r = await generateMonthlyPayouts(
      supa.client as unknown as SupabaseClient,
      { referencePeriod: "2026-03" }
    );
    expect(r.payoutsCreated).toBe(2);
    expect(r.doctorsEvaluated).toBe(2);
    expect(r.earningsLinked).toBe(2);
    expect(r.totalCentsDrafted).toBe(50000);
    expect(r.errors).toBe(0);
  });
});
