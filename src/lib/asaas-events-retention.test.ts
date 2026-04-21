/**
 * Testes de `purgeAsaasEventsPayload` (PR-052 · D-063).
 *
 * Cobre:
 *   - Happy path: N candidatos → N purged, report correto.
 *   - Nenhum candidato → zero sem erro.
 *   - dryRun: SELECT acontece, UPDATE não.
 *   - Erro no SELECT → report.errors=1.
 *   - Erro no UPDATE → report.errors=1.
 *   - Clamp de threshold (<90 → 90; >3650 → 3650).
 *   - Concorrência parcial (SELECT vê X, UPDATE linka Y<X) não é erro.
 */

import { describe, it, expect } from "vitest";
import { createSupabaseMock } from "@/test/mocks/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  purgeAsaasEventsPayload,
  DEFAULT_PURGE_THRESHOLD_DAYS,
  MIN_PURGE_THRESHOLD_DAYS,
  MAX_PURGE_THRESHOLD_DAYS,
} from "./asaas-events-retention";

const NOW = new Date("2026-10-01T00:00:00.000Z");

describe("purgeAsaasEventsPayload", () => {
  it("zero candidatos → report vazio", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("asaas_events", { data: [], error: null });

    const r = await purgeAsaasEventsPayload(
      supa.client as unknown as SupabaseClient,
      { now: NOW }
    );

    expect(r.candidatesFound).toBe(0);
    expect(r.purged).toBe(0);
    expect(r.errors).toBe(0);
    expect(r.thresholdDays).toBe(DEFAULT_PURGE_THRESHOLD_DAYS);
    // SELECT aconteceu, UPDATE não
    expect(supa.calls.filter((c) => c.chain.includes("update"))).toHaveLength(
      0
    );
  });

  it("happy path: 3 candidatos → 3 purged", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("asaas_events", {
      data: [
        { id: "e1", processed_at: "2026-01-01T00:00:00Z" },
        { id: "e2", processed_at: "2026-02-01T00:00:00Z" },
        { id: "e3", processed_at: "2026-03-01T00:00:00Z" },
      ],
      error: null,
    });
    // UPDATE retorna os mesmos 3 ids linkados
    supa.enqueue("asaas_events", {
      data: [{ id: "e1" }, { id: "e2" }, { id: "e3" }],
      error: null,
    });

    const r = await purgeAsaasEventsPayload(
      supa.client as unknown as SupabaseClient,
      { now: NOW }
    );

    expect(r.candidatesFound).toBe(3);
    expect(r.purged).toBe(3);
    expect(r.errors).toBe(0);
    expect(r.oldestPurgedAt).toBe("2026-01-01T00:00:00Z");
    expect(r.newestPurgedAt).toBe("2026-03-01T00:00:00Z");

    // Checa que o UPDATE foi chamado com payload={}, payload_purged_at=NOW
    const updateCall = supa.calls.find(
      (c) => c.table === "asaas_events" && c.chain.includes("update")
    );
    expect(updateCall).toBeDefined();
    const payload = updateCall!.args[updateCall!.chain.indexOf("update")][0] as {
      payload: Record<string, unknown>;
      payload_purged_at: string;
    };
    expect(payload.payload).toEqual({});
    expect(payload.payload_purged_at).toBe(NOW.toISOString());
  });

  it("dryRun: SELECT acontece mas UPDATE não", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("asaas_events", {
      data: [{ id: "e1", processed_at: "2026-01-01T00:00:00Z" }],
      error: null,
    });

    const r = await purgeAsaasEventsPayload(
      supa.client as unknown as SupabaseClient,
      { now: NOW, dryRun: true }
    );

    expect(r.candidatesFound).toBe(1);
    expect(r.purged).toBe(0);
    expect(r.dryRun).toBe(true);
    expect(r.oldestPurgedAt).toBe("2026-01-01T00:00:00Z");
    expect(r.newestPurgedAt).toBe("2026-01-01T00:00:00Z");

    expect(
      supa.calls.filter(
        (c) => c.table === "asaas_events" && c.chain.includes("update")
      )
    ).toHaveLength(0);
  });

  it("erro no SELECT → errors=1", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("asaas_events", {
      data: null,
      error: { message: "connection reset" },
    });

    const r = await purgeAsaasEventsPayload(
      supa.client as unknown as SupabaseClient,
      { now: NOW }
    );

    expect(r.errors).toBe(1);
    expect(r.errorDetails[0]).toContain("connection reset");
  });

  it("erro no UPDATE → errors=1, purged=0", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("asaas_events", {
      data: [{ id: "e1", processed_at: "2026-01-01T00:00:00Z" }],
      error: null,
    });
    supa.enqueue("asaas_events", {
      data: null,
      error: { message: "deadlock detected" },
    });

    const r = await purgeAsaasEventsPayload(
      supa.client as unknown as SupabaseClient,
      { now: NOW }
    );

    expect(r.candidatesFound).toBe(1);
    expect(r.purged).toBe(0);
    expect(r.errors).toBe(1);
    expect(r.errorDetails[0]).toContain("deadlock");
  });

  it("concorrência parcial: SELECT vê 3, UPDATE linka 2 → nao é erro", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("asaas_events", {
      data: [
        { id: "e1", processed_at: "2026-01-01T00:00:00Z" },
        { id: "e2", processed_at: "2026-02-01T00:00:00Z" },
        { id: "e3", processed_at: "2026-03-01T00:00:00Z" },
      ],
      error: null,
    });
    // UPDATE retorna só 2 (guard pegou — outro pod purgou e3 primeiro)
    supa.enqueue("asaas_events", {
      data: [{ id: "e1" }, { id: "e2" }],
      error: null,
    });

    const r = await purgeAsaasEventsPayload(
      supa.client as unknown as SupabaseClient,
      { now: NOW }
    );

    expect(r.candidatesFound).toBe(3);
    expect(r.purged).toBe(2);
    expect(r.errors).toBe(0);
  });

  it("clamp threshold: <MIN → MIN", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("asaas_events", { data: [], error: null });

    const r = await purgeAsaasEventsPayload(
      supa.client as unknown as SupabaseClient,
      { now: NOW, thresholdDays: 1 }
    );

    expect(r.thresholdDays).toBe(MIN_PURGE_THRESHOLD_DAYS);
  });

  it("clamp threshold: >MAX → MAX", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("asaas_events", { data: [], error: null });

    const r = await purgeAsaasEventsPayload(
      supa.client as unknown as SupabaseClient,
      { now: NOW, thresholdDays: 999999 }
    );

    expect(r.thresholdDays).toBe(MAX_PURGE_THRESHOLD_DAYS);
  });

  it("usa cutoff = now - thresholdDays no SELECT", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("asaas_events", { data: [], error: null });

    await purgeAsaasEventsPayload(
      supa.client as unknown as SupabaseClient,
      { now: NOW, thresholdDays: 180 }
    );

    const selCall = supa.calls.find(
      (c) => c.table === "asaas_events" && c.chain.includes("lt")
    );
    expect(selCall).toBeDefined();
    // cutoff = 2026-10-01 - 180d = 2026-04-04
    const ltArgs = selCall!.args[selCall!.chain.indexOf("lt")];
    expect(ltArgs[0]).toBe("processed_at");
    const cutoffIso = ltArgs[1] as string;
    expect(cutoffIso).toBe(
      new Date(NOW.getTime() - 180 * 24 * 60 * 60 * 1000).toISOString()
    );
  });
});
