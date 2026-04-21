/**
 * Testes de patient-profile (D-045 · 3.B).
 *
 * Foco em:
 *   - loadPatientProfile: não-existente devolve null; full shape
 *     mapeado corretamente; erro propagado.
 *   - buildPatientTimeline: pura, ordenação descendente,
 *     quantidade correta de eventos por fluxo.
 *   - summarizePatient: pura, agregados financeiros e contagens.
 */

import { describe, expect, it } from "vitest";
import { createSupabaseMock } from "../test/mocks/supabase";
import {
  buildPatientTimeline,
  loadPatientProfile,
  summarizePatient,
  type PatientProfile,
} from "./patient-profile";

const CID = "00000000-0000-0000-0000-000000000001";

function enqueueFullProfile(supa: ReturnType<typeof createSupabaseMock>) {
  supa.enqueue("customers", {
    data: {
      id: CID,
      name: "Ana Silva",
      email: "ana@x.com",
      phone: "11999991234",
      cpf: "12345678900",
      user_id: "u1",
      asaas_customer_id: "cus_001",
      lead_id: null,
      created_at: "2026-04-01T00:00:00Z",
      updated_at: "2026-04-10T00:00:00Z",
      address_zipcode: "01310100",
      address_street: "Av. Paulista",
      address_number: "1000",
      address_complement: null,
      address_district: "Bela Vista",
      address_city: "São Paulo",
      address_state: "SP",
    },
    error: null,
  });
  supa.enqueue("appointments", { data: [], error: null });
  supa.enqueue("fulfillments_operational", { data: [], error: null });
  supa.enqueue("payments", { data: [], error: null });
  supa.enqueue("plan_acceptances", { data: [], error: null });
}

// ────────────────────────────────────────────────────────────────────────
// loadPatientProfile
// ────────────────────────────────────────────────────────────────────────

