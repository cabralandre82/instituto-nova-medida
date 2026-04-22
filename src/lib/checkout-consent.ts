/**
 * src/lib/checkout-consent.ts — PR-053 · D-064 · finding 5.6
 *
 * Gravação + hash do aceite de termos em `/api/checkout`.
 *
 * Princípios:
 *
 *   - **Server-authoritative**: o cliente só envia
 *     `consent: true` + `consentTextVersion`. O servidor carrega o
 *     texto canônico da versão (`getCheckoutConsentText()`) e grava
 *     como snapshot. O cliente não dita o que foi aceito — ele só
 *     escolhe *qual versão* está vigente na tela dele.
 *
 *   - **Imutabilidade**: `checkout_consents` tem trigger BEFORE
 *     UPDATE/DELETE que barra qualquer mutação. A row fica pra sempre.
 *
 *   - **Hash canonicalizado**: SHA-256 de
 *     JSON.stringify({customer_id, payment_id, text_snapshot_norm,
 *     text_version}) com chaves em ordem alfabética e texto
 *     normalizado (NFC + whitespace collapse + trim). Auditoria
 *     re-calcula e compara — divergência indica tampering.
 *
 * Qual o ponto de gravação no fluxo `/api/checkout`:
 *   1. Validar body (inclui `consent === true` + versão conhecida).
 *   2. Upsert customer (já existente ou novo) → obtém `customer_id`.
 *   3. Insert `payments` (status PENDING) → obtém `payment_id`.
 *   4. **`recordCheckoutConsent()` aqui** (com customer_id + payment_id).
 *   5. Chamar Asaas pra criar a cobrança. Se falhar, o consent
 *      permanece gravado — é prova do interesse do paciente e
 *      permite retry sem re-aceite.
 *
 * Por que não gravar consent ANTES do payment insert:
 *   Se a gente inserir consent antes do payment, fica com
 *   `payment_id = null` e teríamos que UPDATE depois — mas a tabela
 *   é imutável (trigger). Insertar após o payment garante que a row
 *   já nasce com o FK completo e nunca precisa mutar.
 *
 * Failure modes cobertos:
 *   - Insert falha (FK inválido, DB down): função retorna
 *     `{ ok: false, ... }` e a rota decide (rejeita a cobrança).
 *     Rationale: sem prova de aceite, NÃO cobramos. É preferível
 *     frustrar um checkout legítimo a cobrar sem base legal.
 */

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getCheckoutConsentText,
  isKnownCheckoutConsentVersion,
} from "./checkout-consent-terms";
import { logger } from "./logger";

const log = logger.with({ mod: "checkout-consent" });

export type CheckoutConsentInput = {
  customerId: string;
  paymentId: string;
  textVersion: string;
  ipAddress: string | null;
  userAgent: string | null;
  paymentMethod: "pix" | "boleto" | "cartao";
};

export type CheckoutConsentResult =
  | {
      ok: true;
      consentId: string;
      textHash: string;
      textSnapshot: string;
      textVersion: string;
    }
  | {
      ok: false;
      code:
        | "unknown_version"
        | "insert_failed"
        | "invalid_input";
      message: string;
    };

/**
 * Calcula o hash canonical de um aceite de checkout.
 *
 * Exportado pra permitir auditoria post-hoc: dado uma row em
 * `checkout_consents`, re-hashar o snapshot + version + customer +
 * payment deve bater com `text_hash`. Se não bate, tampering.
 */
export function computeCheckoutConsentHash(args: {
  customerId: string;
  paymentId: string;
  textVersion: string;
  textSnapshot: string;
}): string {
  const canonical = JSON.stringify({
    customerId: args.customerId.trim(),
    paymentId: args.paymentId.trim(),
    textSnapshot: normalizeText(args.textSnapshot),
    textVersion: args.textVersion.trim(),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function normalizeText(raw: string): string {
  return raw.normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * Grava uma row em `checkout_consents`. Server-authoritative: o texto
 * gravado é SEMPRE o retornado por `getCheckoutConsentText(version)`,
 * nunca um input do cliente.
 */
export async function recordCheckoutConsent(
  supabase: SupabaseClient,
  input: CheckoutConsentInput
): Promise<CheckoutConsentResult> {
  if (!input.customerId || !input.paymentId) {
    return {
      ok: false,
      code: "invalid_input",
      message: "customerId e paymentId são obrigatórios",
    };
  }

  if (!isKnownCheckoutConsentVersion(input.textVersion)) {
    return {
      ok: false,
      code: "unknown_version",
      message: `versão desconhecida: ${input.textVersion}`,
    };
  }

  let textSnapshot: string;
  try {
    textSnapshot = getCheckoutConsentText(input.textVersion);
  } catch (e) {
    // Guarda redundante — `isKnownCheckoutConsentVersion` já valida,
    // mas preserva o type-narrow e evita crash se alguma version for
    // declarada em `KNOWN_...` mas esquecida do switch.
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, code: "unknown_version", message: msg };
  }

  const textHash = computeCheckoutConsentHash({
    customerId: input.customerId,
    paymentId: input.paymentId,
    textVersion: input.textVersion,
    textSnapshot,
  });

  const { data, error } = await supabase
    .from("checkout_consents")
    .insert({
      customer_id: input.customerId,
      payment_id: input.paymentId,
      text_version: input.textVersion,
      text_snapshot: textSnapshot,
      text_hash: textHash,
      ip_address: input.ipAddress,
      user_agent: input.userAgent,
      payment_method: input.paymentMethod,
    })
    .select("id")
    .single();

  if (error || !data) {
    log.error("insert falhou", {
      err: error?.message,
      customer_id: input.customerId,
      payment_id: input.paymentId,
    });
    return {
      ok: false,
      code: "insert_failed",
      message: error?.message ?? "insert retornou vazio",
    };
  }

  return {
    ok: true,
    consentId: data.id,
    textHash,
    textSnapshot,
    textVersion: input.textVersion,
  };
}

/**
 * Extrai o IP do cliente a partir dos headers de proxy/Vercel.
 *
 * Ordem de precedência (do mais específico pro mais genérico):
 *   1. `x-vercel-forwarded-for` — header nativo Vercel.
 *   2. `cf-connecting-ip` — Cloudflare (se entrar no caminho).
 *   3. `x-forwarded-for` — padrão HTTP, pega o primeiro hop.
 *
 * Retorna `null` se nenhum header bate (ex.: teste local sem proxy).
 */
export function extractClientIp(req: Request): string | null {
  const vercelFwd = req.headers.get("x-vercel-forwarded-for");
  if (vercelFwd) return firstHop(vercelFwd);
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return firstHop(xff);
  return null;
}

function firstHop(headerValue: string): string {
  const parts = headerValue.split(",");
  const first = parts[0]?.trim();
  return first && first.length > 0 ? first : "";
}
