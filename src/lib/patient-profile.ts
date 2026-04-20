/**
 * src/lib/patient-profile.ts — D-045 · 3.B
 *
 * Ficha consolidada do paciente. Abrir `/admin/pacientes/[id]` devolve
 * tudo que o operador precisa pra responder um WhatsApp sem cruzar
 * 5 painéis: dados cadastrais, consultas, fulfillments (estado de
 * entrega), pagamentos, aceites assinados, eventos timeline-friendly.
 *
 * Design:
 *   - Função `loadPatientProfile` busca TODAS as fontes em paralelo
 *     e retorna um objeto unificado. Se o customer não existe,
 *     retorna `null`.
 *   - Função `buildPatientTimeline` é **pura** — dada um profile,
 *     gera uma lista de eventos cronológicos (mais recente primeiro)
 *     misturando consulta agendada, aceite, pagamento, transições de
 *     fulfillment, etc. Testável sem I/O.
 *   - Sem RLS aqui — admin só, o endpoint gates.
 *   - Limites: pegamos últimas 50 appointments e últimos 50 payments.
 *     Mais que isso é paginação em onda futura.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// ────────────────────────────────────────────────────────────────────────
// Tipos
// ────────────────────────────────────────────────────────────────────────

export type PatientCustomer = {
  id: string;
  name: string;
  email: string;
  phone: string;
  cpf: string;
  userId: string | null;
  asaasCustomerId: string | null;
  createdAt: string;
  updatedAt: string;
  address: {
    zipcode: string | null;
    street: string | null;
    number: string | null;
    complement: string | null;
    district: string | null;
    city: string | null;
    state: string | null;
  };
  leadId: string | null;
};

export type PatientAppointment = {
  id: string;
  status: string;
  scheduledAt: string;
  finalizedAt: string | null;
  doctorName: string | null;
  doctorCrm: string | null;
  refundRequired: boolean;
  refundProcessedAt: string | null;
  memedPrescriptionUrl: string | null;
  prescribedPlanId: string | null;
  noShowPolicyAppliedAt: string | null;
  createdAt: string;
};

export type PatientFulfillment = {
  id: string;
  status: string;
  planName: string;
  planMedication: string | null;
  planCycleDays: number | null;
  appointmentId: string;
  createdAt: string;
  acceptedAt: string | null;
  paidAt: string | null;
  pharmacyRequestedAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  cancelledReason: string | null;
  trackingNote: string | null;
  paymentId: string | null;
  paymentStatus: string | null;
  paymentAmountCents: number | null;
  paymentInvoiceUrl: string | null;
};

export type PatientPayment = {
  id: string;
  status: string;
  amountCents: number;
  billingType: string;
  dueDate: string;
  createdAt: string;
  paidAt: string | null;
  refundedAt: string | null;
  invoiceUrl: string | null;
  asaasPaymentId: string | null;
  planSlug: string | null;
  planName: string | null;
};

export type PatientAcceptance = {
  id: string;
  fulfillmentId: string;
  acceptedAt: string;
  termsVersion: string;
  contentHash: string;
  planSlug: string | null;
  planName: string | null;
};

export type PatientProfile = {
  customer: PatientCustomer;
  appointments: PatientAppointment[];
  fulfillments: PatientFulfillment[];
  payments: PatientPayment[];
  acceptances: PatientAcceptance[];
};

// ────────────────────────────────────────────────────────────────────────
// Loader
// ────────────────────────────────────────────────────────────────────────

export async function loadPatientProfile(
  supabase: SupabaseClient,
  customerId: string
): Promise<PatientProfile | null> {
  const [customerRes, appsRes, ffRes, paysRes, accRes] = await Promise.all([
    supabase
      .from("customers")
      .select(
        `id, name, email, phone, cpf, user_id, asaas_customer_id, lead_id,
         created_at, updated_at,
         address_zipcode, address_street, address_number, address_complement,
         address_district, address_city, address_state`
      )
      .eq("id", customerId)
      .maybeSingle(),
    supabase
      .from("appointments")
      .select(
        `id, status, scheduled_at, finalized_at, refund_required,
         refund_processed_at, memed_prescription_url, prescribed_plan_id,
         no_show_policy_applied_at, created_at,
         doctor:doctors ( id, full_name, display_name, crm_number, crm_uf )`
      )
      .eq("customer_id", customerId)
      .order("scheduled_at", { ascending: false })
      .limit(50),
    supabase
      .from("fulfillments_operational")
      .select(
        `fulfillment_id, fulfillment_status, plan_name, plan_medication,
         plan_cycle_days, appointment_id, created_at, accepted_at, paid_at,
         pharmacy_requested_at, shipped_at, delivered_at, cancelled_at,
         cancelled_reason, tracking_note, payment_id, payment_status,
         payment_amount_cents, payment_invoice_url`
      )
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("payments")
      .select(
        `id, status, amount_cents, billing_type, due_date, created_at,
         paid_at, refunded_at, invoice_url, asaas_payment_id,
         plan:plans ( slug, name )`
      )
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("plan_acceptances")
      .select(
        `id, fulfillment_id, accepted_at, terms_version, content_hash,
         plan:plans ( slug, name )`
      )
      .eq("customer_id", customerId)
      .order("accepted_at", { ascending: false })
      .limit(50),
  ]);

  if (customerRes.error && customerRes.error.code !== "PGRST116") {
    throw new Error(
      `loadPatientProfile: customer query failed: ${customerRes.error.message}`
    );
  }
  if (!customerRes.data) return null;

  for (const [label, res] of [
    ["appointments", appsRes],
    ["fulfillments", ffRes],
    ["payments", paysRes],
    ["acceptances", accRes],
  ] as const) {
    if (res.error) {
      throw new Error(
        `loadPatientProfile: ${label} query failed: ${res.error.message}`
      );
    }
  }

  const c = customerRes.data;
  const customer: PatientCustomer = {
    id: c.id,
    name: c.name,
    email: c.email,
    phone: c.phone,
    cpf: c.cpf,
    userId: c.user_id ?? null,
    asaasCustomerId: c.asaas_customer_id ?? null,
    leadId: c.lead_id ?? null,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    address: {
      zipcode: c.address_zipcode ?? null,
      street: c.address_street ?? null,
      number: c.address_number ?? null,
      complement: c.address_complement ?? null,
      district: c.address_district ?? null,
      city: c.address_city ?? null,
      state: c.address_state ?? null,
    },
  };

  const appointments: PatientAppointment[] = (appsRes.data ?? []).map(
    (row: Record<string, unknown>) => {
      const doctor = (row.doctor ?? null) as
        | {
            id: string;
            full_name: string | null;
            display_name: string | null;
            crm_number: string | null;
            crm_uf: string | null;
          }
        | null;
      return {
        id: row.id as string,
        status: row.status as string,
        scheduledAt: row.scheduled_at as string,
        finalizedAt: (row.finalized_at as string | null) ?? null,
        doctorName:
          (doctor?.display_name ?? doctor?.full_name ?? null) || null,
        doctorCrm: doctor
          ? [doctor.crm_number, doctor.crm_uf].filter(Boolean).join(" / ") ||
            null
          : null,
        refundRequired: Boolean(row.refund_required),
        refundProcessedAt: (row.refund_processed_at as string | null) ?? null,
        memedPrescriptionUrl:
          (row.memed_prescription_url as string | null) ?? null,
        prescribedPlanId: (row.prescribed_plan_id as string | null) ?? null,
        noShowPolicyAppliedAt:
          (row.no_show_policy_applied_at as string | null) ?? null,
        createdAt: row.created_at as string,
      };
    }
  );

  const fulfillments: PatientFulfillment[] = (ffRes.data ?? []).map(
    (row: Record<string, unknown>) => ({
      id: row.fulfillment_id as string,
      status: row.fulfillment_status as string,
      planName: (row.plan_name as string | null) ?? "—",
      planMedication: (row.plan_medication as string | null) ?? null,
      planCycleDays: (row.plan_cycle_days as number | null) ?? null,
      appointmentId: row.appointment_id as string,
      createdAt: row.created_at as string,
      acceptedAt: (row.accepted_at as string | null) ?? null,
      paidAt: (row.paid_at as string | null) ?? null,
      pharmacyRequestedAt:
        (row.pharmacy_requested_at as string | null) ?? null,
      shippedAt: (row.shipped_at as string | null) ?? null,
      deliveredAt: (row.delivered_at as string | null) ?? null,
      cancelledAt: (row.cancelled_at as string | null) ?? null,
      cancelledReason: (row.cancelled_reason as string | null) ?? null,
      trackingNote: (row.tracking_note as string | null) ?? null,
      paymentId: (row.payment_id as string | null) ?? null,
      paymentStatus: (row.payment_status as string | null) ?? null,
      paymentAmountCents:
        (row.payment_amount_cents as number | null) ?? null,
      paymentInvoiceUrl:
        (row.payment_invoice_url as string | null) ?? null,
    })
  );

  const payments: PatientPayment[] = (paysRes.data ?? []).map(
    (row: Record<string, unknown>) => {
      const plan = (row.plan ?? null) as
        | { slug: string; name: string }
        | null;
      return {
        id: row.id as string,
        status: row.status as string,
        amountCents: (row.amount_cents as number) ?? 0,
        billingType: (row.billing_type as string) ?? "UNDEFINED",
        dueDate: row.due_date as string,
        createdAt: row.created_at as string,
        paidAt: (row.paid_at as string | null) ?? null,
        refundedAt: (row.refunded_at as string | null) ?? null,
        invoiceUrl: (row.invoice_url as string | null) ?? null,
        asaasPaymentId: (row.asaas_payment_id as string | null) ?? null,
        planSlug: plan?.slug ?? null,
        planName: plan?.name ?? null,
      };
    }
  );

  const acceptances: PatientAcceptance[] = (accRes.data ?? []).map(
    (row: Record<string, unknown>) => {
      const plan = (row.plan ?? null) as
        | { slug: string; name: string }
        | null;
      return {
        id: row.id as string,
        fulfillmentId: row.fulfillment_id as string,
        acceptedAt: row.accepted_at as string,
        termsVersion: row.terms_version as string,
        contentHash: row.content_hash as string,
        planSlug: plan?.slug ?? null,
        planName: plan?.name ?? null,
      };
    }
  );

  return { customer, appointments, fulfillments, payments, acceptances };
}

// ────────────────────────────────────────────────────────────────────────
// Timeline (pura)
// ────────────────────────────────────────────────────────────────────────

export type TimelineEventKind =
  | "appointment_scheduled"
  | "appointment_finalized"
  | "no_show_policy_applied"
  | "refund_processed"
  | "fulfillment_created"
  | "fulfillment_accepted"
  | "fulfillment_paid"
  | "fulfillment_pharmacy_requested"
  | "fulfillment_shipped"
  | "fulfillment_delivered"
  | "fulfillment_cancelled"
  | "payment_created"
  | "payment_received"
  | "payment_refunded"
  | "acceptance_signed";

export type TimelineEvent = {
  at: string;
  kind: TimelineEventKind;
  title: string;
  description: string | null;
  refId: string; // id do recurso fonte (appointment, fulfillment, payment, acceptance)
};

/**
 * Pura. Transforma um `PatientProfile` numa lista cronológica de eventos,
 * mais recente primeiro. Não chama I/O.
 */
