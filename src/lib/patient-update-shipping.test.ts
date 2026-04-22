/**
 * Testes de patient-update-shipping (D-045 · 3.E).
 *
 * Cobre:
 *   - Validação (campos inválidos → invalid_payload com fieldErrors)
 *   - Ownership (customer_id != input.customerId → not_found)
 *   - Status válido (só `paid` passa; outros → invalid_status)
 *   - Idempotência (mesmo snapshot → noChanges=true, sem update, com audit)
 *   - Race (status sai de paid entre select e update → invalid_status)
 *   - Audit log sempre gravado
 *   - DB errors propagados
 */

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseMock } from "@/test/mocks/supabase";
import { updateFulfillmentShipping } from "./patient-update-shipping";

const validAddress = {
  recipient_name: "Maria Silva",
  zipcode: "01310-100",
  street: "Avenida Paulista",
  number: "1000",
  complement: "Apto 42",
  district: "Bela Vista",
  city: "São Paulo",
  state: "SP",
};

function ffRow(
  over: Partial<{
    id: string;
    customer_id: string;
    status: string;
    shipping_recipient_name: string | null;
    shipping_zipcode: string | null;
    shipping_street: string | null;
    shipping_number: string | null;
    shipping_complement: string | null;
    shipping_district: string | null;
    shipping_city: string | null;
    shipping_state: string | null;
  }> = {}
) {
  return {
    id: over.id ?? "ff-1",
    customer_id: over.customer_id ?? "cust-1",
    status: over.status ?? "paid",
    shipping_recipient_name: over.shipping_recipient_name ?? null,
    shipping_zipcode: over.shipping_zipcode ?? null,
    shipping_street: over.shipping_street ?? null,
    shipping_number: over.shipping_number ?? null,
    shipping_complement: over.shipping_complement ?? null,
    shipping_district: over.shipping_district ?? null,
    shipping_city: over.shipping_city ?? null,
    shipping_state: over.shipping_state ?? null,
  };
}

function baseInput(over: Partial<Parameters<typeof updateFulfillmentShipping>[1]> = {}) {
  return {
    fulfillmentId: "ff-1",
    customerId: "cust-1",
    actorUserId: "user-1",
    source: "patient" as const,
    address: validAddress,
    recipientFallback: "Maria Silva",
    ...over,
  };
}

