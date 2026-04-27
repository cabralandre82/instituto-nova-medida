/**
 * POST /api/agendar/free  — PR-075-A · D-086
 *
 * Rota canônica de agendamento da CONSULTA INICIAL GRATUITA (D-044).
 *
 * Diferença da rota legada `/api/agendar/reserve`:
 *   - Sem cobrança Asaas. Nenhum payment é criado. A cobrança em D-044
 *     só acontece em `/api/paciente/fulfillments/.../accept`,
 *     **depois** da consulta, e só se houver prescrição aceita.
 *   - Sem coleta de endereço. Endereço é exigido apenas no aceite do
 *     fulfillment (logística da farmácia).
 *   - `book_free_appointment_slot()` cria appointment direto em
 *     `status='scheduled'`. Sem TTL de pending_payment.
 *   - Lead obrigatório: o paciente tem que ter passado pelo quiz
 *     (cookie httpOnly `inm_lead_id`). Sem isso → 401. Razão: o
 *     quiz é o único filtro de spam da plataforma agora que a
 *     consulta é gratuita (PR-079 adiciona rate-limit + cooldown).
 *
 * Pipeline:
 *   1. Lê `inm_lead_id` do cookie httpOnly (lead-cookie.ts).
 *   2. Valida lead existe e ainda está dentro da janela
 *      (LEAD_MAX_AGE_DAYS).
 *   3. Valida payload: name, cpf, email, phone, scheduledAt, consent.
 *   4. Resolve doctor (primary ativa) + valida slot ofertado
 *      (anti-tampering — slot tem que estar exatamente na lista
 *      retornada por `listAvailableSlots`).
 *   5. Upsert customer com guard de takeover (PR-054). Sem campos
 *      de endereço — passamos strings vazias pro guard, que
 *      compara contra null/empty existing → diff vazio para esses
 *      campos. Atualiza apenas name/email/phone quando permitido.
 *   6. `book_free_appointment_slot` (atomic, anti-double-book pelo
 *      índice `ux_app_doctor_slot_alive`).
 *   7. `enqueueImmediate('confirmacao')` + `scheduleRemindersForAppointment`
 *      (T-24h, T-1h, T-15min, T+10min). Mesmas notificações que o
 *      fluxo legado dispara.
 *   8. Marca lead com `appointment_id` (best-effort).
 *   9. Retorna { appointmentId, patientToken, consultaUrl }.
 *
 * O cookie `inm_lead_id` permanece após o agendamento — paciente pode,
 * em tese, chamar a rota de novo (caso o slot inicial expire ou ele
 * queira marcar segunda consulta no futuro). Estado vivo é validado
 * pelo índice unique parcial: 1 appointment "vivo" por slot.
 *
 * Rate-limit / spam:
 *   Esta versão não adiciona rate-limit. O gating é o cookie de lead
 *   (que exige passar pelo /api/lead, este já tem rate-limit por IP).
 *   Hardening adicional (cooldown por CPF, uniqueness por lead) entra
 *   em PR-079.
 */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  bookFreeSlot,
  getPrimaryDoctor,
  isSlotAvailable,
} from "@/lib/scheduling";
import { signPatientToken, buildConsultationUrl } from "@/lib/patient-tokens";
import { sanitizeShortText, TEXT_PATTERNS } from "@/lib/text-sanitize";
import {
  decideCustomerUpsert,
  logCustomerUpsertDecision,
} from "@/lib/customer-pii-guard";
import { extractClientIp } from "@/lib/checkout-consent";
import { getOptionalPatient } from "@/lib/auth";
import { LEAD_COOKIE_NAME } from "@/lib/lead-cookie";
import {
  enqueueImmediate,
  scheduleRemindersForAppointment,
} from "@/lib/notifications";
import { enqueueDoctorAppointmentReminder } from "@/lib/doctor-notifications";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/agendar/free" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Janela em dias que aceitamos um lead pra agendar consulta gratuita.
 * Maior que isso → exigimos refazer o quiz (lead pode estar viciado /
 * mudou de mãos). 14 dias cobre férias curtas, hospitalização breve,
 * indecisão saudável, sem virar buraco eterno.
 */
