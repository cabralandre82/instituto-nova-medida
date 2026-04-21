/**
 * src/lib/prompt-redact.ts — PR-037 · D-056
 *
 * Redação/mascaramento de PII antes de:
 *   (a) logar (observabilidade futura — PR-039+);
 *   (b) enviar pra LLM externo (OpenAI/Anthropic/Gemini).
 *
 * A ADR `D-056` exige que nenhum texto enviado a uma API externa ou
 * escrito em log drain contenha CPF, CEP, email, telefone brasileiro,
 * UUID (IDs internos) ou segredos (Asaas tokens) na forma crua. Este
 * módulo é a implementação de referência.
 *
 * Padrão de mascaramento:
 *   - CPF        999.999.999-99  →  [CPF]
 *   - CEP        99999-999       →  [CEP]
 *   - E-mail     x@y.com         →  [EMAIL]
 *   - Telefone   (11) 99999-9999 →  [PHONE]
 *   - UUID       8-4-4-4-12 hex  →  [UUID]
 *   - Bearer     Asaas $aact...  →  [TOKEN]
 *
 * O padrão de placeholder é propositalmente curto e padronizado. Se um
 * dia quisermos "partial redact" (ex.: últimos 2 dígitos do CPF pra
 * suporte identificar paciente), substituir aqui centraliza.
 *
 * NÃO é defesa de XSS nem de SQL injection. É defesa contra vazamento
 * de PII em pipeline AI / observabilidade.
 */

// ────────────────────────────────────────────────────────────────────────
// Patterns — intencionalmente **generosos** (preferir falso-positivo
// que vaze dígitos de um produto sem sentido do que falso-negativo que
// vaze CPF real).
// ────────────────────────────────────────────────────────────────────────

/**
 * CPF com ou sem pontuação: 000.000.000-00 ou 00000000000.
 * Exige 11 dígitos consecutivos pra evitar casar número qualquer.
 */
const CPF_RE = /(?<!\d)(\d{3}\.?\d{3}\.?\d{3}-?\d{2})(?!\d)/g;

/**
 * CEP: 00000-000 ou 00000000. Apenas em contexto de separação (não no
 * meio de uma string maior de dígitos tipo ID).
 */
const CEP_RE = /(?<!\d)(\d{5}-?\d{3})(?!\d)/g;

/**
 * E-mail básico. Bate com `x@y.tld` e variantes. Não tenta ser RFC;
 * a meta é redigir em vez de validar.
 */
const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;

/**
 * Telefone BR. Aceita +55, DDD com ou sem parênteses, 8 ou 9 dígitos
 * após DDD, hífen opcional.
 *
 * Importante: o prefixo `55` só casa **quando seguido por separador**
 * (espaço ou hífen), senão qualquer string de 12 dígitos começando em
 * "55" seria confundido com DDI+DDD+phone.
 *
 * Exemplos que bate:
 *   +55 11 99999-9999
 *   (11) 99999-9999
 *   11999999999
 *   (11) 3333-4444
 */
const PHONE_BR_RE =
  /(?<!\d)(?:\+?55[\s-]+)?\(?\d{2}\)?[\s-]*9?\d{4}[-\s]?\d{4}(?!\d)/g;

/**
 * UUID v4-ish (8-4-4-4-12 hex). Case-insensitive.
 */
const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Tokens Asaas têm prefixo `$aact_`. Segue 32+ chars.
 * Tokens arbitrários Bearer/JWT (3 partes separadas por ponto) também.
 * Cada parte com 8+ chars base64url.
 */
const ASAAS_TOKEN_RE = /\$aact_[A-Za-z0-9]{32,}/g;
const JWT_RE =
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

// ────────────────────────────────────────────────────────────────────────
// API
// ────────────────────────────────────────────────────────────────────────

export type RedactOptions = {
  /** Inclui CPF. Default: true. */
  cpf?: boolean;
  /** Inclui CEP. Default: true. */
  cep?: boolean;
  /** Inclui e-mail. Default: true. */
  email?: boolean;
  /** Inclui telefone. Default: true. */
  phone?: boolean;
  /**
   * Inclui UUIDs internos. Default: false — em logs, UUID de
   * `customer_id` ajuda debugging e **não é PII direto** (é pseudônimo).
   * Ative quando mandar pra LLM externa.
   */
  uuid?: boolean;
  /** Inclui tokens (Asaas + JWT). Default: true. */
  tokens?: boolean;
};

const DEFAULT_OPTIONS: Required<RedactOptions> = {
  cpf: true,
  cep: true,
  email: true,
  phone: true,
  uuid: false,
  tokens: true,
};

/**
 * Aplica redação de PII ao texto.
 *
 * Retorna sempre uma nova string; nunca muta a original.
 *
 * Estratégia: UUIDs são SEMPRE detectados primeiro e substituídos por
 * sentinelas temporárias (mesmo quando `uuid:false`) pra impedir que
 * regexes de CPF/CEP/phone peguem subsequências do UUID (ex.: os
 * primeiros 8 dígitos do UUID casariam CEP). No final, as sentinelas
 * são trocadas por `[UUID]` (se `uuid:true`) ou restauradas ao UUID
 * original (se `uuid:false`).
 */
export function redactPII(raw: string, opts: RedactOptions = {}): string {
  const o = { ...DEFAULT_OPTIONS, ...opts };

  // Fase 1: neutraliza UUIDs com sentinela opaca (não-dígito, não-letra
  // "normal" pra que nenhum regex subsequente case).
  const uuidSentinels: string[] = [];
  let out = raw.replace(UUID_RE, (match) => {
    uuidSentinels.push(match);
    return `\u0001UUID${uuidSentinels.length - 1}\u0001`;
  });

  // Fase 2: redações regulares.
  if (o.tokens) {
    out = out.replace(ASAAS_TOKEN_RE, "[TOKEN]");
    out = out.replace(JWT_RE, "[TOKEN]");
  }
  if (o.cpf) {
    out = out.replace(CPF_RE, "[CPF]");
  }
  if (o.cep) {
    out = out.replace(CEP_RE, "[CEP]");
  }
  if (o.email) {
    out = out.replace(EMAIL_RE, "[EMAIL]");
  }
  if (o.phone) {
    out = out.replace(PHONE_BR_RE, "[PHONE]");
  }

  // Fase 3: resolve sentinelas de UUID.
  out = out.replace(/\u0001UUID(\d+)\u0001/g, (_m, idx) => {
    const original = uuidSentinels[Number(idx)];
    if (original === undefined) return "[UUID]";
    return o.uuid ? "[UUID]" : original;
  });

  return out;
}

/**
 * Preset pra observabilidade (Sentry/Axiom). Mantém UUID (útil pra
 * debugging) e remove PII + tokens.
 */
export function redactForLog(raw: string): string {
  return redactPII(raw, { uuid: false });
}

/**
 * Preset pra chamadas externas de LLM (OpenAI etc.). Redige TUDO —
 * inclusive UUID, já que IDs internos podem ser correlacionados com
 * outros logs externos.
 */
export function redactForLLM(raw: string): string {
  return redactPII(raw, { uuid: true });
}
