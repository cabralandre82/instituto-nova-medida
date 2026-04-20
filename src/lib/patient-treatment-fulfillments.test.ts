/**
 * Testes de listActiveFulfillments (D-044 · 2.F).
 */

import { describe, expect, it } from "vitest";
import { createSupabaseMock } from "../test/mocks/supabase";
import { listActiveFulfillments } from "./patient-treatment";

function mkRow(overrides: Record<string, unknown>) {
  return {
    id: "ff-1",
    status: "shipped",
    appointment_id: "appt-1",
    paid_at: "2026-04-10T10:00:00.000Z",
    pharmacy_requested_at: "2026-04-12T10:00:00.000Z",
    shipped_at: "2026-04-15T10:00:00.000Z",
    tracking_note: "Correios BR123456789BR",
    shipping_city: "São Paulo",
    shipping_state: "SP",
    plan: { name: "Tirzepatida 90 dias", medication: "Tirzepatida 5mg" },
    doctor: { full_name: "Dra. Maria", display_name: "Dra. Maria da Silva" },
    ...overrides,
  };
}

describe("listActiveFulfillments", () => {
  it("retorna lista mapeada nos 3 status ativos", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", {
      data: [
        mkRow({ id: "ff-paid", status: "paid" }),
        mkRow({ id: "ff-pharm", status: "pharmacy_requested" }),
        mkRow({ id: "ff-ship", status: "shipped" }),
      ],
      error: null,
    });

    const rows = await listActiveFulfillments(supa.client as never, "cust-1");
    expect(rows).toHaveLength(3);
    expect(rows[0].status).toBe("paid");
    expect(rows[1].status).toBe("pharmacy_requested");
    expect(rows[2].status).toBe("shipped");
    expect(rows[2].trackingNote).toBe("Correios BR123456789BR");
    expect(rows[2].doctorName).toBe("Dra. Maria da Silva");
  });

  it("filtra por customer_id no .eq e usa .in nos status ativos", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", { data: [], error: null });

    await listActiveFulfillments(supa.client as never, "cust-42");

    const call = supa.calls.find((c) => c.table === "fulfillments");
    expect(call).toBeTruthy();
    expect(call!.chain).toContain("eq");
    expect(call!.chain).toContain("in");

    const eqArgs = call!.args[call!.chain.indexOf("eq")];
    expect(eqArgs[0]).toBe("customer_id");
    expect(eqArgs[1]).toBe("cust-42");

    const inArgs = call!.args[call!.chain.indexOf("in")];
    expect(inArgs[0]).toBe("status");
    expect(inArgs[1]).toEqual(["paid", "pharmacy_requested", "shipped"]);
  });

  it("NÃO inclui delivered ou cancelled (ficam fora da visão de ação)", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", { data: [], error: null });

    await listActiveFulfillments(supa.client as never, "cust-1");

    const call = supa.calls.find((c) => c.table === "fulfillments");
    const inArgs = call!.args[call!.chain.indexOf("in")];
    expect(inArgs[1]).not.toContain("delivered");
    expect(inArgs[1]).not.toContain("cancelled");
    expect(inArgs[1]).not.toContain("pending_acceptance");
    expect(inArgs[1]).not.toContain("pending_payment");
  });

  it("fallback do doctor usa full_name quando display_name é null", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", {
      data: [
        mkRow({
          doctor: { full_name: "Dra. Ana Souza", display_name: null },
        }),
      ],
      error: null,
    });

    const rows = await listActiveFulfillments(supa.client as never, "cust-1");
    expect(rows[0].doctorName).toBe("Dra. Ana Souza");
  });

  it("normaliza relação que veio como array (Supabase pode retornar qualquer formato)", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", {
      data: [
        mkRow({
          plan: [{ name: "Semaglutida 90", medication: "Semaglutida 1mg" }],
          doctor: [{ full_name: "Dra. X", display_name: "Dra. X" }],
        }),
      ],
      error: null,
    });

    const rows = await listActiveFulfillments(supa.client as never, "cust-1");
    expect(rows[0].planName).toBe("Semaglutida 90");
    expect(rows[0].doctorName).toBe("Dra. X");
  });

  it("data null vira [] (paciente sem fulfillment ativo não quebra dashboard)", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", { data: null, error: null });

    const rows = await listActiveFulfillments(supa.client as never, "cust-1");
    expect(rows).toEqual([]);
  });

  it("propaga erro do supabase com mensagem clara", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", {
      data: null,
      error: { code: "XX000", message: "connection reset" },
    });

    await expect(
      listActiveFulfillments(supa.client as never, "cust-1")
    ).rejects.toThrow(/listActiveFulfillments.*connection reset/);
  });

  it("ordenação desc por created_at e limit 10", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", { data: [], error: null });

    await listActiveFulfillments(supa.client as never, "cust-1");

    const call = supa.calls.find((c) => c.table === "fulfillments")!;
    const orderArgs = call.args[call.chain.indexOf("order")];
    expect(orderArgs[0]).toBe("created_at");
    expect(orderArgs[1]).toEqual({ ascending: false });

    const limitArgs = call.args[call.chain.indexOf("limit")];
    expect(limitArgs[0]).toBe(10);
  });
});