const LEAD_MAX_AGE_DAYS = 14;

type Body = {
  scheduledAt: string;
  doctorId?: string;
  recordingConsent?: boolean;
  name: string;
  cpf: string;
  email: string;
  phone: string;
  consent: boolean;
};

function parse(raw: unknown): Body | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "body_invalid" };
  const b = raw as Partial<Body>;

  if (typeof b.scheduledAt !== "string" || Number.isNaN(Date.parse(b.scheduledAt)))
    return { error: "slot_invalid" };

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
  if (phoneDigits.length < 10 || phoneDigits.length > 15)
    return { error: "phone_invalid" };

  if (b.consent !== true) return { error: "consent_required" };

  return {
    scheduledAt: new Date(b.scheduledAt).toISOString(),
    doctorId: typeof b.doctorId === "string" ? b.doctorId : undefined,
    recordingConsent: Boolean(b.recordingConsent),
    name: sanitizedName,
    cpf: cpfDigits,
    email: b.email.trim().toLowerCase(),
    phone: phoneDigits,
    consent: true,
  };
}

export async function POST(req: Request) {
  // 0) Lê o lead_id do cookie httpOnly
  const cookieStore = await cookies();
  const leadId = cookieStore.get(LEAD_COOKIE_NAME)?.value ?? null;
  if (!leadId) {
    return NextResponse.json(
      { ok: false, error: "lead_required" },
      { status: 401 }
    );
  }

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

  // 1) Valida lead — existe, é recente, e bate com o lead_id do cookie.
  const leadCutoff = new Date(
    Date.now() - LEAD_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const { data: lead, error: leadErr } = await supabase
    .from("leads")
    .select("id, name, phone, status, created_at")
    .eq("id", leadId)
    .gte("created_at", leadCutoff)
    .maybeSingle();
  if (leadErr) {
    log.error("lead lookup", { err: leadErr });
    return NextResponse.json(
      { ok: false, error: "lead_lookup_failed" },
      { status: 500 }
    );
  }
  if (!lead) {
    return NextResponse.json(
      { ok: false, error: "lead_invalid_or_expired" },
      { status: 401 }
    );
  }

  // 2) Doctor (single MVP) ────────────────────────────────────────────
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
      return NextResponse.json(
        { ok: false, error: "doctor_not_active" },
        { status: 400 }
      );
    }
    if ((doc as { reliability_paused_at: string | null }).reliability_paused_at) {
      return NextResponse.json(
        { ok: false, error: "doctor_reliability_paused" },
        { status: 409 }
      );
    }
    consultationMinutes = doc.consultation_minutes;
  }

  // 3) Anti-tampering: slot enviado tem que estar entre os ofertados
  const slotCheck = await isSlotAvailable(
    doctorId,
    consultationMinutes,
    input.scheduledAt
  );
  if (!slotCheck.ok) {
    return NextResponse.json(
      { ok: false, error: "slot_unavailable", reason: slotCheck.reason },
      { status: 409 }
    );
  }

  // 4) Customer (upsert por CPF, com guard de takeover PR-054)
  const { data: existingCustomer, error: custLookupErr } = await supabase
    .from("customers")
    .select(
      "id, asaas_customer_id, asaas_env, user_id, name, email, phone, address_zipcode, address_street, address_number, address_complement, address_district, address_city, address_state"
    )
    .eq("cpf", input.cpf)
    .maybeSingle();
  if (custLookupErr) {
    log.error("customer lookup", { err: custLookupErr });
    return NextResponse.json(
      { ok: false, error: "customer_lookup_failed" },
      { status: 500 }
    );
  }

  let localCustomerId: string;

  const optionalPatient = await getOptionalPatient();
  const sessionUserId = optionalPatient?.user.id ?? null;

  if (existingCustomer) {
    localCustomerId = existingCustomer.id;

    // Mesmo guard do /api/checkout e /api/agendar/reserve — passamos
    // address vazio porque o fluxo gratuito não coleta endereço; o
    // computeChangedFields trata "" === null como sem-mudança nesses
    // campos. Apenas name/email/phone podem mudar aqui.
    const decision = decideCustomerUpsert({
      existing: existingCustomer,
      incoming: {
        name: input.name,
        email: input.email,
        phone: input.phone,
        address: {
          zipcode: existingCustomer.address_zipcode ?? "",
          street: existingCustomer.address_street ?? "",
          number: existingCustomer.address_number ?? "",
          complement: existingCustomer.address_complement ?? "",
          district: existingCustomer.address_district ?? "",
          city: existingCustomer.address_city ?? "",
          state: existingCustomer.address_state ?? "",
        },
      },
      sessionUserId,
    });

    await logCustomerUpsertDecision(supabase, {
      decision,
      customerId: localCustomerId,
      sessionUserId,
      routeName: "/api/agendar/free",
      ipAddress: extractClientIp(req),
      userAgent: req.headers.get("user-agent"),
    });

    if (decision.action === "update_full") {
      await supabase
        .from("customers")
        .update({
          lead_id: leadId,
          name: input.name,
          email: input.email,
          phone: input.phone,
        })
        .eq("id", localCustomerId);
    } else {
      log.warn("customer upsert bloqueado (takeover guard)", {
        customer_id: localCustomerId,
        decision_reason: decision.reason,
        changed_fields: decision.changedFields,
      });
      // Mesmo bloqueado, vincular o lead atual é seguro (lead não é PII
      // sensível — é só um marcador de origem).
      await supabase
        .from("customers")
        .update({ lead_id: leadId })
        .eq("id", localCustomerId);
    }
  } else {
    const { data: newCust, error: insertErr } = await supabase
      .from("customers")
      .insert({
        lead_id: leadId,
        name: input.name,
        cpf: input.cpf,
        email: input.email,
        phone: input.phone,
        // Address fica null — paciente preenche só se aceitar fulfillment.
      })
      .select("id")
      .single();
    if (insertErr || !newCust) {
      log.error("customer insert", { err: insertErr });
      return NextResponse.json(
        { ok: false, error: "customer_insert_failed" },
        { status: 500 }
      );
    }
    localCustomerId = newCust.id;
  }

  // 5) Reserva o slot atomicamente (status=scheduled direto)
  const reservation = await bookFreeSlot({
    doctorId,
    customerId: localCustomerId,
    scheduledAt: input.scheduledAt,
    durationMinutes: consultationMinutes,
    kind: "scheduled",
    recordingConsent: input.recordingConsent ?? false,
  });

  if (!reservation.ok) {
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

  // 6) Vincula appointment_id no lead (D-086 + leads.appointment_id).
  // Best-effort: erro aqui não derruba o agendamento (já criado).
  {
    const { error: leadUpdateErr } = await supabase
      .from("leads")
      .update({
        appointment_id: appointmentId,
        status: "agendado",
      })
      .eq("id", leadId);
    if (leadUpdateErr) {
      log.warn("lead update", { err: leadUpdateErr, leadId });
    }
  }

  // 7) Confirma e agenda lembretes (T-24h, T-1h, T-15min, T+10min)
  //    + enfileira lembrete pra MÉDICA (T-15min) — PR-077 · D-089.
  try {
    await Promise.all([
      enqueueImmediate(appointmentId, "confirmacao"),
      scheduleRemindersForAppointment(appointmentId),
      enqueueDoctorAppointmentReminder(
        appointmentId,
        doctorId,
        new Date(input.scheduledAt)
      ),
    ]);
  } catch (e) {
    log.error("notifications setup", { err: e, appointmentId });
    // Não derruba a resposta — o appointment foi criado, paciente
    // ainda pode acessar via consultaUrl. Operador vê falha em
    // /admin/notifications.
  }

  // 8) Token + URL pública pra a sala da consulta
  const patientToken = signPatientToken(appointmentId, {
    ttlSeconds: 14 * 24 * 3600,
  });
  const consultaUrl = buildConsultationUrl(appointmentId, patientToken);

  log.info("sucesso", {
    appointmentId,
    customerId: localCustomerId,
    leadId,
    doctorId,
  });

  return NextResponse.json({
    ok: true,
    appointmentId,
    patientToken,
    consultaUrl,
  });
}
