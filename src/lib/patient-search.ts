/**
 * src/lib/patient-search.ts — D-045 · 3.B
 *
 * Busca global de pacientes pro admin. O operador digita qualquer coisa
 * no topo do painel — nome, email, telefone (com ou sem máscara), CPF
 * (com ou sem formatação) — e a lib decide a melhor estratégia:
 *
 *   1. Se bate 11 dígitos → CPF. Busca exata por `cpf`. **Nota**: 11
 *      dígitos também seriam um celular BR (DDD+9+8). Priorizamos CPF
 *      porque é chave única e a busca exata é determinística. Pra
 *      buscar celular com 11 dígitos, o operador pode deixar a máscara
 *      `(11) 99999-1234` ou prefixar DDI `55`.
 *   2. Se tem @ → email. ilike '%q%'.
 *   3. Se >= 7 dígitos (normalizado) → telefone. ilike no phone
 *      normalizado.
 *   4. Caso contrário → nome. ilike '%q%'.
 *
 * Retorna até `limit` resultados com shape enxuto pra autocomplete.
 *
 * Design:
 *   - Lib pura: aceita `SupabaseClient` por injeção (fácil testar
 *     com mock).
 *   - Não usa RLS — service role; o gating acontece no endpoint
 *     (requireAdmin).
 *   - Normalização de input (trim + lowercase email / só dígitos
 *     telefone e CPF) é parte da API pública — funções `normalizeX`
 *     exportadas pra reaproveitar em testes e UI.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type SearchStrategy = "cpf" | "email" | "phone" | "name" | "empty";

export type PatientSearchHit = {
  id: string;
  name: string;
  email: string;
  phone: string;
  cpf: string;
  createdAt: string;
};

// ────────────────────────────────────────────────────────────────────────
// Classificação do input
// ────────────────────────────────────────────────────────────────────────

export function normalizeQuery(q: string | null | undefined): string {
  if (!q) return "";
  return q.trim();
}

export function digitsOnly(s: string): string {
  return s.replace(/\D+/g, "");
}

/**
 * Decide a estratégia de busca com base no input normalizado.
 * Ordem das regras importa.
 *
 * Detecção de CPF canônico: ou 11 dígitos puros, ou máscara exata
 * `123.456.789-00`. Se o input tem outros separadores (parênteses,
 * espaços) o operador tá digitando telefone, não CPF, mesmo que os
 * dígitos bata em 11.
 */
const CPF_MASKED_RE = /^\d{3}\.\d{3}\.\d{3}-\d{2}$/;
const CPF_BARE_RE = /^\d{11}$/;
const PHONE_MASKED_HINT_RE = /[()\s]/;

export function classifyQuery(raw: string | null | undefined): SearchStrategy {
  const q = normalizeQuery(raw);
  if (q.length === 0) return "empty";
  // Email: tem @
  if (q.includes("@")) return "email";
  // CPF: 11 dígitos puros OU máscara canônica
  if (CPF_BARE_RE.test(q) || CPF_MASKED_RE.test(q)) return "cpf";
  // Telefone: 7+ dígitos, e quer com máscara (parênteses/espaços),
  // quer como string numérica com mais/menos de 11 dígitos (DDI 55xx, só 8 dígitos).
  const digits = digitsOnly(q);
  const hasMaskHint = PHONE_MASKED_HINT_RE.test(q);
  // Com hint de máscara (parêntese/espaço): 4+ dígitos já bastam.
  // Sem hint: 7+ dígitos pra evitar colisão com nomes tipo "Ana 10".
  const minDigits = hasMaskHint ? 4 : 7;
  if (digits.length >= minDigits && digits.length / q.length >= 0.4) {
    return "phone";
  }
  return "name";
}

// ────────────────────────────────────────────────────────────────────────
// Execução da busca
// ────────────────────────────────────────────────────────────────────────

export type SearchOptions = {
  limit?: number;
};

/**
 * Executa a busca e retorna hits. Input vazio retorna `[]` imediatamente
 * (não chama o supabase). Limit padrão = 10, clamped em [1, 50].
 */
export async function searchCustomers(
  supabase: SupabaseClient,
  rawQuery: string | null | undefined,
  opts: SearchOptions = {}
): Promise<PatientSearchHit[]> {
  const strategy = classifyQuery(rawQuery);
  if (strategy === "empty") return [];

  const q = normalizeQuery(rawQuery);
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);

  let builder = supabase
    .from("customers")
    .select("id, name, email, phone, cpf, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  switch (strategy) {
    case "cpf": {
      // CPF tem unique constraint — busca exata com dígitos normalizados.
      // Armazenado com formatação? Depende de quem criou. `customers.cpf`
      // tem check que garante 11 dígitos após strip. Fazemos OR de ambas
      // representações pra cobrir legacy.
      const digits = digitsOnly(q);
      builder = builder.or(`cpf.eq.${digits},cpf.eq.${q}`);
      break;
    }
    case "email": {
      builder = builder.ilike("email", `%${escapeIlike(q)}%`);
      break;
    }
    case "phone": {
      // O campo `phone` em customers é texto livre (com ou sem máscara).
      // Pra robustez fazemos ilike com a substring dos dígitos — Postgres
      // não pula caracteres automaticamente. Solução prática: OR com
      // raw e com digits. Se o operador digitou "(21) 9", vira digits
      // "219" e busca phone ilike "%219%" — cobre "5521999991234".
      const digits = digitsOnly(q);
      // Escapa `,` porque o or() do PostgREST usa vírgula como separador.
      const raw = escapeOrValue(q);
      const parts = [`phone.ilike.%${raw}%`];
      if (digits.length >= 4 && digits !== q) {
        parts.push(`phone.ilike.%${digits}%`);
      }
      builder = builder.or(parts.join(","));
      break;
    }
    case "name": {
      builder = builder.ilike("name", `%${escapeIlike(q)}%`);
      break;
    }
  }

  const res = (await builder) as {
    data: Array<{
      id: string;
      name: string;
      email: string;
      phone: string;
      cpf: string;
      created_at: string;
    }> | null;
    error: { message: string } | null;
  };

  if (res.error) {
    throw new Error(`patient-search failed: ${res.error.message}`);
  }

  return (res.data ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    cpf: r.cpf,
    createdAt: r.created_at,
  }));
}

// ────────────────────────────────────────────────────────────────────────
// Helpers de escape
// ────────────────────────────────────────────────────────────────────────

/** Escapa `%` e `_` pra uso em `ilike`. */
export function escapeIlike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Escapa caracteres reservados do `.or()` do PostgREST (vírgula, parênteses
 * não balanceados). Também fazemos trim de aspas pra evitar injection.
 */
export function escapeOrValue(s: string): string {
  return s.replace(/[,()]/g, " ").replace(/"/g, "");
}
