/**
 * src/lib/patient-treatment.ts — D-043 · Área do paciente
 *
 * Fonte única pra compor a visão do paciente sobre o próprio
 * tratamento. Sem regras novas — só agrega `customers`, `plans`,
 * `payments` e `appointments` em formas amigáveis pra UI.
 *
 * Conceitos:
 *   - "Tratamento ativo" = último `payment` CONFIRMED + `plan`
 *     associado. A janela do ciclo é `paid_at .. paid_at +
 *     plan.cycle_days`. Se não há payment confirmed, não há
 *     tratamento ativo (paciente veio só pro checkout, não finalizou).
 *   - "Status de renovação":
 *       · `none`         → nunca pagou
 *       · `active`       → dentro do ciclo, > 14 dias pra acabar
 *       · `expiring_soon`→ dentro do ciclo, ≤ 14 dias pra acabar
 *       · `expired`      → fora do ciclo (precisa renovar)
 *   - "Próxima consulta" = appointment com `scheduled_at >= now()`
 *     e status não-finalizado (pending_payment/scheduled/confirmed/
 *     in_progress).
 *   - "Histórico" = appointments finalizados OU passados, ordenados
 *     decrescente.
 *
 * Todas as funções recebem o `SupabaseClient` pra serem testáveis
 * sem depender de singleton.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type RenewalStatus = "none" | "active" | "expiring_soon" | "expired";

export type ActiveTreatment = {
  planId: string;
  planSlug: string;
  planName: string;
  planMedication: string | null;
  cycleDays: number;
  paidAt: string;          // ISO
  cycleEndsAt: string;     // ISO
  daysRemaining: number;   // pode ser negativo se expirou
  daysElapsed: number;
  progressPct: number;     // 0-100
  lastPaymentId: string;
  paymentAmountCents: number;
};

export type UpcomingAppointment = {
  id: string;
  scheduledAt: string;
  scheduledUntil: string | null;
  status: string;
  doctorName: string;
  durationMinutes: number;
  minutesUntil: number;  // diff agora → scheduled_at (pode ser negativo se em andamento)
};

export type PastAppointment = {
  id: string;
  scheduledAt: string;
  status: string;
  doctorName: string;
  durationMinutes: number;
  completedAt: string | null;
};

export type RenewalInfo = {
  status: RenewalStatus;
  active: ActiveTreatment | null;
  /** slug do plano sugerido pra renovar (mesmo slug do último pago). */
  recommendedPlanSlug: string | null;
};

type PaymentRow = {
  id: string;
  amount_cents: number;
  paid_at: string | null;
  plan_id: string;
  plans:
    | { id: string; slug: string; name: string; medication: string | null; cycle_days: number }
    | { id: string; slug: string; name: string; medication: string | null; cycle_days: number }[]
    | null;
};

type AppointmentRow = {
  id: string;
  scheduled_at: string;
  scheduled_until: string | null;
  status: string;
  completed_at: string | null;
  doctors:
    | { full_name: string; display_name: string | null; consultation_minutes: number }
    | { full_name: string; display_name: string | null; consultation_minutes: number }[]
    | null;
};

function pickSingle<T>(v: T | T[] | null): T | null {
  if (!v) return null;
  return Array.isArray(v) ? v[0] ?? null : v;
}

// ────────────────────────────────────────────────────────────────────
// Active treatment
// ────────────────────────────────────────────────────────────────────

