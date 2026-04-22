/**
 * src/lib/patient-reliability.test.ts — PR-068 · D-076 · finding 17.6
 *
 * Cobre:
 *   1. `computeSnapshotFromEvents` (pura) — contagem, breakdown por
 *      kind, flags soft-warn / hard-flag, janela de 90 dias.
 *   2. `recordManualEvent` — validações de input (UUID, kind, notes),
 *      idempotência via 23505 em (appointment_id, kind), happy path.
 *   3. `dismissEvent` — idempotência (já dispensado), not_found,
 *      validação de reason.
 *   4. `getPatientReliabilitySnapshot` — retorna null pra customer
 *      inexistente, constrói snapshot agregado corretamente.
 *   5. `listCustomerEvents`, `listRecentEvents` — contract básico.
 *
 * Não exercita a trigger DB `trg_record_patient_reliability` (isso é
 * coberto via testes de integração/migration; aqui seria redundante
 * espelhar a lógica SQL em TS).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseMock } from "@/test/mocks/supabase";

vi.mock("@/lib/supabase", () => ({
  getSupabaseAdmin: vi.fn(),
  getSupabaseAnon: vi.fn(),
}));

import { getSupabaseAdmin } from "@/lib/supabase";
import {
  PATIENT_RELIABILITY_HARD_FLAG,
  PATIENT_RELIABILITY_SOFT_WARN,
  PATIENT_RELIABILITY_WINDOW_DAYS,
  MANUAL_KINDS,
  computeSnapshotFromEvents,
  dismissEvent,
  getPatientReliabilitySnapshot,
  listCustomerEvents,
  listRecentEvents,
  recordManualEvent,
  type PatientReliabilityKind,
} from "@/lib/patient-reliability";

const CUSTOMER_UUID = "11111111-2222-3333-4444-555555555555";
const APPT_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ADMIN_UUID = "99999999-aaaa-bbbb-cccc-dddddddddddd";
const EVENT_UUID = "66666666-7777-8888-9999-aaaaaaaaaaaa";

let supa: ReturnType<typeof createSupabaseMock>;

beforeEach(() => {
  supa = createSupabaseMock();
  vi.mocked(getSupabaseAdmin).mockReturnValue(
    supa.client as unknown as ReturnType<typeof getSupabaseAdmin>
  );
});

afterEach(() => {
  supa.reset();
  vi.clearAllMocks();
});

// ─── computeSnapshotFromEvents (pura) ──────────────────────────────────

describe("computeSnapshotFromEvents", () => {
  const now = new Date("2026-04-20T12:00:00Z");

  function mk(kind: PatientReliabilityKind, daysAgo: number) {
    const t = new Date(now.getTime() - daysAgo * 86400_000).toISOString();
    return { kind, occurred_at: t };
  }

  it("retorna zeros pra lista vazia", () => {
    const snap = computeSnapshotFromEvents(CUSTOMER_UUID, [], now);
    expect(snap.activeEventsInWindow).toBe(0);
    expect(snap.isInSoftWarn).toBe(false);
    expect(snap.isAtHardFlag).toBe(false);
    expect(snap.lastEventAt).toBeNull();
    expect(snap.windowDays).toBe(PATIENT_RELIABILITY_WINDOW_DAYS);
  });

  it("ignora eventos fora da janela de 90 dias", () => {
    const snap = computeSnapshotFromEvents(
      CUSTOMER_UUID,
      [mk("no_show_patient", 100), mk("reservation_abandoned", 120)],
      now
    );
    expect(snap.activeEventsInWindow).toBe(0);
    expect(snap.lastEventAt).toBeNull();
  });

  it("conta eventos na janela e agrega por kind", () => {
    const snap = computeSnapshotFromEvents(
      CUSTOMER_UUID,
      [
        mk("no_show_patient", 10),
        mk("no_show_patient", 20),
        mk("reservation_abandoned", 5),
      ],
      now
    );
    expect(snap.activeEventsInWindow).toBe(3);
    expect(snap.byKind.no_show_patient).toBe(2);
    expect(snap.byKind.reservation_abandoned).toBe(1);
    expect(snap.byKind.late_cancel_patient).toBe(0);
    expect(snap.isAtHardFlag).toBe(true);
  });

  it("dispara soft-warn em 2 eventos (< hard-flag=3)", () => {
    const snap = computeSnapshotFromEvents(
      CUSTOMER_UUID,
      [mk("no_show_patient", 5), mk("reservation_abandoned", 10)],
      now
    );
    expect(snap.activeEventsInWindow).toBe(PATIENT_RELIABILITY_SOFT_WARN);
    expect(snap.isInSoftWarn).toBe(true);
    expect(snap.isAtHardFlag).toBe(false);
  });

  it("hard-flag inclui soft-warn como exclusivo", () => {
    const snap = computeSnapshotFromEvents(
      CUSTOMER_UUID,
      [
        mk("no_show_patient", 5),
        mk("no_show_patient", 10),
        mk("reservation_abandoned", 15),
      ],
      now
    );
    expect(snap.activeEventsInWindow).toBe(PATIENT_RELIABILITY_HARD_FLAG);
    expect(snap.isInSoftWarn).toBe(false);
    expect(snap.isAtHardFlag).toBe(true);
  });

  it("lastEventAt é o maior occurred_at na janela", () => {
    const snap = computeSnapshotFromEvents(
      CUSTOMER_UUID,
      [mk("no_show_patient", 30), mk("manual", 2), mk("reservation_abandoned", 15)],
      now
    );
    const twoDaysAgo = new Date(now.getTime() - 2 * 86400_000).toISOString();
    expect(snap.lastEventAt).toBe(twoDaysAgo);
  });

  it("ignora occurred_at inválido sem quebrar", () => {
    const snap = computeSnapshotFromEvents(
      CUSTOMER_UUID,
      [
        { kind: "manual", occurred_at: "not-a-date" },
        { kind: "no_show_patient", occurred_at: new Date(now).toISOString() },
      ],
      now
    );
    expect(snap.activeEventsInWindow).toBe(1);
    expect(snap.byKind.no_show_patient).toBe(1);
    expect(snap.byKind.manual).toBe(0);
  });
});

// ─── recordManualEvent ─────────────────────────────────────────────────

describe("recordManualEvent — validação de input", () => {
  it("rejeita customerId não-UUID", async () => {
    const r = await recordManualEvent({
      customerId: "abc",
      kind: "manual",
      notes: "teste suficiente",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_customer");
    expect(supa.calls.length).toBe(0);
  });

  it("rejeita kind fora do allowlist manual", async () => {
    const r = await recordManualEvent({
      customerId: CUSTOMER_UUID,
      // @ts-expect-error — teste defensivo em tempo de execução
      kind: "no_show_patient",
      notes: "isso é auto",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_kind");
  });

  it("rejeita notes vazio / curto após sanitização", async () => {
    for (const n of ["", "   ", "\x00abc\x00", "abc"]) {
      const r = await recordManualEvent({
        customerId: CUSTOMER_UUID,
        kind: "manual",
        notes: n,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("invalid_notes");
    }
  });

  it("aceita ambos kinds do MANUAL_KINDS", () => {
    expect(MANUAL_KINDS).toContain("manual");
    expect(MANUAL_KINDS).toContain("refund_requested");
    expect(MANUAL_KINDS.length).toBe(2);
  });
});

describe("recordManualEvent — happy path", () => {
  it("insere evento novo e retorna eventId", async () => {
    supa.enqueue("patient_reliability_events", {
      data: { id: EVENT_UUID },
      error: null,
    });
    const r = await recordManualEvent({
      customerId: CUSTOMER_UUID,
      kind: "manual",
      notes: "paciente ligou agressivo após cancelamento de oferta",
      adminUserId: ADMIN_UUID,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.eventId).toBe(EVENT_UUID);
      expect(r.alreadyRecorded).toBe(false);
    }
    expect(supa.calls[0].chain).toContain("insert");
  });

  it("aceita appointmentId válido", async () => {
    supa.enqueue("patient_reliability_events", {
      data: { id: EVENT_UUID },
      error: null,
    });
    const r = await recordManualEvent({
      customerId: CUSTOMER_UUID,
      appointmentId: APPT_UUID,
      kind: "refund_requested",
      notes: "paciente pediu reembolso 5 dias após consulta",
    });
    expect(r.ok).toBe(true);
  });

  it("ignora appointmentId não-UUID (passa null)", async () => {
    supa.enqueue("patient_reliability_events", {
      data: { id: EVENT_UUID },
      error: null,
    });
    const r = await recordManualEvent({
      customerId: CUSTOMER_UUID,
      appointmentId: "not-a-uuid",
      kind: "manual",
      notes: "registro sem appointment",
    });
    expect(r.ok).toBe(true);
  });
});

describe("recordManualEvent — idempotência", () => {
  it("23505 com appointmentId: devolve alreadyRecorded=true", async () => {
    supa.enqueue("patient_reliability_events", {
      data: null,
      error: { code: "23505", message: "duplicate key" },
    });
    supa.enqueue("patient_reliability_events", {
      data: { id: EVENT_UUID },
      error: null,
    });
    const r = await recordManualEvent({
      customerId: CUSTOMER_UUID,
      appointmentId: APPT_UUID,
      kind: "refund_requested",
      notes: "chamou duas vezes o mesmo botão",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.eventId).toBe(EVENT_UUID);
      expect(r.alreadyRecorded).toBe(true);
    }
  });

  it("erro de DB não-23505: retorna db_error", async () => {
    supa.enqueue("patient_reliability_events", {
      data: null,
      error: { code: "XX000", message: "connection lost" },
    });
    const r = await recordManualEvent({
      customerId: CUSTOMER_UUID,
      kind: "manual",
      notes: "registro qualquer",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("db_error");
  });
});

// ─── dismissEvent ──────────────────────────────────────────────────────

describe("dismissEvent", () => {
  it("rejeita eventId não-UUID", async () => {
    const r = await dismissEvent({
      eventId: "abc",
      dismissedBy: ADMIN_UUID,
      reason: "foi bug da plataforma",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("event_not_found");
    expect(supa.calls.length).toBe(0);
  });

  it("rejeita reason vazio / curto", async () => {
    for (const bad of ["", "   ", "abc"]) {
      const r = await dismissEvent({
        eventId: EVENT_UUID,
        dismissedBy: ADMIN_UUID,
        reason: bad,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("invalid_reason");
    }
  });

  it("retorna not_found quando linha não existe", async () => {
    supa.enqueue("patient_reliability_events", {
      data: null,
      error: null,
    });
    const r = await dismissEvent({
      eventId: EVENT_UUID,
      dismissedBy: ADMIN_UUID,
      reason: "admin ignorou por erro de lançamento",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("event_not_found");
  });

  it("já dispensado: retorna alreadyDismissed=true sem novo UPDATE", async () => {
    supa.enqueue("patient_reliability_events", {
      data: {
        id: EVENT_UUID,
        dismissed_at: "2026-04-10T00:00:00Z",
        customer_id: CUSTOMER_UUID,
      },
      error: null,
    });
    const r = await dismissEvent({
      eventId: EVENT_UUID,
      dismissedBy: ADMIN_UUID,
      reason: "revisado em reunião — foi bug",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.alreadyDismissed).toBe(true);
    // Apenas 1 chamada ao DB (SELECT), sem UPDATE.
    expect(supa.calls.length).toBe(1);
  });

  it("happy path: marca dismissed_at/by/reason e retorna alreadyDismissed=false", async () => {
    supa.enqueue("patient_reliability_events", {
      data: {
        id: EVENT_UUID,
        dismissed_at: null,
        customer_id: CUSTOMER_UUID,
      },
      error: null,
    });
    supa.enqueue("patient_reliability_events", {
      data: null,
      error: null,
    });
    const r = await dismissEvent({
      eventId: EVENT_UUID,
      dismissedBy: ADMIN_UUID,
      reason: "foi falso positivo por bug do reconcile",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.alreadyDismissed).toBe(false);
    expect(supa.calls.length).toBe(2);
    expect(supa.calls[1].chain).toContain("update");
  });
});

// ─── getPatientReliabilitySnapshot ─────────────────────────────────────

describe("getPatientReliabilitySnapshot", () => {
  it("retorna null pra customerId não-UUID", async () => {
    const r = await getPatientReliabilitySnapshot("abc");
    expect(r).toBeNull();
    expect(supa.calls.length).toBe(0);
  });

  it("retorna null quando customer inexistente", async () => {
    supa.enqueue("customers", { data: null, error: null });
    const r = await getPatientReliabilitySnapshot(CUSTOMER_UUID);
    expect(r).toBeNull();
  });

  it("retorna snapshot agregado quando customer existe", async () => {
    supa.enqueue("customers", {
      data: { id: CUSTOMER_UUID },
      error: null,
    });
    supa.enqueue("patient_reliability_events", {
      data: [
        {
          kind: "no_show_patient",
          occurred_at: new Date(Date.now() - 86400_000).toISOString(),
        },
        {
          kind: "reservation_abandoned",
          occurred_at: new Date(Date.now() - 2 * 86400_000).toISOString(),
        },
      ],
      error: null,
    });
    const r = await getPatientReliabilitySnapshot(CUSTOMER_UUID);
    expect(r).not.toBeNull();
    if (r) {
      expect(r.activeEventsInWindow).toBe(2);
      expect(r.isInSoftWarn).toBe(true);
      expect(r.byKind.no_show_patient).toBe(1);
      expect(r.byKind.reservation_abandoned).toBe(1);
    }
  });

  it("retorna null quando query de events falha", async () => {
    supa.enqueue("customers", {
      data: { id: CUSTOMER_UUID },
      error: null,
    });
    supa.enqueue("patient_reliability_events", {
      data: null,
      error: { message: "timeout" },
    });
    const r = await getPatientReliabilitySnapshot(CUSTOMER_UUID);
    expect(r).toBeNull();
  });
});

// ─── listCustomerEvents / listRecentEvents ────────────────────────────

describe("listCustomerEvents", () => {
  it("retorna [] pra customerId inválido", async () => {
    const r = await listCustomerEvents("xx");
    expect(r).toEqual([]);
    expect(supa.calls.length).toBe(0);
  });

  it("retorna rows ordenadas", async () => {
    supa.enqueue("patient_reliability_events", {
      data: [
        { id: "e1", customer_id: CUSTOMER_UUID, kind: "manual" },
        { id: "e2", customer_id: CUSTOMER_UUID, kind: "no_show_patient" },
      ],
      error: null,
    });
    const r = await listCustomerEvents(CUSTOMER_UUID);
    expect(r.length).toBe(2);
    expect(supa.calls[0].chain).toContain("order");
  });

  it("clampa limit entre 1 e 200", async () => {
    supa.enqueue("patient_reliability_events", { data: [], error: null });
    await listCustomerEvents(CUSTOMER_UUID, 9999);
    const limitCall = supa.calls[0].args[supa.calls[0].chain.indexOf("limit")];
    expect(limitCall?.[0]).toBe(200);
  });
});

describe("listRecentEvents", () => {
  it("retorna lista com customer_name e appointment_scheduled_at", async () => {
    supa.enqueue("patient_reliability_events", {
      data: [
        {
          id: "e1",
          customer_id: CUSTOMER_UUID,
          appointment_id: APPT_UUID,
          kind: "no_show_patient",
          occurred_at: "2026-04-10T12:00:00Z",
          notes: null,
          dismissed_at: null,
          dismissed_by: null,
          dismissed_reason: null,
          created_at: "2026-04-10T12:00:00Z",
          customers: { name: "Maria Silva" },
          appointments: { scheduled_at: "2026-04-10T09:00:00Z" },
        },
      ],
      error: null,
    });
    const r = await listRecentEvents(10);
    expect(r).toHaveLength(1);
    expect(r[0].customer_name).toBe("Maria Silva");
    expect(r[0].appointment_scheduled_at).toBe("2026-04-10T09:00:00Z");
  });

  it("retorna [] em erro de DB", async () => {
    supa.enqueue("patient_reliability_events", {
      data: null,
      error: { message: "network" },
    });
    const r = await listRecentEvents();
    expect(r).toEqual([]);
  });
});
