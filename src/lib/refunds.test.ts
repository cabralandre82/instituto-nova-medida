/**
 * Testes unitários — refunds.ts (D-038).
 *
 * Foco: feature flag (default-off é política de segurança, se vazar
 * pra on sem intenção pode gerar estorno duplicado) e idempotência
 * do `markRefundProcessed` (dupla trava: guard in-code + guard no
 * update via `.is('refund_processed_at', null)`).
 *
 * Não testamos `processRefundViaAsaas` ponta-a-ponta porque ele chama
 * a API externa — seria um teste de integração. Aqui ficamos nas
 * portas internas.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseMock } from "@/test/mocks/supabase";

vi.mock("@/lib/supabase", () => ({
  getSupabaseAdmin: vi.fn(),
  getSupabaseAnon: vi.fn(),
}));

// asaas lib também é mockada pra não fazer HTTP
vi.mock("@/lib/asaas", () => ({
  refundPayment: vi.fn(),
}));

import { getSupabaseAdmin } from "@/lib/supabase";
import {
  isAsaasRefundsEnabled,
  markRefundProcessed,
} from "@/lib/refunds";

let supa: ReturnType<typeof createSupabaseMock>;
const originalEnv = process.env.REFUNDS_VIA_ASAAS;

beforeEach(() => {
  supa = createSupabaseMock();
  vi.mocked(getSupabaseAdmin).mockReturnValue(
    supa.client as unknown as ReturnType<typeof getSupabaseAdmin>
  );
});

afterEach(() => {
  supa.reset();
  vi.clearAllMocks();
  if (originalEnv === undefined) {
    delete process.env.REFUNDS_VIA_ASAAS;
  } else {
    process.env.REFUNDS_VIA_ASAAS = originalEnv;
  }
});

describe("isAsaasRefundsEnabled", () => {
  it("retorna true só quando REFUNDS_VIA_ASAAS === 'true' exato", () => {
    process.env.REFUNDS_VIA_ASAAS = "true";
    expect(isAsaasRefundsEnabled()).toBe(true);
  });

  it("retorna false quando a var é 'false'", () => {
    process.env.REFUNDS_VIA_ASAAS = "false";
    expect(isAsaasRefundsEnabled()).toBe(false);
  });

  it("retorna false quando a var é undefined", () => {
    delete process.env.REFUNDS_VIA_ASAAS;
    expect(isAsaasRefundsEnabled()).toBe(false);
  });

  it("é case-sensitive — 'TRUE' maiúsculo não habilita", () => {
    process.env.REFUNDS_VIA_ASAAS = "TRUE";
    expect(isAsaasRefundsEnabled()).toBe(false);
  });

  it("não aceita '1' como truthy (precisa ser literal 'true')", () => {
    process.env.REFUNDS_VIA_ASAAS = "1";
    expect(isAsaasRefundsEnabled()).toBe(false);
  });
});

describe("markRefundProcessed", () => {
  const apptWithRefund = {
    id: "ap-1",
    refund_required: true,
    refund_processed_at: null,
    refund_processed_method: null,
    refund_external_ref: null,
  };

  it("marca refund processado no happy path", async () => {
    supa.enqueue("appointments", { data: apptWithRefund, error: null });
    supa.enqueue("appointments", { data: null, error: null });

    const res = await markRefundProcessed({
      appointmentId: "ap-1",
      method: "manual",
      externalRef: "REF-123",
      notes: "estornado no painel Asaas",
      processedBy: "admin-1",
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.alreadyProcessed).toBe(false);
      expect(res.method).toBe("manual");
      expect(res.externalRef).toBe("REF-123");
    }

    const updateCall = supa.calls.find(
      (c) => c.table === "appointments" && c.chain.includes("update")
    );
    expect(updateCall).toBeDefined();
    const [payload] = updateCall!.args[updateCall!.chain.indexOf("update")];
    expect((payload as Record<string, unknown>).refund_processed_method).toBe(
      "manual"
    );
    expect((payload as Record<string, unknown>).refund_external_ref).toBe(
      "REF-123"
    );

    // Verifica que o update tem a trava `.is('refund_processed_at', null)`.
    expect(updateCall!.chain).toContain("is");
  });

  it("retorna refund_not_required se flag é false", async () => {
    supa.enqueue("appointments", {
      data: { ...apptWithRefund, refund_required: false },
      error: null,
    });

    const res = await markRefundProcessed({
      appointmentId: "ap-1",
      method: "manual",
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("refund_not_required");
    }

    // Nenhum update deve ter rodado.
    const updates = supa.calls.filter(
      (c) => c.table === "appointments" && c.chain.includes("update")
    );
    expect(updates).toHaveLength(0);
  });

  it("é idempotente — retorna alreadyProcessed=true sem re-update", async () => {
    const processedAt = "2026-04-10T10:00:00.000Z";
    supa.enqueue("appointments", {
      data: {
        ...apptWithRefund,
        refund_processed_at: processedAt,
        refund_processed_method: "asaas_api",
      },
      error: null,
    });

    const res = await markRefundProcessed({
      appointmentId: "ap-1",
      method: "manual", // mesmo pedindo manual, preserva o asaas_api original
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.alreadyProcessed).toBe(true);
      expect(res.processedAt).toBe(processedAt);
      expect(res.method).toBe("asaas_api");
    }

    const updates = supa.calls.filter(
      (c) => c.table === "appointments" && c.chain.includes("update")
    );
    expect(updates).toHaveLength(0);
  });

  it("retorna appointment_not_found se o ID não existe", async () => {
    supa.enqueue("appointments", { data: null, error: null });

    const res = await markRefundProcessed({
      appointmentId: "ghost",
      method: "manual",
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("appointment_not_found");
    }
  });

  it("normaliza externalRef/notes: trim e string vazia vira null", async () => {
    supa.enqueue("appointments", { data: apptWithRefund, error: null });
    supa.enqueue("appointments", { data: null, error: null });

    const res = await markRefundProcessed({
      appointmentId: "ap-1",
      method: "manual",
      externalRef: "   ",
      notes: "   ",
    });

    expect(res.ok).toBe(true);
    const updateCall = supa.calls.find(
      (c) => c.table === "appointments" && c.chain.includes("update")
    );
    const [payload] = updateCall!.args[updateCall!.chain.indexOf("update")];
    const p = payload as Record<string, unknown>;
    expect(p.refund_external_ref).toBeNull();
    expect(p.refund_processed_notes).toBeNull();
  });
});
