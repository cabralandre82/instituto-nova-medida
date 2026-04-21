/**
 * Testes de patient-access-log (PR-032 · D-051 · Onda 2A).
 *
 * Cobre:
 *   - happy path devolve ok:true com id
 *   - sanitização: strings > 2KB truncadas
 *   - customerId=null (search sem clique)
 *   - failSoft (default): insert falhou → ok:false mas sem throw
 *   - failHard: insert falhou → ok:false propagado
 *   - metadata default vira {}
 */

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseMock } from "../test/mocks/supabase";
import { logPatientAccess } from "./patient-access-log";

const ADMIN_ID = "admin-1";
const CUSTOMER_ID = "cust-1";

describe("logPatientAccess", () => {
  it("happy path: insert ok devolve id", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("patient_access_log", {
      data: { id: "log-1" },
      error: null,
    });

    const res = await logPatientAccess(
      mock.client as unknown as SupabaseClient,
      {
        adminUserId: ADMIN_ID,
        customerId: CUSTOMER_ID,
        action: "view",
        metadata: { route: "/admin/pacientes/cust-1" },
      }
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.id).toBe("log-1");

    const call = mock.calls.find((c) => c.table === "patient_access_log");
    expect(call).toBeDefined();
  });

  it("customer_id null é permitido (busca sem clique)", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("patient_access_log", {
      data: { id: "log-2" },
      error: null,
    });

    const res = await logPatientAccess(
      mock.client as unknown as SupabaseClient,
      {
        adminUserId: ADMIN_ID,
        customerId: null,
        action: "search",
        metadata: { query: "Maria" },
      }
    );
    expect(res.ok).toBe(true);
  });

  it("sanitiza strings > 2KB em metadata", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("patient_access_log", {
      data: { id: "log-3" },
      error: null,
    });
    const bigString = "x".repeat(3000);

    await logPatientAccess(mock.client as unknown as SupabaseClient, {
      adminUserId: ADMIN_ID,
      customerId: CUSTOMER_ID,
      action: "view",
      metadata: { notes: bigString },
    });

    const call = mock.calls.find(
      (c) => c.table === "patient_access_log" && c.chain[0] === "insert"
    );
    expect(call).toBeDefined();
    // Primeiro arg do insert é o row — pegamos e conferimos truncation
    const row = call!.args[0]?.[0] as { metadata: { notes: string } };
    expect(row.metadata.notes.length).toBeLessThanOrEqual(2100);
    expect(row.metadata.notes).toContain("…[truncated]");
  });

  it("failSoft (padrão): insert falha, devolve ok:false sem throw", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mock = createSupabaseMock();
    mock.enqueue("patient_access_log", {
      data: null,
      error: { code: "42P01", message: "table missing" },
    });

    const res = await logPatientAccess(
      mock.client as unknown as SupabaseClient,
      {
        adminUserId: ADMIN_ID,
        customerId: CUSTOMER_ID,
        action: "view",
      }
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("insert_failed");
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("failHard: insert falha, devolve ok:false sem logar (caller decide)", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mock = createSupabaseMock();
    mock.enqueue("patient_access_log", {
      data: null,
      error: { code: "42P01", message: "table missing" },
    });

    const res = await logPatientAccess(
      mock.client as unknown as SupabaseClient,
      {
        adminUserId: ADMIN_ID,
        customerId: CUSTOMER_ID,
        action: "export",
      },
      { failHard: true }
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("insert_failed");
      expect(res.message).toContain("table missing");
    }
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("metadata ausente vira {} (não null)", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("patient_access_log", {
      data: { id: "log-4" },
      error: null,
    });

    await logPatientAccess(mock.client as unknown as SupabaseClient, {
      adminUserId: ADMIN_ID,
      customerId: CUSTOMER_ID,
      action: "view",
    });

    const call = mock.calls.find(
      (c) => c.table === "patient_access_log" && c.chain[0] === "insert"
    );
    const row = call!.args[0]?.[0] as { metadata: Record<string, unknown> };
    expect(row.metadata).toEqual({});
  });

  it("actorKind padrão é 'admin' e é persistido", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("patient_access_log", { data: { id: "log-5" }, error: null });

    await logPatientAccess(mock.client as unknown as SupabaseClient, {
      adminUserId: ADMIN_ID,
      customerId: CUSTOMER_ID,
      action: "view",
    });

    const call = mock.calls.find(
      (c) => c.table === "patient_access_log" && c.chain[0] === "insert"
    );
    const row = call!.args[0]?.[0] as { actor_kind: string };
    expect(row.actor_kind).toBe("admin");
  });

  it("actorKind='system' é aceito quando adminUserId é null", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("patient_access_log", { data: { id: "log-6" }, error: null });

    const res = await logPatientAccess(
      mock.client as unknown as SupabaseClient,
      {
        adminUserId: null,
        adminEmail: "system:retention",
        actorKind: "system",
        customerId: CUSTOMER_ID,
        action: "retention_anonymize",
        metadata: { thresholdDays: 730 },
      }
    );
    expect(res.ok).toBe(true);

    const call = mock.calls.find(
      (c) => c.table === "patient_access_log" && c.chain[0] === "insert"
    );
    const row = call!.args[0]?.[0] as {
      actor_kind: string;
      admin_user_id: string | null;
      admin_email: string | null;
    };
    expect(row.actor_kind).toBe("system");
    expect(row.admin_user_id).toBeNull();
    expect(row.admin_email).toBe("system:retention");
  });

  it("rejeita actorKind='admin' sem adminUserId (constraint de binding)", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mock = createSupabaseMock();

    const res = await logPatientAccess(
      mock.client as unknown as SupabaseClient,
      {
        adminUserId: null,
        customerId: CUSTOMER_ID,
        action: "view",
      }
    );
    expect(res.ok).toBe(false);
    // Não deve nem tentar insert — falha rápida na validação.
    expect(
      mock.calls.filter((c) => c.chain[0] === "insert").length
    ).toBe(0);
    consoleSpy.mockRestore();
  });

  it("rejeita actorKind='system' com adminUserId (constraint de binding)", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mock = createSupabaseMock();

    const res = await logPatientAccess(
      mock.client as unknown as SupabaseClient,
      {
        adminUserId: ADMIN_ID,
        actorKind: "system",
        customerId: CUSTOMER_ID,
        action: "retention_anonymize",
      }
    );
    expect(res.ok).toBe(false);
    consoleSpy.mockRestore();
  });
});
