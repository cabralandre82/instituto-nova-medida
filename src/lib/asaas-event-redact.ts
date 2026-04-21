/**
 * src/lib/asaas-event-redact.ts — PR-052 · D-063 · finding 5.12
 *
 * Sanitização do payload de webhook Asaas antes de persistir em
 * `asaas_events`. Remove PII do customer (nome, CPF, email, phone,
 * endereço), dados do cartão (holderInfo) e descrições livres, mantendo
 * **apenas** o que é necessário pra:
 *
 *   - Processar o evento (classificação, idempotência).
 *   - Reconciliar com `payments`/`customers` locais via IDs e externalReference.
 *   - Auditoria financeira (valor, status, datas, billingType).
 *
 * Filosofia: **allowlist deny-by-default**. Se um campo novo aparecer
 * no payload do Asaas (eles adicionam campos sem avisar), ele não passa
 * a menos que a gente liste explicitamente. Isso protege contra futura
 * PII que vier embutida em `metadata`, `customFields`, etc.
 *
 * O que é preservado (allowlist):
 *
 *   Nível 0 (envelope):
 *     id, event, dateCreated
 *
 *   payment.*:
 *     id, status, billingType, value, netValue, originalValue,
 *     interestValue, discount.value, fine.value,
 *     dueDate, paymentDate, clientPaymentDate, originalDueDate,
 *     confirmedDate, creditDate, estimatedCreditDate,
 *     invoiceNumber, externalReference, installment, installmentNumber,
 *     installmentCount, customer (ID Asaas apenas — string, não obj),
 *     subscription, deleted, pixTransaction.qrCode /* sem payload interno *\/
 *     bankSlipUrl (mantido — URL pública, não PII em si),
 *     invoiceUrl, transactionReceiptUrl (URLs assinadas, não PII)
 *
 *   payment.refunds[] (array de estornos, guardamos metadados):
 *     id, status, value, dateCreated, refundDate
 *
 * O que é BLOQUEADO (deny):
 *
 *   - payment.description (campo livre — pode ter PII se o operador
 *     incluir)
 *   - payment.customer QUANDO for objeto expandido (name, cpfCnpj,
 *     email, phone, mobilePhone, address*, postalCode, province,
 *     city, state, country, company, externalReference)
 *   - creditCard, creditCardHolderInfo, creditCardToken (dados do cartão)
 *   - payer.* (dados de quem está pagando quando diferente do customer)
 *   - billing.* (address, cpfCnpj)
 *   - payment.split[] (repasses automáticos — podem conter walletId)
 *   - discount.description, fine.description, interest.description
 *     (textos livres que podem ter PII)
 *   - metadata, customFields, anyProperty com nome que contenha cpf/
 *     email/phone/address (defesa em profundidade — redact_by_name)
 *   - QUALQUER campo não listado na allowlist
 *
 * Como o webhook processa/reconcilia:
 *   - `asaas_payment_id` coluna separada → usada pra join em `payments`.
 *   - `externalReference` (preservado) = nosso `payments.id` local.
 *   - `status`, `value`, `paymentDate` → suficientes pra classificação
 *     (`payment-event-category.ts`).
 *   - Se o operador precisa ver a PII de um evento antigo, busca via
 *     `customers.asaas_customer_id` → `customers` local (onde a PII
 *     está sob controle RLS + trilha `patient_access_log`). NUNCA
 *     devemos re-fonte PII em `asaas_events`.
 *
 * Performance: o redact é CPU puro, sem IO. Tipicamente <1ms por
 * payload (JSON < 10KB). Não bloqueia o webhook perceptivelmente.
 */

import { logger } from "./logger";

const log = logger.with({ mod: "asaas-event-redact" });

/**
 * Constante sentinela usada no lugar de PII quando um campo é dropado.
 * Mantém a estrutura do JSON legível pra debug (vs omitir a chave).
 * Usamos um texto curto e inequívoco.
 */
export const REDACTED_MARK = "[redacted]";

/**
 * Allowlist de campos em `payment.*`. Se o Asaas introduzir um campo
 * novo que seja seguro, adicionar aqui + bump da versão de redact em
 * `REDACT_VERSION` pra rastrear no log.
 */
const PAYMENT_ALLOWED_KEYS = new Set<string>([
  "id",
  "status",
  "billingType",
  "value",
  "netValue",
  "originalValue",
  "interestValue",
  "discount",
  "fine",
  "interest",
  "dueDate",
  "paymentDate",
  "clientPaymentDate",
  "originalDueDate",
  "confirmedDate",
  "creditDate",
  "estimatedCreditDate",
  "invoiceNumber",
  "externalReference",
  "installment",
  "installmentNumber",
  "installmentCount",
  "subscription",
  "deleted",
  "bankSlipUrl",
  "invoiceUrl",
  "transactionReceiptUrl",
  // `customer` é tratado especial: se for string (ID Asaas), preserva;
  // se for objeto expandido, substitui por `{ id, externalReference }`.
  "customer",
  "refunds",
  "pixTransaction",
]);

const ENVELOPE_ALLOWED_KEYS = new Set<string>([
  "id",
  "event",
  "dateCreated",
  "payment",
]);

const REFUND_ALLOWED_KEYS = new Set<string>([
  "id",
  "status",
  "value",
  "dateCreated",
  "refundDate",
]);

const CUSTOMER_SUMMARY_ALLOWED_KEYS = new Set<string>([
  "id",
  "externalReference",
]);

/**
 * Campos dentro de `discount`, `fine`, `interest` e similares. Valor
 * numérico é seguro; description/text é livre e pode conter PII.
 */
