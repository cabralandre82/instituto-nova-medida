/**
 * src/lib/lead-validate.ts — PR-036 · D-054
 *
 * Validação e sanitização do payload recebido em `POST /api/lead`.
 *
 * Motivação (audit findings 9.1 + 9.3 + 22.2):
 *   - 9.1: `leads.answers` (JSONB) é um dos campos livres que vão
 *     alimentar LLMs no futuro (nudges, admin-digest, triagem). Se
 *     `answers = { respostaLivre: "IGNORE ALL PREVIOUS INSTRUCTIONS" }`
 *     chegar bruto ao DB, qualquer pipeline de IA fica contaminado.
 *   - 9.3: atacante envia `answers` de 50KB → `public.leads` cresce,
 *     índice GIN sofre, custo Supabase sobe.
 *   - 22.2: mesma raiz 9.3 do lado adversário — LLM-gera 10000 leads
 *     com 50KB cada. Sem rate-limit, admin solo só descobre na fatura.
 *
 * Estratégia de defesa:
 *   1. Schema estrito no TS: só aceitamos as 4 perguntas conhecidas do
 *      quiz. Extras são descartadas (fail-open — não quebra a captura
 *      se alguém adicionar pergunta nova no futuro e esquecer de
 *      rebuild; só ignora).
 *   2. Charset slug-ish pras keys e values (a-z0-9-_): o quiz é
 *      multiple-choice, os valores são slugs fechados (`fome`,
 *      `manter`, etc). Ninguém precisa de `<`, `>`, newline.
 *   3. Nome: charset de `TEXT_PATTERNS.personName` (PR-035) + limite
 *      de 80 chars.
 *   4. Phone: só dígitos + DDI/DDD check (10-15 dígitos).
 *   5. UTM: máx 5 pares known-keys, cada value ≤ 120 chars, charset
 *      `utmToken` (a-z0-9+._-). UTM arbitrário extra é descartado.
 *   6. Referrer: URL ou null. Máx 500 chars. Só `http(s)://`.
 *   7. LandingPath: path interno (`normalizeInternalPath`).
 *
 * Pura: não toca Supabase, não toca headers, não toca WhatsApp.
 * `validateLead` devolve objeto canônico ou lista de erros tipada.
 */

import {
  hasControlChars,
  normalizeInternalPath,
  sanitizeShortText,
  TEXT_PATTERNS,
} from "./text-sanitize";

// ────────────────────────────────────────────────────────────────────────
// Limites
// ────────────────────────────────────────────────────────────────────────

export const LEAD_LIMITS = {
  /** Nome do lead — 80 cobre qualquer nome brasileiro real. */
  nameMaxLen: 80,
  /** Min — 2 chars já era a regra do DB (`check length(trim(name)) >= 2`). */
  nameMinLen: 2,

  /** Slug de key de pergunta. Quiz usa 4 keys de 7-9 chars. */
  answerKeyMaxLen: 40,
  /** Slug de value de resposta. Quiz usa 3 options de 3-10 chars. */
  answerValueMaxLen: 60,
  /** Máximo de pares no objeto `answers`. Quiz tem 4 — margem. */
  answerMaxPairs: 20,

  /** Phone: 10 (fixo local, 10 dígitos) até 15 (DDI + DDD + 9 dígitos). */
  phoneMinDigits: 10,
  phoneMaxDigits: 15,

  /** UTM: max 5 pares (source/medium/campaign/term/content). */
  utmMaxPairs: 5,
  utmKeyMaxLen: 40,
  utmValueMaxLen: 120,

  /** Referrer: URL truncada. */
  referrerMaxLen: 500,

  /** Landing path — bate com normalizeInternalPath. */
  landingPathMaxLen: 200,

  /**
   * Limite de bytes do JSON inteiro. Se o cliente mandar mais que isso,
   * rejeitamos sem deserializar — proteção contra DoS em parse.
   */
  bodyMaxBytes: 8192, // 8 KB — quiz real cabe em < 1KB.
} as const;

// ────────────────────────────────────────────────────────────────────────
// Tipos
// ────────────────────────────────────────────────────────────────────────

export type LeadAnswers = Record<string, string>;
export type LeadUtm = Record<string, string>;

export type LeadInput = {
  name: string;
  phone: string;
  consent: boolean;
  answers: LeadAnswers;
  utm?: LeadUtm | null;
  referrer?: string | null;
  landingPath?: string | null;
};

export type LeadSanitized = {
  name: string;
  phone: string;
  consent: true;
  answers: LeadAnswers;
  utm: LeadUtm;
  referrer: string | null;
  landingPath: string;
};

export type LeadErrorCode =
  | "invalid_json"
  | "too_large"
  | "invalid_shape"
  | "invalid_name"
  | "invalid_phone"
  | "missing_consent"
  | "invalid_answers";

export type LeadValidationResult =
  | { ok: true; lead: LeadSanitized }
  | { ok: false; code: LeadErrorCode; message: string };

// ────────────────────────────────────────────────────────────────────────
// Guards
// ────────────────────────────────────────────────────────────────────────

/**
 * Sanidade de shape. Usado antes de tocar em qualquer sub-validador,
 * pra evitar passar `undefined` adiante.
 */
function hasShape(x: unknown): x is Record<string, unknown> {
  return Boolean(x) && typeof x === "object" && !Array.isArray(x);
}

// ────────────────────────────────────────────────────────────────────────
// Pattern slug: letras minúsculas, dígitos, `_`, `-`.
// ────────────────────────────────────────────────────────────────────────
const PATTERN_SLUG = /^[a-z0-9_-]+$/;

// ────────────────────────────────────────────────────────────────────────
// Sanitizers internos
// ────────────────────────────────────────────────────────────────────────