export function buildPatientTimeline(profile: PatientProfile): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  for (const a of profile.appointments) {
    events.push({
      at: a.scheduledAt,
      kind: "appointment_scheduled",
      title: `Consulta agendada${a.doctorName ? ` com ${a.doctorName}` : ""}`,
      description: statusLabel(a.status),
      refId: a.id,
    });
    if (a.finalizedAt) {
      events.push({
        at: a.finalizedAt,
        kind: "appointment_finalized",
        title: "Consulta finalizada",
        description: a.prescribedPlanId
          ? "com prescrição de plano"
          : "sem prescrição",
        refId: a.id,
      });
    }
    if (a.noShowPolicyAppliedAt) {
      events.push({
        at: a.noShowPolicyAppliedAt,
        kind: "no_show_policy_applied",
        title: "Política de no-show aplicada",
        description: a.refundRequired ? "gera direito a refund" : null,
        refId: a.id,
      });
    }
    if (a.refundProcessedAt) {
      events.push({
        at: a.refundProcessedAt,
        kind: "refund_processed",
        title: "Estorno processado",
        description: null,
        refId: a.id,
      });
    }
  }

  for (const f of profile.fulfillments) {
    events.push({
      at: f.createdAt,
      kind: "fulfillment_created",
      title: `Plano prescrito: ${f.planName}`,
      description: "aguardando aceite do paciente",
      refId: f.id,
    });
    if (f.acceptedAt) {
      events.push({
        at: f.acceptedAt,
        kind: "fulfillment_accepted",
        title: "Paciente aceitou o plano",
        description: "pagamento pendente",
        refId: f.id,
      });
    }
    if (f.paidAt) {
      events.push({
        at: f.paidAt,
        kind: "fulfillment_paid",
        title: "Pagamento confirmado",
        description: "aguardando envio à farmácia",
        refId: f.id,
      });
    }
    if (f.pharmacyRequestedAt) {
      events.push({
        at: f.pharmacyRequestedAt,
        kind: "fulfillment_pharmacy_requested",
        title: "Receita enviada à farmácia",
        description: null,
        refId: f.id,
      });
    }
    if (f.shippedAt) {
      events.push({
        at: f.shippedAt,
        kind: "fulfillment_shipped",
        title: "Medicamento despachado ao paciente",
        description: f.trackingNote,
        refId: f.id,
      });
    }
    if (f.deliveredAt) {
      events.push({
        at: f.deliveredAt,
        kind: "fulfillment_delivered",
        title: "Entrega confirmada",
        description: null,
        refId: f.id,
      });
    }
    if (f.cancelledAt) {
      events.push({
        at: f.cancelledAt,
        kind: "fulfillment_cancelled",
        title: "Fulfillment cancelado",
        description: f.cancelledReason,
        refId: f.id,
      });
    }
  }

  for (const p of profile.payments) {
    events.push({
      at: p.createdAt,
      kind: "payment_created",
      title: `Cobrança criada${p.planName ? ` · ${p.planName}` : ""}`,
      description: `${(p.amountCents / 100).toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL",
      })} · ${p.billingType}`,
      refId: p.id,
    });
    if (p.paidAt) {
      events.push({
        at: p.paidAt,
        kind: "payment_received",
        title: "Pagamento recebido",
        description: null,
        refId: p.id,
      });
    }
    if (p.refundedAt) {
      events.push({
        at: p.refundedAt,
        kind: "payment_refunded",
        title: "Pagamento estornado",
        description: null,
        refId: p.id,
      });
    }
  }

  for (const acc of profile.acceptances) {
    events.push({
      at: acc.acceptedAt,
      kind: "acceptance_signed",
      title: "Termo de aceite assinado",
      description: `versão ${acc.termsVersion} · hash ${acc.contentHash.slice(
        0,
        8
      )}…`,
      refId: acc.id,
    });
  }

  return events.sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()
  );
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    scheduled: "agendada",
    confirmed: "confirmada",
    in_progress: "em andamento",
    completed: "concluída",
    cancelled: "cancelada",
    no_show: "no-show",
    expired: "expirada",
  };
  return map[status] ?? status;
}

