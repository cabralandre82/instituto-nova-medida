/**
 * Testes de createConsultationEarning e createClawback (PR-014 · D-050).
 *
 * Foco:
 *   1. Idempotência — chamar 2x com o mesmo payment_id não cria earning
 *      duplicado, mesmo em retry de webhook.
 *   2. Cria 1 earning para consulta 'scheduled'; cria 2 earnings para
 *      'on_demand' (consultation + on_demand_bonus).
 *   3. Usa a regra de compensação ativa (doctor_compensation_rules).
 *   4. Fallback pra defaults D-024 quando não existe regra.
 *   5. Clawback idempotente e só cancela earning ainda não paga.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createSupabaseMock } from "@/test/mocks/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createConsultationEarning, createClawback } from "./earnings";

describe("createConsultationEarning", () => {
  let supa: ReturnType<typeof createSupabaseMock>;

  beforeEach(() => {
    supa = createSupabaseMock();
  });

  it("cria earning de consultation para appointment 'scheduled'", async () => {
    // select existing (vazio)
    supa.enqueue("doctor_earnings", { data: [], error: null });
    // select doctor_compensation_rules
    supa.enqueue("doctor_compensation_rules", {
      data: { id: "rule1", consultation_cents: 20000, on_demand_bonus_cents: 4000 },
      error: null,
    });
    // insert doctor_earnings (consultation)
    supa.enqueue("doctor_earnings", {
      data: { id: "earn1" },
      error: null,
    });

    const result = await createConsultationEarning(
      supa.client as unknown as SupabaseClient,
      {
        paymentId: "pay1",
        doctorId: "d1",
        appointmentId: "appt1",
        appointmentKind: "scheduled",
        description: "Consulta · Maria",
      }
    );

    expect(result).toEqual({ ok: true, earningId: "earn1", created: true });

    // inseriu 1 earning só (scheduled não tem bônus)
    const inserts = supa.calls.filter(
      (c) => c.table === "doctor_earnings" && c.chain.includes("insert")
    );
    expect(inserts).toHaveLength(1);
    const payload = inserts[0].args[0]?.[0] as Record<string, unknown>;
    expect(payload.type).toBe("consultation");
    expect(payload.amount_cents).toBe(20000);
    expect(payload.compensation_rule_id).toBe("rule1");
    expect(payload.status).toBe("pending");

    // chamou o recálculo de availability
    expect(supa.rpcCalls).toEqual([
      { fn: "recalculate_earnings_availability", params: undefined },
    ]);
  });

  it("cria 2 earnings (consultation + on_demand_bonus) para 'on_demand'", async () => {
    supa.enqueue("doctor_earnings", { data: [], error: null });
    supa.enqueue("doctor_compensation_rules", {
      data: { id: "rule1", consultation_cents: 20000, on_demand_bonus_cents: 4000 },
      error: null,
    });
    supa.enqueue("doctor_earnings", {
      data: { id: "earn1" },
      error: null,
    });
    // insert do bônus
    supa.enqueue("doctor_earnings", { data: null, error: null });

    const result = await createConsultationEarning(
      supa.client as unknown as SupabaseClient,
      {
        paymentId: "pay1",
        doctorId: "d1",
        appointmentId: "appt1",
        appointmentKind: "on_demand",
      }
    );

    expect(result.ok).toBe(true);

    const inserts = supa.calls.filter(
      (c) => c.table === "doctor_earnings" && c.chain.includes("insert")
    );
    expect(inserts).toHaveLength(2);

    const firstPayload = inserts[0].args[0]?.[0] as Record<string, unknown>;
    const secondPayload = inserts[1].args[0]?.[0] as Record<string, unknown>;

    expect(firstPayload.type).toBe("consultation");
    expect(secondPayload.type).toBe("on_demand_bonus");
    expect(secondPayload.amount_cents).toBe(4000);
  });

  it("é idempotente — não cria 2º earning se já existe um para o mesmo payment_id", async () => {
    // select existing: já tem earning
    supa.enqueue("doctor_earnings", {
      data: [{ id: "earn-existing", type: "consultation" }],
      error: null,
    });

    const result = await createConsultationEarning(
      supa.client as unknown as SupabaseClient,
      {
        paymentId: "pay1",
        doctorId: "d1",
        appointmentKind: "scheduled",
      }
    );

    expect(result).toEqual({
      ok: true,
      earningId: "earn-existing",
      created: false,
    });

    // Não tocou em compensation_rules nem fez insert — nem recalc.
    const inserts = supa.calls.filter(
      (c) => c.table === "doctor_earnings" && c.chain.includes("insert")
    );
    expect(inserts).toHaveLength(0);
    expect(supa.rpcCalls).toHaveLength(0);
  });

  it("fallback pra defaults D-024 quando não existe regra ativa", async () => {
    supa.enqueue("doctor_earnings", { data: [], error: null });
    // select rule vazio (caso patológico)
    supa.enqueue("doctor_compensation_rules", { data: null, error: null });
    supa.enqueue("doctor_earnings", {
      data: { id: "earn-default" },
      error: null,
    });

    const result = await createConsultationEarning(
      supa.client as unknown as SupabaseClient,
      { paymentId: "pay1", doctorId: "d1", appointmentKind: "scheduled" }
    );

    expect(result.ok).toBe(true);

    const inserts = supa.calls.filter(
      (c) => c.table === "doctor_earnings" && c.chain.includes("insert")
    );
    const payload = inserts[0].args[0]?.[0] as Record<string, unknown>;
    expect(payload.amount_cents).toBe(20000); // default D-024
    expect(payload.compensation_rule_id).toBeNull();
  });

  it("retorna erro quando insert do earning principal falha", async () => {
    supa.enqueue("doctor_earnings", { data: [], error: null });
    supa.enqueue("doctor_compensation_rules", {
      data: { id: "rule1", consultation_cents: 20000, on_demand_bonus_cents: 4000 },
      error: null,
    });
    supa.enqueue("doctor_earnings", {
      data: null,
      error: { message: "constraint violation" },
    });

    const result = await createConsultationEarning(
      supa.client as unknown as SupabaseClient,
      { paymentId: "pay1", doctorId: "d1", appointmentKind: "scheduled" }
    );

    expect(result).toEqual({
      ok: false,
      error: "constraint violation",
    });
  });
});

describe("createClawback", () => {
  let supa: ReturnType<typeof createSupabaseMock>;

  beforeEach(() => {
    supa = createSupabaseMock();
  });

  it("retorna 0 clawbacks quando não existe earning positivo no payment", async () => {
    supa.enqueue("doctor_earnings", { data: [], error: null });
    const result = await createClawback(supa.client as unknown as SupabaseClient, {
      paymentId: "pay1",
      doctorId: "d1",
      reason: "Estorno",
    });
    expect(result).toEqual({ ok: true, clawbacks: 0 });
  });

  it("cria clawback negativo e cancela earning pending", async () => {
    // select parents
    supa.enqueue("doctor_earnings", {
      data: [
        {
          id: "earn1",
          doctor_id: "d1",
          amount_cents: 20000,
          status: "pending",
          type: "consultation",
          payment_id: "pay1",
        },
      ],
      error: null,
    });
    // select existing clawback (none)
    supa.enqueue("doctor_earnings", { data: null, error: null });
    // insert clawback
    supa.enqueue("doctor_earnings", { data: null, error: null });
    // update (cancel original)
    supa.enqueue("doctor_earnings", { data: null, error: null });

    const result = await createClawback(supa.client as unknown as SupabaseClient, {
      paymentId: "pay1",
      doctorId: "d1",
      reason: "Chargeback",
    });

    expect(result).toEqual({ ok: true, clawbacks: 1 });

    // Clawback inserido com valor negativo
    const inserts = supa.calls.filter(
      (c) => c.table === "doctor_earnings" && c.chain.includes("insert")
    );
    expect(inserts).toHaveLength(1);
    const payload = inserts[0].args[0]?.[0] as Record<string, unknown>;
    expect(payload.type).toBe("refund_clawback");
    expect(payload.amount_cents).toBe(-20000);
    expect(payload.parent_earning_id).toBe("earn1");
    expect(payload.status).toBe("available");

    // Update cancelou a original
    const updates = supa.calls.filter(
      (c) => c.table === "doctor_earnings" && c.chain.includes("update")
    );
    expect(updates).toHaveLength(1);
    const updatePayload = updates[0].args[0]?.[0] as Record<string, unknown>;
    expect(updatePayload.status).toBe("cancelled");
    expect(updatePayload.cancelled_reason).toBe("Chargeback");
  });

  it("é idempotente — não cria clawback duplicado se já existe um com o mesmo parent", async () => {
    supa.enqueue("doctor_earnings", {
      data: [
        {
          id: "earn1",
          doctor_id: "d1",
          amount_cents: 20000,
          status: "pending",
          type: "consultation",
          payment_id: "pay1",
        },
      ],
      error: null,
    });
    // select existing clawback — JÁ EXISTE
    supa.enqueue("doctor_earnings", {
      data: { id: "claw-existing" },
      error: null,
    });

    const result = await createClawback(supa.client as unknown as SupabaseClient, {
      paymentId: "pay1",
      doctorId: "d1",
      reason: "Estorno",
    });

    expect(result).toEqual({ ok: true, clawbacks: 0 });

    // Não inseriu novo clawback
    const inserts = supa.calls.filter(
      (c) => c.table === "doctor_earnings" && c.chain.includes("insert")
    );
    expect(inserts).toHaveLength(0);
  });

  it("cria clawback mas NÃO cancela earning já 'paid' (já foi pra médica via payout)", async () => {
    supa.enqueue("doctor_earnings", {
      data: [
        {
          id: "earn1",
          doctor_id: "d1",
          amount_cents: 20000,
          status: "paid", // já virou cash na conta da médica
          type: "consultation",
          payment_id: "pay1",
        },
      ],
      error: null,
    });
    supa.enqueue("doctor_earnings", { data: null, error: null }); // no existing clawback
    supa.enqueue("doctor_earnings", { data: null, error: null }); // insert clawback

    const result = await createClawback(supa.client as unknown as SupabaseClient, {
      paymentId: "pay1",
      doctorId: "d1",
      reason: "Estorno",
    });

    expect(result).toEqual({ ok: true, clawbacks: 1 });

    // Inseriu clawback negativo, mas NÃO cancelou o pai (não dá pra cancelar o que já foi pago)
    const updates = supa.calls.filter(
      (c) => c.table === "doctor_earnings" && c.chain.includes("update")
    );
    expect(updates).toHaveLength(0);
  });
});
