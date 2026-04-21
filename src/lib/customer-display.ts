/**
 * src/lib/customer-display.ts — PR-037 · D-056
 *
 * Helpers de **renderização** de nome de paciente em canais externos
 * (WhatsApp, emails, SMS) e em prompts futuros.
 *
 * Problema: `customers.name` historicamente só passava por `.trim()`.
 * Dados antigos (pré-PR-037) podem conter lixo, caracteres de controle,
 * zero-width ou templates de prompt-injection. Antes de interpolar num
 * texto que vai pra canal externo OU pra LLM, **sempre** passar por um
 * destes helpers.
 *
 * Dois helpers — `displayFirstName` e `displayFullName` — compartilham
 * a mesma pipeline defensiva:
 *   1. Tipagem: não-string vira fallback.
 *   2. `sanitizeShortText` com pattern `personName`. Remove controle,
 *      zero-width, rejeita dígitos/símbolos estranhos.
 *   3. Se falhar a sanitização, retorna fallback ("paciente").
 *   4. Corta pelo tamanho adequado (60 pro full, 30 pro first).
 *
 * O contrato é: **o retorno SEMPRE é seguro pra interpolar** em
 * template WhatsApp, email body, prompt LLM. Nunca retorna lixo, nunca
 * retorna `null`, nunca retorna string vazia (sempre fallback).
 */

import { sanitizeShortText, TEXT_PATTERNS } from "./text-sanitize";

const FALLBACK = "paciente";

const FULL_NAME_MAX = 60;
const FIRST_NAME_MAX = 30;

/**
 * Sanitiza o nome completo pra display em canal externo.
 *
 * Fallback: `"paciente"` (minúsculo intencional — quem usa isso em
 * template já capitaliza quando precisa, ou o fallback serve como
 * bandeira visual de "nome não foi capturado").
 */
export function displayFullName(raw: unknown): string {
  if (typeof raw !== "string") return FALLBACK;

  const result = sanitizeShortText(raw, {
    maxLen: FULL_NAME_MAX,
    minLen: 1,
    pattern: TEXT_PATTERNS.personName,
  });

  if (!result.ok) return FALLBACK;

  // Segunda camada: garante que o resultado não é só pontuação ou
  // espaços após pattern match (pattern permite `.,'()-` isolados).
  const hasLetter = /\p{L}/u.test(result.value);
  if (!hasLetter) return FALLBACK;

  return result.value;
}

/**
 * Sanitiza e extrai o primeiro nome pra display em canal externo.
 *
 * Regra: primeiro "token" separado por espaço do nome completo
 * sanitizado. Se o primeiro token tem parênteses / pontuação solta
 * ("(Maria)"), cai no fallback.
 */
export function displayFirstName(raw: unknown): string {
  const full = displayFullName(raw);
  if (full === FALLBACK) return FALLBACK;

  const first = full.split(/\s+/)[0] ?? "";
  if (first.length === 0) return FALLBACK;

  // Limpa pontuação de bordas ("Dr.Maria" → "Dr.Maria"; "(Maria)" →
  // "Maria"). Não removemos pontuação interna porque nomes como
  // "Mary-Ann" ou "O'Brien" são legítimos.
  const trimmed = first.replace(/^[\s.,'()\-]+|[\s.,'()\-]+$/g, "");
  if (trimmed.length === 0) return FALLBACK;
  if (!/\p{L}/u.test(trimmed)) return FALLBACK;

  // Respeita limite do primeiro nome — nomes únicos extremamente longos
  // (30+ chars) são caso esquisito; corta sem ... pra não poluir.
  if (trimmed.length > FIRST_NAME_MAX) {
    return trimmed.slice(0, FIRST_NAME_MAX);
  }

  return trimmed;
}

/**
 * Sanitiza texto de "plano/produto" pra interpolação em mensagem
 * externa. Diferente de `displayFullName`, aceita dígitos (ex.:
 * "Plano Emagrecimento 6 meses") mas rejeita lixo e templates.
 *
 * Fallback: `"seu plano"` — preserva legibilidade do template.
 */
export function displayPlanName(raw: unknown): string {
  if (typeof raw !== "string") return "seu plano";
  const result = sanitizeShortText(raw, {
    maxLen: 80,
    minLen: 2,
    pattern: TEXT_PATTERNS.freeTextWithDigits,
  });
  if (!result.ok) return "seu plano";
  if (!/\p{L}/u.test(result.value)) return "seu plano";
  return result.value;
}

/**
 * Sanitiza texto curto "cidade/estado" pra mensagem externa (ex.:
 * "São Paulo/SP", "Belo Horizonte - MG").
 *
 * Fallback: `"seu endereço"`.
 */
export function displayCityState(raw: unknown): string {
  if (typeof raw !== "string") return "seu endereço";
  const result = sanitizeShortText(raw, {
    maxLen: 80,
    minLen: 2,
    // Cidade pode ter "/" entre nome e UF, então usamos um pattern
    // estendido aqui em vez de `freeTextStrict`.
    pattern: /^[\p{L} .,'()\-/]+$/u,
  });
  if (!result.ok) return "seu endereço";
  if (!/\p{L}/u.test(result.value)) return "seu endereço";
  return result.value;
}
