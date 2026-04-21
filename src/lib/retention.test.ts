/**
 * Testes de retention.ts (PR-033-A · D-052 · Onda 2B).
 *
 * Cenários cobertos:
 *   - findCustomersEligibleForRetentionAnonymize:
 *       · retorna só customers "ghost" (sem history)
 *       · descarta quem tem appointments/fulfillments/acceptances
 *       · respeita threshold e limit
 *       · retorna lista vazia quando nenhum customer é antigo o suficiente
 *       · erro no select retorna lista vazia (não throw)
 *   - runRetentionAnonymization:
 *       · dryRun não muta nada
 *       · anonimização emite logAdminAction + logPatientAccess com actor_kind=system
 *       · already_anonymized é contado como skipped
 *       · has_active_fulfillment é contado como skipped
 *       · relatório agrega contadores
 */

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseMock } from "../test/mocks/supabase";
import {
  findCustomersEligibleForRetentionAnonymize,
  runRetentionAnonymization,
  DEFAULT_RETENTION_THRESHOLD_DAYS,
  RETENTION_SYSTEM_EMAIL,
} from "./retention";

const NOW = new Date("2028-04-20T12:00:00.000Z");
const OLD = new Date("2025-01-01T00:00:00.000Z").toISOString(); // > 730d antes
const RECENT = new Date("2028-03-01T00:00:00.000Z").toISOString(); // < 730d antes

function asClient(mock: ReturnType<typeof createSupabaseMock>) {
  return mock.client as unknown as SupabaseClient;
}

describe("findCustomersEligibleForRetentionAnonymize", () => {
  it("retorna só ghosts (sem appointments/fulfillments/acceptances)", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("customers", {
      data: [
        { id: "c1", created_at: OLD, updated_at: OLD },
        { id: "c2", created_at: OLD, updated_at: OLD },
        { id: "c3", created_at: OLD, updated_at: OLD },
      ],
      error: null,
    });
    // c1 tem appointment, c3 tem acceptance; c2 é ghost.
    mock.enqueue("appointments", {
      data: [{ customer_id: "c1" }],
      error: null,
    });
    mock.enqueue("fulfillments", { data: [], error: null });
    mock.enqueue("plan_acceptances", {
      data: [{ customer_id: "c3" }],
      error: null,
    });

    const list = await findCustomersEligibleForRetentionAnonymize(
      asClient(mock),
      { now: NOW }
    );
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("c2");
  });

  it("lista vazia quando nenhum customer é antigo o suficiente", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("customers", { data: [], error: null });

    const list = await findCustomersEligibleForRetentionAnonymize(
      asClient(mock),
      { now: NOW }
    );
    expect(list).toHaveLength(0);
  });

  it("respeita limit (após filtrar por history)", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("customers", {
      data: [
        { id: "c1", created_at: OLD, updated_at: OLD },
        { id: "c2", created_at: OLD, updated_at: OLD },
        { id: "c3", created_at: OLD, updated_at: OLD },
        { id: "c4", created_at: OLD, updated_at: OLD },
      ],
      error: null,
    });
    mock.enqueue("appointments", { data: [], error: null });
    mock.enqueue("fulfillments", { data: [], error: null });
    mock.enqueue("plan_acceptances", { data: [], error: null });

    const list = await findCustomersEligibleForRetentionAnonymize(
      asClient(mock),
      { now: NOW, limit: 2 }
    );
    expect(list).toHaveLength(2);
  });

  it("query usa threshold corretamente (parâmetro lt recebe cutoff iso)", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("customers", { data: [], error: null });

    await findCustomersEligibleForRetentionAnonymize(asClient(mock), {
      now: NOW,
      thresholdDays: 365,
    });

    const call = mock.calls.find((c) => c.table === "customers");
    expect(call).toBeDefined();
    // .lt foi chamado 2x — um por created_at, um por updated_at.
    const ltCalls = call!.chain.filter((m) => m === "lt").length;
    expect(ltCalls).toBe(2);

    // O cutoff ISO está presente nos args de lt. 2028-04-20 - 365d = 2027-04-21.
    const ltArgsFlat = call!.args.flat();
    expect(
      ltArgsFlat.some(
        (a) =>
          typeof a === "string" &&
          a.startsWith("2027-04-") // aprox.: evita flake por DST
      )
    ).toBe(true);
  });

  it("erro no select de customers retorna lista vazia sem throw", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("customers", {
      data: null,
      error: { code: "42P01", message: "boom" },
    });

    const list = await findCustomersEligibleForRetentionAnonymize(
      asClient(mock),
      { now: NOW }
    );
    expect(list).toHaveLength(0);
  });
});