export async function getActiveTreatment(
  supabase: SupabaseClient,
  customerId: string,
  now: Date = new Date(),
): Promise<ActiveTreatment | null> {
  const { data, error } = await supabase
    .from("payments")
    .select(
      "id, amount_cents, paid_at, plan_id, plans ( id, slug, name, medication, cycle_days )",
    )
    .eq("customer_id", customerId)
    .eq("status", "CONFIRMED")
    .not("paid_at", "is", null)
    .order("paid_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`getActiveTreatment: ${error.message}`);
  }
  if (!data) return null;

  const row = data as unknown as PaymentRow;
  const plan = pickSingle(row.plans);
  if (!plan || !row.paid_at) return null;

  const paidAt = new Date(row.paid_at);
  const cycleEndsAtMs = paidAt.getTime() + plan.cycle_days * 24 * 60 * 60 * 1000;
  const cycleEndsAt = new Date(cycleEndsAtMs);
  const totalMs = cycleEndsAtMs - paidAt.getTime();
  const elapsedMs = Math.max(0, now.getTime() - paidAt.getTime());
  const daysElapsed = Math.floor(elapsedMs / (24 * 60 * 60 * 1000));
  const daysRemaining = Math.ceil((cycleEndsAtMs - now.getTime()) / (24 * 60 * 60 * 1000));
  const progressPct = Math.max(0, Math.min(100, Math.round((elapsedMs / totalMs) * 100)));

  return {
    planId: plan.id,
    planSlug: plan.slug,
    planName: plan.name,
    planMedication: plan.medication ?? null,
    cycleDays: plan.cycle_days,
    paidAt: paidAt.toISOString(),
    cycleEndsAt: cycleEndsAt.toISOString(),
    daysRemaining,
    daysElapsed,
    progressPct,
    lastPaymentId: row.id,
    paymentAmountCents: row.amount_cents,
  };
}

// ────────────────────────────────────────────────────────────────────
// Next appointment
// ────────────────────────────────────────────────────────────────────

const ACTIVE_APPOINTMENT_STATUSES = [
  "pending_payment",
  "scheduled",
  "confirmed",
  "in_progress",
];

export async function getUpcomingAppointment(
  supabase: SupabaseClient,
  customerId: string,
  now: Date = new Date(),
): Promise<UpcomingAppointment | null> {
  const { data, error } = await supabase
    .from("appointments")
    .select(
      "id, scheduled_at, scheduled_until, status, completed_at, doctors ( full_name, display_name, consultation_minutes )",
    )
    .eq("customer_id", customerId)
    .in("status", ACTIVE_APPOINTMENT_STATUSES)
    .order("scheduled_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`getUpcomingAppointment: ${error.message}`);
  }
  if (!data) return null;

  const row = data as unknown as AppointmentRow;
  const doctor = pickSingle(row.doctors);
  const duration = doctor?.consultation_minutes ?? 30;
  const scheduledAtMs = new Date(row.scheduled_at).getTime();
  const minutesUntil = Math.round((scheduledAtMs - now.getTime()) / 60_000);

  return {
    id: row.id,
    scheduledAt: row.scheduled_at,
    scheduledUntil: row.scheduled_until,
    status: row.status,
    doctorName: doctor?.display_name || doctor?.full_name || "Médica",
    durationMinutes: duration,
    minutesUntil,
  };
}

// ────────────────────────────────────────────────────────────────────
// Past appointments (histórico)
// ────────────────────────────────────────────────────────────────────

export async function listPastAppointments(
  supabase: SupabaseClient,
  customerId: string,
  limit: number = 20,
): Promise<PastAppointment[]> {
  // "Passadas" = finalizadas (qualquer terminal status) OU com
  // scheduled_at no passado (inclui scheduled/confirmed que não
  // foram marcadas completed por algum motivo — UX melhor que
  // esconder).
  const nowIso = new Date().toISOString();
  const terminalStatuses = [
    "completed",
    "no_show_patient",
    "no_show_doctor",
    "cancelled_by_patient",
    "cancelled_by_doctor",
    "cancelled_by_admin",
  ];

  const { data, error } = await supabase
    .from("appointments")
    .select(
      "id, scheduled_at, scheduled_until, status, completed_at, doctors ( full_name, display_name, consultation_minutes )",
    )
    .eq("customer_id", customerId)
    .or(
      `status.in.(${terminalStatuses.join(",")}),and(scheduled_at.lt.${nowIso},status.not.in.(pending_payment))`,
    )
    .order("scheduled_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`listPastAppointments: ${error.message}`);
  }

  const rows = (data ?? []) as unknown as AppointmentRow[];
  return rows.map((row) => {
    const doctor = pickSingle(row.doctors);
    return {
      id: row.id,
      scheduledAt: row.scheduled_at,
      status: row.status,
      doctorName: doctor?.display_name || doctor?.full_name || "Médica",
      durationMinutes: doctor?.consultation_minutes ?? 30,
      completedAt: row.completed_at,
    };
  });
}