describe("loadPatientProfile", () => {
  it("retorna null quando customer não existe", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("customers", { data: null, error: null });
    supa.enqueue("appointments", { data: [], error: null });
    supa.enqueue("fulfillments_operational", { data: [], error: null });
    supa.enqueue("payments", { data: [], error: null });
    supa.enqueue("plan_acceptances", { data: [], error: null });

    const profile = await loadPatientProfile(supa.client as never, CID);
    expect(profile).toBeNull();
  });

  it("retorna profile completo com dados mapeados", async () => {
    const supa = createSupabaseMock();
    enqueueFullProfile(supa);

    const profile = await loadPatientProfile(supa.client as never, CID);
    expect(profile).not.toBeNull();
    expect(profile?.customer.id).toBe(CID);
    expect(profile?.customer.name).toBe("Ana Silva");
    expect(profile?.customer.address.city).toBe("São Paulo");
    expect(profile?.customer.address.state).toBe("SP");
    expect(profile?.appointments).toEqual([]);
    expect(profile?.fulfillments).toEqual([]);
    expect(profile?.payments).toEqual([]);
    expect(profile?.acceptances).toEqual([]);
  });

  it("mapeia appointment com médica (display_name) corretamente", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("customers", {
      data: {
        id: CID,
        name: "Ana",
        email: "a@x.com",
        phone: "1",
        cpf: "12345678900",
        user_id: null,
        asaas_customer_id: null,
        lead_id: null,
        created_at: "2026-04-01T00:00:00Z",
        updated_at: "2026-04-01T00:00:00Z",
      },
      error: null,
    });
    supa.enqueue("appointments", {
      data: [
        {
          id: "a1",
          status: "completed",
          scheduled_at: "2026-04-15T10:00:00Z",
          finalized_at: "2026-04-15T10:30:00Z",
          refund_required: false,
          refund_processed_at: null,
          memed_prescription_url: "https://memed.x/p/1",
          prescribed_plan_id: "plan1",
          no_show_policy_applied_at: null,
          created_at: "2026-04-14T00:00:00Z",
          doctor: {
            id: "d1",
            full_name: "Dra. Carla Fernandes",
            display_name: "Dra. Carla",
            crm_number: "12345",
            crm_uf: "SP",
          },
        },
      ],
      error: null,
    });
    supa.enqueue("fulfillments_operational", { data: [], error: null });
    supa.enqueue("payments", { data: [], error: null });
    supa.enqueue("plan_acceptances", { data: [], error: null });

    const profile = await loadPatientProfile(supa.client as never, CID);
    expect(profile?.appointments).toHaveLength(1);
    expect(profile?.appointments[0].doctorName).toBe("Dra. Carla");
    expect(profile?.appointments[0].doctorCrm).toBe("12345 / SP");
    expect(profile?.appointments[0].memedPrescriptionUrl).toBe(
      "https://memed.x/p/1"
    );
  });

  it("fallback full_name quando display_name é null", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("customers", {
      data: {
        id: CID,
        name: "Ana",
        email: "a@x.com",
        phone: "1",
        cpf: "12345678900",
        user_id: null,
        asaas_customer_id: null,
        lead_id: null,
        created_at: "2026-04-01T00:00:00Z",
        updated_at: "2026-04-01T00:00:00Z",
      },
      error: null,
    });
    supa.enqueue("appointments", {
      data: [
        {
          id: "a1",
          status: "scheduled",
          scheduled_at: "2026-05-01T10:00:00Z",
          finalized_at: null,
          refund_required: false,
          refund_processed_at: null,
          memed_prescription_url: null,
          prescribed_plan_id: null,
          no_show_policy_applied_at: null,
          created_at: "2026-04-25T00:00:00Z",
          doctor: {
            id: "d2",
            full_name: "Dra. Paula",
            display_name: null,
            crm_number: "99999",
            crm_uf: "RJ",
          },
        },
      ],
      error: null,
    });
    supa.enqueue("fulfillments_operational", { data: [], error: null });
    supa.enqueue("payments", { data: [], error: null });
    supa.enqueue("plan_acceptances", { data: [], error: null });

    const profile = await loadPatientProfile(supa.client as never, CID);
    expect(profile?.appointments[0].doctorName).toBe("Dra. Paula");
  });

  it("propaga erro de customer (diferente de PGRST116)", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("customers", {
      data: null,
      error: { message: "connection timeout", code: "PGRST500" },
    });
    supa.enqueue("appointments", { data: [], error: null });
    supa.enqueue("fulfillments_operational", { data: [], error: null });
    supa.enqueue("payments", { data: [], error: null });
    supa.enqueue("plan_acceptances", { data: [], error: null });

    await expect(
      loadPatientProfile(supa.client as never, CID)
    ).rejects.toThrow(/connection timeout/);
  });

  it("propaga erro de fulfillments", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("customers", {
      data: {
        id: CID,
        name: "Ana",
        email: "a@x.com",
        phone: "1",
        cpf: "12345678900",
        user_id: null,
        asaas_customer_id: null,
        lead_id: null,
        created_at: "2026-04-01T00:00:00Z",
        updated_at: "2026-04-01T00:00:00Z",
      },
      error: null,
    });
    supa.enqueue("appointments", { data: [], error: null });
    supa.enqueue("fulfillments_operational", {
      data: null,
      error: { message: "view does not exist" },
    });
    supa.enqueue("payments", { data: [], error: null });
    supa.enqueue("plan_acceptances", { data: [], error: null });

    await expect(
      loadPatientProfile(supa.client as never, CID)
    ).rejects.toThrow(/fulfillments.*view does not exist/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// buildPatientTimeline
// ────────────────────────────────────────────────────────────────────────

function emptyProfile(): PatientProfile {
  return {
    customer: {
      id: CID,
      name: "Ana",
      email: "a@x.com",
      phone: "11",
      cpf: "12345678900",
      userId: null,
      asaasCustomerId: null,
      leadId: null,
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-04-01T00:00:00Z",
      address: {
        zipcode: null,
        street: null,
        number: null,
        complement: null,
        district: null,
        city: null,
        state: null,
      },
      anonymizedAt: null,
      anonymizedRef: null,
    },
    appointments: [],
    fulfillments: [],
    payments: [],
    acceptances: [],
  };
}

describe("buildPatientTimeline", () => {
  it("profile vazio retorna []", () => {
    expect(buildPatientTimeline(emptyProfile())).toEqual([]);
  });

  it("consulta agendada + finalizada gera 2 eventos", () => {
    const p = emptyProfile();
    p.appointments.push({
      id: "a1",
      status: "completed",
      scheduledAt: "2026-04-15T10:00:00Z",
      finalizedAt: "2026-04-15T10:30:00Z",
      doctorName: "Dra. Carla",
      doctorCrm: "12345 / SP",
      refundRequired: false,
      refundProcessedAt: null,
      memedPrescriptionUrl: null,
      prescribedPlanId: null,
      noShowPolicyAppliedAt: null,
      createdAt: "2026-04-14T00:00:00Z",
    });
    const events = buildPatientTimeline(p);
    expect(events).toHaveLength(2);
    // Mais recente primeiro
    expect(events[0].kind).toBe("appointment_finalized");
    expect(events[1].kind).toBe("appointment_scheduled");
    expect(events[1].title).toContain("Dra. Carla");
  });

  it("ciclo completo de fulfillment gera 7 eventos", () => {
    const p = emptyProfile();
    p.fulfillments.push({
      id: "f1",
      status: "delivered",
      planName: "Avançado",
      planMedication: "tirzepatida 5mg",
      planCycleDays: 90,
      appointmentId: "a1",
      createdAt: "2026-04-01T10:00:00Z",
      acceptedAt: "2026-04-02T10:00:00Z",
      paidAt: "2026-04-02T10:15:00Z",
      pharmacyRequestedAt: "2026-04-03T10:00:00Z",
      shippedAt: "2026-04-05T10:00:00Z",
      deliveredAt: "2026-04-08T10:00:00Z",
      cancelledAt: null,
      cancelledReason: null,
      trackingNote: "BR1234",
      paymentId: "p1",
      paymentStatus: "RECEIVED",
      paymentAmountCents: 240000,
      paymentInvoiceUrl: null,
    });
    const events = buildPatientTimeline(p);
    // created + accepted + paid + pharmacy + shipped + delivered = 6
    expect(events.filter((e) => e.kind.startsWith("fulfillment_"))).toHaveLength(
      6
    );
    expect(events[0].kind).toBe("fulfillment_delivered");
    expect(events[events.length - 1].kind).toBe("fulfillment_created");
  });

  it("fulfillment cancelado aparece", () => {
    const p = emptyProfile();
    p.fulfillments.push({
      id: "f1",
      status: "cancelled",
      planName: "Essencial",
      planMedication: null,
      planCycleDays: null,
      appointmentId: "a1",
      createdAt: "2026-04-01T10:00:00Z",
      acceptedAt: null,
      paidAt: null,
      pharmacyRequestedAt: null,
      shippedAt: null,
      deliveredAt: null,
      cancelledAt: "2026-04-02T00:00:00Z",
      cancelledReason: "paciente desistiu",
      trackingNote: null,
      paymentId: null,
      paymentStatus: null,
      paymentAmountCents: null,
      paymentInvoiceUrl: null,
    });
    const events = buildPatientTimeline(p);
    const cancel = events.find((e) => e.kind === "fulfillment_cancelled");
    expect(cancel?.description).toBe("paciente desistiu");
  });

  it("ordenação descendente mistura todas as fontes", () => {
    const p = emptyProfile();
    p.appointments.push({
      id: "a1",
      status: "scheduled",
      scheduledAt: "2026-04-10T10:00:00Z",
      finalizedAt: null,
      doctorName: null,
      doctorCrm: null,
      refundRequired: false,
      refundProcessedAt: null,
      memedPrescriptionUrl: null,
      prescribedPlanId: null,
      noShowPolicyAppliedAt: null,
      createdAt: "2026-04-09T00:00:00Z",
    });
    p.payments.push({
      id: "p1",
      status: "RECEIVED",
      amountCents: 120000,
      billingType: "PIX",
      dueDate: "2026-04-15",
      createdAt: "2026-04-12T10:00:00Z",
      paidAt: "2026-04-12T10:05:00Z",
      refundedAt: null,
      invoiceUrl: null,
      asaasPaymentId: "asaas_1",
      planSlug: "essencial",
      planName: "Essencial",
    });
    p.acceptances.push({
      id: "acc1",
      fulfillmentId: "f1",
      acceptedAt: "2026-04-11T10:00:00Z",
      termsVersion: "v1-2026-04",
      contentHash: "abcdef1234567890",
      planSlug: "essencial",
      planName: "Essencial",
    });
    const events = buildPatientTimeline(p);
    const dates = events.map((e) => e.at);
    // Deve estar em ordem desc
    for (let i = 0; i + 1 < dates.length; i++) {
      expect(new Date(dates[i]).getTime()).toBeGreaterThanOrEqual(
        new Date(dates[i + 1]).getTime()
      );
    }
  });

  it("acceptance descrição inclui versão e prefixo do hash", () => {
    const p = emptyProfile();
    p.acceptances.push({
      id: "acc1",
      fulfillmentId: "f1",
      acceptedAt: "2026-04-02T10:00:00Z",
      termsVersion: "v1-2026-04",
      contentHash: "deadbeefcafebabe1234",
      planSlug: null,
      planName: null,
    });
    const events = buildPatientTimeline(p);
    expect(events[0].description).toContain("v1-2026-04");
    expect(events[0].description).toContain("deadbeef");
  });
});

// ────────────────────────────────────────────────────────────────────────
// summarizePatient
// ────────────────────────────────────────────────────────────────────────

describe("summarizePatient", () => {
  it("profile vazio: tudo zero", () => {
    const s = summarizePatient(emptyProfile());
    expect(s.totalPaidCents).toBe(0);
    expect(s.totalRefundedCents).toBe(0);
    expect(s.netPaidCents).toBe(0);
    expect(s.appointmentsCount).toBe(0);
    expect(s.completedAppointmentsCount).toBe(0);
    expect(s.activePlanName).toBeNull();
  });

  it("soma pagamentos pagos (não estornados)", () => {
    const p = emptyProfile();
    p.payments = [
      {
        id: "p1",
        status: "RECEIVED",
        amountCents: 120000,
        billingType: "PIX",
        dueDate: "2026-04-15",
        createdAt: "2026-04-12T10:00:00Z",
        paidAt: "2026-04-12T10:05:00Z",
        refundedAt: null,
        invoiceUrl: null,
        asaasPaymentId: null,
        planSlug: null,
        planName: null,
      },
      {
        id: "p2",
        status: "REFUNDED",
        amountCents: 50000,
        billingType: "PIX",
        dueDate: "2026-04-20",
        createdAt: "2026-04-18T10:00:00Z",
        paidAt: "2026-04-18T10:01:00Z",
        refundedAt: "2026-04-19T10:00:00Z",
        invoiceUrl: null,
        asaasPaymentId: null,
        planSlug: null,
        planName: null,
      },
    ];
    const s = summarizePatient(p);
    expect(s.totalPaidCents).toBe(120000);
    expect(s.totalRefundedCents).toBe(50000);
    expect(s.netPaidCents).toBe(70000);
  });

  it("activePlan pega primeiro fulfillment em estado ativo", () => {
    const p = emptyProfile();
    p.fulfillments = [
      {
        id: "f1",
        status: "cancelled",
        planName: "Essencial",
        planMedication: null,
        planCycleDays: null,
        appointmentId: "a1",
        createdAt: "2026-03-01T00:00:00Z",
        acceptedAt: null,
        paidAt: null,
        pharmacyRequestedAt: null,
        shippedAt: null,
        deliveredAt: null,
        cancelledAt: "2026-03-02T00:00:00Z",
        cancelledReason: null,
        trackingNote: null,
        paymentId: null,
        paymentStatus: null,
        paymentAmountCents: null,
        paymentInvoiceUrl: null,
      },
      {
        id: "f2",
        status: "shipped",
        planName: "Avançado",
        planMedication: null,
        planCycleDays: null,
        appointmentId: "a2",
        createdAt: "2026-04-01T00:00:00Z",
        acceptedAt: "2026-04-02T00:00:00Z",
        paidAt: "2026-04-02T00:10:00Z",
        pharmacyRequestedAt: "2026-04-03T00:00:00Z",
        shippedAt: "2026-04-05T00:00:00Z",
        deliveredAt: null,
        cancelledAt: null,
        cancelledReason: null,
        trackingNote: null,
        paymentId: "p2",
        paymentStatus: "RECEIVED",
        paymentAmountCents: 240000,
        paymentInvoiceUrl: null,
      },
    ];
    const s = summarizePatient(p);
    expect(s.activePlanName).toBe("Avançado");
  });

  it("conta consultas e completadas", () => {
    const p = emptyProfile();
    p.appointments = [
      { ...stubApp("a1"), status: "completed" },
      { ...stubApp("a2"), status: "scheduled" },
      { ...stubApp("a3"), status: "completed" },
    ];
    const s = summarizePatient(p);
    expect(s.appointmentsCount).toBe(3);
    expect(s.completedAppointmentsCount).toBe(2);
  });
});

function stubApp(id: string) {
  return {
    id,
    status: "scheduled",
    scheduledAt: "2026-04-10T10:00:00Z",
    finalizedAt: null,
    doctorName: null,
    doctorCrm: null,
    refundRequired: false,
    refundProcessedAt: null,
    memedPrescriptionUrl: null,
    prescribedPlanId: null,
    noShowPolicyAppliedAt: null,
    createdAt: "2026-04-09T00:00:00Z",
  };
}
