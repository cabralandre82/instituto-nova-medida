/**
 * POST /api/agendar/reserve
 *
 * Recebe dados do paciente + plano + slot escolhido. Sequência:
 *
 *   1. Valida payload, plano, slot, dados pessoais.
 *   2. Upsert do customer (chave: CPF).
 *   3. Garante customer no Asaas (cria se não existir).
 *   4. Insere `payments` em PENDING (id estável → externalReference).
 *   5. RESERVA o slot via book_pending_appointment_slot (atomic).
 *   6. Vincula payment_id no appointment.
 *   7. Cria a cobrança no Asaas.
 *   8. Devolve { invoiceUrl, appointmentId, patientToken, consultaUrl }.
 *
 * Se algo entre 5 e 7 falhar, a cobrança Asaas pode ficar órfã ou o
 * appointment fica como pending_payment com payment_id nulo — o cron de
 * expiração + admin reconciliam.
 *
 * Não cobra rate-limit aqui ainda — colocar via middleware quando entrar
 * em produção real (TODO: WAF / Vercel Edge Functions).
 */

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  createCustomer,
  createPayment,
  getAsaasEnv,
  type AsaasBillingType,
} from "@/lib/asaas";
import {
  bookPendingSlot,
  getPrimaryDoctor,
  isSlotAvailable,
} from "@/lib/scheduling";
import { signPatientToken, buildConsultationUrl } from "@/lib/patient-tokens";
import { formatDateTimeBR } from "@/lib/datetime-br";
import { sanitizeShortText, TEXT_PATTERNS } from "@/lib/text-sanitize";
import {
  decideCustomerUpsert,
  logCustomerUpsertDecision,
} from "@/lib/customer-pii-guard";
import { extractClientIp } from "@/lib/checkout-consent";
import { getOptionalPatient } from "@/lib/auth";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/agendar/reserve" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PaymentMethod = "pix" | "boleto" | "cartao";

type Body = {
  planSlug: string;
  paymentMethod: PaymentMethod;
  /** ISO UTC do slot escolhido (deve ser EXATAMENTE um dos slots ofertados). */
  scheduledAt: string;
  /** Optional: id da médica. Se ausente, usa a primary do MVP. */
  doctorId?: string;
  recordingConsent?: boolean;
  name: string;
  cpf: string;
  email: string;
  phone: string;
  address: {
    zipcode: string;
    street: string;
    number: string;
    complement?: string;
    district: string;
    city: string;
    state: string;
  };
  consent: boolean;
  leadId?: string | null;
};

const METHOD_TO_BILLING_TYPE: Record<PaymentMethod, AsaasBillingType> = {
  pix: "PIX",
  boleto: "BOLETO",
  cartao: "CREDIT_CARD",
};