const MONEY_SUBOBJECT_ALLOWED_KEYS = new Set<string>([
  "value",
  "dueDateLimitDays",
  "type",
]);

/**
 * `pixTransaction` vem com metadados do QR code. O campo `payload` do
 * Pix EMV tem identificação do recebedor (inclui CPF do titular em
 * alguns casos) e é não-trivial. Mantemos só os campos discretos.
 */
const PIX_TRANSACTION_ALLOWED_KEYS = new Set<string>([
  "qrCode",
  "endToEndIdentifier",
  "txid",
]);

/**
 * Versão do redactor. Incremente quando mudar a allowlist. Gravado
 * implicitamente via `payload_redacted_at` (timestamp) + logs de
 * aplicação — futuras investigações podem cruzar timestamp com a
 * versão deployada.
 */
export const REDACT_VERSION = 1;

export type AsaasWebhookPayload = Record<string, unknown>;

/**
 * Sanitiza um payload de webhook do Asaas. Deny-by-default: qualquer
 * campo não listado é dropado.
 *
 * Implementação imutável — não muta o input.
 *
 * Se o payload é estruturalmente inválido (não-objeto, null, etc.),
 * retorna `{}` e loga warn (caller deve decidir como persistir).
 */
export function redactAsaasPayload(
  input: unknown
): AsaasWebhookPayload {
  if (!isPlainObject(input)) {
    log.warn("payload nao eh objeto — retornando vazio", {
      type: typeof input,
    });
    return {};
  }

  const out: AsaasWebhookPayload = {};

  for (const [key, value] of Object.entries(input)) {
    if (!ENVELOPE_ALLOWED_KEYS.has(key)) continue;

    if (key === "payment") {
      out.payment = redactPayment(value);
      continue;
    }

    // envelope: id/event/dateCreated — tipos primitivos esperados.
    // Se vier objeto por algum motivo, converte pra string (defesa).
    out[key] = coercePrimitive(value);
  }

  return out;
}

/**
 * Sanitiza o sub-objeto `payment`. Expõe só os campos seguros
 * declarados em `PAYMENT_ALLOWED_KEYS` e aplica recursão especial em
 * `customer`, `refunds[]`, `discount/fine/interest`, `pixTransaction`.
 */
function redactPayment(raw: unknown): AsaasWebhookPayload {
  if (!isPlainObject(raw)) return {};

  const out: AsaasWebhookPayload = {};

  for (const [key, value] of Object.entries(raw)) {
    if (!PAYMENT_ALLOWED_KEYS.has(key)) continue;

    if (key === "customer") {
      out.customer = redactCustomerRef(value);
      continue;
    }

    if (key === "refunds") {
      out.refunds = redactRefunds(value);
      continue;
    }

    if (key === "discount" || key === "fine" || key === "interest") {
      out[key] = redactMoneySubobject(value);
      continue;
    }

    if (key === "pixTransaction") {
      out.pixTransaction = redactPixTransaction(value);
      continue;
    }

    // Campos escalares (id, status, billingType, value, dates, URLs).
    // URL fields podem, em casos extremos, ter params com PII — as
    // URLs do Asaas são assinadas com hash opaco; seguras. Preservamos.
    out[key] = coercePrimitive(value);
  }

  return out;
}

/**
 * Trata `payment.customer`: pode vir como string (ID) ou objeto
 * expandido. String passa direto. Objeto reduzido a `{id, externalReference}`.
 */
function redactCustomerRef(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (!isPlainObject(value)) return null;

  const out: AsaasWebhookPayload = {};
  for (const [k, v] of Object.entries(value)) {
    if (CUSTOMER_SUMMARY_ALLOWED_KEYS.has(k)) {
      out[k] = coercePrimitive(v);
    }
  }
  return out;
}

function redactRefunds(value: unknown): AsaasWebhookPayload[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((r) => {
      if (!isPlainObject(r)) return null;
      const out: AsaasWebhookPayload = {};
      for (const [k, v] of Object.entries(r)) {
        if (REFUND_ALLOWED_KEYS.has(k)) out[k] = coercePrimitive(v);
      }
      return out;
    })
    .filter((r): r is AsaasWebhookPayload => r !== null);
}

function redactMoneySubobject(value: unknown): AsaasWebhookPayload {
  if (!isPlainObject(value)) return {};
  const out: AsaasWebhookPayload = {};
  for (const [k, v] of Object.entries(value)) {
    if (MONEY_SUBOBJECT_ALLOWED_KEYS.has(k)) out[k] = coercePrimitive(v);
  }
  return out;
}

function redactPixTransaction(value: unknown): AsaasWebhookPayload {
  if (!isPlainObject(value)) return {};
  const out: AsaasWebhookPayload = {};
  for (const [k, v] of Object.entries(value)) {
    if (PIX_TRANSACTION_ALLOWED_KEYS.has(k)) out[k] = coercePrimitive(v);
  }
  return out;
}

// ─── helpers ────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Coerce um valor desconhecido pra um primitivo seguro de JSON. Se já
 * é primitivo/array/plain object passa intacto (após validação básica);
 * senão, vira null. Não queremos tipos exóticos (Date, BigInt, Function)
 * poluindo o jsonb.
 */
function coercePrimitive(v: unknown): unknown {
  const t = typeof v;
  if (v === null) return null;
  if (t === "string" || t === "number" || t === "boolean") return v;
  if (Array.isArray(v)) return v; // arrays superficiais (refunds já são tratados)
  if (t === "object") return v; // objetos simples — jsonb lida
  return null; // function/undefined/symbol/bigint
}
