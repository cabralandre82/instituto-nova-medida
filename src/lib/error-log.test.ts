/**
 * Testes de error-log (D-045 · 3.G).
 *
 * Foco em:
 *   - Helpers puros (truncate, clampWindowHours, clampPerSourceLimit,
 *     sinceIso)
 *   - Agregação/ordenação de entries por `loadErrorLog` com mocks
 *     das 5 fontes.
 *   - Counts por source mesmo quando alguma fonte volta vazia.
 */

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseMock } from "../test/mocks/supabase";
import {
  clampPerSourceLimit,
  clampWindowHours,
  loadErrorLog,
  sinceIso,
  truncate,
} from "./error-log";

const NOW = new Date("2026-04-20T12:00:00.000Z");

// ────────────────────────────────────────────────────────────────────────
// truncate
// ────────────────────────────────────────────────────────────────────────

describe("truncate", () => {
  it("devolve string vazia pra null/undefined/empty", () => {
    expect(truncate(null)).toBe("");
    expect(truncate(undefined)).toBe("");
    expect(truncate("")).toBe("");
  });

  it("não mexe em string dentro do limite", () => {
    expect(truncate("ok")).toBe("ok");
  });

  it("trunca com reticências", () => {
    expect(truncate("abcdef", 3)).toBe("abc…");
  });
});

// ────────────────────────────────────────────────────────────────────────
// clamps
// ────────────────────────────────────────────────────────────────────────

describe("clampWindowHours", () => {
  it("default 24 se NaN", () => {
    expect(clampWindowHours(Number.NaN)).toBe(24);
    expect(clampWindowHours(Infinity)).toBe(24);
  });

  it("mínimo 1, máximo 720 (30d)", () => {
    expect(clampWindowHours(0)).toBe(1);
    expect(clampWindowHours(-5)).toBe(1);
    expect(clampWindowHours(99999)).toBe(720);
    expect(clampWindowHours(48)).toBe(48);
  });

  it("arredonda valor fracionário", () => {
    expect(clampWindowHours(24.7)).toBe(25);
  });
});

describe("clampPerSourceLimit", () => {
  it("default 200 se NaN", () => {
    expect(clampPerSourceLimit(Number.NaN)).toBe(200);
  });

  it("mínimo 1, máximo 1000", () => {
    expect(clampPerSourceLimit(0)).toBe(1);
    expect(clampPerSourceLimit(5000)).toBe(1000);
    expect(clampPerSourceLimit(50)).toBe(50);
  });
});

// ────────────────────────────────────────────────────────────────────────
// sinceIso
// ────────────────────────────────────────────────────────────────────────

describe("sinceIso", () => {
  it("subtrai janela em horas e retorna ISO UTC", () => {
    expect(sinceIso(NOW, 24)).toBe("2026-04-19T12:00:00.000Z");
    expect(sinceIso(NOW, 1)).toBe("2026-04-20T11:00:00.000Z");
  });
});

// ────────────────────────────────────────────────────────────────────────
// loadErrorLog
// ────────────────────────────────────────────────────────────────────────

