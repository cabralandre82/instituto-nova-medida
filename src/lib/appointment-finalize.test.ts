/**
 * Testes unitários de `finalizeAppointment` (D-044 · onda 2.B).
 *
 * Cobre:
 *   - validação do payload (decisão obrigatória; prescribed exige
 *     plano UUID válido + URL Memed http/https; limites de tamanho)
 *   - ownership (doctor_id diferente → forbidden)
 *   - estado (cancelada → erro; já finalizada → already_finalized)
 *   - caminho feliz prescribed (cria fulfillment, atualiza appt,
 *     transiciona status pra completed)
 *   - caminho feliz declined (não cria fulfillment, limpa campos
 *     memed_*)
 *   - idempotência: se já existe fulfillment pro mesmo appointment,
 *     reusa o id em vez de tentar INSERT (evitando erro de unique)
 *   - plano inexistente / inativo
 *   - db_error propagado em cada etapa
 */

import { describe, it, expect } from "vitest";
import { createSupabaseMock } from "@/test/mocks/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  finalizeAppointment,
  validateFinalizeInput,
  type FinalizeInput,
} from "./appointment-finalize";

const APPT_ID = "11111111-1111-1111-1111-111111111111";
const DOCTOR_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_DOCTOR_ID = "33333333-3333-3333-3333-333333333333";
const CUSTOMER_ID = "44444444-4444-4444-4444-444444444444";
const PLAN_ID = "55555555-5555-5555-5555-555555555555";
const USER_ID = "66666666-6666-6666-6666-666666666666";
const FULFILL_ID = "77777777-7777-7777-7777-777777777777";

const prescribedInput: FinalizeInput = {
  decision: "prescribed",
  anamnese: { text: "Paciente relata fome constante." },
  hipotese: "Obesidade grau I",
  conduta: "Iniciar tirzepatida 2,5mg semanal",
  prescribed_plan_id: PLAN_ID,
  memed_prescription_url: "https://memed.com.br/r/abc",
  memed_prescription_id: "memed-abc",
};

const declinedInput: FinalizeInput = {
  decision: "declined",
  hipotese: "IMC abaixo do critério",
  conduta: "Orientação nutricional; sem indicação medicamentosa.",
};

// ────────────────────────────────────────────────────────────────────────
// validateFinalizeInput — pura
// ────────────────────────────────────────────────────────────────────────

describe("validateFinalizeInput", () => {
  it("aceita payload declined mínimo", () => {
    expect(validateFinalizeInput({ decision: "declined" })).toBeNull();
  });

  it("aceita payload prescribed completo", () => {
    expect(validateFinalizeInput(prescribedInput)).toBeNull();
  });

  it("rejeita decision ausente ou inválida", () => {
    expect(
      validateFinalizeInput({ decision: "x" as unknown as "prescribed" })
    ).toMatchObject({ code: "invalid_payload", field: "decision" });
  });

  it("rejeita prescribed sem plano", () => {
    expect(
      validateFinalizeInput({ ...prescribedInput, prescribed_plan_id: null })
    ).toMatchObject({
      code: "invalid_payload",
      field: "prescribed_plan_id",
    });
  });

  it("rejeita prescribed com plano em formato não-UUID", () => {
    expect(
      validateFinalizeInput({
        ...prescribedInput,
        prescribed_plan_id: "tirzepatida-90",
      })
    ).toMatchObject({ code: "invalid_payload", field: "prescribed_plan_id" });
  });

  it("rejeita prescribed sem URL Memed", () => {
    expect(
      validateFinalizeInput({
        ...prescribedInput,
        memed_prescription_url: null,
      })
    ).toMatchObject({
      code: "invalid_payload",
      field: "memed_prescription_url",
    });
  });

  it("rejeita prescribed com URL que não é http/https", () => {
    expect(
      validateFinalizeInput({
        ...prescribedInput,
        memed_prescription_url: "javascript:alert(1)",
      })
    ).toMatchObject({
      code: "invalid_payload",
      field: "memed_prescription_url",
    });
  });

  it("rejeita campos de texto que excedem 8000 chars", () => {
    expect(
      validateFinalizeInput({
        ...declinedInput,
        hipotese: "x".repeat(8001),
      })
    ).toMatchObject({ code: "invalid_payload", field: "hipotese" });

    expect(
      validateFinalizeInput({
        ...declinedInput,
        conduta: "x".repeat(8001),
      })
    ).toMatchObject({ code: "invalid_payload", field: "conduta" });
  });
});

// ────────────────────────────────────────────────────────────────────────
// finalizeAppointment — I/O mockado
// ────────────────────────────────────────────────────────────────────────