function sanitizeAnswers(
  raw: unknown
): { ok: true; value: LeadAnswers } | { ok: false; reason: string } {
  if (!hasShape(raw)) {
    return { ok: false, reason: "answers deve ser objeto" };
  }

  const entries = Object.entries(raw);
  if (entries.length === 0) {
    // answers vazio é aceitável — o quiz pode ter skip. DB aceita.
    return { ok: true, value: {} };
  }
  if (entries.length > LEAD_LIMITS.answerMaxPairs) {
    return {
      ok: false,
      reason: `answers acima de ${LEAD_LIMITS.answerMaxPairs} pares`,
    };
  }

  const out: LeadAnswers = {};
  for (const [key, value] of entries) {
    if (typeof key !== "string" || key.length === 0) {
      return { ok: false, reason: "answers: key não-string ou vazia" };
    }
    if (key.length > LEAD_LIMITS.answerKeyMaxLen) {
      return { ok: false, reason: "answers: key acima do limite" };
    }
    if (hasControlChars(key) || !PATTERN_SLUG.test(key)) {
      return { ok: false, reason: "answers: key com charset inválido" };
    }

    if (typeof value !== "string") {
      return { ok: false, reason: "answers: value não-string" };
    }
    if (value.length > LEAD_LIMITS.answerValueMaxLen) {
      return { ok: false, reason: "answers: value acima do limite" };
    }
    if (hasControlChars(value) || !PATTERN_SLUG.test(value)) {
      return { ok: false, reason: "answers: value com charset inválido" };
    }

    out[key] = value;
  }
  return { ok: true, value: out };
}

function sanitizeUtm(raw: unknown): LeadUtm {
  // UTM é best-effort: em vez de rejeitar o lead por UTM malformado,
  // descartamos pares inválidos e guardamos o que sobrou. Atribuição
  // suja é melhor que lead perdido.
  if (!hasShape(raw)) return {};

  const entries = Object.entries(raw).slice(0, LEAD_LIMITS.utmMaxPairs);
  const out: LeadUtm = {};
  for (const [key, value] of entries) {
    if (
      typeof key !== "string" ||
      key.length === 0 ||
      key.length > LEAD_LIMITS.utmKeyMaxLen ||
      hasControlChars(key) ||
      !TEXT_PATTERNS.utmToken.test(key)
    ) {
      continue;
    }
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > LEAD_LIMITS.utmValueMaxLen ||
      hasControlChars(value) ||
      !TEXT_PATTERNS.utmToken.test(value)
    ) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

function sanitizeReferrer(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > LEAD_LIMITS.referrerMaxLen) return null;
  if (hasControlChars(trimmed)) return null;
  // Aceita só http(s). Bloqueia `javascript:`, `data:`, relative, etc.
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}

function sanitizePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < LEAD_LIMITS.phoneMinDigits) return null;
  if (digits.length > LEAD_LIMITS.phoneMaxDigits) return null;
  return digits;
}

// ────────────────────────────────────────────────────────────────────────
// Entrada principal
// ────────────────────────────────────────────────────────────────────────

/**
 * Valida + sanitiza o body cru de `/api/lead`. Input tipado como
 * `unknown` propositalmente — esta é a fronteira de confiança: a
 * função precisa checar tudo.
 */
export function validateLead(raw: unknown): LeadValidationResult {
  if (!hasShape(raw)) {
    return {
      ok: false,
      code: "invalid_shape",
      message: "Payload inválido.",
    };
  }

  // Nome
  const nameResult = sanitizeShortText(raw.name, {
    maxLen: LEAD_LIMITS.nameMaxLen,
    minLen: LEAD_LIMITS.nameMinLen,
    pattern: TEXT_PATTERNS.personName,
  });
  if (!nameResult.ok) {
    return {
      ok: false,
      code: "invalid_name",
      message:
        nameResult.reason === "too_long"
          ? "Nome acima do limite."
          : nameResult.reason === "control_chars" ||
            nameResult.reason === "charset"
          ? "Nome contém caracteres não permitidos."
          : "Informe seu nome.",
    };
  }

  // Telefone
  const phone = sanitizePhone(raw.phone);
  if (!phone) {
    return {
      ok: false,
      code: "invalid_phone",
      message: "Informe um telefone válido (com DDD).",
    };
  }

  // Consent (obrigatório — legal)
  if (raw.consent !== true) {
    return {
      ok: false,
      code: "missing_consent",
      message: "Consentimento LGPD obrigatório.",
    };
  }

  // Answers (charset estrito + limites)
  const answersResult = sanitizeAnswers(raw.answers);
  if (!answersResult.ok) {
    return {
      ok: false,
      code: "invalid_answers",
      message: answersResult.reason,
    };
  }

  // UTM + referrer + landingPath são best-effort (fallback seguro).
  const utm = sanitizeUtm(raw.utm);
  const referrer = sanitizeReferrer(raw.referrer);
  const landingPath = normalizeInternalPath(
    raw.landingPath,
    LEAD_LIMITS.landingPathMaxLen
  );

  return {
    ok: true,
    lead: {
      name: nameResult.value,
      phone,
      consent: true,
      answers: answersResult.value,
      utm,
      referrer,
      landingPath,
    },
  };
}

/**
 * Mede o tamanho do body bruto (antes de `JSON.parse`) comparando em
 * bytes UTF-8. Usado na rota pra rejeitar payloads gigantes sem gastar
 * CPU em parse.
 */
export function isBodyTooLarge(raw: string): boolean {
  // `new Blob([raw]).size` seria exato mas é `DOM-only`. Em runtime
  // Node, `Buffer.byteLength(raw, "utf8")` é a versão servidor.
  return Buffer.byteLength(raw, "utf8") > LEAD_LIMITS.bodyMaxBytes;
}
