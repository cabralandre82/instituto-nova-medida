import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  createCustomer,
  createPayment,
  getAsaasEnv,
  type AsaasBillingType,
} from "@/lib/asaas";
import { sanitizeShortText, TEXT_PATTERNS } from "@/lib/text-sanitize";
import {
  recordCheckoutConsent,
  extractClientIp,
} from "@/lib/checkout-consent";
import {
  CHECKOUT_CONSENT_TEXT_VERSION,
  isKnownCheckoutConsentVersion,
} from "@/lib/checkout-consent-terms";
import {
  decideCustomerUpsert,
  logCustomerUpsertDecision,
} from "@/lib/customer-pii-guard";
import { getOptionalPatient } from "@/lib/auth";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/checkout" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/checkout
 *
 * Recebe os dados do paciente + plano escolhido, cria (ou reaproveita)
 * o customer no Asaas, cria a cobrança e retorna a URL da invoice
 * hospedada pra o cliente pagar.
 *
 * Idempotência:
 *   - customer: chave é o CPF. Se já existir uma linha em `customers`
 *     com esse CPF, reaproveitamos `asaas_customer_id`.
 *   - payment: novo a cada chamada (paciente pode desistir e tentar
 *     de novo com forma de pagamento diferente).
 */

type PaymentMethod = "pix" | "boleto" | "cartao";

type CheckoutBody = {
  planSlug: string;
  paymentMethod: PaymentMethod;
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
  /**
   * Versão do texto legal exibido na checkbox. O SERVER não aceita
   * texto vindo do cliente — só a versão. O texto canonical fica em
   * `src/lib/checkout-consent-terms.ts` (D-064). Se ausente, usa o
   * `CHECKOUT_CONSENT_TEXT_VERSION` vigente.
   */
  consentTextVersion?: string;
  leadId?: string | null;
};

type ParsedCheckout = Omit<CheckoutBody, "consentTextVersion"> & {
  consentTextVersion: string;
};

function parseAndValidate(raw: unknown): ParsedCheckout | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Body inválido" };
  const b = raw as Partial<CheckoutBody>;

  if (typeof b.planSlug !== "string" || !/^[a-z0-9-]+$/.test(b.planSlug))
    return { error: "Plano inválido" };

  if (
    b.paymentMethod !== "pix" &&
    b.paymentMethod !== "boleto" &&
    b.paymentMethod !== "cartao"
  )
    return { error: "Forma de pagamento inválida" };

  // PR-037 · D-056: `customers.name` é propagado pra templates WhatsApp,
  // eventual LLM de atendimento, logs e comprovantes. Sanitização mais
  // apertada que o resto do body: rejeita dígitos, controles, zero-width
  // e qualquer char fora do `personName` pattern (letras Unicode + `.
  // , ' ( ) -`).
  const nameSanitization =
    typeof b.name === "string"
      ? sanitizeShortText(b.name, {
          maxLen: 120,
          minLen: 3,
          pattern: TEXT_PATTERNS.personName,
        })
      : ({ ok: false as const, reason: "empty" as const });
  if (!nameSanitization.ok) {
    if (nameSanitization.reason === "charset") {
      return {
        error:
          "Nome contém caracteres não permitidos. Use apenas letras, espaços e pontuação básica.",
      };
    }
    if (nameSanitization.reason === "too_long") {
      return { error: "Nome muito longo" };
    }
    return { error: "Informe o nome completo" };
  }
  const sanitizedName = nameSanitization.value;

  const cpfDigits =
    typeof b.cpf === "string" ? b.cpf.replace(/\D/g, "") : "";
  if (cpfDigits.length !== 11) return { error: "CPF inválido" };

  if (typeof b.email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email))
    return { error: "Email inválido" };

  const phoneDigits =
    typeof b.phone === "string" ? b.phone.replace(/\D/g, "") : "";
  if (phoneDigits.length < 10) return { error: "Telefone inválido" };

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
    return { error: "Endereço incompleto" };

  if (b.consent !== true) return { error: "Aceite dos termos é obrigatório" };

  // PR-053 · D-064 · finding 5.6: versão do texto legal. Cliente pode
  // omitir → server usa a vigente. Se enviar uma desconhecida, rejeita
  // (defesa contra `?consentTextVersion=ignora-lgpd`).
  const consentTextVersion =
    typeof b.consentTextVersion === "string" && b.consentTextVersion.length > 0
      ? b.consentTextVersion
      : CHECKOUT_CONSENT_TEXT_VERSION;
  if (!isKnownCheckoutConsentVersion(consentTextVersion)) {
    return { error: "Versão do termo de aceite desconhecida" };
  }

  return {
    planSlug: b.planSlug,
    paymentMethod: b.paymentMethod,
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
    consentTextVersion,
    leadId: b.leadId ?? null,
  };
}

