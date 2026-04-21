/**
 * Testes do cron nudge-reconsulta (D-045 · 3.C).
 *
 * Valida:
 *   - `daysRemaining` em isolamento
 *   - orquestrador: janela de nudge, idempotência, skips por phone/cycle
 *   - erro de DB pós-WA é reportado mas não crasha
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSupabaseMock } from "@/test/mocks/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/whatsapp", () => ({
  sendText: vi.fn(),
}));

import { sendText } from "@/lib/whatsapp";
import {
  daysRemaining,
  nudgeReconsulta,
  NUDGE_WINDOW_DAYS,
} from "./nudge-reconsulta";

const waMock = vi.mocked(sendText);

function ffRow(
  over: Partial<{
    id: string;
    customer_id: string;
    delivered_at: string | null;
    customers: { name: string | null; phone: string | null } | null;
    plans: { name: string | null; cycle_days: number | null } | null;
  }> = {}
) {
  return {
    id: over.id ?? "ff1",
    customer_id: over.customer_id ?? "c1",
    delivered_at: over.delivered_at ?? "2026-01-20T10:00:00.000Z",
    customers:
      over.customers === undefined
        ? { name: "Maria Silva", phone: "+5511999998888" }
        : over.customers,
    plans:
      over.plans === undefined
        ? { name: "Tirzepatida 90d", cycle_days: 90 }
        : over.plans,
  };
}

describe("daysRemaining", () => {
  const now = new Date("2026-04-15T12:00:00.000Z");

  it("retorna null se delivered_at ausente", () => {
    expect(daysRemaining(now, null, 90)).toBeNull();
  });

  it("retorna null se cycle_days ausente ou <= 0", () => {
    expect(daysRemaining(now, "2026-01-15T12:00:00Z", null)).toBeNull();
    expect(daysRemaining(now, "2026-01-15T12:00:00Z", 0)).toBeNull();
    expect(daysRemaining(now, "2026-01-15T12:00:00Z", -1)).toBeNull();
  });

  it("retorna positivo quando ainda falta", () => {
    // delivered 2026-01-20 + 90d = 2026-04-20. now = 2026-04-15 → falta 5
    expect(
      daysRemaining(now, "2026-01-20T12:00:00Z", 90)
    ).toBe(5);
  });

  it("retorna negativo quando já passou", () => {
    // delivered 2026-01-01 + 90d = 2026-04-01. now = 2026-04-15 → -14
    expect(
      daysRemaining(now, "2026-01-01T12:00:00Z", 90)
    ).toBe(-14);
  });

  it("retorna null quando delivered_at é inválido", () => {
    expect(daysRemaining(now, "not-a-date", 90)).toBeNull();
  });
});

describe("nudgeReconsulta", () => {
  let supa: ReturnType<typeof createSupabaseMock>;
  // delivered em 2026-01-20 + 90d = 2026-04-20. 2026-04-15 → faltam 5 (<= 7).
  const now = new Date("2026-04-15T12:00:00.000Z");

  beforeEach(() => {
    supa = createSupabaseMock();
    waMock.mockReset();
    waMock.mockResolvedValue({
      ok: true,
      messageId: "wamid.1",
      waId: "5511999998888",
    });
  });

  it("retorna zeros quando não há candidatos", async () => {
    supa.enqueue("fulfillments", { data: [], error: null });

    const r = await nudgeReconsulta(
      supa.client as unknown as SupabaseClient,
      { now }
    );
    expect(r.evaluated).toBe(0);
    expect(r.nudged).toBe(0);
    expect(waMock).not.toHaveBeenCalled();
  });

  it("propaga erro da query inicial", async () => {
    supa.enqueue("fulfillments", {
      data: null,
      error: { message: "oops" },
    });
    await expect(
      nudgeReconsulta(supa.client as unknown as SupabaseClient, { now })
    ).rejects.toThrow(/oops/);
  });

  it("envia WA e marca reconsulta_nudged_at quando dentro da janela", async () => {
    supa.enqueue("fulfillments", { data: [ffRow()], error: null });
    // update do reconsulta_nudged_at
    supa.enqueue("fulfillments", { data: null, error: null });

    const r = await nudgeReconsulta(
      supa.client as unknown as SupabaseClient,
      { now }
    );

    expect(r.nudged).toBe(1);
    expect(r.evaluated).toBe(1);
    expect(waMock).toHaveBeenCalledTimes(1);
    expect(waMock.mock.calls[0][0].to).toBe("+5511999998888");
    expect(waMock.mock.calls[0][0].text).toContain("reconsulta");

    const updateCalls = supa.calls.filter((c) => c.chain.includes("update"));
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0]).toEqual([
      { reconsulta_nudged_at: now.toISOString() },
    ]);
  });

  it("pula quando ainda faltam mais que NUDGE_WINDOW_DAYS", async () => {
    // delivered recente: faltam ~85 dias (> 7)
    supa.enqueue("fulfillments", {
      data: [
        ffRow({ delivered_at: "2026-04-10T10:00:00.000Z" }),
      ],
      error: null,
    });

    const r = await nudgeReconsulta(
      supa.client as unknown as SupabaseClient,
      { now }
    );

    expect(r.nudged).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.details[0].outcome).toBe("skipped_not_due");
    expect(r.details[0].daysRemaining).toBeGreaterThan(NUDGE_WINDOW_DAYS);
    expect(waMock).not.toHaveBeenCalled();
  });

  it("pula quando plan.cycle_days é null (sem how to calculate)", async () => {
    supa.enqueue("fulfillments", {
      data: [ffRow({ plans: { name: "Plano X", cycle_days: null } })],
      error: null,
    });

    const r = await nudgeReconsulta(
      supa.client as unknown as SupabaseClient,
      { now }
    );

    expect(r.nudged).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.details[0].outcome).toBe("skipped_not_due");
    expect(waMock).not.toHaveBeenCalled();
  });

  it("pula quando paciente não tem phone", async () => {
    supa.enqueue("fulfillments", {
      data: [ffRow({ customers: { name: "Sem Fone", phone: null } })],
      error: null,
    });

    const r = await nudgeReconsulta(
      supa.client as unknown as SupabaseClient,
      { now }
    );

    expect(r.nudged).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.details[0].outcome).toBe("skipped_missing_phone");
    expect(waMock).not.toHaveBeenCalled();
  });

  it("reporta wa_failed sem marcar nudged_at", async () => {
    supa.enqueue("fulfillments", { data: [ffRow()], error: null });
    waMock.mockResolvedValueOnce({
      ok: false,
      code: 131047,
      message: "fora da janela",
    });

    const r = await nudgeReconsulta(
      supa.client as unknown as SupabaseClient,
      { now }
    );

    expect(r.nudged).toBe(0);
    expect(r.errors).toBe(1);
    expect(r.details[0].outcome).toBe("wa_failed");
    const updateCalls = supa.calls.filter((c) => c.chain.includes("update"));
    expect(updateCalls).toHaveLength(0);
  });

  it("reporta db_error se marcação pós-WA falha (já mandamos msg)", async () => {
    supa.enqueue("fulfillments", { data: [ffRow()], error: null });
    supa.enqueue("fulfillments", {
      data: null,
      error: { message: "update failed" },
    });

    const r = await nudgeReconsulta(
      supa.client as unknown as SupabaseClient,
      { now }
    );

    expect(r.nudged).toBe(0);
    expect(r.errors).toBe(1);
    expect(r.details[0].outcome).toBe("db_error");
    expect(r.details[0].message).toContain("update failed");
  });

  it("processa múltiplos em ordem cronológica", async () => {
    supa.enqueue("fulfillments", {
      data: [
        ffRow({ id: "ff1", delivered_at: "2026-01-20T10:00:00.000Z" }),
        ffRow({ id: "ff2", delivered_at: "2026-01-22T10:00:00.000Z" }),
      ],
      error: null,
    });
    // 2 updates (um por nudge bem-sucedido)
    supa.enqueue("fulfillments", { data: null, error: null });
    supa.enqueue("fulfillments", { data: null, error: null });

    const r = await nudgeReconsulta(
      supa.client as unknown as SupabaseClient,
      { now }
    );

    expect(r.evaluated).toBe(2);
    expect(r.nudged).toBe(2);
    expect(waMock).toHaveBeenCalledTimes(2);
  });
});
