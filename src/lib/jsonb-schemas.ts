/**
 * src/lib/jsonb-schemas.ts — PR-061 · D-071 · finding 10.4
 *
 * Validadores estruturais pra colunas `jsonb` app-geradas. Serve pra
 * pegar bugs silenciosos onde o app serializa um `Record<string, unknown>`
 * com algo que **não deveria** virar JSON (Date, Error, função, NaN,
 * circular ref etc.) — o Postgres aceita quase tudo via `jsonb`, mas
 * o resultado fica irrecuperável na leitura.
 *
 * Filosofia.
 * ----------
 *   1. **Zero dependências externas.** Mesmo padrão de
 *      `text-sanitize.ts`, `admin-list-filters.ts`, `customer-pii-guard.ts`.
 *      Ninguém quer puxar Zod só pra isso.
 *   2. **Retorno discriminado**: `{ ok: true; value: T }` ou
 *      `{ ok: false; issues: string[] }`. Caller decide se aborta ou
 *      cai pro fallback.
 *   3. **Dois níveis de rigor**:
 *      - `validateSafeJsonbObject` — genérico, aplicável a payloads
 *        livres (cron_runs.payload, admin_audit_log.metadata,
 *        patient_access_log.metadata). Garante que o valor é JSON-
 *        serializável, sem tipos proibidos e dentro de limites.
 *      - Schemas específicos (`validateShippingSnapshot` e outros)
 *        — usados em contratos rígidos (plan_acceptances.shipping_snapshot,
 *        fulfillment_address_changes.{before,after}_snapshot).
 *   4. **Fail-soft em payloads livres, fail-hard em contratos rígidos.**
 *      A decisão fica com o call-site (e é documentada no D-071).
 *
 * Não-objetivos.
 * --------------
 *   - Não valida webhooks externos (asaas_events.payload, daily_events
 *     .payload, whatsapp_events.payload). Esses são espelhos do provider
 *     — o schema pode mudar sem aviso e o log precisa guardar o bruto.
 *   - Não valida `products.features`, `appointments.anamnese` ou
 *     `*.asaas_raw` (mesma razão — flexibilidade legítima).
 *   - Não tenta redigir PII (já coberto por `prompt-redact.ts` e pela
 *     retenção em `asaas-events-retention.ts`).
 */

// ────────────────────────────────────────────────────────────────────────
// Tipos públicos
// ────────────────────────────────────────────────────────────────────────

export type ValidationOk<T> = { ok: true; value: T };
export type ValidationErr = { ok: false; issues: string[] };
export type Validation<T> = ValidationOk<T> | ValidationErr;

export type JsonbPrimitive = string | number | boolean | null;
export type JsonbValue = JsonbPrimitive | JsonbObject | JsonbArray;
export type JsonbObject = { [k: string]: JsonbValue };
export type JsonbArray = JsonbValue[];

export type SafeJsonbOptions = {
  /**
   * Profundidade máxima de aninhamento. Default 6 — cobre qualquer
   * payload legítimo do app (cron_runs chegam até 3, metadata de
   * audit até 4). Profundidade maior que isso quase sempre é bug
   * (ex.: serializar a entity toda recursivamente).
   */
  maxDepth?: number;
  /**
   * Tamanho máximo estimado da string JSON (chars). Default 16 KiB.
   * Protege contra dump acidental de payload gigante em colunas que
   * deveriam guardar resumo (`cron_runs.payload`).
   */
  maxSerializedChars?: number;
  /**
   * Tamanho máximo de uma string primitiva individual. Default 4 KiB.
   * Captura casos como "operador colou stack trace de 200 KB em
   * metadata.reason".
   */
  maxStringLength?: number;
  /**
   * Chaves NÃO permitidas. Default bloqueia __proto__/constructor/
   * prototype (prototype pollution residual — mesmo com jsonb sendo
   * armazenamento, não queremos o objeto chegar "envenenado" à
   * aplicação na re-leitura).
   */
  forbiddenKeys?: readonly string[];
};

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_SERIALIZED = 16 * 1024;
const DEFAULT_MAX_STRING = 4 * 1024;
const DEFAULT_FORBIDDEN_KEYS: readonly string[] = [
  "__proto__",
  "constructor",
  "prototype",
];

// ────────────────────────────────────────────────────────────────────────
// 1) Validador genérico (safe JSON)
// ────────────────────────────────────────────────────────────────────────

/**
 * Valida que `value` é JSON-serializável, dentro dos limites configurados,
 * e retorna uma cópia "limpa" (sem referências ao input original — o
 * caller pode persistir sem risco).
 *
 * Rejeita explicitamente:
 *   - `undefined`, `NaN`, `Infinity` / `-Infinity` (não têm representação
 *     em JSON; viram `null` ou `"Infinity"` dependendo do path).
 *   - Funções, símbolos, Promises, Date, Error, Buffer (chegam com
 *     `typeof === 'object'` mas não-literal — `JSON.stringify` vira
 *     `{}` ou serializa só partes).
 *   - Referências circulares (detectadas via WeakSet).
 *   - Strings maiores que `maxStringLength` chars.
 *   - Chaves listadas em `forbiddenKeys`.
 *   - Profundidade > `maxDepth`.
 *
 * A serialização final é verificada contra `maxSerializedChars`.
 */