const METHOD_TO_BILLING_TYPE: Record<PaymentMethod, AsaasBillingType> = {
  pix: "PIX",
  boleto: "BOLETO",
  cartao: "CREDIT_CARD",
};

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "JSON inválido" },
      { status: 400 }
    );
  }

  const parsed = parseAndValidate(raw);
  if ("error" in parsed) {
    return NextResponse.json(
      { ok: false, error: parsed.error },
      { status: 400 }
    );
  }
  const input = parsed;

  const supabase = getSupabaseAdmin();

  // 1) Buscar o plano (ativo) ────────────────────────────────────────────
  const { data: plan, error: planErr } = await supabase
    .from("plans")
    .select("id, slug, name, price_cents, price_pix_cents, cycle_days, active")
    .eq("slug", input.planSlug)
    .eq("active", true)
    .maybeSingle();

  if (planErr) {
    log.error("plano lookup error", { err: planErr });
    return NextResponse.json(
      { ok: false, error: "Erro ao consultar plano" },
      { status: 500 }
    );
  }
  if (!plan) {
    return NextResponse.json(
      { ok: false, error: "Plano não encontrado" },
      { status: 404 }
    );
  }

  // PIX/boleto = preço à vista; cartão = preço cheio (3x sem juros)
  const amountCents =
    input.paymentMethod === "cartao" ? plan.price_cents : plan.price_pix_cents;

  // 2) Customer: existe pelo CPF? ────────────────────────────────────────
  const asaasEnv = getAsaasEnv();

  const { data: existingCustomer, error: custLookupErr } = await supabase
    .from("customers")
    .select(
      "id, asaas_customer_id, asaas_env, user_id, name, email, phone, address_zipcode, address_street, address_number, address_complement, address_district, address_city, address_state"
    )
    .eq("cpf", input.cpf)
    .maybeSingle();

  if (custLookupErr) {
    log.error("customer lookup error", { err: custLookupErr });
    return NextResponse.json(
      { ok: false, error: "Erro ao consultar cliente" },
      { status: 500 }
    );
  }

  let localCustomerId: string;
  let asaasCustomerId: string | null = existingCustomer?.asaas_customer_id ?? null;

  // PR-054 · D-065 · finding 5.8: guard de takeover. Sessão patient é
  // OPCIONAL — se houver e bater com `customers.user_id`, permite
  // atualização de PII; senão, dados gravados ficam intocados.
  const optionalPatient = await getOptionalPatient();
  const sessionUserId = optionalPatient?.user.id ?? null;

  if (existingCustomer) {
    localCustomerId = existingCustomer.id;
    // Se o ambiente mudou (sandbox → production), o id antigo não vale.
    if (existingCustomer.asaas_env !== asaasEnv) {
      asaasCustomerId = null;
    }

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

    // Log da decisão (best-effort). update_full sem diff é silencioso.
    await logCustomerUpsertDecision(supabase, {
      decision,
      customerId: localCustomerId,
      sessionUserId,
      routeName: "/api/checkout",
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
      // update_blocked: só atualiza `lead_id` (não é PII e não há
      // ataque útil em sobrescrever a origem do lead). Os demais
      // campos ficam exatamente como estavam — atacante não consegue
      // tomber email/phone/address. A cobrança Asaas será criada com
      // `asaas_customer_id` existente, então comunicações continuam
      // indo pra vítima legítima (não pro atacante).
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
      log.error("customer insert error", { err: insertErr });
      return NextResponse.json(
        { ok: false, error: "Erro ao registrar cliente" },
        { status: 500 }
      );
    }
    localCustomerId = newCust.id;
  }

  // 3) Garantir que existe customer no Asaas ───────────────────────────────
  // PR-054 · D-065: usa SEMPRE os dados gravados em `customers` (que
  // refletem a decisão do guard) — nunca o input bruto. Em caso de
  // update_blocked, isso garante que o customer Asaas é criado com a
  // PII real da vítima, não com dados spoofed pelo atacante.
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
        { ok: false, error: "Erro ao consultar cliente" },
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
      log.error("asaas createCustomer falhou", { err: created });
      return NextResponse.json(
        {
          ok: false,
          error: "Não foi possível registrar no provedor de pagamento",
          details: created.message,
        },
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

  // 4) Criar a cobrança no Asaas ─────────────────────────────────────────
  // Inserimos a row local PRIMEIRO (status PENDING) pra ter um id estável
  // pra usar como externalReference. Se o Asaas falhar, atualizamos pra
  // DELETED na próxima retry — mas o ideal é o front retentar com o mesmo
  // payload (que vai gerar uma nova row, ok).
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
    log.error("payment insert error", { err: payInsertErr });
    return NextResponse.json(
      { ok: false, error: "Erro ao registrar cobrança" },
      { status: 500 }
    );
  }

  // PR-053 · D-064 · finding 5.6: grava prova legal do aceite ANTES
  // da chamada Asaas. Se o insert falhar, abortamos a cobrança — é
  // preferível frustrar um checkout legítimo a cobrar sem base legal
  // LGPD (Art. 8º §1º exige prova do consentimento). O payment local
  // fica PENDING; cron de cleanup ou retry do usuário resolve.
  const ipAddress = extractClientIp(req);
  const userAgent = req.headers.get("user-agent");
  const consentResult = await recordCheckoutConsent(supabase, {
    customerId: localCustomerId,
    paymentId: localPayment.id,
    textVersion: input.consentTextVersion,
    ipAddress,
    userAgent,
    paymentMethod: input.paymentMethod,
  });

  if (!consentResult.ok) {
    log.error("consent insert falhou — abortando checkout", {
      code: consentResult.code,
      message: consentResult.message,
      payment_id: localPayment.id,
    });
    // Marca o payment como DELETED pra não ficar órfão no banco.
    await supabase
      .from("payments")
      .update({ status: "DELETED" })
      .eq("id", localPayment.id);
    return NextResponse.json(
      {
        ok: false,
        error:
          "Não foi possível registrar o aceite dos termos. Tente novamente.",
      },
      { status: 500 }
    );
  }

  const description = `${plan.name} — ciclo ${plan.cycle_days} dias · Instituto Nova Medida`;

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
    log.error("asaas createPayment falhou", { err: created });
    await supabase
      .from("payments")
      .update({
        status: "DELETED",
        asaas_raw: { error: created.message, code: created.code } as unknown as Record<
          string,
          unknown
        >,
      })
      .eq("id", localPayment.id);

    return NextResponse.json(
      {
        ok: false,
        error: "Não foi possível gerar a cobrança",
        details: created.message,
      },
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

  log.info("sucesso", {
    paymentId: localPayment.id,
    asaasPaymentId: created.data.id,
    status: created.data.status,
    invoiceUrl: created.data.invoiceUrl,
  });

  return NextResponse.json({
    ok: true,
    paymentId: localPayment.id,
    asaasPaymentId: created.data.id,
    invoiceUrl: created.data.invoiceUrl,
    bankSlipUrl: created.data.bankSlipUrl,
    status: created.data.status,
    method: input.paymentMethod,
  });
}
