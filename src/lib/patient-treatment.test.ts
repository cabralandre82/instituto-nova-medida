/**
 * Testes unitários para src/lib/patient-treatment.ts — D-043.
 *
 * Cobre a lógica de agregação que sustenta a área do paciente:
 *   - getActiveTreatment: janela do ciclo, daysRemaining, progressPct
 *   - getRenewalInfo: transições none/active/expiring_soon/expired
 *   - getUpcomingAppointment: filtro de statuses ativos, minutesUntil
 *   - listPastAppointments: filtro OR (terminal OR passed)
 *   - labelForAppointmentStatus / labelForRenewalStatus: mapa completo
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseMock } from "@/test/mocks/supabase";
import {
  getActiveTreatment,
  getRenewalInfo,
  getUpcomingAppointment,
  listPastAppointments,
  getPatientProfile,
  labelForAppointmentStatus,
  labelForRenewalStatus,
} from "./patient-treatment";

function asClient(mock: ReturnType<typeof createSupabaseMock>): SupabaseClient {
  return mock.client as unknown as SupabaseClient;
}

const CUSTOMER_ID = "550e8400-e29b-41d4-a716-446655440000";
const PLAN = {
  id: "plan-1",
  slug: "tirzepatida-90",
  name: "Tirzepatida 90 dias",
  medication: "Tirzepatida 2,5–7,5mg",
  cycle_days: 90,
};

describe("getActiveTreatment", () => {
  let supa: ReturnType<typeof createSupabaseMock>;
  beforeEach(() => {
    supa = createSupabaseMock();
  });

  it("returns null when no confirmed payment exists", async () => {
    supa.enqueue("payments", { data: null, error: null });
    const r = await getActiveTreatment(asClient(supa), CUSTOMER_ID);
    expect(r).toBeNull();
  });

  it("computes cycle window, daysRemaining e progressPct", async () => {
    const paidAt = new Date("2026-03-01T00:00:00Z");
    const now = new Date("2026-03-31T00:00:00Z"); // 30 dias dentro do ciclo de 90

    supa.enqueue("payments", {
      data: {
        id: "pay-1",
        amount_cents: 90000,
        paid_at: paidAt.toISOString(),
        plan_id: PLAN.id,
        plans: PLAN,
      },
      error: null,
    });

    const r = await getActiveTreatment(asClient(supa), CUSTOMER_ID, now);
    expect(r).not.toBeNull();
    expect(r!.planSlug).toBe(PLAN.slug);
    expect(r!.cycleDays).toBe(90);
    expect(r!.daysElapsed).toBe(30);
    expect(r!.daysRemaining).toBe(60);
    expect(r!.progressPct).toBeGreaterThanOrEqual(33);
    expect(r!.progressPct).toBeLessThanOrEqual(34);
    expect(r!.cycleEndsAt).toBe(new Date(paidAt.getTime() + 90 * 86400_000).toISOString());
  });

  it("returns negative daysRemaining when expired", async () => {
    const paidAt = new Date("2026-01-01T00:00:00Z");
    const now = new Date("2026-05-01T00:00:00Z"); // 120 dias depois, ciclo de 90 já acabou

    supa.enqueue("payments", {
      data: {
        id: "pay-1",
        amount_cents: 90000,
        paid_at: paidAt.toISOString(),
        plan_id: PLAN.id,
        plans: PLAN,
      },
      error: null,
    });

    const r = await getActiveTreatment(asClient(supa), CUSTOMER_ID, now);
    expect(r!.daysRemaining).toBeLessThanOrEqual(-29);
    expect(r!.progressPct).toBe(100);
  });

  it("handles plans embedded as array (PostgREST can serialize either)", async () => {
    const paidAt = new Date("2026-03-01T00:00:00Z");
    supa.enqueue("payments", {
      data: {
        id: "pay-1",
        amount_cents: 90000,
        paid_at: paidAt.toISOString(),
        plan_id: PLAN.id,
        plans: [PLAN],
      },
      error: null,
    });
    const r = await getActiveTreatment(asClient(supa), CUSTOMER_ID, paidAt);
    expect(r!.planSlug).toBe(PLAN.slug);
  });

  it("throws when Supabase returns an error", async () => {
    supa.enqueue("payments", { data: null, error: { message: "boom" } });
    await expect(getActiveTreatment(asClient(supa), CUSTOMER_ID)).rejects.toThrow(/boom/);
  });
});

describe("getRenewalInfo", () => {
  let supa: ReturnType<typeof createSupabaseMock>;
  beforeEach(() => {
    supa = createSupabaseMock();
  });

  it("returns 'none' when there is no active treatment", async () => {
    supa.enqueue("payments", { data: null, error: null });
    const r = await getRenewalInfo(asClient(supa), CUSTOMER_ID);
    expect(r.status).toBe("none");
    expect(r.active).toBeNull();
    expect(r.recommendedPlanSlug).toBeNull();
  });

  it("returns 'active' with >14 days left", async () => {
    const paidAt = new Date("2026-03-01T00:00:00Z");
    const now = new Date("2026-03-15T00:00:00Z"); // 76 dias restantes
    supa.enqueue("payments", {
      data: {
        id: "pay",
        amount_cents: 100,
        paid_at: paidAt.toISOString(),
        plan_id: PLAN.id,
        plans: PLAN,
      },
      error: null,
    });
    const r = await getRenewalInfo(asClient(supa), CUSTOMER_ID, now);
    expect(r.status).toBe("active");
    expect(r.recommendedPlanSlug).toBe(PLAN.slug);
  });

  it("returns 'expiring_soon' when ≤14 days", async () => {
    const paidAt = new Date("2026-01-01T00:00:00Z");
    const now = new Date("2026-03-25T00:00:00Z"); // ~ 7 dias restantes (ciclo 90)
    supa.enqueue("payments", {
      data: {
        id: "pay",
        amount_cents: 100,
        paid_at: paidAt.toISOString(),
        plan_id: PLAN.id,
        plans: PLAN,
      },
      error: null,
    });
    const r = await getRenewalInfo(asClient(supa), CUSTOMER_ID, now);
    expect(r.status).toBe("expiring_soon");
  });

  it("returns 'expired' when past cycleEndsAt", async () => {
    const paidAt = new Date("2026-01-01T00:00:00Z");
    const now = new Date("2026-05-01T00:00:00Z");
    supa.enqueue("payments", {
      data: {
        id: "pay",
        amount_cents: 100,
        paid_at: paidAt.toISOString(),
        plan_id: PLAN.id,
        plans: PLAN,
      },
      error: null,
    });
    const r = await getRenewalInfo(asClient(supa), CUSTOMER_ID, now);
    expect(r.status).toBe("expired");
  });
});

describe("getUpcomingAppointment", () => {
  let supa: ReturnType<typeof createSupabaseMock>;
  beforeEach(() => {
    supa = createSupabaseMock();
  });

  it("returns null when no upcoming exists", async () => {
    supa.enqueue("appointments", { data: null, error: null });
    const r = await getUpcomingAppointment(asClient(supa), CUSTOMER_ID);
    expect(r).toBeNull();
  });

  it("computes minutesUntil from scheduled_at", async () => {
    const now = new Date("2026-03-01T12:00:00Z");
    const scheduled = new Date("2026-03-01T12:30:00Z");
    supa.enqueue("appointments", {
      data: {
        id: "app-1",
        scheduled_at: scheduled.toISOString(),
        scheduled_until: null,
        status: "scheduled",
        completed_at: null,
        doctors: {
          full_name: "Dra Ana",
          display_name: "Dra. Ana",
          consultation_minutes: 30,
        },
      },
      error: null,
    });
    const r = await getUpcomingAppointment(asClient(supa), CUSTOMER_ID, now);
    expect(r!.minutesUntil).toBe(30);
    expect(r!.doctorName).toBe("Dra. Ana");
    expect(r!.durationMinutes).toBe(30);
  });

  it("filters by active statuses via .in", async () => {
    supa.enqueue("appointments", { data: null, error: null });
    await getUpcomingAppointment(asClient(supa), CUSTOMER_ID);
    const call = supa.calls.find((c) => c.table === "appointments");
    expect(call).toBeDefined();
    expect(call!.chain).toContain("in");
    const inArgs = call!.args[call!.chain.indexOf("in")];
    expect(inArgs[0]).toBe("status");
    expect(inArgs[1]).toEqual([
      "pending_payment",
      "scheduled",
      "confirmed",
      "in_progress",
    ]);
  });

  it("falls back to full_name when display_name missing", async () => {
    supa.enqueue("appointments", {
      data: {
        id: "app-1",
        scheduled_at: new Date().toISOString(),
        scheduled_until: null,
        status: "scheduled",
        completed_at: null,
        doctors: {
          full_name: "Dra Maria Completa",
          display_name: null,
          consultation_minutes: 45,
        },
      },
      error: null,
    });
    const r = await getUpcomingAppointment(asClient(supa), CUSTOMER_ID);
    expect(r!.doctorName).toBe("Dra Maria Completa");
    expect(r!.durationMinutes).toBe(45);
  });
});

describe("listPastAppointments", () => {
  let supa: ReturnType<typeof createSupabaseMock>;
  beforeEach(() => {
    supa = createSupabaseMock();
  });

  it("returns [] when data is null", async () => {
    supa.enqueue("appointments", { data: null, error: null });
    const r = await listPastAppointments(asClient(supa), CUSTOMER_ID);
    expect(r).toEqual([]);
  });

  it("maps rows with derived doctorName and duration defaults", async () => {
    supa.enqueue("appointments", {
      data: [
        {
          id: "a1",
          scheduled_at: "2026-02-01T10:00:00Z",
          scheduled_until: null,
          status: "completed",
          completed_at: "2026-02-01T10:30:00Z",
          doctors: null,
        },
        {
          id: "a2",
          scheduled_at: "2026-01-15T10:00:00Z",
          scheduled_until: null,
          status: "no_show_patient",
          completed_at: null,
          doctors: {
            full_name: "Dra. X",
            display_name: null,
            consultation_minutes: 30,
          },
        },
      ],
      error: null,
    });
    const r = await listPastAppointments(asClient(supa), CUSTOMER_ID, 10);
    expect(r).toHaveLength(2);
    expect(r[0].id).toBe("a1");
    expect(r[0].doctorName).toBe("Médica"); // fallback
    expect(r[0].durationMinutes).toBe(30); // default
    expect(r[1].doctorName).toBe("Dra. X");
  });

  it("uses .or filter that includes both terminal statuses and scheduled_at.lt.now", async () => {
    supa.enqueue("appointments", { data: [], error: null });
    await listPastAppointments(asClient(supa), CUSTOMER_ID);
    const call = supa.calls.find((c) => c.table === "appointments");
    expect(call).toBeDefined();
    expect(call!.chain).toContain("or");
    const orArgs = call!.args[call!.chain.indexOf("or")];
    const orClause = orArgs[0] as string;
    expect(orClause).toContain("status.in.");
    expect(orClause).toContain("completed");
    expect(orClause).toContain("scheduled_at.lt.");
  });

  it("throws on Supabase error", async () => {
    supa.enqueue("appointments", {
      data: null,
      error: { message: "network" },
    });
    await expect(
      listPastAppointments(asClient(supa), CUSTOMER_ID),
    ).rejects.toThrow(/network/);
  });
});

describe("getPatientProfile", () => {
  it("returns shape with id/name/email/phone", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("customers", {
      data: {
        id: CUSTOMER_ID,
        name: "Fulana",
        email: "f@x.com",
        phone: "11999998888",
      },
      error: null,
    });
    const r = await getPatientProfile(asClient(supa), CUSTOMER_ID);
    expect(r).toEqual({
      id: CUSTOMER_ID,
      name: "Fulana",
      email: "f@x.com",
      phone: "11999998888",
    });
  });

  it("returns null when not found", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("customers", { data: null, error: null });
    const r = await getPatientProfile(asClient(supa), CUSTOMER_ID);
    expect(r).toBeNull();
  });
});

describe("label helpers", () => {
  it("labelForAppointmentStatus: mapa completo", () => {
    expect(labelForAppointmentStatus("scheduled")).toBe("Agendada");
    expect(labelForAppointmentStatus("completed")).toBe("Concluída");
    expect(labelForAppointmentStatus("no_show_patient")).toBe("Você faltou");
    expect(labelForAppointmentStatus("no_show_doctor")).toBe("A médica faltou");
    expect(labelForAppointmentStatus("cancelled_by_admin")).toBe("Cancelada");
    expect(labelForAppointmentStatus("unknown_weird_status")).toBe(
      "unknown_weird_status",
    );
  });

  it("labelForRenewalStatus: exaustivo", () => {
    expect(labelForRenewalStatus("none")).toBe("Sem tratamento ativo");
    expect(labelForRenewalStatus("active")).toBe("Tratamento em dia");
    expect(labelForRenewalStatus("expiring_soon")).toBe("Prestes a expirar");
    expect(labelForRenewalStatus("expired")).toBe("Expirado");
  });
});
