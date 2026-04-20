/**
 * Testes de promoteFulfillmentAfterPayment (D-044 · 2.D).
 */

import { describe, expect, it } from "vitest";
import { createSupabaseMock } from "../test/mocks/supabase";
import {
  composePaidWhatsAppMessage,
  promoteFulfillmentAfterPayment,
} from "./fulfillment-promote";

function mkFf(overrides?: Record<string, unknown>) {
  return {
    id: "ff-1",
    status: "pending_payment",
    customer_id: "cust-1",
    payment_id: "pay-1",
    customer: { id: "cust-1", name: "Maria da Silva", phone: "5511999999999" },
    plan: { id: "plan-1", name: "Tirzepatida 90 dias" },
    ...overrides,
  };
}

describe("promoteFulfillmentAfterPayment · happy path", () => {
  it("promove pending_payment → paid quando paymentId está vinculado", async () => {
    const supa = createSupabaseMock();
    // 1) SELECT fulfillments by payment_id
    supa.enqueue("fulfillments", { data: mkFf(), error: null });
    // 2) UPDATE fulfillments → paid
    supa.enqueue("fulfillments", {
      data: { id: "ff-1", status: "paid" },
      error: null,
    });

    const res = await promoteFulfillmentAfterPayment(supa.client as never, {
      paymentId: "pay-1",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.wasPromoted).toBe(true);
    expect(res.alreadyPaid).toBe(false);
    expect(res.status).toBe("paid");
    expect(res.fulfillmentId).toBe("ff-1");
    expect(res.customerPhone).toBe("5511999999999");
    expect(res.planName).toBe("Tirzepatida 90 dias");
  });

  it("resolve paymentId a partir do asaasPaymentId quando local não foi passado", async () => {
    const supa = createSupabaseMock();
    // 1) resolve local id via asaas_payment_id
    supa.enqueue("payments", { data: { id: "pay-1" }, error: null });
    // 2) select fulfillments
    supa.enqueue("fulfillments", { data: mkFf(), error: null });
    // 3) update
    supa.enqueue("fulfillments", {
      data: { id: "ff-1", status: "paid" },
      error: null,
    });

    const res = await promoteFulfillmentAfterPayment(supa.client as never, {
      asaasPaymentId: "asaas-xyz",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.wasPromoted).toBe(true);
  });
});

describe("promoteFulfillmentAfterPayment · idempotência", () => {
  it("retorna alreadyPaid quando status já é paid", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", {
      data: mkFf({ status: "paid" }),
      error: null,
    });

    const res = await promoteFulfillmentAfterPayment(supa.client as never, {
      paymentId: "pay-1",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.wasPromoted).toBe(false);
    expect(res.alreadyPaid).toBe(true);
    expect(res.status).toBe("paid");
  });

  it("retorna alreadyPaid pra pharmacy_requested / shipped / delivered", async () => {
    for (const status of ["pharmacy_requested", "shipped", "delivered"]) {
      const supa = createSupabaseMock();
      supa.enqueue("fulfillments", {
        data: mkFf({ status }),
        error: null,
      });
      const res = await promoteFulfillmentAfterPayment(supa.client as never, {
        paymentId: "pay-1",
      });
      expect(res.ok).toBe(true);
      if (!res.ok) continue;
      expect(res.alreadyPaid).toBe(true);
      expect(res.wasPromoted).toBe(false);
      expect(res.status).toBe(status);
    }
  });

  it("trata race (UPDATE não casa linha) como idempotência", async () => {
    const supa = createSupabaseMock();
    // select pegou pending_payment
    supa.enqueue("fulfillments", { data: mkFf(), error: null });
    // mas update não bateu (outro worker promoveu)
    supa.enqueue("fulfillments", { data: null, error: null });

    const res = await promoteFulfillmentAfterPayment(supa.client as never, {
      paymentId: "pay-1",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.wasPromoted).toBe(false);
    expect(res.alreadyPaid).toBe(true);
    expect(res.status).toBe("paid");
  });
});

describe("promoteFulfillmentAfterPayment · estados inválidos", () => {
  it("rejeita fulfillment em pending_acceptance", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", {
      data: mkFf({ status: "pending_acceptance" }),
      error: null,
    });

    const res = await promoteFulfillmentAfterPayment(supa.client as never, {
      paymentId: "pay-1",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("invalid_state");
  });

  it("rejeita fulfillment cancelado", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", {
      data: mkFf({ status: "cancelled" }),
      error: null,
    });

    const res = await promoteFulfillmentAfterPayment(supa.client as never, {
      paymentId: "pay-1",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("invalid_state");
  });
});

