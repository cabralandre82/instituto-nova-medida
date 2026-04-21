/**
 * Testes de patient-lgpd (D-045 · 3.G).
 *
 * Cobre:
 *   - Helpers puros (ref, placeholders) determinísticos e dentro das
 *     constraints da tabela customers.
 *   - exportPatientData: agregação correta, retorna null pra ausente,
 *     notifications/address_changes lidam com ids vazios.
 *   - anonymizePatient: not_found, already_anonymized, bloqueio por
 *     fulfillment ativo, happy path, force pra ignorar bloqueio,
 *     update_failed quando RPC explode.
 */

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseMock } from "../test/mocks/supabase";
import {
  anonymizedRefFromId,
  anonymizePatient,
  exportPatientData,
  placeholderCpf,
  placeholderEmail,
  placeholderName,
  placeholderPhone,
} from "./patient-lgpd";
import {
  APPOINTMENT_COLUMNS,
  CUSTOMER_COLUMNS,
  FULFILLMENT_COLUMNS,
  LGPD_EXPORT_ALLOWLIST,
  LGPD_EXPORT_FORBIDDEN_FIELDS,
  PAYMENT_COLUMNS,
  PLAN_ACCEPTANCE_COLUMNS,
} from "./patient-lgpd-fields";

const NOW = new Date("2026-04-20T12:00:00.000Z");
const CUSTOMER_ID = "550e8400-e29b-41d4-a716-446655440000";
const REF = anonymizedRefFromId(CUSTOMER_ID);

// ────────────────────────────────────────────────────────────────────────
// Helpers puros
// ────────────────────────────────────────────────────────────────────────

describe("anonymizedRefFromId", () => {
  it("devolve 8 chars hex estáveis", () => {
    const r1 = anonymizedRefFromId(CUSTOMER_ID);
    const r2 = anonymizedRefFromId(CUSTOMER_ID);
    expect(r1).toBe(r2);
    expect(r1).toHaveLength(8);
    expect(r1).toMatch(/^[0-9a-f]{8}$/);
  });

  it("gera refs diferentes pra ids diferentes", () => {
    const a = anonymizedRefFromId("id-a");
    const b = anonymizedRefFromId("id-b");
    expect(a).not.toBe(b);
  });
});

describe("placeholders", () => {
  it("placeholderCpf tem 11 dígitos numéricos", () => {
    const cpf = placeholderCpf(REF);
    expect(cpf).toHaveLength(11);
    expect(cpf).toMatch(/^\d{11}$/);
  });

  it("placeholderEmail passa regex básico de email", () => {
    const em = placeholderEmail(REF);
    expect(em).toMatch(/^[^@]+@[^@]+\.[^@]+$/);
    expect(em.endsWith("@anonimizado.invalid")).toBe(true);
  });

  it("placeholderPhone tem pelo menos 10 dígitos numéricos", () => {
    const ph = placeholderPhone(REF);
    const digits = ph.replace(/\D/g, "");
    expect(digits.length).toBeGreaterThanOrEqual(10);
  });

  it("placeholderName inclui o ref pra diferenciar anonymizados", () => {
    const n = placeholderName(REF);
    expect(n).toContain(REF);
    expect(n.length).toBeGreaterThanOrEqual(3);
  });
});

// ────────────────────────────────────────────────────────────────────────
// exportPatientData
// ────────────────────────────────────────────────────────────────────────

