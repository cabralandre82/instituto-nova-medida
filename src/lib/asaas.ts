/**
 * Cliente Asaas — Instituto Nova Medida.
 *
 * Server-only. Não importar em client components (a API key nunca pode
 * sair do backend).
 *
 * Conceitos:
 *
 * - Sandbox vs Produção: a única diferença é a URL base e a API key.
 *   Setamos `ASAAS_ENV=sandbox` em dev e em produção até o operador
 *   abrir o CNPJ próprio. Quando trocar pra `production`, o resto do
 *   código não muda. Decisão: `docs/DECISIONS.md` D-019.
 *
 * - Customer (cliente): pessoa que vai pagar. Criado uma vez por CPF.
 *   Reutilizado em cobranças futuras.
 *
 * - Payment (cobrança): valor a receber, vinculado a um customer. Pode
 *   ser PIX, boleto, cartão, ou UNDEFINED (paciente escolhe na invoice
 *   hospedada do Asaas).
 *
 * - Subscription (assinatura): cobrança recorrente. Não usamos na Sprint 3
 *   (planos são ciclos avulsos de 90 dias), mas o tipo está aqui pra
 *   facilitar a Sprint 5+.
 *
 * - Webhook: o Asaas POSTa eventos `PAYMENT_*` na nossa URL configurada.
 *   Tratado em `/api/asaas/webhook`. Cada evento tem um id único pra
 *   idempotência.
 *
 * Docs oficiais: https://docs.asaas.com/reference/comece-por-aqui
 */

const SANDBOX_BASE = "https://sandbox.asaas.com/api/v3";
const PRODUCTION_BASE = "https://api.asaas.com/v3";

export type AsaasEnv = "sandbox" | "production";

type AsaasConfig = {
  apiKey: string;
  baseUrl: string;
  env: AsaasEnv;
};

function loadConfig(): AsaasConfig {
  const env = (process.env.ASAAS_ENV ?? "sandbox") as AsaasEnv;
  if (env !== "sandbox" && env !== "production") {
    throw new Error(
      `[asaas] ASAAS_ENV inválido: "${env}". Use "sandbox" ou "production".`
    );
  }

  const apiKey = process.env.ASAAS_API_KEY;
  if (!apiKey) {
    throw new Error(
      "[asaas] ASAAS_API_KEY ausente. Defina no .env.local (dev) ou no Vercel (prod)."
    );
  }

  return {
    apiKey,
    env,
    baseUrl: env === "production" ? PRODUCTION_BASE : SANDBOX_BASE,
  };
}

/**
 * Retorna o ambiente atual configurado. Útil pra registrar em `payments.asaas_env`
 * sem ter que repetir a leitura da env var em quem chamar.
 */
export function getAsaasEnv(): AsaasEnv {
  return (process.env.ASAAS_ENV ?? "sandbox") as AsaasEnv;
}

// ────────────────────────────────────────────────────────────────────────────
// Tipos do Asaas (subset que usamos — a API tem mais campos)
// ────────────────────────────────────────────────────────────────────────────

export type AsaasBillingType =
  | "PIX"
  | "CREDIT_CARD"
  | "BOLETO"
  | "UNDEFINED"; // permite o paciente escolher na invoice hospedada

export type AsaasPaymentStatus =
  | "PENDING"
  | "RECEIVED"
  | "CONFIRMED"
  | "OVERDUE"
  | "REFUNDED"
  | "RECEIVED_IN_CASH"
  | "REFUND_REQUESTED"
  | "REFUND_IN_PROGRESS"
  | "CHARGEBACK_REQUESTED"
  | "CHARGEBACK_DISPUTE"
  | "AWAITING_CHARGEBACK_REVERSAL"
  | "DUNNING_REQUESTED"
  | "DUNNING_RECEIVED"
  | "AWAITING_RISK_ANALYSIS"
  | "DELETED";