// ────────────────────────────────────────────────────────────────────
// Renewal
// ────────────────────────────────────────────────────────────────────

const EXPIRING_SOON_DAYS = 14;

export async function getRenewalInfo(
  supabase: SupabaseClient,
  customerId: string,
  now: Date = new Date(),
): Promise<RenewalInfo> {
  const active = await getActiveTreatment(supabase, customerId, now);
  if (!active) {
    return { status: "none", active: null, recommendedPlanSlug: null };
  }

  let status: RenewalStatus = "active";
  if (active.daysRemaining <= 0) status = "expired";
  else if (active.daysRemaining <= EXPIRING_SOON_DAYS) status = "expiring_soon";

  return {
    status,
    active,
    recommendedPlanSlug: active.planSlug,
  };
}

// ────────────────────────────────────────────────────────────────────
// Customer info (helpers de apresentação)
// ────────────────────────────────────────────────────────────────────

export type PatientProfile = {
  id: string;
  name: string;
  email: string;
  phone: string;
};

// ────────────────────────────────────────────────────────────────────
// Ofertas pendentes (D-044 · 2.C.2)
// ────────────────────────────────────────────────────────────────────
// Um fulfillment em `pending_acceptance` = médica prescreveu em uma
// consulta e o paciente ainda não aceitou. `pending_payment` = já
// aceitou e falta pagar. Ambos devem gerar card de ação na área do
// paciente.

export type PendingOffer = {
  fulfillmentId: string;
  appointmentId: string;
  status: "pending_acceptance" | "pending_payment";
  planName: string;
  planMedication: string | null;
  pricePixCents: number;
  doctorName: string;
  createdAt: string;
  invoiceUrl: string | null;
};

export async function listPendingOffers(
  supabase: SupabaseClient,
  customerId: string,
): Promise<PendingOffer[]> {
  const { data, error } = await supabase
    .from("fulfillments")
    .select(
      `id, status, appointment_id, created_at,
       plan:plans!inner(id, name, medication, price_pix_cents),
       doctor:doctors!inner(id, full_name, display_name),
       payment:payments(id, status, invoice_url)`
    )
    .eq("customer_id", customerId)
    .in("status", ["pending_acceptance", "pending_payment"])
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`listPendingOffers: ${error.message}`);
  }
  if (!data) return [];

  return (data as unknown[]).map((raw) => {
    const r = raw as Record<string, unknown>;
    const plan = pickSingle(
      r.plan as
        | { name: string; medication: string | null; price_pix_cents: number }
        | Array<{ name: string; medication: string | null; price_pix_cents: number }>
        | null
    );
    const doctor = pickSingle(
      r.doctor as
        | { full_name: string; display_name: string | null }
        | Array<{ full_name: string; display_name: string | null }>
        | null
    );
    const payment = pickSingle(
      r.payment as
        | { id: string; status: string; invoice_url: string | null }
        | Array<{ id: string; status: string; invoice_url: string | null }>
        | null
    );

    return {
      fulfillmentId: r.id as string,
      appointmentId: r.appointment_id as string,
      status: r.status as PendingOffer["status"],
      planName: plan?.name ?? "Plano indicado",
      planMedication: plan?.medication ?? null,
      pricePixCents: plan?.price_pix_cents ?? 0,
      doctorName: doctor?.display_name ?? doctor?.full_name ?? "Médica",
      createdAt: r.created_at as string,
      invoiceUrl:
        payment && payment.status !== "DELETED" ? payment.invoice_url : null,
    };
  });
}

// ────────────────────────────────────────────────────────────────────
// Fulfillments ativos (D-044 · 2.F)
// ────────────────────────────────────────────────────────────────────
// "Ativo" aqui = já pago e em processo operacional — o paciente
// precisa saber onde está a caixa dele:
//   - `paid`               → Instituto vai acionar farmácia
//   - `pharmacy_requested` → prescrição foi pra farmácia; aguardando manipulação
//   - `shipped`            → a caminho; aqui aparece o CTA "confirmar recebimento"
//
// `delivered` e `cancelled` NÃO voltam aqui — saem da visão de ação e
// viram histórico (TreatmentCard cobre o ciclo pós-entrega).
//
// Importante: lista é ordenada por `created_at desc` e cap 10 — na
// prática o paciente só tem 1 ou 2 em paralelo.