describe("exportPatientData", () => {
  it("retorna null se customer não existe", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("customers", { data: null, error: null });
    mock.enqueue("appointments", { data: [], error: null });
    mock.enqueue("fulfillments", { data: [], error: null });
    mock.enqueue("payments", { data: [], error: null });
    mock.enqueue("plan_acceptances", { data: [], error: null });
    mock.enqueue("appointments", { data: [], error: null });
    mock.enqueue("fulfillments", { data: [], error: null });

    const res = await exportPatientData(
      mock.client as unknown as SupabaseClient,
      CUSTOMER_ID
    );
    expect(res).toBeNull();
  });

  it("agrega todas as fontes + metadados de schema", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("customers", {
      data: { id: CUSTOMER_ID, name: "Ana" },
      error: null,
    });
    mock.enqueue("appointments", {
      data: [{ id: "ap1", customer_id: CUSTOMER_ID }],
      error: null,
    });
    mock.enqueue("fulfillments", {
      data: [{ id: "ff1", customer_id: CUSTOMER_ID }],
      error: null,
    });
    mock.enqueue("payments", {
      data: [{ id: "pay1", customer_id: CUSTOMER_ID }],
      error: null,
    });
    mock.enqueue("plan_acceptances", {
      data: [{ id: "pa1", customer_id: CUSTOMER_ID }],
      error: null,
    });
    // Para notifications: primeiro apps (ids), depois notifs.
    mock.enqueue("appointments", {
      data: [{ id: "ap1" }],
      error: null,
    });
    mock.enqueue("appointment_notifications", {
      data: [{ id: "n1", appointment_id: "ap1" }],
      error: null,
    });
    // Para address_changes: primeiro ffs (ids), depois changes.
    mock.enqueue("fulfillments", {
      data: [{ id: "ff1" }],
      error: null,
    });
    mock.enqueue("fulfillment_address_changes", {
      data: [{ id: "ac1", fulfillment_id: "ff1" }],
      error: null,
    });

    const res = await exportPatientData(
      mock.client as unknown as SupabaseClient,
      CUSTOMER_ID
    );
    expect(res).not.toBeNull();
    expect(res!.schema_version).toBe("v1-2026-04");
    expect(res!.exported_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res!.legal_notice).toContain("LGPD");
    expect(res!.appointments).toHaveLength(1);
    expect(res!.fulfillments).toHaveLength(1);
    expect(res!.payments).toHaveLength(1);
    expect(res!.plan_acceptances).toHaveLength(1);
    expect(res!.appointment_notifications).toHaveLength(1);
    expect(res!.fulfillment_address_changes).toHaveLength(1);

    // PR-016: cada SELECT usa allowlist explícita, não `*`.
    // Inspecionamos os argumentos passados ao .select() pra garantir que
    // as colunas foram listadas. Sem isso, o audit finding [6.3] volta.
    const selectCalls = mock.calls.filter((c) => c.chain[0] === "select");
    for (const call of selectCalls) {
      const firstArg = call.args[0]?.[0] as string | undefined;
      if (typeof firstArg !== "string") continue;
      expect(firstArg, `tabela ${call.table} com SELECT *`).not.toBe("*");
      // Também não pode vir vazio (equivale a *)
      expect(firstArg.length).toBeGreaterThan(0);
    }

    // A query principal de cada tabela deve conter as colunas esperadas.
    const expectInclude = (
      table: string,
      cols: readonly string[]
    ) => {
      const call = selectCalls.find(
        (c) =>
          c.table === table &&
          typeof c.args[0]?.[0] === "string" &&
          (c.args[0][0] as string).split(",").length > 1
      );
      expect(call, `${table} sem allowlist`).toBeDefined();
      const received = (call!.args[0][0] as string).split(",");
      for (const col of cols) {
        expect(received, `${table}.${col} fora do SELECT`).toContain(col);
      }
    };
    expectInclude("customers", CUSTOMER_COLUMNS);
    expectInclude("appointments", APPOINTMENT_COLUMNS);
    expectInclude("fulfillments", FULFILLMENT_COLUMNS);
    expectInclude("payments", PAYMENT_COLUMNS);
    expectInclude("plan_acceptances", PLAN_ACCEPTANCE_COLUMNS);
  });

  it("quando paciente não tem appointments nem fulfillments, pula queries em chain", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("customers", {
      data: { id: CUSTOMER_ID, name: "Ana" },
      error: null,
    });
    mock.enqueue("appointments", { data: [], error: null });
    mock.enqueue("fulfillments", { data: [], error: null });
    mock.enqueue("payments", { data: [], error: null });
    mock.enqueue("plan_acceptances", { data: [], error: null });
    mock.enqueue("appointments", { data: [], error: null });
    mock.enqueue("fulfillments", { data: [], error: null });

    const res = await exportPatientData(
      mock.client as unknown as SupabaseClient,
      CUSTOMER_ID
    );
    expect(res).not.toBeNull();
    expect(res!.appointment_notifications).toEqual([]);
    expect(res!.fulfillment_address_changes).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// anonymizePatient
// ────────────────────────────────────────────────────────────────────────

describe("anonymizePatient", () => {
  it("retorna customer_not_found se maybeSingle devolve null", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("customers", { data: null, error: null });

    const res = await anonymizePatient(
      mock.client as unknown as SupabaseClient,
      CUSTOMER_ID
    );
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ code: "customer_not_found" });
  });

  it("retorna already_anonymized se anonymized_at preenchido", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("customers", {
      data: { id: CUSTOMER_ID, anonymized_at: "2026-04-19T10:00:00.000Z" },
      error: null,
    });

    const res = await anonymizePatient(
      mock.client as unknown as SupabaseClient,
      CUSTOMER_ID
    );
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ code: "already_anonymized" });
  });

  it("bloqueia se existe fulfillment em paid/pharmacy_requested/shipped", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("customers", {
      data: { id: CUSTOMER_ID, anonymized_at: null },
      error: null,
    });
    mock.enqueue("fulfillments", {
      data: [{ id: "ff1", status: "shipped" }],
      error: null,
    });

    const res = await anonymizePatient(
      mock.client as unknown as SupabaseClient,
      CUSTOMER_ID
    );
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ code: "has_active_fulfillment" });
  });

  it("happy path: atualiza customer com placeholders e retorna ref", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("customers", {
      data: { id: CUSTOMER_ID, anonymized_at: null },
      error: null,
    });
    mock.enqueue("fulfillments", { data: [], error: null });
    mock.enqueue("customers", { data: null, error: null });

    const res = await anonymizePatient(
      mock.client as unknown as SupabaseClient,
      CUSTOMER_ID,
      { now: NOW }
    );
    expect(res.ok).toBe(true);
    expect(res).toMatchObject({
      customerId: CUSTOMER_ID,
      anonymizedAt: "2026-04-20T12:00:00.000Z",
      anonymizedRef: REF,
    });

    // Verifica que o update foi chamado com placeholders.
    const updCall = mock.calls.find(
      (c) => c.table === "customers" && c.chain.includes("update")
    );
    expect(updCall).toBeTruthy();
    const updateArgs = updCall!.args[updCall!.chain.indexOf("update")];
    const patch = updateArgs[0] as Record<string, unknown>;
    expect(patch.name).toBe(placeholderName(REF));
    expect(patch.email).toBe(placeholderEmail(REF));
    expect(patch.cpf).toBe(placeholderCpf(REF));
    expect(patch.phone).toBe(placeholderPhone(REF));
    expect(patch.address_city).toBeNull();
    expect(patch.lead_id).toBeNull();
    expect(patch.anonymized_at).toBe("2026-04-20T12:00:00.000Z");
    expect(patch.anonymized_ref).toBe(REF);
  });

  it("force=true ignora bloqueio de fulfillment ativo", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("customers", {
      data: { id: CUSTOMER_ID, anonymized_at: null },
      error: null,
    });
    mock.enqueue("customers", { data: null, error: null });

    const res = await anonymizePatient(
      mock.client as unknown as SupabaseClient,
      CUSTOMER_ID,
      { now: NOW, force: true }
    );
    expect(res.ok).toBe(true);

    // Não deve ter chamado fulfillments (force pula a checagem)
    const ffCall = mock.calls.find((c) => c.table === "fulfillments");
    expect(ffCall).toBeUndefined();
  });

  it("retorna update_failed quando update explode", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("customers", {
      data: { id: CUSTOMER_ID, anonymized_at: null },
      error: null,
    });
    mock.enqueue("fulfillments", { data: [], error: null });
    mock.enqueue("customers", {
      data: null,
      error: { message: "constraint violation" },
    });

    const res = await anonymizePatient(
      mock.client as unknown as SupabaseClient,
      CUSTOMER_ID,
      { now: NOW }
    );
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ code: "update_failed" });
  });

  it("retorna update_failed quando load inicial do customer falha", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("customers", {
      data: null,
      error: { message: "connection refused" },
    });

    const res = await anonymizePatient(
      mock.client as unknown as SupabaseClient,
      CUSTOMER_ID
    );
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ code: "update_failed" });
  });
});