export type AsaasCustomer = {
  id: string;
  name: string;
  cpfCnpj: string;
  email: string;
  mobilePhone?: string;
  postalCode?: string;
  address?: string;
  addressNumber?: string;
  complement?: string;
  province?: string;
  city?: string;
  state?: string;
  externalReference?: string;
};

export type AsaasPayment = {
  id: string;
  customer: string;
  value: number;
  netValue?: number;
  billingType: AsaasBillingType;
  status: AsaasPaymentStatus;
  dueDate: string;
  invoiceUrl?: string;
  bankSlipUrl?: string;
  externalReference?: string;
  description?: string;
  installmentCount?: number;
  installmentValue?: number;
};

export type AsaasPixQrCode = {
  encodedImage: string; // base64 PNG
  payload: string;       // copia-e-cola
  expirationDate: string;
};

type AsaasErrorResponse = {
  errors?: Array<{ code: string; description: string }>;
};

// ────────────────────────────────────────────────────────────────────────────
// Resultado padrão (mesma filosofia do whatsapp.ts: union ok/erro tipado)
// ────────────────────────────────────────────────────────────────────────────

export type AsaasResult<T> =
  | { ok: true; data: T; env: AsaasEnv }
  | { ok: false; status: number | null; code: string | null; message: string; raw?: unknown };

// ────────────────────────────────────────────────────────────────────────────
// Núcleo HTTP
// ────────────────────────────────────────────────────────────────────────────

