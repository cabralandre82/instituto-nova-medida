/**
 * Testes unitários — reliability.ts (D-038).
 *
 * Foco no caminho crítico: auto-pause no threshold hard, idempotência
 * de pause/unpause (importa muito, porque um pause perdido = médica
 * despausada por acidente; um pause duplicado = metadados manuais
 * sobrescritos por automação), e dedupe de events via 23505.
 *
 * Supabase é mockado — sem DB real. Cada teste enfileira explicitamente
 * as respostas das tabelas `doctors` e `doctor_reliability_events` na
 * ordem exata em que a função sob teste vai consumi-las.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseMock } from "@/test/mocks/supabase";

// Mock do módulo supabase ANTES dos imports que dependem dele.
vi.mock("@/lib/supabase", () => ({
  getSupabaseAdmin: vi.fn(),
  getSupabaseAnon: vi.fn(),
}));

import { getSupabaseAdmin } from "@/lib/supabase";
import {
  RELIABILITY_HARD_BLOCK,
  RELIABILITY_SOFT_WARN,
  RELIABILITY_WINDOW_DAYS,
  evaluateAndMaybeAutoPause,
  pauseDoctor,
  recordReliabilityEvent,
  unpauseDoctor,
} from "@/lib/reliability";

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

describe("recordReliabilityEvent", () => {
  it("registra evento novo e devolve ok com alreadyRecorded=false", async () => {
    supa.enqueue("doctor_reliability_events", {
      data: { id: "ev-1" },
      error: null,
    });

    const res = await recordReliabilityEvent({
      doctorId: "d-1",
      appointmentId: "a-1",
      kind: "no_show_doctor",
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.eventId).toBe("ev-1");
      expect(res.alreadyRecorded).toBe(false);
    }

    // Primeira chamada deve ser insert.
    expect(supa.calls[0].table).toBe("doctor_reliability_events");
    expect(supa.calls[0].chain).toContain("insert");
  });

  it("tolera conflito 23505 (appointment já registrado) e devolve alreadyRecorded=true", async () => {
    supa.enqueue("doctor_reliability_events", {
      data: null,
      error: { code: "23505", message: "duplicate key" },
    });
    supa.enqueue("doctor_reliability_events", {
      data: { id: "ev-existing" },
      error: null,
    });

    const res = await recordReliabilityEvent({
      doctorId: "d-1",
      appointmentId: "a-1",
      kind: "no_show_doctor",
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.eventId).toBe("ev-existing");
      expect(res.alreadyRecorded).toBe(true);
    }
  });

  it("propaga erro não-23505 como db_error", async () => {
    supa.enqueue("doctor_reliability_events", {
      data: null,
      error: { code: "42P01", message: "relation does not exist" },
    });

    const res = await recordReliabilityEvent({
      doctorId: "d-1",
      appointmentId: "a-1",
      kind: "no_show_doctor",
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("db_error");
    }
  });
});

describe("evaluateAndMaybeAutoPause", () => {
  it("NÃO pausa quando activeEvents < HARD_BLOCK", async () => {
    // getDoctorReliabilitySnapshot: doctor select + count events
    supa.enqueue("doctors", {
      data: {
        id: "d-1",
        reliability_paused_at: null,
        reliability_paused_auto: false,
        reliability_paused_reason: null,
      },
      error: null,
    });
    supa.enqueue("doctor_reliability_events", {
      data: null,
      error: null,
      count: RELIABILITY_HARD_BLOCK - 1,
    });

    const res = await evaluateAndMaybeAutoPause("d-1");

    expect(res.autoPaused).toBe(false);
    expect(res.snapshot?.activeEventsInWindow).toBe(RELIABILITY_HARD_BLOCK - 1);
    expect(res.snapshot?.isAtHardBlock).toBe(false);
    expect(res.snapshot?.isInSoftWarn).toBe(
      RELIABILITY_HARD_BLOCK - 1 >= RELIABILITY_SOFT_WARN
    );

    // Não deve ter chamado update na doctors.
    const updates = supa.calls.filter(
      (c) => c.table === "doctors" && c.chain.includes("update")
    );
    expect(updates).toHaveLength(0);
  });

  it("PAUSA automaticamente quando activeEvents >= HARD_BLOCK", async () => {
    // snapshot inicial: não pausada, HARD_BLOCK eventos
    supa.enqueue("doctors", {
      data: {
        id: "d-1",
        reliability_paused_at: null,
        reliability_paused_auto: false,
        reliability_paused_reason: null,
      },
      error: null,
    });
    supa.enqueue("doctor_reliability_events", {
      data: null,
      error: null,
      count: RELIABILITY_HARD_BLOCK,
    });

    // pauseDoctor faz select + update
    supa.enqueue("doctors", {
      data: {
        id: "d-1",
        reliability_paused_at: null,
        reliability_paused_auto: false,
      },
      error: null,
    });
    supa.enqueue("doctors", { data: null, error: null });

    const res = await evaluateAndMaybeAutoPause("d-1");

    expect(res.autoPaused).toBe(true);
    expect(res.snapshot?.isPaused).toBe(true);
    expect(res.snapshot?.pausedAuto).toBe(true);

    // Deve ter rodado UPDATE em doctors.
    const updates = supa.calls.filter(
      (c) => c.table === "doctors" && c.chain.includes("update")
    );
    expect(updates).toHaveLength(1);
  });

  it("é noop quando médica já está pausada", async () => {
    const pausedAt = new Date().toISOString();
    supa.enqueue("doctors", {
      data: {
        id: "d-1",
        reliability_paused_at: pausedAt,
        reliability_paused_auto: true,
        reliability_paused_reason: "Auto-pause anterior",
      },
      error: null,
    });
    supa.enqueue("doctor_reliability_events", {
      data: null,
      error: null,
      count: RELIABILITY_HARD_BLOCK + 5, // mesmo com MUITOS eventos
    });

    const res = await evaluateAndMaybeAutoPause("d-1");

    expect(res.autoPaused).toBe(false); // já estava pausada, não conta como "acabou de pausar"
    expect(res.snapshot?.isPaused).toBe(true);

    // Nenhum update deve ter rodado.
    const updates = supa.calls.filter(
      (c) => c.table === "doctors" && c.chain.includes("update")
    );
    expect(updates).toHaveLength(0);
  });
});

describe("pauseDoctor", () => {
  it("pausa médica ativa com metadados corretos", async () => {
    supa.enqueue("doctors", {
      data: {
        id: "d-1",
        reliability_paused_at: null,
        reliability_paused_auto: false,
      },
      error: null,
    });
    supa.enqueue("doctors", { data: null, error: null });

    const res = await pauseDoctor({
      doctorId: "d-1",
      reason: "motivo admin",
      triggeredBy: "admin-1",
      auto: false,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.alreadyPaused).toBe(false);
      expect(res.pausedAt).toBeTruthy();
    }

    // Verifica que o update foi chamado com os campos esperados.
    const updateCall = supa.calls.find(
      (c) => c.table === "doctors" && c.chain.includes("update")
    );
    expect(updateCall).toBeDefined();
    const [updatePayload] = updateCall!.args[updateCall!.chain.indexOf("update")];
    const payload = updatePayload as Record<string, unknown>;
    expect(payload.reliability_paused_by).toBe("admin-1");
    expect(payload.reliability_paused_reason).toBe("motivo admin");
    expect(payload.reliability_paused_auto).toBe(false);
  });

  it("é idempotente — não sobrescreve metadados se já pausada", async () => {
    const pausedAt = "2026-01-01T00:00:00.000Z";
    supa.enqueue("doctors", {
      data: {
        id: "d-1",
        reliability_paused_at: pausedAt,
        reliability_paused_auto: false, // foi pause MANUAL anterior
      },
      error: null,
    });

    // auto=true agora, mas como já pausada, não deve sobrescrever
    const res = await pauseDoctor({
      doctorId: "d-1",
      reason: "Auto-pause novo",
      triggeredBy: null,
      auto: true,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.alreadyPaused).toBe(true);
      expect(res.pausedAt).toBe(pausedAt);
      expect(res.previouslyPausedAuto).toBe(false); // preservou o manual
    }

    // NENHUM update deve ter rodado.
    const updates = supa.calls.filter(
      (c) => c.table === "doctors" && c.chain.includes("update")
    );
    expect(updates).toHaveLength(0);
  });

  it("retorna doctor_not_found se a médica não existe", async () => {
    supa.enqueue("doctors", { data: null, error: null });

    const res = await pauseDoctor({
      doctorId: "d-missing",
      reason: "x",
      triggeredBy: "admin-1",
      auto: false,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("doctor_not_found");
    }
  });
});

describe("unpauseDoctor", () => {
  it("limpa campos de pause quando médica estava pausada", async () => {
    supa.enqueue("doctors", {
      data: {
        id: "d-1",
        reliability_paused_at: "2026-01-01T00:00:00.000Z",
      },
      error: null,
    });
    supa.enqueue("doctors", { data: null, error: null });

    const res = await unpauseDoctor({
      doctorId: "d-1",
      unpausedBy: "admin-1",
      notes: "ok",
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.wasPaused).toBe(true);
    }

    const updateCall = supa.calls.find(
      (c) => c.table === "doctors" && c.chain.includes("update")
    );
    const [updatePayload] = updateCall!.args[updateCall!.chain.indexOf("update")];
    const payload = updatePayload as Record<string, unknown>;
    expect(payload.reliability_paused_at).toBeNull();
    expect(payload.reliability_paused_by).toBeNull();
    expect(payload.reliability_paused_auto).toBe(false);
  });

  it("é idempotente — noop se já estava despausada", async () => {
    supa.enqueue("doctors", {
      data: { id: "d-1", reliability_paused_at: null },
      error: null,
    });

    const res = await unpauseDoctor({
      doctorId: "d-1",
      unpausedBy: "admin-1",
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.wasPaused).toBe(false);
    }

    const updates = supa.calls.filter(
      (c) => c.table === "doctors" && c.chain.includes("update")
    );
    expect(updates).toHaveLength(0);
  });
});

describe("constants", () => {
  it("mantém os thresholds documentados em D-036", () => {
    expect(RELIABILITY_WINDOW_DAYS).toBe(30);
    expect(RELIABILITY_SOFT_WARN).toBe(2);
    expect(RELIABILITY_HARD_BLOCK).toBe(3);
    expect(RELIABILITY_SOFT_WARN).toBeLessThan(RELIABILITY_HARD_BLOCK);
  });
});
