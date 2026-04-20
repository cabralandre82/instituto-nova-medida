/**
 * Validação e normalização de endereço do paciente (D-044 · onda 2.C).
 *
 * Código PURO — sem I/O, sem Supabase, sem fetch. Isso é o que
 * transforma entrada de formulário em shape canônico pra gravar
 * em `customers.address_*` e `fulfillments.shipping_*`, e pra
 * derivar o `shipping_snapshot` que entra no hash do aceite.
 *
 * ViaCEP: não chamamos daqui. O CheckoutForm e o OfferForm fazem
 * o fetch client-side (UX melhor — mostra "buscando CEP" enquanto
 * digita). A lib só valida o resultado final que o usuário submete.
 *
 * Regras fortes:
 *   - CEP: 8 dígitos após `\D`-strip. Só dígitos são gravados.
 *   - UF: 2 letras maiúsculas (validado contra lista de estados).
 *   - Recipient, street, district, city: >= 2 caracteres não-espaço.
 *   - Number: obrigatório (pra "sem número" use "S/N" explícito).
 *   - Complement: opcional; null quando vazio.
 */

import type { ShippingSnapshot } from "./fulfillments";

// ────────────────────────────────────────────────────────────────────────
// Tipos
// ────────────────────────────────────────────────────────────────────────

/**
 * Input bruto do formulário. Tolerante a whitespace e máscaras —
 * a validação se encarrega de normalizar antes de aprovar.
 */
export type AddressInput = {
  recipient_name?: string | null;
  zipcode: string;
  street: string;
  number: string;
  complement?: string | null;
  district: string;
  city: string;
  state: string;
};

/** Resultado OK: endereço limpo e pronto pra persistência. */
export type AddressOk = {
  ok: true;
  snapshot: ShippingSnapshot;
};

/** Resultado de erro, agregando todos os campos inválidos de uma vez. */
export type AddressFail = {
  ok: false;
  errors: Partial<Record<keyof AddressInput, string>>;
};

export type AddressValidationResult = AddressOk | AddressFail;

// ────────────────────────────────────────────────────────────────────────
// Constantes
// ────────────────────────────────────────────────────────────────────────

/**
 * UFs brasileiras válidas. Hardcoded intencional — é mais rápido
 * que fetch e a lista não muda (só se o país dividir/unir estado,
 * o que historicamente não acontece).
 */
const BR_STATES: ReadonlySet<string> = new Set([
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA",
  "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN",
  "RS", "RO", "RR", "SC", "SP", "SE", "TO",
]);

// ────────────────────────────────────────────────────────────────────────
// Normalizações
// ────────────────────────────────────────────────────────────────────────

export function normalizeZipcode(raw: string): string {
  return raw.replace(/\D/g, "");
}

export function normalizeState(raw: string): string {
  return raw.trim().toUpperCase();
}

/** Remove espaços duplos, trim, e normaliza Unicode pra NFC. */
function cleanText(raw: string): string {
  return raw.normalize("NFC").replace(/\s+/g, " ").trim();
}

// ────────────────────────────────────────────────────────────────────────
// Validação
// ────────────────────────────────────────────────────────────────────────

/**
 * Valida e normaliza um endereço de paciente.
 *
 * `recipientFallback` é o nome do paciente (de `customers.name`) —
 * usado quando `recipient_name` não for informado (caso comum:
 * paciente manda pra si mesmo).
 */
