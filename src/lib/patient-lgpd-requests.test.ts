/**
 * Testes de patient-lgpd-requests (PR-017 · Onda 2A · D-051).
 *
 * Cobre:
 *   - createExportAudit: happy path + erro de insert (não deve lançar).
 *   - createAnonymizeRequest: customer_not_found, customer_anonymized,
 *     happy path com alreadyPending=false, lost race (23505) reusa
 *     pending existente.
 *   - listLgpdRequestsForCustomer + getPendingAnonymizeRequest
 *   - cancelLgpdRequest: not_found, wrong owner (404 opaco), not_pending,
 *     happy path.
 *   - fulfillAnonymizeRequest: not_found, not_pending, já anonymized,
 *     fulfillment ativo (deixa pending), happy path.
 *   - rejectAnonymizeRequest: reason obrigatório, not_found, happy path.
 */

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseMock } from "../test/mocks/supabase";
import {
  cancelLgpdRequest,
  createAnonymizeRequest,
  createExportAudit,
  fulfillAnonymizeRequest,
  getPendingAnonymizeRequest,
  listLgpdRequestsForCustomer,
  rejectAnonymizeRequest,
} from "./patient-lgpd-requests";

const CUSTOMER_ID = "550e8400-e29b-41d4-a716-446655440000";
const ADMIN_ID = "admin-111";
const REQUEST_ID = "req-123";

describe("createExportAudit", () => {
  it("insert bem-sucedido retorna ok:true com requestId", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("lgpd_requests", {
      data: { id: REQUEST_ID },
      error: null,
    });

    const res = await createExportAudit(
      mock.client as unknown as SupabaseClient,
      {
        customerId: CUSTOMER_ID,
        exportBytes: 1234,
        ip: "203.0.113.10",
        userAgent: "Mozilla/5.0",
      }
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.requestId).toBe(REQUEST_ID);
  });

  it("retorna ok:false quando insert falha (não lança)", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("lgpd_requests", {
      data: null,
      error: { code: "42P01", message: "table gone" },
    });

    const res = await createExportAudit(
      mock.client as unknown as SupabaseClient,
      { customerId: CUSTOMER_ID, exportBytes: 10 }
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("insert_failed");
  });
});

describe("createAnonymizeRequest", () => {
  it("customer_not_found quando maybeSingle devolve null", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("customers", { data: null, error: null });

    const res = await createAnonymizeRequest(
      mock.client as unknown as SupabaseClient,
      { customerId: CUSTOMER_ID }
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("customer_not_found");
  });

  it("customer_anonymized quando já tem anonymized_at", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("customers", {
      data: { id: CUSTOMER_ID, anonymized_at: "2026-01-01T00:00:00Z" },
      error: null,
    });

    const res = await createAnonymizeRequest(
      mock.client as unknown as SupabaseClient,
      { customerId: CUSTOMER_ID }
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("customer_anonymized");
  });

  it("happy path devolve alreadyPending=false", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("customers", {
      data: { id: CUSTOMER_ID, anonymized_at: null },
      error: null,
    });
    mock.enqueue("lgpd_requests", {
      data: { id: REQUEST_ID },
      error: null,
    });

    const res = await createAnonymizeRequest(
      mock.client as unknown as SupabaseClient,
      { customerId: CUSTOMER_ID, ip: "192.0.2.1", userAgent: "UA" }
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.alreadyPending).toBe(false);
      expect(res.requestId).toBe(REQUEST_ID);
    }
  });

  it("lost race (23505) devolve pending existente com alreadyPending=true", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("customers", {
      data: { id: CUSTOMER_ID, anonymized_at: null },
      error: null,
    });
    mock.enqueue("lgpd_requests", {
      data: null,
      error: { code: "23505", message: "duplicate key" },
    });
    mock.enqueue("lgpd_requests", {
      data: { id: "existing-id" },
      error: null,
    });

    const res = await createAnonymizeRequest(
      mock.client as unknown as SupabaseClient,
      { customerId: CUSTOMER_ID }
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.alreadyPending).toBe(true);
      expect(res.requestId).toBe("existing-id");
    }
  });

  it("insert_failed em erro genérico", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("customers", {
      data: { id: CUSTOMER_ID, anonymized_at: null },
      error: null,
    });
    mock.enqueue("lgpd_requests", {
      data: null,
      error: { code: "42501", message: "RLS denied" },
    });

    const res = await createAnonymizeRequest(
      mock.client as unknown as SupabaseClient,
      { customerId: CUSTOMER_ID }
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("insert_failed");
  });
});

