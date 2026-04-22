/**
 * src/lib/meus-dados-update.ts — PR-056 · D-067
 *
 * Lib PURA (sem I/O, sem Supabase, sem fetch) que sustenta o endpoint
 * POST /api/paciente/meus-dados/atualizar. Extraída pra permitir
 * testes unitários determinísticos da validação e do diff sem subir
 * mock do Supabase.
 *
 * Exports:
 *   - `parseAndValidateUpdate(raw)` — normaliza + valida o payload
 *     `{ name, email, phone, address }`, agregando erros de campo.
 *   - `computeChangedFields(existing, next)` — diff normalizado que
 *     gera a lista de campos alterados pra audit log (sem PII).
 *
 * Regras herdadas:
 *   - Nome via `sanitizeShortText(TEXT_PATTERNS.personName)` (PR-037).
 *   - Endereço via `validateAddress` (PR-035 · D-053).
 *   - Email: regex liberal (`/^[^@\s]+@[^@\s]+\.[^@\s]+$/`) + lower + trim +
 *     máximo 254 (RFC 5321).
 *   - Phone: só dígitos, 10–13 (DDD + número; tolera +55 prefixado).
 */

import { sanitizeShortText, TEXT_PATTERNS } from "./text-sanitize";
import { validateAddress, type AddressInput } from "./patient-address";

// ────────────────────────────────────────────────────────────────────────
// Tipos públicos
// ────────────────────────────────────────────────────────────────────────

export type UpdateRawBody = {
  name?: string;
  email?: string;
  phone?: string;
  address?: AddressInput;
};

export type UpdateFieldErrors = Partial<
  Record<
    | "name"
    | "email"
    | "phone"
    | "zipcode"
    | "street"
    | "number"
    | "complement"
    | "district"
    | "city"
    | "state",
    string
  >
>;

export type ParsedUpdateInput = {
  name: string;
  email: string;
  phone: string;
  address: {
    zipcode: string;
    street: string;
    number: string;
    complement: string | null;
    district: string;
    city: string;
    state: string;
  };
};

export type ParseResult =
  | { ok: true; input: ParsedUpdateInput }
  | {
      ok: false;
      error: "body_invalid" | "validation_failed";
      fieldErrors?: UpdateFieldErrors;
    };

export type CustomerSnapshot = {
  name: string | null;
  email: string | null;
  phone: string | null;
  address_zipcode: string | null;
  address_street: string | null;
  address_number: string | null;
  address_complement: string | null;
  address_district: string | null;
  address_city: string | null;
  address_state: string | null;
};

// ────────────────────────────────────────────────────────────────────────
// Validação
// ────────────────────────────────────────────────────────────────────────

export function parseAndValidateUpdate(raw: unknown): ParseResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "body_invalid" };
  }
  const b = raw as UpdateRawBody;
  const fieldErrors: UpdateFieldErrors = {};

  const nameSan =
    typeof b.name === "string"
      ? sanitizeShortText(b.name, {
          maxLen: 120,
          minLen: 3,
          pattern: TEXT_PATTERNS.personName,
        })
      : ({ ok: false as const, reason: "empty" as const });
  if (!nameSan.ok) {
    // `sanitizeShortText` devolve `empty` pra tamanho < minLen (comporta-
    // mento documentado em text-sanitize.ts). Traduzimos pra "mínimo 3".
    fieldErrors.name =
      nameSan.reason === "empty"
        ? "Informe o nome completo (mínimo 3 caracteres)."
        : nameSan.reason === "too_long"
          ? "Nome muito longo (máx. 120 caracteres)."
          : "Nome inválido — use apenas letras, espaço, hífen e apóstrofo.";
  }

  const email =
    typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
  if (!email) {
    fieldErrors.email = "Informe o e-mail.";
  } else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    fieldErrors.email = "E-mail inválido.";
  } else if (email.length > 254) {
    fieldErrors.email = "E-mail muito longo.";
  }

  const phoneDigits =
    typeof b.phone === "string" ? b.phone.replace(/\D/g, "") : "";
  if (phoneDigits.length < 10 || phoneDigits.length > 13) {
    fieldErrors.phone =
      "Telefone inválido — inclua DDD (ex: 11999990000).";
  }

  // `validateAddress` exige um fallback pro `recipient_name`. Aqui não
  // editamos destinatário (esse campo é do fulfillment, não do
  // customer) — passamos o nome sanitizado quando houver, senão um
  // placeholder ASCII que sempre passa o charset check. Qualquer
  // `errors.recipient_name` que porventura escape é descartado abaixo.
  const recipientFallback = nameSan.ok ? nameSan.value : "Paciente";
  const addrResult = validateAddress(
    b.address ?? ({} as AddressInput),
    recipientFallback
  );
  if (!addrResult.ok) {
    for (const [k, v] of Object.entries(addrResult.errors)) {
      if (k === "recipient_name") continue;
      (fieldErrors as Record<string, string>)[k] = v;
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, error: "validation_failed", fieldErrors };
  }

  if (!nameSan.ok || !addrResult.ok) {
    // Defensivo — inalcançável quando fieldErrors está vazio.
    return { ok: false, error: "validation_failed", fieldErrors };
  }

  return {
    ok: true,
    input: {
      name: nameSan.value,
      email,
      phone: phoneDigits,
      address: {
        zipcode: addrResult.snapshot.zipcode,
        street: addrResult.snapshot.street,
        number: addrResult.snapshot.number,
        complement: addrResult.snapshot.complement,
        district: addrResult.snapshot.district,
        city: addrResult.snapshot.city,
        state: addrResult.snapshot.state,
      },
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// Diff normalizado pra audit (só nomes de campo, sem PII)
// ────────────────────────────────────────────────────────────────────────

export function computeChangedFields(
  existing: CustomerSnapshot,
  next: ParsedUpdateInput
): string[] {
  const changes: string[] = [];
  const norm = (v: string | null | undefined) => (v ?? "").trim();
  const lower = (v: string | null | undefined) => norm(v).toLowerCase();
  const digits = (v: string | null | undefined) =>
    (v ?? "").replace(/\D/g, "");

  if (norm(existing.name) !== norm(next.name)) changes.push("name");
  if (lower(existing.email) !== lower(next.email)) changes.push("email");
  if (digits(existing.phone) !== digits(next.phone)) changes.push("phone");
  if (digits(existing.address_zipcode) !== digits(next.address.zipcode))
    changes.push("address_zipcode");
  if (norm(existing.address_street) !== norm(next.address.street))
    changes.push("address_street");
  if (norm(existing.address_number) !== norm(next.address.number))
    changes.push("address_number");
  const existingComplement = (existing.address_complement ?? "").trim();
  const incomingComplement = (next.address.complement ?? "").trim();
  if (existingComplement !== incomingComplement)
    changes.push("address_complement");
  if (norm(existing.address_district) !== norm(next.address.district))
    changes.push("address_district");
  if (norm(existing.address_city) !== norm(next.address.city))
    changes.push("address_city");
  if (
    (existing.address_state ?? "").toUpperCase() !==
    next.address.state.toUpperCase()
  )
    changes.push("address_state");

  return changes.sort();
}