export function validateAddress(
  input: AddressInput,
  recipientFallback: string
): AddressValidationResult {
  const errors: Partial<Record<keyof AddressInput, string>> = {};

  const zipcode = normalizeZipcode(input.zipcode);
  if (zipcode.length !== 8) {
    errors.zipcode = "CEP deve ter 8 dígitos.";
  }

  const street = cleanText(input.street);
  if (street.length < 2) {
    errors.street = "Informe o nome da rua.";
  }

  const number = cleanText(input.number);
  if (number.length < 1) {
    errors.number = "Informe o número (use S/N se não houver).";
  }

  const district = cleanText(input.district);
  if (district.length < 2) {
    errors.district = "Informe o bairro.";
  }

  const city = cleanText(input.city);
  if (city.length < 2) {
    errors.city = "Informe a cidade.";
  }

  const state = normalizeState(input.state);
  if (!BR_STATES.has(state)) {
    errors.state = "UF inválida. Use a sigla com 2 letras (ex: SP).";
  }

  const recipientRaw =
    input.recipient_name && input.recipient_name.trim().length > 0
      ? input.recipient_name
      : recipientFallback;
  const recipient = cleanText(recipientRaw);
  if (recipient.length < 3) {
    errors.recipient_name = "Nome do destinatário muito curto.";
  }

  const complementRaw = input.complement ?? "";
  const complement = cleanText(complementRaw);

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    snapshot: {
      recipient_name: recipient,
      zipcode,
      street,
      number,
      complement: complement.length > 0 ? complement : null,
      district,
      city,
      state,
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// Conversões p/ persistência
// ────────────────────────────────────────────────────────────────────────

/**
 * Converte um snapshot em patch pra `public.customers` —
 * colunas `address_*` + `updated_at` via trigger.
 *
 * Não seta `address_state` se UF for inválida (redundância
 * defensiva: o validate já aprovou, mas isolamos aqui).
 */
export function snapshotToCustomerPatch(s: ShippingSnapshot): {
  address_zipcode: string;
  address_street: string;
  address_number: string;
  address_complement: string | null;
  address_district: string;
  address_city: string;
  address_state: string;
} {
  return {
    address_zipcode: s.zipcode,
    address_street: s.street,
    address_number: s.number,
    address_complement: s.complement,
    address_district: s.district,
    address_city: s.city,
    address_state: s.state,
  };
}

/**
 * Converte um snapshot em patch pra `public.fulfillments` —
 * colunas `shipping_*`.
 *
 * Útil em 2 momentos:
 *   1. No aceite, gravamos o snapshot no fulfillment (clínica usa
 *      pra gerar etiqueta depois).
 *   2. No painel admin, se operador editar tracking_note, NÃO
 *      mexemos nesses campos (eles são imutáveis na prática).
 */
export function snapshotToFulfillmentPatch(s: ShippingSnapshot): {
  shipping_recipient_name: string;
  shipping_zipcode: string;
  shipping_street: string;
  shipping_number: string;
  shipping_complement: string | null;
  shipping_district: string;
  shipping_city: string;
  shipping_state: string;
} {
  return {
    shipping_recipient_name: s.recipient_name,
    shipping_zipcode: s.zipcode,
    shipping_street: s.street,
    shipping_number: s.number,
    shipping_complement: s.complement,
    shipping_district: s.district,
    shipping_city: s.city,
    shipping_state: s.state,
  };
}

/**
 * Lê as colunas `address_*` do customer e converte num
 * `AddressInput` pra pré-preencher o formulário de aceite.
 *
 * Se qualquer campo obrigatório estiver null, devolve null
 * (a tela mostra o form vazio pra o paciente preencher do zero).
 */
export function customerToAddressInput(c: {
  name: string;
  address_zipcode: string | null;
  address_street: string | null;
  address_number: string | null;
  address_complement: string | null;
  address_district: string | null;
  address_city: string | null;
  address_state: string | null;
}): AddressInput | null {
  if (
    !c.address_zipcode ||
    !c.address_street ||
    !c.address_number ||
    !c.address_district ||
    !c.address_city ||
    !c.address_state
  ) {
    return null;
  }
  return {
    recipient_name: c.name,
    zipcode: c.address_zipcode,
    street: c.address_street,
    number: c.address_number,
    complement: c.address_complement,
    district: c.address_district,
    city: c.address_city,
    state: c.address_state,
  };
}