describe("listLgpdRequestsForCustomer", () => {
  it("devolve array com dados do select", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("lgpd_requests", {
      data: [
        { id: "r1", kind: "export_copy", status: "fulfilled" },
        { id: "r2", kind: "anonymize", status: "pending" },
      ],
      error: null,
    });

    const res = await listLgpdRequestsForCustomer(
      mock.client as unknown as SupabaseClient,
      CUSTOMER_ID
    );
    expect(res).toHaveLength(2);
  });

  it("devolve array vazio quando data=null", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("lgpd_requests", { data: null, error: null });
    const res = await listLgpdRequestsForCustomer(
      mock.client as unknown as SupabaseClient,
      CUSTOMER_ID
    );
    expect(res).toEqual([]);
  });
});

describe("getPendingAnonymizeRequest", () => {
  it("devolve null quando não tem pendência", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("lgpd_requests", { data: null, error: null });
    const res = await getPendingAnonymizeRequest(
      mock.client as unknown as SupabaseClient,
      CUSTOMER_ID
    );
    expect(res).toBeNull();
  });

  it("devolve record quando existe pendência", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("lgpd_requests", {
      data: { id: REQUEST_ID, kind: "anonymize", status: "pending" },
      error: null,
    });
    const res = await getPendingAnonymizeRequest(
      mock.client as unknown as SupabaseClient,
      CUSTOMER_ID
    );
    expect(res).not.toBeNull();
    expect(res!.id).toBe(REQUEST_ID);
  });
});

describe("cancelLgpdRequest", () => {
  it("not_found quando request não existe", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("lgpd_requests", { data: null, error: null });

    const res = await cancelLgpdRequest(
      mock.client as unknown as SupabaseClient,
      { requestId: REQUEST_ID, customerId: CUSTOMER_ID }
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not_found");
  });

  it("devolve not_found opaco quando dono é outro customer (não revela)", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("lgpd_requests", {
      data: {
        id: REQUEST_ID,
        customer_id: "outro-cliente",
        status: "pending",
      },
      error: null,
    });

    const res = await cancelLgpdRequest(
      mock.client as unknown as SupabaseClient,
      { requestId: REQUEST_ID, customerId: CUSTOMER_ID }
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not_found");
  });

  it("not_pending quando já fulfilled", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("lgpd_requests", {
      data: {
        id: REQUEST_ID,
        customer_id: CUSTOMER_ID,
        status: "fulfilled",
      },
      error: null,
    });

    const res = await cancelLgpdRequest(
      mock.client as unknown as SupabaseClient,
      { requestId: REQUEST_ID, customerId: CUSTOMER_ID }
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not_pending");
  });

  it("happy path: cancela request pending", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("lgpd_requests", {
      data: {
        id: REQUEST_ID,
        customer_id: CUSTOMER_ID,
        status: "pending",
      },
      error: null,
    });
    mock.enqueue("lgpd_requests", { data: null, error: null });

    const res = await cancelLgpdRequest(
      mock.client as unknown as SupabaseClient,
      { requestId: REQUEST_ID, customerId: CUSTOMER_ID }
    );
    expect(res.ok).toBe(true);
  });
});

