/**
 * Testes do cron auto-deliver-fulfillments (D-045 · 3.C).
 *
 * Estratégia: mockamos `transitionFulfillment` e `sendText` (dependências
 * externas) e verificamos o orquestrador (query, guards, relatório).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSupabaseMock } from "@/test/mocks/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/fulfillment-transitions", () => ({
  transitionFulfillment: vi.fn(),
}));
vi.mock("@/lib/whatsapp", () => ({
  sendText: vi.fn(),
}));

import { transitionFulfillment } from "@/lib/fulfillment-transitions";
import { sendText } from "@/lib/whatsapp";
import {
  autoDeliverFulfillments,
  SHIPPED_TO_DELIVERED_DAYS,
} from "./auto-deliver-fulfillments";

const transMock = vi.mocked(transitionFulfillment);
const waMock = vi.mocked(sendText);

function ffRow(
  over: Partial<{
    id: string;
    customer_id: string;
    shipped_at: string;
    customers: { name: string | null; phone: string | null } | null;
    plans: { name: string | null } | null;
  }> = {}
) {
  return {
    id: over.id ?? "ff1",
    customer_id: over.customer_id ?? "c1",
    shipped_at: over.shipped_at ?? "2026-04-01T10:00:00.000Z",
    customers:
      over.customers === undefined
        ? { name: "Maria Silva", phone: "+5511999998888" }
        : over.customers,
    plans:
      over.plans === undefined ? { name: "Tirzepatida 90d" } : over.plans,
  };
}

describe("autoDeliverFulfillments", () => {
  let supa: ReturnType<typeof createSupabaseMock>;
  // 20 dias depois do shipped_at default (> SHIPPED_TO_DELIVERED_DAYS)
  const now = new Date("2026-04-21T10:00:00.000Z");

  beforeEach(() => {
    supa = createSupabaseMock();
    transMock.mockReset();
    waMock.mockReset();
    transMock.mockResolvedValue({
      ok: true,
      fulfillmentId: "ff1",
      from: "shipped",
      to: "delivered",
      alreadyAtTarget: false,
    });
    waMock.mockResolvedValue({
      ok: true,
      messageId: "wamid.1",
      waId: "5511999998888",
    });
  });

  it("retorna zeros quando não há fulfillments elegíveis", async () => {
    supa.enqueue("fulfillments", { data: [], error: null });

    const r = await autoDeliverFulfillments(
      supa.client as unknown as SupabaseClient,
      { now }
    );

    expect(r.evaluated).toBe(0);
    expect(r.delivered).toBe(0);
    expect(transMock).not.toHaveBeenCalled();
    expect(waMock).not.toHaveBeenCalled();
  });

  it("propaga erro da query inicial", async () => {
    supa.enqueue("fulfillments", {
      data: null,
      error: { message: "boom" },
    });

    await expect(
      autoDeliverFulfillments(supa.client as unknown as SupabaseClient, { now })
    ).rejects.toThrow(/boom/);
  });

  it("transiciona fulfillment pra delivered e envia WA", async () => {
    supa.enqueue("fulfillments", { data: [ffRow()], error: null });

    const r = await autoDeliverFulfillments(
      supa.client as unknown as SupabaseClient,
      { now }
    );

    expect(r.evaluated).toBe(1);
    expect(r.delivered).toBe(1);
    expect(r.errors).toBe(0);
    expect(transMock).toHaveBeenCalledTimes(1);
    expect(transMock.mock.calls[0][1]).toMatchObject({
      fulfillmentId: "ff1",
      to: "delivered",
      actor: "system",
    });
    expect(waMock).toHaveBeenCalledTimes(1);
    expect(waMock.mock.calls[0][0].to).toBe("+5511999998888");
    expect(r.details[0].outcome).toBe("auto_delivered");
  });

  it("conta transition_failed quando transitionFulfillment falha", async () => {
    supa.enqueue("fulfillments", { data: [ffRow()], error: null });
    transMock.mockResolvedValueOnce({
      ok: false,
      code: "invalid_transition",
      message: "no.",
    });

    const r = await autoDeliverFulfillments(
      supa.client as unknown as SupabaseClient,
      { now }
    );

    expect(r.delivered).toBe(0);
    expect(r.errors).toBe(1);
    expect(r.details[0].outcome).toBe("transition_failed");
    expect(waMock).not.toHaveBeenCalled();
  });

  it("marca skipped_missing_phone mas conta como delivered", async () => {
    supa.enqueue("fulfillments", {
      data: [ffRow({ customers: { name: "Sem Fone", phone: null } })],
      error: null,
    });

    const r = await autoDeliverFulfillments(
      supa.client as unknown as SupabaseClient,
      { now }
    );

    expect(r.delivered).toBe(1);
    expect(r.skipped).toBe(1);
    expect(waMock).not.toHaveBeenCalled();
    expect(r.details[0].outcome).toBe("skipped_missing_phone");
  });

  it("registra wa_failed sem reverter a transition", async () => {
    supa.enqueue("fulfillments", { data: [ffRow()], error: null });
    waMock.mockResolvedValueOnce({
      ok: false,
      code: 131047,
      message: "fora da janela de 24h",
    });

    const r = await autoDeliverFulfillments(
      supa.client as unknown as SupabaseClient,
      { now }
    );

    expect(r.delivered).toBe(1);
    expect(r.details[0].outcome).toBe("wa_failed");
    expect(r.details[0].message).toContain("24h");
  });

  it("respeita maxPerRun via opts", async () => {
    supa.enqueue("fulfillments", { data: [], error: null });
    await autoDeliverFulfillments(
      supa.client as unknown as SupabaseClient,
      { now, maxPerRun: 5 }
    );

    const call = supa.calls[0];
    const limitIdx = call.chain.lastIndexOf("limit");
    expect(limitIdx).toBeGreaterThanOrEqual(0);
    expect(call.args[limitIdx][0]).toBe(5);
  });

  it("passa cutoff correto baseado em daysThreshold", async () => {
    supa.enqueue("fulfillments", { data: [], error: null });

    await autoDeliverFulfillments(
      supa.client as unknown as SupabaseClient,
      { now, daysThreshold: 10 }
    );

    const call = supa.calls[0];
    const ltIdx = call.chain.indexOf("lt");
    expect(ltIdx).toBeGreaterThanOrEqual(0);
    const [col, value] = call.args[ltIdx];
    expect(col).toBe("shipped_at");
    const expected = new Date(now.getTime() - 10 * 86400000).toISOString();
    expect(value).toBe(expected);
  });

  it("default daysThreshold = SHIPPED_TO_DELIVERED_DAYS", async () => {
    supa.enqueue("fulfillments", { data: [], error: null });
    await autoDeliverFulfillments(
      supa.client as unknown as SupabaseClient,
      { now }
    );
    const call = supa.calls[0];
    const ltIdx = call.chain.indexOf("lt");
    const expected = new Date(
      now.getTime() - SHIPPED_TO_DELIVERED_DAYS * 86400000
    ).toISOString();
    expect(call.args[ltIdx][1]).toBe(expected);
  });
});