// ────────────────────────────────────────────────────────────────────────
// Agregados (puros)
// ────────────────────────────────────────────────────────────────────────

export type PatientStats = {
  totalPaidCents: number;
  totalRefundedCents: number;
  netPaidCents: number;
  appointmentsCount: number;
  completedAppointmentsCount: number;
  activePlanName: string | null;
};

/**
 * Sumariza o que vale a pena mostrar em cima da ficha: quanto o
 * paciente já pagou, quanto foi estornado, saldo líquido, contagem
 * de consultas.
 */
export function summarizePatient(profile: PatientProfile): PatientStats {
  const totalPaidCents = profile.payments
    .filter((p) => p.paidAt && !p.refundedAt)
    .reduce((acc, p) => acc + p.amountCents, 0);
  const totalRefundedCents = profile.payments
    .filter((p) => p.refundedAt)
    .reduce((acc, p) => acc + p.amountCents, 0);

  const activePlan =
    profile.fulfillments.find(
      (f) =>
        f.status === "paid" ||
        f.status === "pharmacy_requested" ||
        f.status === "shipped"
    )?.planName ?? null;

  return {
    totalPaidCents,
    totalRefundedCents,
    netPaidCents: totalPaidCents - totalRefundedCents,
    appointmentsCount: profile.appointments.length,
    completedAppointmentsCount: profile.appointments.filter(
      (a) => a.status === "completed"
    ).length,
    activePlanName: activePlan,
  };
}