export type ActiveFulfillmentStatus = "paid" | "pharmacy_requested" | "shipped";

export type ActiveFulfillment = {
  fulfillmentId: string;
  appointmentId: string;
  status: ActiveFulfillmentStatus;
  planName: string;
  planMedication: string | null;
  doctorName: string;
  paidAt: string | null;
  pharmacyRequestedAt: string | null;
  shippedAt: string | null;
  trackingNote: string | null;
  shippingCity: string | null;
  shippingState: string | null;
};

export async function listActiveFulfillments(
  supabase: SupabaseClient,
  customerId: string,
): Promise<ActiveFulfillment[]> {
  const { data, error } = await supabase
    .from("fulfillments")
    .select(
      `id, status, appointment_id, paid_at, pharmacy_requested_at, shipped_at,
       tracking_note, shipping_city, shipping_state,
       plan:plans!inner(name, medication),
       doctor:doctors!inner(full_name, display_name)`
    )
    .eq("customer_id", customerId)
    .in("status", ["paid", "pharmacy_requested", "shipped"])
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) {
    throw new Error(`listActiveFulfillments: ${error.message}`);
  }
  if (!data) return [];

  return (data as unknown[]).map((raw) => {
    const r = raw as Record<string, unknown>;
    const plan = pickSingle(
      r.plan as
        | { name: string; medication: string | null }
        | Array<{ name: string; medication: string | null }>
        | null
    );
    const doctor = pickSingle(
      r.doctor as
        | { full_name: string; display_name: string | null }
        | Array<{ full_name: string; display_name: string | null }>
        | null
    );

    return {
      fulfillmentId: r.id as string,
      appointmentId: r.appointment_id as string,
      status: r.status as ActiveFulfillmentStatus,
      planName: plan?.name ?? "Plano",
      planMedication: plan?.medication ?? null,
      doctorName: doctor?.display_name ?? doctor?.full_name ?? "Médica",
      paidAt: (r.paid_at as string | null) ?? null,
      pharmacyRequestedAt: (r.pharmacy_requested_at as string | null) ?? null,
      shippedAt: (r.shipped_at as string | null) ?? null,
      trackingNote: (r.tracking_note as string | null) ?? null,
      shippingCity: (r.shipping_city as string | null) ?? null,
      shippingState: (r.shipping_state as string | null) ?? null,
    };
  });
}

export async function getPatientProfile(
  supabase: SupabaseClient,
  customerId: string,
): Promise<PatientProfile | null> {
  const { data, error } = await supabase
    .from("customers")
    .select("id, name, email, phone")
    .eq("id", customerId)
    .maybeSingle();

  if (error) {
    throw new Error(`getPatientProfile: ${error.message}`);
  }
  if (!data) return null;

  return data as PatientProfile;
}

// ────────────────────────────────────────────────────────────────────
// Helpers puros (para UI)
// ────────────────────────────────────────────────────────────────────

export function labelForAppointmentStatus(status: string): string {
  const map: Record<string, string> = {
    pending_payment: "Aguardando pagamento",
    scheduled: "Agendada",
    confirmed: "Confirmada",
    in_progress: "Em andamento",
    completed: "Concluída",
    no_show_patient: "Você faltou",
    no_show_doctor: "A médica faltou",
    cancelled_by_patient: "Cancelada por você",
    cancelled_by_doctor: "Cancelada pela médica",
    cancelled_by_admin: "Cancelada",
  };
  return map[status] ?? status;
}

export function labelForRenewalStatus(status: RenewalStatus): string {
  switch (status) {
    case "none":
      return "Sem tratamento ativo";
    case "active":
      return "Tratamento em dia";
    case "expiring_soon":
      return "Prestes a expirar";
    case "expired":
      return "Expirado";
  }
}