describe("updateFulfillmentShipping", () => {
  it("rejeita endereço inválido com fieldErrors", async () => {
    const supa = createSupabaseMock();

    const r = await updateFulfillmentShipping(
      supa.client as unknown as SupabaseClient,
      baseInput({
        address: { ...validAddress, state: "XX", zipcode: "123" },
      })
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_payload");
    expect(r.fieldErrors?.state).toBeDefined();
    expect(r.fieldErrors?.zipcode).toBeDefined();
  });

  it("retorna not_found se fulfillment não existe", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", { data: null, error: null });

    const r = await updateFulfillmentShipping(
      supa.client as unknown as SupabaseClient,
      baseInput()
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("not_found");
  });

  it("retorna not_found se customer_id não bate (defense-in-depth)", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", {
      data: ffRow({ customer_id: "OUTRO-CUSTOMER" }),
      error: null,
    });

    const r = await updateFulfillmentShipping(
      supa.client as unknown as SupabaseClient,
      baseInput()
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("not_found");
  });

  it.each(["pending_acceptance", "pending_payment"])(
    "rejeita update em status %s com mensagem educativa",
    async (status) => {
      const supa = createSupabaseMock();
      supa.enqueue("fulfillments", { data: ffRow({ status }), error: null });

      const r = await updateFulfillmentShipping(
        supa.client as unknown as SupabaseClient,
        baseInput()
      );

      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("invalid_status");
      expect(r.message.toLowerCase()).toContain("aceite");
    }
  );

  it.each(["pharmacy_requested", "shipped", "delivered", "cancelled"])(
    "rejeita update pós-%s com mensagem 'fale com o Instituto'",
    async (status) => {
      const supa = createSupabaseMock();
      supa.enqueue("fulfillments", { data: ffRow({ status }), error: null });

      const r = await updateFulfillmentShipping(
        supa.client as unknown as SupabaseClient,
        baseInput()
      );

      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("invalid_status");
      expect(r.message.toLowerCase()).toContain("instituto");
    }
  );

  it("atualiza com sucesso em status paid e grava audit", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", {
      data: ffRow({
        shipping_street: "Rua Antiga",
        shipping_zipcode: "04567890",
      }),
      error: null,
    });
    // update select
    supa.enqueue("fulfillments", { data: { id: "ff-1" }, error: null });
    // audit insert
    supa.enqueue("fulfillment_address_changes", {
      data: { id: "audit-1" },
      error: null,
    });

    const r = await updateFulfillmentShipping(
      supa.client as unknown as SupabaseClient,
      baseInput({ actorEmail: "  MARIA@Example.COM  " })
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.noChanges).toBe(false);
    expect(r.auditId).toBe("audit-1");
    expect(r.snapshot.shipping_zipcode).toBe("01310100"); // normalizado
    expect(r.snapshot.shipping_state).toBe("SP");

    // Verifica que audit recebeu before e after
    const auditCall = supa.calls.find(
      (c) =>
        c.table === "fulfillment_address_changes" && c.chain.includes("insert")
    );
    expect(auditCall).toBeTruthy();
    const insertArgs = auditCall!.args[auditCall!.chain.indexOf("insert")][0] as {
      before_snapshot: unknown;
      after_snapshot: unknown;
      source: string;
    };
    expect(insertArgs.source).toBe("patient");
    expect(insertArgs.before_snapshot).toMatchObject({
      shipping_street: "Rua Antiga",
    });
    expect(insertArgs.after_snapshot).toMatchObject({
      shipping_street: "Avenida Paulista",
    });

    // PR-064 · D-072: o fulfillment recebe updated_by_email (snapshot imutável).
    const ffUpdCall = supa.calls.find(
      (c) => c.table === "fulfillments" && c.chain.includes("update")
    );
    const ffPatch = ffUpdCall!.args[
      ffUpdCall!.chain.indexOf("update")
    ][0] as Record<string, unknown>;
    expect(ffPatch.updated_by_email).toBe("maria@example.com");
  });

  it("before_snapshot é null quando não havia endereço prévio", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", {
      data: ffRow(),
      error: null,
    });
    supa.enqueue("fulfillments", { data: { id: "ff-1" }, error: null });
    supa.enqueue("fulfillment_address_changes", {
      data: { id: "audit-1" },
      error: null,
    });

    const r = await updateFulfillmentShipping(
      supa.client as unknown as SupabaseClient,
      baseInput()
    );

    expect(r.ok).toBe(true);
    const auditCall = supa.calls.find(
      (c) =>
        c.table === "fulfillment_address_changes" && c.chain.includes("insert")
    );
    const insertArgs = auditCall!.args[auditCall!.chain.indexOf("insert")][0] as {
      before_snapshot: unknown;
    };
    expect(insertArgs.before_snapshot).toBeNull();
  });

  it("idempotência: mesmo endereço → noChanges=true, sem update, audit gravado", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", {
      data: ffRow({
        shipping_recipient_name: "Maria Silva",
        shipping_zipcode: "01310100",
        shipping_street: "Avenida Paulista",
        shipping_number: "1000",
        shipping_complement: "Apto 42",
        shipping_district: "Bela Vista",
        shipping_city: "São Paulo",
        shipping_state: "SP",
      }),
      error: null,
    });
    // sem update enfileirado — se for chamado, retorna default null/null
    supa.enqueue("fulfillment_address_changes", {
      data: { id: "audit-noop" },
      error: null,
    });

    const r = await updateFulfillmentShipping(
      supa.client as unknown as SupabaseClient,
      baseInput()
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.noChanges).toBe(true);
    expect(r.auditId).toBe("audit-noop");

    // update NÃO foi chamado
    const updCall = supa.calls.find(
      (c) => c.table === "fulfillments" && c.chain.includes("update")
    );
    expect(updCall).toBeUndefined();
  });

  it("race: status saiu de paid entre select e update → invalid_status", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", {
      data: ffRow({ shipping_street: "Rua X" }),
      error: null,
    });
    // update não bate linha (guard `.eq('status', 'paid')` falhou)
    supa.enqueue("fulfillments", { data: null, error: null });

    const r = await updateFulfillmentShipping(
      supa.client as unknown as SupabaseClient,
      baseInput()
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_status");
    expect(r.message.toLowerCase()).toContain("farmácia");
  });

  it("audit falha é logada mas não quebra o fluxo", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", {
      data: ffRow({ shipping_street: "Rua X" }),
      error: null,
    });
    supa.enqueue("fulfillments", { data: { id: "ff-1" }, error: null });
    supa.enqueue("fulfillment_address_changes", {
      data: null,
      error: { message: "insert audit falhou" },
    });

    const r = await updateFulfillmentShipping(
      supa.client as unknown as SupabaseClient,
      baseInput()
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.auditId).toBeNull();
  });

  it("propaga erro de DB no select inicial", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", {
      data: null,
      error: { message: "conexão caiu" },
    });

    const r = await updateFulfillmentShipping(
      supa.client as unknown as SupabaseClient,
      baseInput()
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("db_error");
    expect(r.message).toContain("conexão caiu");
  });

  it("propaga erro de DB no update", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", {
      data: ffRow({ shipping_street: "Rua X" }),
      error: null,
    });
    supa.enqueue("fulfillments", {
      data: null,
      error: { message: "update falhou" },
    });

    const r = await updateFulfillmentShipping(
      supa.client as unknown as SupabaseClient,
      baseInput()
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("db_error");
  });

  it("source=admin grava 'admin' no audit log", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", {
      data: ffRow({ shipping_street: "Rua X" }),
      error: null,
    });
    supa.enqueue("fulfillments", { data: { id: "ff-1" }, error: null });
    supa.enqueue("fulfillment_address_changes", {
      data: { id: "audit-1" },
      error: null,
    });

    await updateFulfillmentShipping(
      supa.client as unknown as SupabaseClient,
      baseInput({ source: "admin" })
    );

    const auditCall = supa.calls.find(
      (c) =>
        c.table === "fulfillment_address_changes" && c.chain.includes("insert")
    );
    const args = auditCall!.args[auditCall!.chain.indexOf("insert")][0] as {
      source: string;
    };
    expect(args.source).toBe("admin");
  });
});