async function request<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown
): Promise<AsaasResult<T>> {
  const cfg = loadConfig();
  const url = `${cfg.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        access_token: cfg.apiKey,
        "Content-Type": "application/json",
        "User-Agent": "InstitutoNovaMedida/1.0",
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch (err) {
    return {
      ok: false,
      status: null,
      code: "NETWORK_ERROR",
      message:
        err instanceof Error ? err.message : "Falha de rede ao chamar Asaas API",
    };
  }

  // Algumas respostas (DELETE) podem vir vazias
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      return {
        ok: false,
        status: res.status,
        code: "INVALID_JSON",
        message: `Resposta do Asaas não é JSON (HTTP ${res.status})`,
        raw: text,
      };
    }
  }

  if (!res.ok) {
    const errPayload = json as AsaasErrorResponse | null;
    const firstErr = errPayload?.errors?.[0];
    return {
      ok: false,
      status: res.status,
      code: firstErr?.code ?? `HTTP_${res.status}`,
      message: firstErr?.description ?? `HTTP ${res.status}`,
      raw: json,
    };
  }

  return { ok: true, data: json as T, env: cfg.env };
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers de formatação
// ────────────────────────────────────────────────────────────────────────────

/** Centavos → reais (o Asaas trabalha com float em reais, não centavos). */
export function centsToReais(cents: number): number {
  return Math.round(cents) / 100;
}

/** Remove tudo que não é dígito de CPF/telefone/CEP. */
export function digitsOnly(input: string): string {
  return input.replace(/\D/g, "");
}

/**
 * Data de hoje + N dias no formato esperado pelo Asaas (YYYY-MM-DD).
 * Calculada em UTC pra evitar surpresas de timezone na borda do dia.
 */
export function dueDateInDays(days: number): string {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

// ────────────────────────────────────────────────────────────────────────────
// Customers
// ────────────────────────────────────────────────────────────────────────────

export type CreateCustomerInput = {
  name: string;
  cpf: string;
  email: string;
  phone: string;
  address?: {
    zipcode?: string;
    street?: string;
    number?: string;
    complement?: string;
    district?: string;
    city?: string;
    state?: string;
  };
  externalReference?: string; // ex: nosso lead.id ou customers.id local
};

/**
 * Cria um cliente no Asaas. Idempotência fica por conta do chamador (a
 * gente checa antes se já temos `asaas_customer_id` salvo no Supabase).
 */
export async function createCustomer(
  input: CreateCustomerInput
): Promise<AsaasResult<AsaasCustomer>> {
  return request<AsaasCustomer>("POST", "/customers", {
    name: input.name,
    cpfCnpj: digitsOnly(input.cpf),
    email: input.email,
    mobilePhone: digitsOnly(input.phone),
    postalCode: input.address?.zipcode
      ? digitsOnly(input.address.zipcode)
      : undefined,
    address: input.address?.street,
    addressNumber: input.address?.number,
    complement: input.address?.complement,
    province: input.address?.district,
    city: input.address?.city,
    state: input.address?.state,
    externalReference: input.externalReference,
    notificationDisabled: false, // Asaas envia email/SMS de cobrança
  });
}

export async function getCustomer(
  asaasCustomerId: string
): Promise<AsaasResult<AsaasCustomer>> {
  return request<AsaasCustomer>("GET", `/customers/${asaasCustomerId}`);
}

// ────────────────────────────────────────────────────────────────────────────
// Payments
// ────────────────────────────────────────────────────────────────────────────

export type CreatePaymentInput = {
  customerId: string;          // asaas customer id
  amountCents: number;
  billingType: AsaasBillingType;
  description: string;         // aparece na fatura
  externalReference?: string;  // ex: nosso payments.id
  dueInDays?: number;          // default 3 (PIX/boleto). UNDEFINED também usa.
  installmentCount?: number;   // só pra CREDIT_CARD
};

/**
 * Cria uma cobrança. Para PIX/boleto/UNDEFINED, retorna `invoiceUrl`
 * que o paciente acessa para pagar. Para CREDIT_CARD com tokenização,
 * o fluxo é mais elaborado (não usado no MVP — usamos UNDEFINED e o
 * paciente escolhe o cartão na invoice hospedada do Asaas).
 */
export async function createPayment(
  input: CreatePaymentInput
): Promise<AsaasResult<AsaasPayment>> {
  const dueDate = dueDateInDays(input.dueInDays ?? 3);
  const value = centsToReais(input.amountCents);

  // Se billingType é CREDIT_CARD com parcelamento, o Asaas exige
  // installmentCount + installmentValue (em vez de value).
  const isInstallment =
    input.billingType === "CREDIT_CARD" &&
    typeof input.installmentCount === "number" &&
    input.installmentCount > 1;

  const body: Record<string, unknown> = {
    customer: input.customerId,
    billingType: input.billingType,
    description: input.description,
    dueDate,
    externalReference: input.externalReference,
  };

  if (isInstallment) {
    body.installmentCount = input.installmentCount;
    body.installmentValue = Number(
      (value / (input.installmentCount as number)).toFixed(2)
    );
    body.totalValue = value;
  } else {
    body.value = value;
  }

  return request<AsaasPayment>("POST", "/payments", body);
}

export async function getPayment(
  asaasPaymentId: string
): Promise<AsaasResult<AsaasPayment>> {
  return request<AsaasPayment>("GET", `/payments/${asaasPaymentId}`);
}

export async function getPaymentPixQrCode(
  asaasPaymentId: string
): Promise<AsaasResult<AsaasPixQrCode>> {
  return request<AsaasPixQrCode>(
    "GET",
    `/payments/${asaasPaymentId}/pixQrCode`
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Refunds (estorno total ou parcial)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Resposta do endpoint `POST /payments/{id}/refund`.
 *
 * O Asaas devolve o objeto Payment atualizado (status='REFUNDED' ou
 * 'REFUND_IN_PROGRESS'). Não existe um id separado pra "o refund" na V3
 * pública — a entidade Payment mantém o histórico de estornos e muda de
 * status. Por isso, quando a gente precisa de um `external_ref` único no
 * nosso lado, a estratégia é usar o próprio `asaasPaymentId` — que é
 * suficiente pra rastrear "quem foi estornado" no painel Asaas e no
 * webhook `PAYMENT_REFUNDED`.
 *
 * Docs: https://docs.asaas.com/reference/estornar-cobranca
 */
export type AsaasRefundResponse = AsaasPayment & {
  // campos que o V3 às vezes expõe além do Payment bruto
  dateRefunded?: string;
  refundDescription?: string;
};

export type RefundPaymentInput = {
  asaasPaymentId: string;
  /** Valor em centavos a estornar. Se omitido, refund total. */
  amountCents?: number;
  /** Descrição que fica no painel Asaas pro operador entender o contexto. */
  description?: string;
};

/**
 * Solicita estorno de uma cobrança ao Asaas.
 *
 * Comportamento da Asaas:
 *   - PIX: estorno automático e instantâneo (status vira REFUNDED).
 *   - Cartão: requer N dias de compensação pro adquirente; devolve
 *     REFUND_IN_PROGRESS e dispara PAYMENT_REFUNDED no webhook depois.
 *   - Boleto: não tem estorno automático — o Asaas devolve erro, a
 *     devolução tem que ser manual via TED.
 *
 * Idempotência: tentar estornar 2x a mesma cobrança devolve erro
 * `invalid_action` do Asaas (não é um problema de dados). A gente
 * protege a montante via `markRefundProcessed()` que só chama isto
 * quando `refund_processed_at IS NULL`.
 */
export async function refundPayment(
  input: RefundPaymentInput
): Promise<AsaasResult<AsaasRefundResponse>> {
  const body: Record<string, unknown> = {};
  if (typeof input.amountCents === "number" && input.amountCents > 0) {
    body.value = centsToReais(input.amountCents);
  }
  if (input.description) {
    body.description = input.description;
  }
  return request<AsaasRefundResponse>(
    "POST",
    `/payments/${input.asaasPaymentId}/refund`,
    Object.keys(body).length > 0 ? body : undefined
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Subscriptions (estrutura pronta pra Sprint 5)
// ────────────────────────────────────────────────────────────────────────────

export type AsaasSubscriptionCycle =
  | "WEEKLY"
  | "BIWEEKLY"
  | "MONTHLY"
  | "QUARTERLY"
  | "SEMIANNUALLY"
  | "YEARLY";

export type AsaasSubscription = {
  id: string;
  customer: string;
  value: number;
  cycle: AsaasSubscriptionCycle;
  billingType: AsaasBillingType;
  nextDueDate: string;
  status: "ACTIVE" | "INACTIVE" | "EXPIRED";
};

export type CreateSubscriptionInput = {
  customerId: string;
  amountCents: number;
  billingType: AsaasBillingType;
  cycle?: AsaasSubscriptionCycle; // default QUARTERLY (90 dias)
  description: string;
  nextDueInDays?: number;
  externalReference?: string;
};

export async function createSubscription(
  input: CreateSubscriptionInput
): Promise<AsaasResult<AsaasSubscription>> {
  return request<AsaasSubscription>("POST", "/subscriptions", {
    customer: input.customerId,
    billingType: input.billingType,
    value: centsToReais(input.amountCents),
    cycle: input.cycle ?? "QUARTERLY",
    description: input.description,
    nextDueDate: dueDateInDays(input.nextDueInDays ?? 1),
    externalReference: input.externalReference,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Webhook helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * O Asaas autentica o webhook de duas formas (escolhidas no painel):
 *
 * 1. Header `asaas-access-token` com um valor fixo que a gente define
 *    (ASAAS_WEBHOOK_TOKEN). Mais simples, é o que vamos usar.
 * 2. HMAC com chave secreta (mais robusto, requer mais setup). Fica
 *    pra Sprint 7 (hardening).
 *
 * Esta função apenas compara o token recebido com o esperado, em
 * tempo constante (pra não vazar nada por timing attack).
 */
export function isWebhookTokenValid(headerToken: string | null): boolean {
  const expected = process.env.ASAAS_WEBHOOK_TOKEN;
  if (!expected || !headerToken) return false;
  if (expected.length !== headerToken.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ headerToken.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Tipos básicos do payload de webhook do Asaas.
 * Doc: https://docs.asaas.com/docs/sobre-os-webhooks
 */
export type AsaasWebhookEvent = {
  id?: string;       // id único do evento (idempotência)
  event: string;     // ex: PAYMENT_RECEIVED
  dateCreated?: string;
  payment?: AsaasPayment;
  subscription?: AsaasSubscription;
};