export function validateSafeJsonbValue(
  value: unknown,
  opts: SafeJsonbOptions = {}
): Validation<JsonbValue> {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxSerialized = opts.maxSerializedChars ?? DEFAULT_MAX_SERIALIZED;
  const maxString = opts.maxStringLength ?? DEFAULT_MAX_STRING;
  const forbiddenKeys = new Set<string>(
    opts.forbiddenKeys ?? DEFAULT_FORBIDDEN_KEYS
  );

  const issues: string[] = [];
  const seen = new WeakSet<object>();

  function visit(v: unknown, path: string, depth: number): JsonbValue | undefined {
    if (depth > maxDepth) {
      issues.push(`${path}: profundidade excede ${maxDepth}`);
      return undefined;
    }
    if (v === null) return null;
    if (v === undefined) {
      issues.push(`${path}: undefined não é JSON`);
      return undefined;
    }
    if (typeof v === "string") {
      if (v.length > maxString) {
        issues.push(
          `${path}: string com ${v.length} chars (máx ${maxString})`
        );
        return undefined;
      }
      return v;
    }
    if (typeof v === "number") {
      if (!Number.isFinite(v)) {
        issues.push(`${path}: número não-finito (${String(v)})`);
        return undefined;
      }
      return v;
    }
    if (typeof v === "boolean") return v;
    if (typeof v === "bigint") {
      issues.push(`${path}: bigint não é JSON`);
      return undefined;
    }
    if (typeof v === "symbol" || typeof v === "function") {
      issues.push(`${path}: ${typeof v} não é JSON`);
      return undefined;
    }
    if (typeof v !== "object") {
      issues.push(`${path}: tipo não suportado (${typeof v})`);
      return undefined;
    }

    // object / array
    if (seen.has(v as object)) {
      issues.push(`${path}: referência circular`);
      return undefined;
    }
    seen.add(v as object);

    // Rejeita tipos específicos que viram `object` mas não são literais.
    // Observe: Array e plain object passam; Date/Error/Map/Set/Buffer
    // / Promise / RegExp / TypedArray são filtrados aqui.
    if (Array.isArray(v)) {
      const out: JsonbValue[] = [];
      for (let i = 0; i < v.length; i += 1) {
        const child = visit((v as unknown[])[i], `${path}[${i}]`, depth + 1);
        if (child === undefined) return undefined;
        out.push(child);
      }
      return out;
    }

    // Filtra instâncias não-literais.
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      const ctor = (v as { constructor?: { name?: string } }).constructor?.name;
      issues.push(
        `${path}: objeto não-literal (${ctor ?? "unknown"}) — use plain object`
      );
      return undefined;
    }

    const out: JsonbObject = {};
    for (const [k, raw] of Object.entries(v as object)) {
      if (forbiddenKeys.has(k)) {
        issues.push(`${path}: chave proibida "${k}"`);
        return undefined;
      }
      const child = visit(raw, path ? `${path}.${k}` : k, depth + 1);
      if (child === undefined) return undefined;
      out[k] = child;
    }
    return out;
  }

  const cleaned = visit(value, "", 0);
  if (cleaned === undefined || issues.length > 0) {
    return { ok: false, issues };
  }

  // Pós-check de tamanho serializado.
  let serialized: string;
  try {
    serialized = JSON.stringify(cleaned);
  } catch (err) {
    return {
      ok: false,
      issues: [
        `falha ao serializar JSON: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
  if (serialized.length > maxSerialized) {
    return {
      ok: false,
      issues: [
        `payload serializado com ${serialized.length} chars (máx ${maxSerialized})`,
      ],
    };
  }

  return { ok: true, value: cleaned };
}

/**
 * Atalho: garante que `value` é um OBJETO literal (não array, não primitivo),
 * e safe. Usado pela maior parte das colunas `metadata`/`payload` jsonb.
 */
export function validateSafeJsonbObject(
  value: unknown,
  opts: SafeJsonbOptions = {}
): Validation<JsonbObject> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, issues: ["esperava objeto literal"] };
  }
  const res = validateSafeJsonbValue(value, opts);
  if (!res.ok) return res;
  if (typeof res.value !== "object" || res.value === null || Array.isArray(res.value)) {
    return { ok: false, issues: ["valor validado não é objeto literal"] };
  }
  return { ok: true, value: res.value as JsonbObject };
}

// ────────────────────────────────────────────────────────────────────────
// 2) Schemas específicos de contrato
// ────────────────────────────────────────────────────────────────────────

/**
 * `plan_acceptances.shipping_snapshot` e eco em
 * `fulfillment_address_changes.after_snapshot` (quando o paciente aceita
 * o plano e confirma o endereço de entrega).
 *
 * Contrato idêntico ao `ShippingSnapshot` de `fulfillments.ts`:
 *   - recipient_name: string não-vazia (≤ 120 chars)
 *   - zipcode: 8 dígitos (CEP numérico)
 *   - street: string não-vazia (≤ 200 chars)
 *   - number: string não-vazia (≤ 30 chars)   — aceita "s/n", "100A" etc.
 *   - complement: string (≤ 120 chars) ou null
 *   - district: string não-vazia (≤ 120 chars)
 *   - city: string não-vazia (≤ 120 chars)
 *   - state: 2 letras maiúsculas (UF brasileira)
 */
export type ShippingSnapshotSchema = {
  recipient_name: string;
  zipcode: string;
  street: string;
  number: string;
  complement: string | null;
  district: string;
  city: string;
  state: string;
};

const UF_REGEX = /^[A-Z]{2}$/;
const ZIPCODE_REGEX = /^\d{8}$/;

function isNonEmptyString(v: unknown, max: number): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max;
}

export function validateShippingSnapshot(
  value: unknown
): Validation<ShippingSnapshotSchema> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, issues: ["shipping_snapshot: esperava objeto literal"] };
  }
  const o = value as Record<string, unknown>;
  const issues: string[] = [];

  if (!isNonEmptyString(o.recipient_name, 120)) {
    issues.push("recipient_name: string não-vazia até 120 chars");
  }
  if (typeof o.zipcode !== "string" || !ZIPCODE_REGEX.test(o.zipcode)) {
    issues.push("zipcode: 8 dígitos numéricos");
  }
  if (!isNonEmptyString(o.street, 200)) {
    issues.push("street: string não-vazia até 200 chars");
  }
  if (!isNonEmptyString(o.number, 30)) {
    issues.push("number: string não-vazia até 30 chars");
  }
  if (
    o.complement !== null &&
    !(typeof o.complement === "string" && o.complement.length <= 120)
  ) {
    issues.push("complement: string até 120 chars ou null");
  }
  if (!isNonEmptyString(o.district, 120)) {
    issues.push("district: string não-vazia até 120 chars");
  }
  if (!isNonEmptyString(o.city, 120)) {
    issues.push("city: string não-vazia até 120 chars");
  }
  if (typeof o.state !== "string" || !UF_REGEX.test(o.state)) {
    issues.push("state: UF brasileira (2 letras maiúsculas)");
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    value: {
      recipient_name: (o.recipient_name as string).trim(),
      zipcode: o.zipcode as string,
      street: (o.street as string).trim(),
      number: (o.number as string).trim(),
      complement:
        o.complement === null ? null : ((o.complement as string).trim() || null),
      district: (o.district as string).trim(),
      city: (o.city as string).trim(),
      state: o.state as string,
    },
  };
}

/**
 * `fulfillment_address_changes.before_snapshot` e `after_snapshot` usam
 * a versão "colunas do fulfillment" (`shipping_*` como prefixo, com
 * todos os campos opcionalmente null — antes pode não haver endereço
 * prévio).
 */
export type AddressChangeSnapshot = {
  shipping_recipient_name: string | null;
  shipping_zipcode: string | null;
  shipping_street: string | null;
  shipping_number: string | null;
  shipping_complement: string | null;
  shipping_district: string | null;
  shipping_city: string | null;
  shipping_state: string | null;
};

const ADDRESS_CHANGE_KEYS: readonly (keyof AddressChangeSnapshot)[] = [
  "shipping_recipient_name",
  "shipping_zipcode",
  "shipping_street",
  "shipping_number",
  "shipping_complement",
  "shipping_district",
  "shipping_city",
  "shipping_state",
];

export function validateAddressChangeSnapshot(
  value: unknown,
  opts: { allowNullSnapshot?: boolean } = {}
): Validation<AddressChangeSnapshot | null> {
  if (value === null) {
    if (opts.allowNullSnapshot !== false) {
      return { ok: true, value: null };
    }
    return { ok: false, issues: ["snapshot nulo não permitido neste campo"] };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, issues: ["snapshot: esperava objeto literal"] };
  }

  const o = value as Record<string, unknown>;
  const issues: string[] = [];

  // Exige APENAS as chaves conhecidas — extras são ignoradas silencio-
  // samente (tolerância p/ evolução de schema), mas os tipos são rígidos.
  const out = {} as AddressChangeSnapshot;
  for (const k of ADDRESS_CHANGE_KEYS) {
    const raw = o[k];
    if (raw === null || raw === undefined) {
      out[k] = null;
      continue;
    }
    if (typeof raw !== "string") {
      issues.push(`${k}: string ou null`);
      continue;
    }
    if (raw.length > 200) {
      issues.push(`${k}: string até 200 chars`);
      continue;
    }
    out[k] = raw;
  }

  // Consistência leve: se tem zipcode, precisa bater o formato.
  if (out.shipping_zipcode && !ZIPCODE_REGEX.test(out.shipping_zipcode)) {
    issues.push("shipping_zipcode: 8 dígitos numéricos");
  }
  if (out.shipping_state && !UF_REGEX.test(out.shipping_state)) {
    issues.push("shipping_state: UF brasileira (2 letras maiúsculas)");
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: out };
}
