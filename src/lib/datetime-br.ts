/**
 * src/lib/datetime-br.ts — helpers de formatação BR (PR-021 · audit [2.1]).
 *
 * Contexto:
 *   `new Date(iso).toLocaleDateString("pt-BR")` sem `timeZone` usa o
 *   TZ do processo. No servidor (Vercel) isso é UTC — para datas
 *   próximas à meia-noite BR, o dia exibido ao usuário pode ser
 *   o anterior/posterior. Discrepância crônica e silenciosa.
 *
 *   Esta biblioteca é a **fonte única** de formatação temporal em
 *   pt-BR, sempre com `America/Sao_Paulo`. Todos os
 *   `.toLocaleDateString("pt-BR")` server-side devem passar por aqui.
 *
 *   Os helpers aceitam `string` (ISO), `Date` ou `null/undefined`.
 *   Quando a entrada é nula, devolvem `""` — o caller decide se quer
 *   renderizar placeholder (`—`) ou esconder.
 *
 * Por que não usar `Intl.DateTimeFormat` direto em cada lugar:
 *   1. Evita omissão acidental de `timeZone`.
 *   2. Permite trocar a implementação no futuro (ex.: Temporal API)
 *      sem caçar arquivos.
 *   3. Presets nomeados ("short", "long", "full") encapsulam as
 *      escolhas de apresentação e padronizam a UI.
 */

export const DEFAULT_TIMEZONE = "America/Sao_Paulo" as const;
export const DEFAULT_LOCALE = "pt-BR" as const;

export type DateInput = string | number | Date | null | undefined;

function toDate(input: DateInput): Date | null {
  if (input == null) return null;
  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? null : input;
  }
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ────────────────────────────────────────────────────────────────────────
// Datas (sem hora)
// ────────────────────────────────────────────────────────────────────────

/**
 * "15/04/2026" (default) — equivalente a toLocaleDateString pt-BR
 * com `timeZone: America/Sao_Paulo`. Aceita opções extras para
 * variantes (weekday, month:'long', etc.).
 */
export function formatDateBR(
  input: DateInput,
  options: Intl.DateTimeFormatOptions = {}
): string {
  const d = toDate(input);
  if (!d) return "";
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    timeZone: DEFAULT_TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    ...options,
  }).format(d);
}

/**
 * "15 de abril de 2026" — data por extenso.
 */
export function formatDateLongBR(input: DateInput): string {
  return formatDateBR(input, {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

/**
 * "15 abr" (short month) — útil pra tabelas compactas.
 */
export function formatDateShortMonthBR(input: DateInput): string {
  return formatDateBR(input, {
    day: "2-digit",
    month: "short",
  });
}

/**
 * "segunda-feira, 15 de abril" — para dashboards.
 */
export function formatWeekdayLongBR(input: DateInput): string {
  return formatDateBR(input, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

// ────────────────────────────────────────────────────────────────────────
// Horas
// ────────────────────────────────────────────────────────────────────────

/**
 * "14:30" — hora + minuto em TZ BR.
 */
export function formatTimeBR(
  input: DateInput,
  options: Intl.DateTimeFormatOptions = {}
): string {
  const d = toDate(input);
  if (!d) return "";
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    timeZone: DEFAULT_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    ...options,
  }).format(d);
}

// ────────────────────────────────────────────────────────────────────────
// Data + hora
// ────────────────────────────────────────────────────────────────────────

/**
 * "15/04/2026 14:30" — data + hora em TZ BR (equivalente a
 * toLocaleString pt-BR sem TZ, mas sempre em Sao_Paulo).
 */
export function formatDateTimeBR(
  input: DateInput,
  options: Intl.DateTimeFormatOptions = {}
): string {
  const d = toDate(input);
  if (!d) return "";
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    timeZone: DEFAULT_TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    ...options,
  }).format(d);
}

/**
 * "15/04 14:30" — compacto pra tabelas/inbox.
 */
export function formatDateTimeShortBR(input: DateInput): string {
  return formatDateTimeBR(input, {
    day: "2-digit",
    month: "2-digit",
    year: undefined,
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ────────────────────────────────────────────────────────────────────────
// Moeda (BRL) — incluído aqui pra concentrar formatação de apresentação
// ────────────────────────────────────────────────────────────────────────

/**
 * "R$ 1.797,00" — centavos → BRL. Idempotente com `Intl.NumberFormat`
 * pt-BR; o NBSP entre R$ e valor é comportamento padrão do locale.
 */
export function formatCurrencyBRL(cents: number | null | undefined): string {
  if (cents == null || Number.isNaN(cents)) return "";
  return (cents / 100).toLocaleString(DEFAULT_LOCALE, {
    style: "currency",
    currency: "BRL",
  });
}