describe("loadErrorLog", () => {
  it("agrega 5 fontes, conta por source, ordena DESC por occurredAt", async () => {
    const mock = createSupabaseMock();

    mock.enqueue("cron_runs", {
      data: [
        {
          id: "c1",
          job: "auto_deliver_fulfillments",
          started_at: "2026-04-20T10:00:00.000Z",
          finished_at: "2026-04-20T10:00:05.000Z",
          error_message: "db timeout",
          duration_ms: 5000,
        },
      ],
      error: null,
    });

    mock.enqueue("asaas_events", {
      data: [
        {
          id: "a1",
          event_type: "PAYMENT_CONFIRMED",
          asaas_payment_id: "pay_xyz",
          received_at: "2026-04-20T11:00:00.000Z",
          processed_at: null,
          processing_error: "payment_id não encontrado na base",
        },
      ],
      error: null,
    });

    mock.enqueue("daily_events", {
      data: [
        {
          id: "d1",
          event_type: "meeting.ended",
          received_at: "2026-04-20T09:00:00.000Z",
          processed_at: null,
          processing_error: "room não linkado a appointment",
        },
      ],
      error: null,
    });

    mock.enqueue("appointment_notifications", {
      data: [
        {
          id: "n1",
          appointment_id: "ap_1",
          kind: "t_minus_1h",
          template_name: null,
          scheduled_for: "2026-04-20T09:30:00.000Z",
          updated_at: "2026-04-20T09:31:00.000Z",
          error: "fora da janela 24h",
        },
      ],
      error: null,
    });

    mock.enqueue("whatsapp_events", {
      data: [
        {
          id: "w1",
          event_type: "message_status",
          message_id: "wamid.XYZ",
          recipient_id: "5511999999999",
          received_at: "2026-04-20T11:30:00.000Z",
          error_code: 131047,
          error_title: "Re-engagement",
          error_message: "24h window closed",
        },
      ],
      error: null,
    });

    const log = await loadErrorLog(mock.client as unknown as SupabaseClient, {
      now: NOW,
      windowHours: 24,
    });

    expect(log.windowHours).toBe(24);
    expect(log.total).toBe(5);
    expect(log.sourceCounts).toEqual({
      cron: 1,
      asaas_webhook: 1,
      daily_webhook: 1,
      notification: 1,
      whatsapp_delivery: 1,
    });

    const occurredOrder = log.entries.map((e) => e.occurredAt);
    expect(occurredOrder).toEqual([
      "2026-04-20T11:30:00.000Z", // whatsapp_delivery
      "2026-04-20T11:00:00.000Z", // asaas
      "2026-04-20T10:00:05.000Z", // cron (uses finished_at)
      "2026-04-20T09:31:00.000Z", // notification
      "2026-04-20T09:00:00.000Z", // daily
    ]);

    const whatsapp = log.entries[0];
    expect(whatsapp.source).toBe("whatsapp_delivery");
    expect(whatsapp.message).toBe("Re-engagement · 24h window closed");
    expect(whatsapp.reference).toBe("whatsapp_events:w1");

    const cron = log.entries.find((e) => e.source === "cron")!;
    expect(cron.reference).toBe("cron_runs:c1");
    expect(cron.context.job).toBe("auto_deliver_fulfillments");
  });

  it("trata fontes vazias sem explodir", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("cron_runs", { data: [], error: null });
    mock.enqueue("asaas_events", { data: [], error: null });
    mock.enqueue("daily_events", { data: [], error: null });
    mock.enqueue("appointment_notifications", { data: [], error: null });
    mock.enqueue("whatsapp_events", { data: [], error: null });

    const log = await loadErrorLog(mock.client as unknown as SupabaseClient, {
      now: NOW,
    });

    expect(log.total).toBe(0);
    expect(log.entries).toEqual([]);
    expect(log.sourceCounts.cron).toBe(0);
  });

  it("propaga erro quando uma query falha", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("cron_runs", {
      data: null,
      error: { message: "db exploded" },
    });
    mock.enqueue("asaas_events", { data: [], error: null });
    mock.enqueue("daily_events", { data: [], error: null });
    mock.enqueue("appointment_notifications", { data: [], error: null });
    mock.enqueue("whatsapp_events", { data: [], error: null });

    await expect(
      loadErrorLog(mock.client as unknown as SupabaseClient, { now: NOW })
    ).rejects.toMatchObject({ message: "db exploded" });
  });

  it("fallback de occurredAt do cron usa started_at se finished_at for null", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("cron_runs", {
      data: [
        {
          id: "c2",
          job: "admin_digest",
          started_at: "2026-04-20T08:00:00.000Z",
          finished_at: null,
          error_message: "cron travou",
          duration_ms: null,
        },
      ],
      error: null,
    });
    mock.enqueue("asaas_events", { data: [], error: null });
    mock.enqueue("daily_events", { data: [], error: null });
    mock.enqueue("appointment_notifications", { data: [], error: null });
    mock.enqueue("whatsapp_events", { data: [], error: null });

    const log = await loadErrorLog(mock.client as unknown as SupabaseClient, {
      now: NOW,
    });
    expect(log.entries[0].occurredAt).toBe("2026-04-20T08:00:00.000Z");
  });

  it("whatsapp sem error_title/message gera mensagem default", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("cron_runs", { data: [], error: null });
    mock.enqueue("asaas_events", { data: [], error: null });
    mock.enqueue("daily_events", { data: [], error: null });
    mock.enqueue("appointment_notifications", { data: [], error: null });
    mock.enqueue("whatsapp_events", {
      data: [
        {
          id: "w2",
          event_type: "message_status",
          message_id: "wamid.A",
          recipient_id: "5511888887777",
          received_at: "2026-04-20T11:00:00.000Z",
          error_code: null,
          error_title: null,
          error_message: null,
        },
      ],
      error: null,
    });

    const log = await loadErrorLog(mock.client as unknown as SupabaseClient, {
      now: NOW,
    });
    expect(log.entries[0].message).toBe(
      "Meta retornou status=failed sem detalhes."
    );
  });

  it("usa valores default quando opts não informadas", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("cron_runs", { data: [], error: null });
    mock.enqueue("asaas_events", { data: [], error: null });
    mock.enqueue("daily_events", { data: [], error: null });
    mock.enqueue("appointment_notifications", { data: [], error: null });
    mock.enqueue("whatsapp_events", { data: [], error: null });

    const log = await loadErrorLog(mock.client as unknown as SupabaseClient);
    expect(log.windowHours).toBe(24);
    expect(log.perSourceLimit).toBe(200);
  });
});
