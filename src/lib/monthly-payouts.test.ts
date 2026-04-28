/**
 * Testes de generateMonthlyPayouts (D-040, atualizados em PR-049 · D-098).
 *
 * Os testes passam `concurrency: 1` em todas as chamadas pra preservar a
 * semântica FIFO do mock Supabase (`createSupabaseMock` usa fila per-tabela
 * — com paralelismo, dois processSingleDoctor concorrentes racem pelo
 * mesmo item da fila, gerando flakiness). Em produção, default é 8.
 *
 * Há um teste dedicado abaixo (`concurrency=2 · 2 médicas em paralelo`)
 * que valida o caminho concorrente real, com mock customizado pra
 * tolerar ordem de resolução não-determinística.
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
      { referencePeriod: "2026-03", concurrency: 1 }
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
      { referencePeriod: "2026-03", concurrency: 1 }
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
      { referencePeriod: "2026-03", concurrency: 1 }
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
      { referencePeriod: "2026-03", concurrency: 1 }
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
      { referencePeriod: "2026-03", concurrency: 1 }
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
      { referencePeriod: "2026-03", concurrency: 1 }
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
      { referencePeriod: "2026-03", concurrency: 1 }
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
      { referencePeriod: "2026-03", concurrency: 1 }
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
    supa.enqueue("doctor_earnings", { data: [], error: null }); // reconcile d1
    supa.enqueue("doctor_payouts", { data: { id: "p2" }, error: null });
    supa.enqueue("doctor_earnings", { data: [{ id: "e2" }], error: null });
    supa.enqueue("doctor_earnings", { data: [], error: null }); // reconcile d2

    const r = await generateMonthlyPayouts(
      supa.client as unknown as SupabaseClient,
      { referencePeriod: "2026-03", concurrency: 1 }
    );
    expect(r.payoutsCreated).toBe(2);
    expect(r.doctorsEvaluated).toBe(2);
    expect(r.earningsLinked).toBe(2);
    expect(r.totalCentsDrafted).toBe(50000);
    expect(r.errors).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────
  // D-062 · PR-051 · finding 5.5 — reconciliação pós-clawback
  // ─────────────────────────────────────────────────────────────────────

  it("5.5 · clawback positivo chega entre select e update → é reconciliado ao payout", async () => {
    // Estado inicial: e1 (+20000), e2 (+4000), sum=24000.
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
    // INSERT payout
    supa.enqueue("doctor_payouts", { data: { id: "p-new" }, error: null });
    // UPDATE earnings inicial (linkou e1, e2)
    supa.enqueue("doctor_earnings", {
      data: [{ id: "e1" }, { id: "e2" }],
      error: null,
    });
    // Reconcile iter 1: SELECT extras — webhook criou clawback e3=-4000
    supa.enqueue("doctor_earnings", {
      data: [{ id: "e3", amount_cents: -4000 }],
      error: null,
    });
    // Reconcile iter 1: UPDATE extras
    supa.enqueue("doctor_earnings", {
      data: [{ id: "e3", amount_cents: -4000 }],
      error: null,
    });
    // Reconcile iter 2: SELECT extras (vazio — convergiu)
    supa.enqueue("doctor_earnings", { data: [], error: null });
    // Adjust payout amount (não ≤ 0 — amount final = 20000)
    supa.enqueue("doctor_payouts", { data: null, error: null });

    const r = await generateMonthlyPayouts(
      supa.client as unknown as SupabaseClient,
      { referencePeriod: "2026-03", concurrency: 1 }
    );

    expect(r.payoutsCreated).toBe(1);
    expect(r.earningsLinked).toBe(3); // e1 + e2 + e3
    expect(r.totalCentsDrafted).toBe(20000); // 24000 - 4000
    expect(r.errors).toBe(0);

    const reconciled = r.warnings.find(
      (w) => w.reason === "clawback_reconciled"
    );
    expect(reconciled).toBeDefined();
    expect(reconciled!.amountCents).toBe(20000);
    expect(reconciled!.earningsCount).toBe(3);

    // Verifica que fez UPDATE em doctor_payouts com o novo amount
    const adjustCalls = supa.calls.filter(
      (c) =>
        c.table === "doctor_payouts" &&
        c.chain.includes("update") &&
        !c.chain.includes("insert")
    );
    expect(adjustCalls.length).toBeGreaterThanOrEqual(1);
    const adjustPayload = adjustCalls[0].args[
      adjustCalls[0].chain.indexOf("update")
    ][0] as { amount_cents: number; earnings_count: number };
    expect(adjustPayload.amount_cents).toBe(20000);
    expect(adjustPayload.earnings_count).toBe(3);
  });

  it("5.5 · clawback dominante (sum final ≤ 0) → payout auto-cancelado + earnings liberadas", async () => {
    // Estado inicial: e1 (+10000). Sum=+10000 no SELECT inicial.
    supa.enqueue("doctor_earnings", {
      data: [{ id: "e1", doctor_id: "d1", amount_cents: 10000 }],
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
          pix_key: "k1",
          pix_key_type: "EMAIL",
          pix_key_holder: "A",
        },
      ],
      error: null,
    });
    supa.enqueue("doctor_payouts", { data: { id: "p1" }, error: null });
    // UPDATE inicial linka e1
    supa.enqueue("doctor_earnings", { data: [{ id: "e1" }], error: null });
    // Reconcile iter 1: webhook criou 2 clawbacks (-6000, -5000) = -11000
    supa.enqueue("doctor_earnings", {
      data: [
        { id: "e2", amount_cents: -6000 },
        { id: "e3", amount_cents: -5000 },
      ],
      error: null,
    });
    supa.enqueue("doctor_earnings", {
      data: [
        { id: "e2", amount_cents: -6000 },
        { id: "e3", amount_cents: -5000 },
      ],
      error: null,
    });
    // Reconcile iter 2: vazio
    supa.enqueue("doctor_earnings", { data: [], error: null });
    // Adjust amount (-1000) — ok
    supa.enqueue("doctor_payouts", { data: null, error: null });
    // Auto-cancel payout (amount ≤ 0)
    supa.enqueue("doctor_payouts", { data: null, error: null });
    // Release earnings (payout_id=null, status=available)
    supa.enqueue("doctor_earnings", { data: null, error: null });

    const r = await generateMonthlyPayouts(
      supa.client as unknown as SupabaseClient,
      { referencePeriod: "2026-03", concurrency: 1 }
    );

    // Payout não conta (foi cancelado automaticamente)
    expect(r.payoutsCreated).toBe(0);
    expect(r.earningsLinked).toBe(0);
    expect(r.totalCentsDrafted).toBe(0);
    expect(r.errors).toBe(0);

    // Warning dominant_cancelled com amount negativo
    const cancelled = r.warnings.find(
      (w) => w.reason === "clawback_dominant_cancelled"
    );
    expect(cancelled).toBeDefined();
    expect(cancelled!.amountCents).toBe(-1000); // 10000 - 11000
    expect(cancelled!.earningsCount).toBe(3);

    // E o `clawback_reconciled` foi removido (substituído pelo cancelled)
    expect(
      r.warnings.find((w) => w.reason === "clawback_reconciled")
    ).toBeUndefined();

    // Verifica que:
    //  (a) houve UPDATE em doctor_payouts com status='cancelled'
    //  (b) houve UPDATE em doctor_earnings liberando (payout_id=null)
    const cancelCall = supa.calls.find(
      (c) =>
        c.table === "doctor_payouts" &&
        c.chain.includes("update") &&
        (c.args[c.chain.indexOf("update")][0] as { status?: string }).status ===
          "cancelled"
    );
    expect(cancelCall).toBeDefined();

    const releaseCall = supa.calls.find((c) => {
      if (c.table !== "doctor_earnings" || !c.chain.includes("update"))
        return false;
      const payload = c.args[c.chain.indexOf("update")][0] as {
        payout_id?: string | null;
        status?: string;
      };
      return payload.payout_id === null && payload.status === "available";
    });
    expect(releaseCall).toBeDefined();
  });

  it("5.5 · reconcile não converge em 3 iters → warning reconcile_incomplete", async () => {
    supa.enqueue("doctor_earnings", {
      data: [{ id: "e1", doctor_id: "d1", amount_cents: 10000 }],
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
          pix_key: "k1",
          pix_key_type: "EMAIL",
          pix_key_holder: "A",
        },
      ],
      error: null,
    });
    supa.enqueue("doctor_payouts", { data: { id: "p1" }, error: null });
    supa.enqueue("doctor_earnings", { data: [{ id: "e1" }], error: null });
    // 3 iters de reconcile: cada uma encontra mais earnings pra linkar
    // (simulando tempestade contínua de webhooks)
    for (let i = 0; i < 3; i++) {
      supa.enqueue("doctor_earnings", {
        data: [{ id: `ex${i}`, amount_cents: 500 }],
        error: null,
      });
      supa.enqueue("doctor_earnings", {
        data: [{ id: `ex${i}`, amount_cents: 500 }],
        error: null,
      });
    }
    // Após 3 iters, faz a checagem final — ainda há 1 extra não convergido
    supa.enqueue("doctor_earnings", { data: [{ id: "still" }], error: null });
    // Adjust amount (extras foram linkados mesmo que não convergiu)
    supa.enqueue("doctor_payouts", { data: null, error: null });

    const r = await generateMonthlyPayouts(
      supa.client as unknown as SupabaseClient,
      { referencePeriod: "2026-03", concurrency: 1 }
    );

    expect(r.payoutsCreated).toBe(1);
    expect(r.warnings.some((w) => w.reason === "reconcile_incomplete")).toBe(
      true
    );
  });

  // ─────────────────────────────────────────────────────────────────────
  // PR-049 · D-098 — paralelismo configurável
  // ─────────────────────────────────────────────────────────────────────

  it("PR-049 · concurrency configurável aceita valores válidos sem crash", async () => {
    // Smoke test: garante que `concurrency` flui pra `processInBatches`
    // sem quebrar o caminho feliz. Mock simples (1 médica) então não
    // sofre da race condição da fila FIFO.
    supa.enqueue("doctor_earnings", {
      data: [{ id: "e1", doctor_id: "d1", amount_cents: 12345 }],
      error: null,
    });
    supa.enqueue("doctors", {
      data: [{ id: "d1", full_name: "Dr A", display_name: null, status: "active" }],
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
      ],
      error: null,
    });
    supa.enqueue("doctor_payouts", { data: { id: "p1" }, error: null });
    supa.enqueue("doctor_earnings", { data: [{ id: "e1" }], error: null });
    supa.enqueue("doctor_earnings", { data: [], error: null });

    const r = await generateMonthlyPayouts(
      supa.client as unknown as SupabaseClient,
      { referencePeriod: "2026-03", concurrency: 4 }
    );
    expect(r.payoutsCreated).toBe(1);
    expect(r.totalCentsDrafted).toBe(12345);
  });

  it("PR-049 · concurrency=0 é clampado a 1 (não trava)", async () => {
    supa.enqueue("doctor_earnings", { data: [], error: null });
    const r = await generateMonthlyPayouts(
      supa.client as unknown as SupabaseClient,
      { referencePeriod: "2026-03", concurrency: 0 }
    );
    expect(r.errors).toBe(0);
    expect(r.doctorsEvaluated).toBe(0);
  });

  it("PR-049 · concurrency > MAX é clampado (não estoura pool)", async () => {
    supa.enqueue("doctor_earnings", { data: [], error: null });
    const r = await generateMonthlyPayouts(
      supa.client as unknown as SupabaseClient,
      { referencePeriod: "2026-03", concurrency: 9999 }
    );
    expect(r.errors).toBe(0);
  });

  it("PR-049 · concurrency=NaN cai no default (não NaN-poisoned)", async () => {
    supa.enqueue("doctor_earnings", { data: [], error: null });
    const r = await generateMonthlyPayouts(
      supa.client as unknown as SupabaseClient,
      { referencePeriod: "2026-03", concurrency: Number.NaN }
    );
    expect(r.errors).toBe(0);
  });

  it("PR-049 · doctorsEvaluated reflete todas mesmo em paralelo", async () => {
    // 3 médicas, todas com PIX faltando — caminho síncrono curto
    // (não bate na fila FIFO de doctor_payouts), permite testar
    // paralelismo real sem flakiness.
    supa.enqueue("doctor_earnings", {
      data: [
        { id: "e1", doctor_id: "d1", amount_cents: 100 },
        { id: "e2", doctor_id: "d2", amount_cents: 200 },
        { id: "e3", doctor_id: "d3", amount_cents: 300 },
      ],
      error: null,
    });
    supa.enqueue("doctors", {
      data: [
        { id: "d1", full_name: "A", display_name: null, status: "active" },
        { id: "d2", full_name: "B", display_name: null, status: "active" },
        { id: "d3", full_name: "C", display_name: null, status: "active" },
      ],
      error: null,
    });
    supa.enqueue("doctor_payment_methods", {
      data: [], // todas faltam PIX
      error: null,
    });
    const r = await generateMonthlyPayouts(
      supa.client as unknown as SupabaseClient,
      { referencePeriod: "2026-03", concurrency: 8 }
    );
    expect(r.doctorsEvaluated).toBe(3);
    expect(r.payoutsSkippedMissingPix).toBe(3);
    expect(r.payoutsCreated).toBe(0);
    expect(r.warnings).toHaveLength(3);
    // Ordem das warnings reflete ordem de doctorIds (determinismo).
    expect(r.warnings.map((w) => w.doctorId)).toEqual(["d1", "d2", "d3"]);
  });
});
