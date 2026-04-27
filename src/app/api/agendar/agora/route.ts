/**
 * POST /api/agendar/agora — PR-080 · D-092
 *
 * Cria uma solicitação on-demand do paciente: "quero atendimento agora".
 *
 * Pipeline (igual em espírito a /api/agendar/free, com ajustes pra fila
 * efêmera ao invés de slot programado):
 *
 *   1. Lê `inm_lead_id` do cookie httpOnly. Sem cookie → 401.
 *   2. Valida lead existe e está dentro da janela LEAD_MAX_AGE_DAYS.
 *   3. Valida payload: name, cpf, email, phone, chiefComplaint, consent.
 *   4. Upsert customer com guard de takeover (PR-054).
 *   5. RPC `create_on_demand_request` (idempotente — se cliente já tem
 *      pending, devolve o id existente sem erro).
 *   6. Fan-out síncrono pra médicas online via WhatsApp + dispatches.
 *      Se nenhuma médica está online, retorna 200 com warning
 *      `no_doctors_online` — UI mostra opção de "agendar pra mais
 *      tarde" linkando pra /agendar.
 *   7. Marca lead com `status='solicitou_agora'` (best-effort).
 *   8. Retorna { requestId, expiresAt, ttlSeconds, dispatched, noDoctorsOnline }.
 *
 * UI faz polling em GET /api/agendar/agora/status?id=... a cada 3s
 * pra detectar accepted/expired/cancelled.
 *
 * Sem cobrança nesta etapa (D-044). Mesma garantia do /agendar/free.
 */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSupabaseAdmin } from "@/lib/supabase";
import { sanitizeShortText, TEXT_PATTERNS } from "@/lib/text-sanitize";
import {
  decideCustomerUpsert,
  logCustomerUpsertDecision,
} from "@/lib/customer-pii-guard";
import { extractClientIp } from "@/lib/checkout-consent";
import { getOptionalPatient } from "@/lib/auth";
import { LEAD_COOKIE_NAME } from "@/lib/lead-cookie";
import {
  createOnDemandRequest,
  fanOutToOnlineDoctors,
} from "@/lib/on-demand";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/agendar/agora" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LEAD_MAX_AGE_DAYS = 14;

type Body = {
  name: string;
  cpf: string;
  email: string;
  phone: string;
  chiefComplaint: string;
  consent: boolean;
  recordingConsent?: boolean;
};

function parse(raw: unknown): Body | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "body_invalid" };
  const b = raw as Partial<Body>;

  const nameSan =
    typeof b.name === "string"
      ? sanitizeShortText(b.name, {
          maxLen: 120,
          minLen: 3,
          pattern: TEXT_PATTERNS.personName,
        })
      : ({ ok: false as const, reason: "empty" as const });
  if (!nameSan.ok) return { error: "name_invalid" };

  const cpfDigits = typeof b.cpf === "string" ? b.cpf.replace(/\D/g, "") : "";
  if (cpfDigits.length !== 11) return { error: "cpf_invalid" };

  if (typeof b.email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email))
    return { error: "email_invalid" };

  const phoneDigits = typeof b.phone === "string" ? b.phone.replace(/\D/g, "") : "";
  if (phoneDigits.length < 10 || phoneDigits.length > 15)
    return { error: "phone_invalid" };

  if (b.consent !== true) return { error: "consent_required" };

  if (typeof b.chiefComplaint !== "string") return { error: "chief_complaint_invalid" };

  return {
    name: nameSan.value,
    cpf: cpfDigits,
    email: b.email.trim().toLowerCase(),
    phone: phoneDigits,
    chiefComplaint: b.chiefComplaint,
    consent: true,
    recordingConsent: Boolean(b.recordingConsent),
  };
}

export async function POST(req: Request) {
  // 0) Lead cookie
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

  // 1) Lead válido + recente
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

  // 2) Customer (upsert por CPF, com guard de takeover PR-054)
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
      routeName: "/api/agendar/agora",
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

  // 3) Cria request (idempotente — clique-duplo devolve mesmo id)
  const created = await createOnDemandRequest({
    customerId: localCustomerId,
    chiefComplaint: input.chiefComplaint,
  });
  if (!created.ok) {
    log.warn("create_on_demand_request rejected", {
      customer_id: localCustomerId,
      error: created.error,
    });
    return NextResponse.json(
      { ok: false, error: created.error },
      { status: 400 }
    );
  }
  const requestId = created.requestId;

  // 4) Fan-out síncrono. Sem médicas online → fan-out devolve 0
  //    candidatos. Não falha — UI mostra fallback "agendar pra
  //    mais tarde".
  const baseUrl = (process.env.NEXT_PUBLIC_BASE_URL || "").replace(/\/$/, "");
  let fanOutDispatched = 0;
  let fanOutEligible = 0;
  try {
    const report = await fanOutToOnlineDoctors({
      requestId,
      baseUrl,
    });
    fanOutDispatched = report.dispatched;
    fanOutEligible = report.candidatesEligible;
  } catch (e) {
    log.error("fan_out_failed", { err: e, request_id: requestId });
    // Não derruba o request — o paciente ainda pode esperar até
    // alguma médica entrar no /medico/plantao e pegar manualmente.
  }

  // 5) Lead segue best-effort
  {
    const { error: leadUpdateErr } = await supabase
      .from("leads")
      .update({ status: "solicitou_agora" })
      .eq("id", leadId);
    if (leadUpdateErr) {
      log.warn("lead update", { err: leadUpdateErr, leadId });
    }
  }

  // 6) Computa expires_at devolvido pra UI fazer countdown.
  const { data: row } = await supabase
    .from("on_demand_requests")
    .select("expires_at, status, created_at")
    .eq("id", requestId)
    .maybeSingle();

  log.info("created", {
    request_id: requestId,
    customer_id: localCustomerId,
    is_new: created.isNew,
    fan_out_eligible: fanOutEligible,
    fan_out_dispatched: fanOutDispatched,
  });

  return NextResponse.json({
    ok: true,
    requestId,
    expiresAt: row?.expires_at ?? null,
    isNew: created.isNew,
    candidatesEligible: fanOutEligible,
    dispatched: fanOutDispatched,
    noDoctorsOnline: fanOutEligible === 0,
  });
}