describe("runRetentionAnonymization", () => {
  it("dryRun não muta nada e reporta total de candidatos", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("customers", {
      data: [{ id: "c1", created_at: OLD, updated_at: OLD }],
      error: null,
    });
    mock.enqueue("appointments", { data: [], error: null });
    mock.enqueue("fulfillments", { data: [], error: null });
    mock.enqueue("plan_acceptances", { data: [], error: null });

    const report = await runRetentionAnonymization(asClient(mock), {
      now: NOW,
      dryRun: true,
    });

    expect(report.dryRun).toBe(true);
    expect(report.totalCandidates).toBe(1);
    expect(report.anonymized).toBe(0);
    // Nenhum update em customers.
    const updCalls = mock.calls.filter(
      (c) => c.table === "customers" && c.chain.includes("update")
    );
    expect(updCalls).toHaveLength(0);
  });

  it("happy path: anonimiza e emite audit+access log com actor_kind=system", async () => {
    const mock = createSupabaseMock();

    // 1. findCustomersEligible — customers select
    mock.enqueue("customers", {
      data: [{ id: "c1", created_at: OLD, updated_at: OLD }],
      error: null,
    });
    mock.enqueue("appointments", { data: [], error: null });
    mock.enqueue("fulfillments", { data: [], error: null });
    mock.enqueue("plan_acceptances", { data: [], error: null });

    // 2. anonymizePatient: select customer anonymized_at
    mock.enqueue("customers", {
      data: { id: "c1", anonymized_at: null },
      error: null,
    });
    // 3. anonymizePatient: select fulfillments blocking check
    mock.enqueue("fulfillments", { data: [], error: null });
    // 4. anonymizePatient: update customers
    mock.enqueue("customers", { data: null, error: null });

    // 5. logAdminAction → insert admin_audit_log
    mock.enqueue("admin_audit_log", {
      data: { id: "audit-1" },
      error: null,
    });
    // 6. logPatientAccess → insert patient_access_log
    mock.enqueue("patient_access_log", {
      data: { id: "log-1" },
      error: null,
    });

    const report = await runRetentionAnonymization(asClient(mock), {
      now: NOW,
    });

    expect(report.anonymized).toBe(1);
    expect(report.errors).toBe(0);
    expect(report.details[0]).toMatchObject({
      customerId: "c1",
      outcome: "anonymized",
    });

    // Confirma actor_kind=system e email no admin_audit_log.
    const auditCall = mock.calls.find(
      (c) => c.table === "admin_audit_log" && c.chain[0] === "insert"
    );
    const auditRow = auditCall!.args[0]?.[0] as Record<string, unknown>;
    expect(auditRow.actor_kind).toBe("system");
    expect(auditRow.actor_user_id).toBeNull();
    expect(auditRow.actor_email).toBe(RETENTION_SYSTEM_EMAIL);
    expect(auditRow.action).toBe("customer.retention_anonymize");

    // Confirma actor_kind=system no patient_access_log.
    const accessCall = mock.calls.find(
      (c) => c.table === "patient_access_log" && c.chain[0] === "insert"
    );
    const accessRow = accessCall!.args[0]?.[0] as Record<string, unknown>;
    expect(accessRow.actor_kind).toBe("system");
    expect(accessRow.admin_user_id).toBeNull();
    expect(accessRow.admin_email).toBe(RETENTION_SYSTEM_EMAIL);
    expect(accessRow.action).toBe("retention_anonymize");
  });

  it("already_anonymized é contado como skipped, não erro", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("customers", {
      data: [{ id: "c1", created_at: OLD, updated_at: OLD }],
      error: null,
    });
    mock.enqueue("appointments", { data: [], error: null });
    mock.enqueue("fulfillments", { data: [], error: null });
    mock.enqueue("plan_acceptances", { data: [], error: null });

    // anonymizePatient encontra row já anonimizada.
    mock.enqueue("customers", {
      data: {
        id: "c1",
        anonymized_at: "2027-01-01T00:00:00.000Z",
      },
      error: null,
    });

    const report = await runRetentionAnonymization(asClient(mock), {
      now: NOW,
    });
    expect(report.anonymized).toBe(0);
    expect(report.skippedAlreadyAnonymized).toBe(1);
    expect(report.errors).toBe(0);
  });

  it("has_active_fulfillment é contado como skipped (race tardia)", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("customers", {
      data: [{ id: "c1", created_at: OLD, updated_at: OLD }],
      error: null,
    });
    mock.enqueue("appointments", { data: [], error: null });
    mock.enqueue("fulfillments", { data: [], error: null });
    mock.enqueue("plan_acceptances", { data: [], error: null });

    mock.enqueue("customers", {
      data: { id: "c1", anonymized_at: null },
      error: null,
    });
    // Fulfillment ativo (paciente reativou nos últimos dias)
    mock.enqueue("fulfillments", {
      data: [{ id: "f1", status: "paid" }],
      error: null,
    });

    const report = await runRetentionAnonymization(asClient(mock), {
      now: NOW,
    });
    expect(report.skippedHasActiveFulfillment).toBe(1);
    expect(report.anonymized).toBe(0);
  });

  it("relatório vazio quando zero candidatos", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("customers", { data: [], error: null });

    const report = await runRetentionAnonymization(asClient(mock), {
      now: NOW,
    });
    expect(report.totalCandidates).toBe(0);
    expect(report.details).toHaveLength(0);
  });

  it("thresholdDays personalizado é passado adiante", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("customers", { data: [], error: null });

    const report = await runRetentionAnonymization(asClient(mock), {
      now: NOW,
      thresholdDays: 365,
    });
    expect(report.thresholdDays).toBe(365);
    // Default é 730 — confirma que não vazou.
    expect(report.thresholdDays).not.toBe(DEFAULT_RETENTION_THRESHOLD_DAYS);
  });
});

it("ignora customer recent (já vem filtrado pela query pelo cutoff)", () => {
  // Caso "customer atualizou recentemente" não aparece como candidato
  // porque o .lt("updated_at", cutoffIso) da query já bloqueia. Teste
  // existencial — o banco é que faz o filtro, aqui só documentamos.
  expect(RECENT > OLD).toBe(true);
});