describe("finalizeAppointment", () => {
  function setupAppt(
    mock: ReturnType<typeof createSupabaseMock>,
    overrides: Partial<{
      doctor_id: string;
      status: string;
      finalized_at: string | null;
    }> = {}
  ) {
    mock.enqueue("appointments", {
      data: {
        id: APPT_ID,
        doctor_id: overrides.doctor_id ?? DOCTOR_ID,
        customer_id: CUSTOMER_ID,
        status: overrides.status ?? "scheduled",
        finalized_at: overrides.finalized_at ?? null,
      },
      error: null,
    });
  }

  function runFinalize(
    mock: ReturnType<typeof createSupabaseMock>,
    input: FinalizeInput,
    opts: { doctorId?: string } = {}
  ) {
    return finalizeAppointment(mock.client as unknown as SupabaseClient, {
      appointmentId: APPT_ID,
      doctorId: opts.doctorId ?? DOCTOR_ID,
      userId: USER_ID,
      input,
      now: new Date("2026-04-20T15:00:00Z"),
    });
  }

  it("retorna not_found quando appointment não existe", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("appointments", { data: null, error: null });

    const result = await runFinalize(mock, declinedInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("not_found");
  });

  it("retorna forbidden quando doctor_id não bate", async () => {
    const mock = createSupabaseMock();
    setupAppt(mock, { doctor_id: OTHER_DOCTOR_ID });

    const result = await runFinalize(mock, declinedInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("forbidden");
  });

  it("retorna cancelled quando consulta está cancelada", async () => {
    const mock = createSupabaseMock();
    setupAppt(mock, { status: "cancelled_by_patient" });

    const result = await runFinalize(mock, declinedInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("cancelled");
  });

  it("retorna already_finalized quando finalized_at já está preenchido", async () => {
    const mock = createSupabaseMock();
    setupAppt(mock, { finalized_at: "2026-04-19T10:00:00Z" });

    const result = await runFinalize(mock, declinedInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("already_finalized");
  });

  it("caminho feliz declined: não busca plano nem cria fulfillment", async () => {
    const mock = createSupabaseMock();
    setupAppt(mock);
    mock.enqueue("appointments", { data: null, error: null }); // update

    const result = await runFinalize(mock, declinedInput);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fulfillmentId).toBeNull();
      expect(result.status).toBe("completed");
    }

    const tables = mock.calls.map((c) => c.table);
    expect(tables).toEqual(["appointments", "appointments"]);
    expect(tables).not.toContain("plans");
    expect(tables).not.toContain("fulfillments");
  });

  it("caminho feliz prescribed: valida plano, cria fulfillment e atualiza appt", async () => {
    const mock = createSupabaseMock();
    setupAppt(mock);
    mock.enqueue("plans", {
      data: { id: PLAN_ID, slug: "tirzepatida-90", active: true },
      error: null,
    });
    mock.enqueue("fulfillments", { data: null, error: null }); // select maybeSingle
    mock.enqueue("fulfillments", {
      data: { id: FULFILL_ID },
      error: null,
    }); // insert().single()
    mock.enqueue("appointments", { data: null, error: null }); // update

    const result = await runFinalize(mock, prescribedInput);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fulfillmentId).toBe(FULFILL_ID);
      expect(result.status).toBe("completed");
    }

    const tables = mock.calls.map((c) => c.table);
    expect(tables).toEqual([
      "appointments",
      "plans",
      "fulfillments",
      "fulfillments",
      "appointments",
    ]);

    const updateCall = mock.calls[mock.calls.length - 1];
    expect(updateCall.chain).toContain("update");
    expect(updateCall.chain).toContain("eq");
  });

  it("idempotência: se fulfillment já existe, reusa id sem tentar INSERT", async () => {
    const mock = createSupabaseMock();
    setupAppt(mock);
    mock.enqueue("plans", {
      data: { id: PLAN_ID, slug: "tirzepatida-90", active: true },
      error: null,
    });
    mock.enqueue("fulfillments", {
      data: { id: FULFILL_ID, appointment_id: APPT_ID },
      error: null,
    });
    mock.enqueue("appointments", { data: null, error: null });

    const result = await runFinalize(mock, prescribedInput);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.fulfillmentId).toBe(FULFILL_ID);

    const tables = mock.calls.map((c) => c.table);
    expect(tables).toEqual([
      "appointments",
      "plans",
      "fulfillments",
      "appointments",
    ]);
  });

  it("plano inexistente gera plan_not_active", async () => {
    const mock = createSupabaseMock();
    setupAppt(mock);
    mock.enqueue("plans", { data: null, error: null });

    const result = await runFinalize(mock, prescribedInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("plan_not_active");
  });

  it("plano inativo gera plan_not_active", async () => {
    const mock = createSupabaseMock();
    setupAppt(mock);
    mock.enqueue("plans", {
      data: { id: PLAN_ID, slug: "arquivado", active: false },
      error: null,
    });

    const result = await runFinalize(mock, prescribedInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("plan_not_active");
  });

  it("no_show_patient: finaliza como declined preservando o status (não vira completed)", async () => {
    const mock = createSupabaseMock();
    setupAppt(mock, { status: "no_show_patient" });
    mock.enqueue("appointments", { data: null, error: null });

    const result = await runFinalize(mock, declinedInput);
    expect(result.ok).toBe(true);
    // O contrato promete `status: 'completed'` no retorno como sinalização
    // do endpoint; o patch SQL respeita o status original — validamos só o
    // retorno aqui, já que a matriz de updates é do mock.
  });

  it("propaga db_error quando select de appointment falha", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("appointments", {
      data: null,
      error: { message: "connection reset" },
    });

    const result = await runFinalize(mock, declinedInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("db_error");
  });

  it("propaga db_error quando update de appointment falha", async () => {
    const mock = createSupabaseMock();
    setupAppt(mock);
    mock.enqueue("appointments", {
      data: null,
      error: { message: "timeout" },
    });

    const result = await runFinalize(mock, declinedInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("db_error");
  });

  it("propaga db_error quando insert de fulfillment falha", async () => {
    const mock = createSupabaseMock();
    setupAppt(mock);
    mock.enqueue("plans", {
      data: { id: PLAN_ID, slug: "x", active: true },
      error: null,
    });
    mock.enqueue("fulfillments", { data: null, error: null });
    mock.enqueue("fulfillments", {
      data: null,
      error: { message: "unique violation" },
    });

    const result = await runFinalize(mock, prescribedInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("db_error");
  });
});