describe("fulfillAnonymizeRequest", () => {
  it("not_found quando request inexistente", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("lgpd_requests", { data: null, error: null });

    const res = await fulfillAnonymizeRequest(
      mock.client as unknown as SupabaseClient,
      { requestId: REQUEST_ID, adminUserId: ADMIN_ID }
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not_found");
  });

  it("not_found quando kind não é anonymize", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("lgpd_requests", {
      data: {
        id: REQUEST_ID,
        customer_id: CUSTOMER_ID,
        kind: "export_copy",
        status: "fulfilled",
      },
      error: null,
    });

    const res = await fulfillAnonymizeRequest(
      mock.client as unknown as SupabaseClient,
      { requestId: REQUEST_ID, adminUserId: ADMIN_ID }
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not_found");
  });

  it("not_pending quando já fulfilled", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("lgpd_requests", {
      data: {
        id: REQUEST_ID,
        customer_id: CUSTOMER_ID,
        kind: "anonymize",
        status: "fulfilled",
      },
      error: null,
    });

    const res = await fulfillAnonymizeRequest(
      mock.client as unknown as SupabaseClient,
      { requestId: REQUEST_ID, adminUserId: ADMIN_ID }
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not_pending");
  });

  it("propaga has_active_fulfillment sem atualizar o request", async () => {
    const mock = createSupabaseMock();
    // 1. lookup do lgpd_requests
    mock.enqueue("lgpd_requests", {
      data: {
        id: REQUEST_ID,
        customer_id: CUSTOMER_ID,
        kind: "anonymize",
        status: "pending",
      },
      error: null,
    });
    // anonymizePatient: fetch customer
    mock.enqueue("customers", {
      data: { id: CUSTOMER_ID, anonymized_at: null },
      error: null,
    });
    // anonymizePatient: verifica fulfillment ativo
    mock.enqueue("fulfillments", {
      data: [{ id: "ff-x", status: "paid" }],
      error: null,
    });

    const res = await fulfillAnonymizeRequest(
      mock.client as unknown as SupabaseClient,
      { requestId: REQUEST_ID, adminUserId: ADMIN_ID }
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("has_active_fulfillment");
  });

  it("happy path: anonymize executa e marca request fulfilled", async () => {
    const mock = createSupabaseMock();
    // 1. lookup do lgpd_requests
    mock.enqueue("lgpd_requests", {
      data: {
        id: REQUEST_ID,
        customer_id: CUSTOMER_ID,
        kind: "anonymize",
        status: "pending",
      },
      error: null,
    });
    // anonymizePatient: fetch customer
    mock.enqueue("customers", {
      data: { id: CUSTOMER_ID, anonymized_at: null },
      error: null,
    });
    // anonymizePatient: verifica fulfillment ativo (vazio)
    mock.enqueue("fulfillments", { data: [], error: null });
    // anonymizePatient: update customers
    mock.enqueue("customers", { data: null, error: null });
    // fulfillAnonymizeRequest: update lgpd_requests
    mock.enqueue("lgpd_requests", { data: null, error: null });

    const res = await fulfillAnonymizeRequest(
      mock.client as unknown as SupabaseClient,
      { requestId: REQUEST_ID, adminUserId: ADMIN_ID }
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.customerId).toBe(CUSTOMER_ID);
      expect(res.anonymizedRef).toMatch(/^[0-9a-f]{8}$/);
    }
  });
});

describe("rejectAnonymizeRequest", () => {
  it("update_failed quando reason está vazio", async () => {
    const mock = createSupabaseMock();
    const res = await rejectAnonymizeRequest(
      mock.client as unknown as SupabaseClient,
      { requestId: REQUEST_ID, adminUserId: ADMIN_ID, reason: "   " }
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("update_failed");
  });

  it("not_found quando request inexistente", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("lgpd_requests", { data: null, error: null });

    const res = await rejectAnonymizeRequest(
      mock.client as unknown as SupabaseClient,
      {
        requestId: REQUEST_ID,
        adminUserId: ADMIN_ID,
        reason: "tem fulfillment ativo",
      }
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not_found");
  });

  it("not_pending quando já fulfilled", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("lgpd_requests", {
      data: {
        id: REQUEST_ID,
        status: "fulfilled",
        customer_id: CUSTOMER_ID,
      },
      error: null,
    });

    const res = await rejectAnonymizeRequest(
      mock.client as unknown as SupabaseClient,
      {
        requestId: REQUEST_ID,
        adminUserId: ADMIN_ID,
        reason: "already done",
      }
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not_pending");
  });

  it("happy path: marca rejected com reason e devolve customerId", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("lgpd_requests", {
      data: {
        id: REQUEST_ID,
        status: "pending",
        customer_id: CUSTOMER_ID,
      },
      error: null,
    });
    mock.enqueue("lgpd_requests", { data: null, error: null });

    const res = await rejectAnonymizeRequest(
      mock.client as unknown as SupabaseClient,
      {
        requestId: REQUEST_ID,
        adminUserId: ADMIN_ID,
        reason: "tem chargeback pendente",
      }
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.customerId).toBe(CUSTOMER_ID);
  });
});