function parse(raw: unknown): Body | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "body_invalid" };
  const b = raw as Partial<Body>;

  if (typeof b.planSlug !== "string" || !/^[a-z0-9-]+$/.test(b.planSlug))
    return { error: "plan_invalid" };

  if (b.paymentMethod !== "pix" && b.paymentMethod !== "boleto" && b.paymentMethod !== "cartao")
    return { error: "method_invalid" };

  if (typeof b.scheduledAt !== "string" || Number.isNaN(Date.parse(b.scheduledAt)))
    return { error: "slot_invalid" };

  // PR-037 · D-056: sanitização apertada — nome entra em WhatsApp,
  // logs e eventual prompt de LLM. Ver comentário idêntico em
  // `/api/checkout/route.ts`.
  const nameSanitization =
    typeof b.name === "string"
      ? sanitizeShortText(b.name, {
          maxLen: 120,
          minLen: 3,
          pattern: TEXT_PATTERNS.personName,
        })
      : ({ ok: false as const, reason: "empty" as const });
  if (!nameSanitization.ok) {
    return { error: "name_invalid" };
  }
  const sanitizedName = nameSanitization.value;

  const cpfDigits = typeof b.cpf === "string" ? b.cpf.replace(/\D/g, "") : "";
  if (cpfDigits.length !== 11) return { error: "cpf_invalid" };

  if (typeof b.email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email))
    return { error: "email_invalid" };

  const phoneDigits = typeof b.phone === "string" ? b.phone.replace(/\D/g, "") : "";
  if (phoneDigits.length < 10) return { error: "phone_invalid" };

  const a = b.address;
  if (
    !a ||
    typeof a !== "object" ||
    typeof a.zipcode !== "string" ||
    a.zipcode.replace(/\D/g, "").length !== 8 ||
    typeof a.street !== "string" ||
    a.street.trim().length < 3 ||
    typeof a.number !== "string" ||
    a.number.trim().length < 1 ||
    typeof a.district !== "string" ||
    a.district.trim().length < 2 ||
    typeof a.city !== "string" ||
    a.city.trim().length < 2 ||
    typeof a.state !== "string" ||
    a.state.trim().length !== 2
  )
    return { error: "address_invalid" };

  if (b.consent !== true) return { error: "consent_required" };

  return {
    planSlug: b.planSlug,
    paymentMethod: b.paymentMethod,
    scheduledAt: new Date(b.scheduledAt).toISOString(),
    doctorId: typeof b.doctorId === "string" ? b.doctorId : undefined,
    recordingConsent: Boolean(b.recordingConsent),
    name: sanitizedName,
    cpf: cpfDigits,
    email: b.email.trim().toLowerCase(),
    phone: phoneDigits,
    address: {
      zipcode: a.zipcode.replace(/\D/g, ""),
      street: a.street.trim(),
      number: a.number.trim(),
      complement: a.complement?.trim() || undefined,
      district: a.district.trim(),
      city: a.city.trim(),
      state: a.state.trim().toUpperCase(),
    },
    consent: true,
    leadId: b.leadId ?? null,
  };
}

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "json_invalid" }, { status: 400 });
  }
  const parsed = parse(raw);
  if ("error" in parsed) {
    return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  }
  const input = parsed;

  const supabase = getSupabaseAdmin();

  // 1) Doctor (single MVP) ─────────────────────────────────────────────
  let doctorId = input.doctorId;
  let consultationMinutes = 30;
  if (!doctorId) {
    const primary = await getPrimaryDoctor();
    if (!primary) {
      return NextResponse.json(
        { ok: false, error: "no_doctor_active" },
        { status: 503 }
      );
    }
    doctorId = primary.id;
    consultationMinutes = primary.consultation_minutes;
  } else {
    const { data: doc } = await supabase
      .from("doctors")
      .select("id, consultation_minutes, status, reliability_paused_at")
      .eq("id", doctorId)
      .maybeSingle();
    if (!doc || doc.status !== "active") {
      return NextResponse.json({ ok: false, error: "doctor_not_active" }, { status: 400 });
    }
    // D-036: médica auto-pausada por regra de confiabilidade não recebe
    // novas reservas. Appointments existentes seguem; isso só barra novas.
    if ((doc as { reliability_paused_at: string | null }).reliability_paused_at) {
      return NextResponse.json(
        { ok: false, error: "doctor_reliability_paused" },
        { status: 409 }
      );
    }
    consultationMinutes = doc.consultation_minutes;
  }

  // 2) Anti-tampering: o slot enviado tem que estar entre os ofertados
  const slotCheck = await isSlotAvailable(doctorId, consultationMinutes, input.scheduledAt);
  if (!slotCheck.ok) {
    return NextResponse.json(
      { ok: false, error: "slot_unavailable", reason: slotCheck.reason },
      { status: 409 }
    );
  }

  // 3) Plano ───────────────────────────────────────────────────────────
  const { data: plan, error: planErr } = await supabase
    .from("plans")
    .select("id, slug, name, price_cents, price_pix_cents, cycle_days, active")
    .eq("slug", input.planSlug)
    .eq("active", true)
    .maybeSingle();
  if (planErr) {
    log.error("plan lookup", { err: planErr });
    return NextResponse.json({ ok: false, error: "plan_lookup_failed" }, { status: 500 });
  }
  if (!plan) {
    return NextResponse.json({ ok: false, error: "plan_not_found" }, { status: 404 });
  }
  const amountCents =
    input.paymentMethod === "cartao" ? plan.price_cents : plan.price_pix_cents;

  // 4) Customer (upsert por CPF) ───────────────────────────────────────
  const asaasEnv = getAsaasEnv();
  const { data: existingCustomer, error: custLookupErr } = await supabase
    .from("customers")
    .select(
      "id, asaas_customer_id, asaas_env, user_id, name, email, phone, address_zipcode, address_street, address_number, address_complement, address_district, address_city, address_state"
    )
    .eq("cpf", input.cpf)
    .maybeSingle();
  if (custLookupErr) {
    log.error("customer lookup", { err: custLookupErr });
    return NextResponse.json({ ok: false, error: "customer_lookup_failed" }, { status: 500 });
  }

  let localCustomerId: string;
  let asaasCustomerId: string | null = existingCustomer?.asaas_customer_id ?? null;

  // PR-054 · D-065 · finding 5.8: guard de takeover (mesma lógica do
  // /api/checkout). Sessão patient é OPCIONAL — se houver e bater
  // com `customers.user_id`, permite atualização de PII; senão,
  // dados gravados ficam intocados e a reserva continua usando-os.
  const optionalPatient = await getOptionalPatient();
  const sessionUserId = optionalPatient?.user.id ?? null;

  if (existingCustomer) {
    localCustomerId = existingCustomer.id;
    if (existingCustomer.asaas_env !== asaasEnv) asaasCustomerId = null;

    const decision = decideCustomerUpsert({
      existing: existingCustomer,
      incoming: {
        name: input.name,
        email: input.email,
        phone: input.phone,
        address: input.address,
      },
      sessionUserId,
    });

    await logCustomerUpsertDecision(supabase, {
      decision,
      customerId: localCustomerId,
      sessionUserId,
      routeName: "/api/agendar/reserve",
      ipAddress: extractClientIp(req),
      userAgent: req.headers.get("user-agent"),
    });

    if (decision.action === "update_full") {
      await supabase
        .from("customers")
        .update({
          lead_id: input.leadId ?? null,
          name: input.name,
          email: input.email,
          phone: input.phone,
          address_zipcode: input.address.zipcode,
          address_street: input.address.street,
          address_number: input.address.number,
          address_complement: input.address.complement ?? null,
          address_district: input.address.district,
          address_city: input.address.city,
          address_state: input.address.state,
        })
        .eq("id", localCustomerId);
    } else {
      log.warn("customer upsert bloqueado (takeover guard)", {
        customer_id: localCustomerId,
        decision_reason: decision.reason,
        changed_fields: decision.changedFields,
      });
      if (input.leadId) {
        await supabase
          .from("customers")
          .update({ lead_id: input.leadId })
          .eq("id", localCustomerId);
      }
    }
  } else {
    const { data: newCust, error: insertErr } = await supabase
      .from("customers")
      .insert({
        lead_id: input.leadId ?? null,
        name: input.name,
        cpf: input.cpf,
        email: input.email,
        phone: input.phone,
        address_zipcode: input.address.zipcode,
        address_street: input.address.street,
        address_number: input.address.number,
        address_complement: input.address.complement ?? null,
        address_district: input.address.district,
        address_city: input.address.city,
        address_state: input.address.state,
        asaas_env: asaasEnv,
      })
      .select("id")
      .single();
    if (insertErr || !newCust) {
      log.error("customer insert", { err: insertErr });
      return NextResponse.json({ ok: false, error: "customer_insert_failed" }, { status: 500 });
    }
    localCustomerId = newCust.id;
  }

  // PR-054 · D-065: usa SEMPRE os dados gravados em `customers` —
  // nunca o input bruto. Em update_blocked, isso garante que o
  // customer Asaas é criado com a PII real da vítima.
  if (!asaasCustomerId) {
    const { data: persistedCust, error: persistedErr } = await supabase
      .from("customers")
      .select(
        "name, cpf, email, phone, address_zipcode, address_street, address_number, address_complement, address_district, address_city, address_state"
      )
      .eq("id", localCustomerId)
      .single();
    if (persistedErr || !persistedCust) {
      log.error("re-fetch customer pra Asaas falhou", { err: persistedErr });
      return NextResponse.json(
        { ok: false, error: "customer_refetch_failed" },
        { status: 500 }
      );
    }
    const created = await createCustomer({
      name: persistedCust.name as string,
      cpf: persistedCust.cpf as string,
      email: persistedCust.email as string,
      phone: persistedCust.phone as string,
      address: {
        zipcode: (persistedCust.address_zipcode as string) ?? "",
        street: (persistedCust.address_street as string) ?? "",
        number: (persistedCust.address_number as string) ?? "",
        complement:
          (persistedCust.address_complement as string | null) ?? undefined,
        district: (persistedCust.address_district as string) ?? "",
        city: (persistedCust.address_city as string) ?? "",
        state: (persistedCust.address_state as string) ?? "",
      },
      externalReference: localCustomerId,
    });
    if (!created.ok) {
      log.error("asaas createCustomer", { err: created });
      return NextResponse.json(
        { ok: false, error: "asaas_customer_failed", details: created.message },
        { status: 502 }
      );
    }
    asaasCustomerId = created.data.id;
    await supabase
      .from("customers")
      .update({
        asaas_customer_id: asaasCustomerId,
        asaas_env: asaasEnv,
        asaas_raw: created.data as unknown as Record<string, unknown>,
      })
      .eq("id", localCustomerId);
  }

  // 5) Insere payment local (PENDING) ──────────────────────────────────
  const { data: localPayment, error: payInsertErr } = await supabase
    .from("payments")
    .insert({
      customer_id: localCustomerId,
      plan_id: plan.id,
      amount_cents: amountCents,
      billing_type: METHOD_TO_BILLING_TYPE[input.paymentMethod],
      status: "PENDING",
      due_date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10),
      asaas_env: asaasEnv,
    })
    .select("id")
    .single();
  if (payInsertErr || !localPayment) {
    log.error("payment insert", { err: payInsertErr });
    return NextResponse.json({ ok: false, error: "payment_insert_failed" }, { status: 500 });
  }

  // 6) RESERVA o slot (atomic via SQL function) ────────────────────────
  const reservation = await bookPendingSlot({
    doctorId,
    customerId: localCustomerId,
    scheduledAt: input.scheduledAt,
    durationMinutes: consultationMinutes,
    kind: "scheduled",
    ttlMinutes: 15,
    recordingConsent: input.recordingConsent ?? false,
  });

  if (!reservation.ok) {
    // Rollback do payment local pra não deixar lixo
    await supabase
      .from("payments")
      .update({ status: "DELETED", asaas_raw: { error: "slot_taken" } as unknown as Record<string, unknown> })
      .eq("id", localPayment.id);

    if (reservation.error === "slot_taken") {
      return NextResponse.json(
        { ok: false, error: "slot_taken", message: reservation.message },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { ok: false, error: reservation.error, message: reservation.message },
      { status: 500 }
    );
  }

  const appointmentId = reservation.appointmentId;

  // 7) Vincula payment_id no appointment
  await supabase
    .from("appointments")
    .update({ payment_id: localPayment.id })
    .eq("id", appointmentId);

  // 8) Cria cobrança Asaas
  const description = `${plan.name} — consulta em ${formatDateTimeBR(input.scheduledAt)} · Instituto Nova Medida`;
  const created = await createPayment({
    customerId: asaasCustomerId,
    amountCents,
    billingType: METHOD_TO_BILLING_TYPE[input.paymentMethod],
    description,
    externalReference: localPayment.id,
    dueInDays: 3,
    installmentCount: input.paymentMethod === "cartao" ? 3 : undefined,
  });

  if (!created.ok) {
    log.error("asaas createPayment", { err: created });
    await supabase
      .from("payments")
      .update({
        status: "DELETED",
        asaas_raw: { error: created.message, code: created.code } as unknown as Record<string, unknown>,
      })
      .eq("id", localPayment.id);
    // Não derruba o appointment pending_payment — TTL de 15min vai cuidar.
    return NextResponse.json(
      { ok: false, error: "asaas_payment_failed", details: created.message },
      { status: 502 }
    );
  }

  await supabase
    .from("payments")
    .update({
      asaas_payment_id: created.data.id,
      status: created.data.status,
      invoice_url: created.data.invoiceUrl ?? null,
      bank_slip_url: created.data.bankSlipUrl ?? null,
      due_date: created.data.dueDate,
      asaas_raw: created.data as unknown as Record<string, unknown>,
    })
    .eq("id", localPayment.id);

  // 9) Token + URL pública pra o paciente receber por WhatsApp/email
  const patientToken = signPatientToken(appointmentId, { ttlSeconds: 14 * 24 * 3600 });
  const consultaUrl = buildConsultationUrl(appointmentId, patientToken);

  log.info("sucesso", {
    appointmentId,
    paymentId: localPayment.id,
    asaasPaymentId: created.data.id,
    method: input.paymentMethod,
  });

  return NextResponse.json({
    ok: true,
    appointmentId,
    paymentId: localPayment.id,
    asaasPaymentId: created.data.id,
    invoiceUrl: created.data.invoiceUrl,
    bankSlipUrl: created.data.bankSlipUrl,
    status: created.data.status,
    method: input.paymentMethod,
    patientToken,
    consultaUrl,
  });
}