describe("promoteFulfillmentAfterPayment · fallback sem payment_id vinculado", () => {
  it("encontra único fulfillment pendente do customer e amarra payment_id", async () => {
    const supa = createSupabaseMock();
    // 1) select fulfillments by payment_id → vazio
    supa.enqueue("fulfillments", { data: null, error: null });
    // 2) select payments → customer_id
    supa.enqueue("payments", {
      data: { customer_id: "cust-1" },
      error: null,
    });
    // 3) select fulfillments candidatos
    supa.enqueue("fulfillments", {
      data: [mkFf({ payment_id: null })],
      error: null,
    });
    // 4) update fulfillments link retroativo (payment_id)
    supa.enqueue("fulfillments", { data: null, error: null });
    // 5) UPDATE fulfillments → paid
    supa.enqueue("fulfillments", {
      data: { id: "ff-1", status: "paid" },
      error: null,
    });

    const res = await promoteFulfillmentAfterPayment(supa.client as never, {
      paymentId: "pay-1",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.wasPromoted).toBe(true);
  });

  it("aborta com ambiguous_fulfillment quando há múltiplos candidatos", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", { data: null, error: null });
    supa.enqueue("payments", {
      data: { customer_id: "cust-1" },
      error: null,
    });
    supa.enqueue("fulfillments", {
      data: [mkFf({ id: "ff-1", payment_id: null }), mkFf({ id: "ff-2", payment_id: null })],
      error: null,
    });

    const res = await promoteFulfillmentAfterPayment(supa.client as never, {
      paymentId: "pay-1",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("ambiguous_fulfillment");
  });

  it("retorna fulfillment_not_found se não há candidatos pendentes", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", { data: null, error: null });
    supa.enqueue("payments", {
      data: { customer_id: "cust-1" },
      error: null,
    });
    supa.enqueue("fulfillments", { data: [], error: null });

    const res = await promoteFulfillmentAfterPayment(supa.client as never, {
      paymentId: "pay-1",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("fulfillment_not_found");
  });
});

describe("promoteFulfillmentAfterPayment · erros de entrada", () => {
  it("retorna payment_not_found quando asaas_payment_id não existe", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("payments", { data: null, error: null });

    const res = await promoteFulfillmentAfterPayment(supa.client as never, {
      asaasPaymentId: "asaas-inexistente",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("payment_not_found");
  });

  it("retorna payment_not_found quando não passa nenhum id", async () => {
    const supa = createSupabaseMock();
    const res = await promoteFulfillmentAfterPayment(supa.client as never, {});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("payment_not_found");
  });

  it("propaga db_error quando supabase devolve erro no select fulfillments", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", {
      data: null,
      error: { code: "XX000", message: "connection reset" },
    });

    const res = await promoteFulfillmentAfterPayment(supa.client as never, {
      paymentId: "pay-1",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("db_error");
  });
});

describe("composePaidWhatsAppMessage", () => {
  it("usa o primeiro nome do paciente e cita o plano", () => {
    const msg = composePaidWhatsAppMessage({
      customerName: "Maria da Silva",
      planName: "Tirzepatida 90 dias",
    });
    expect(msg).toContain("Maria");
    expect(msg).not.toContain("Silva");
    expect(msg).toContain("Tirzepatida 90 dias");
    expect(msg).toContain("pagamento");
  });

  it("fallback pra 'paciente' quando nome é vazio", () => {
    const msg = composePaidWhatsAppMessage({
      customerName: "",
      planName: "Plano X",
    });
    expect(msg).toContain("paciente");
  });
});
