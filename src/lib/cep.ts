/**
 * src/lib/cep.ts — PR-035 · D-053
 *
 * Camada server-side pra consulta de CEP via ViaCEP.
 *
 * Por que existe:
 *   audit [22.1 · ALTO]: até agora o `fetch("https://viacep.com.br/...")`
 *   rodava no **browser** e o resultado era colado direto em
 *   `fulfillments.shipping_*` sem sanitização. DNS rebinding, proxy
 *   hostil em Wi-Fi público ou extensão maliciosa conseguem substituir
 *   `logradouro: "Rua " + <5KB de prompt injection>`. Quando um agente
 *   LLM (9.1) olhar a inbox admin, o payload vai vazar instruções
 *   arbitrárias pra dentro do contexto.
 *
 * Correção:
 *   - Toda consulta CEP agora passa por este módulo no servidor.
 *   - Schema estrito (length + charset allowlist) valida a resposta
 *     antes dela chegar no DB ou no UI.
 *   - Timeout baixo (2,5s) + AbortController pra não segurar a route.
 *   - Payload de erro é text explícito, nunca passa dados do ViaCEP
 *     crus pro client.
 *
 * Este módulo é PURO I/O: não grava em DB, não lê env sensível, não
 * depende de headers. O endpoint `/api/cep/[cep]` é quem adiciona
 * rate-limit e contexto HTTP.
 */

const VIACEP_BASE = "https://viacep.com.br/ws";
const DEFAULT_TIMEOUT_MS = 2500;

/** Limites conservadores. Nenhum endereço real legítimo excede esses. */
const LIMITS = {
  street: 200,
  district: 100,
  city: 100,
  state: 2,
} as const;

/**
 * Charsets permitidos por campo. Usamos espaço LITERAL (U+0020) em vez
 * de `\s` porque `\s` casa com `\n`, `\r`, `\t` e outros whitespace —
 * e newline é vetor clássico de prompt injection ("Rua X\nIGNORE
 * PREVIOUS INSTRUCTIONS"). Endereço legítimo não precisa de quebra.
 *
 * - `street` / `district`: letras (acentos incl.), dígitos, pontuação
 *   comum de logradouros brasileiros. Bloqueia `<`, `>`, `{`, `}`,
 *   `\`, `|`, `&`, `$`, `;`, `"`, `` ` `` — sinais de template/shell/
 *   prompt injection.
 * - `city`: só letras + espaço + hífen + apóstrofo + ponto. "D'Ávila",
 *   "São João del-Rei" passam. Dígitos não passam.
 * - `state`: 2 letras maiúsculas A-Z.
 *
 * `\p{L}` / `\p{N}` são Unicode property escapes (Node 18+ nativo).
 */
const PATTERN_STREET = /^[\p{L}\p{N} .,'()\-/ºª°]+$/u;
const PATTERN_DISTRICT = /^[\p{L}\p{N} .,'()\-]+$/u;
const PATTERN_CITY = /^[\p{L} .'\-]+$/u;
const PATTERN_STATE = /^[A-Z]{2}$/;

export type CepLookupOk = {
  ok: true;
  cep: string;            // sempre 8 dígitos, sem máscara
  street: string;
  district: string;
  city: string;
  state: string;
};

export type CepLookupError = {
  ok: false;
  code:
    | "invalid_cep"
    | "not_found"
    | "network_error"
    | "timeout"
    | "invalid_response";
  message: string;
};

export type CepLookupResult = CepLookupOk | CepLookupError;

/** Remove tudo que não for dígito; útil pra máscara "00000-000". */
export function normalizeCep(raw: string): string {
  return (raw ?? "").replace(/\D/g, "");
}

/** Valida que o CEP tem formato sintático correto (8 dígitos). */
export function isSyntaxValidCep(raw: string): boolean {
  return /^\d{8}$/.test(normalizeCep(raw));
}

/**
 * Fetch ViaCEP no servidor com timeout + schema. Nunca lança exceção:
 * todos os erros viram `CepLookupError` tipado.
 */
export async function fetchViaCep(
  raw: string,
  opts: {
    timeoutMs?: number;
    /** Injetável pra testes unitários. Default: `globalThis.fetch`. */
    fetchImpl?: typeof fetch;
  } = {}
): Promise<CepLookupResult> {
  const cep = normalizeCep(raw);
  if (!isSyntaxValidCep(cep)) {
    return {
      ok: false,
      code: "invalid_cep",
      message: "CEP precisa ter exatamente 8 dígitos.",
    };
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchImpl(`${VIACEP_BASE}/${cep}/json/`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    const name = (err as Error)?.name ?? "";
    if (name === "AbortError") {
      return {
        ok: false,
        code: "timeout",
        message: "ViaCEP demorou mais que o esperado.",
      };
    }
    return {
      ok: false,
      code: "network_error",
      message: "Falha ao consultar o serviço de CEP.",
    };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    return {
      ok: false,
      code: "network_error",
      message: `ViaCEP respondeu ${res.status}.`,
    };
  }

  let raw_body: unknown;
  try {
    raw_body = await res.json();
  } catch {
    return {
      ok: false,
      code: "invalid_response",
      message: "ViaCEP retornou payload inválido.",
    };
  }

  return parseViaCepResponse(cep, raw_body);
}

/**
 * Schema manual pro payload do ViaCEP. Preferido a trazer `zod`
 * (dep nova, overkill pra 4 strings).
 *
 * Payload esperado:
 *   { cep, logradouro, complemento, bairro, localidade, uf, ... }
 *   — ou —
 *   { erro: true | "true" }
 *
 * Campos extras (ibge, gia, ddd etc.) são ignorados silenciosamente.
 */
export function parseViaCepResponse(
  cep: string,
  raw: unknown
): CepLookupResult {
  if (!raw || typeof raw !== "object") {
    return {
      ok: false,
      code: "invalid_response",
      message: "Payload não é objeto.",
    };
  }
  const obj = raw as Record<string, unknown>;

  // Erro explícito do ViaCEP ("erro: true" pra CEP não existente).
  // Nota: às vezes vem como string "true" em respostas velhas.
  if (obj.erro === true || obj.erro === "true") {
    return {
      ok: false,
      code: "not_found",
      message: "CEP não encontrado.",
    };
  }

  const logradouro = asString(obj.logradouro);
  const bairro = asString(obj.bairro);
  const localidade = asString(obj.localidade);
  const uf = asString(obj.uf);

  // ViaCEP devolve campos vazios pra CEPs genéricos (ex.: CEP de cidade
  // pequena, só UF + cidade sem logradouro). Aceitamos street/district
  // vazios — o paciente preenche manualmente.
  if (!localidade || !uf) {
    return {
      ok: false,
      code: "invalid_response",
      message: "ViaCEP não retornou cidade/UF.",
    };
  }

  // Sanitização de tamanho.
  if (
    logradouro.length > LIMITS.street ||
    bairro.length > LIMITS.district ||
    localidade.length > LIMITS.city
  ) {
    return {
      ok: false,
      code: "invalid_response",
      message: "Campos excedem tamanho máximo.",
    };
  }
  if (uf.length !== LIMITS.state) {
    return {
      ok: false,
      code: "invalid_response",
      message: "UF fora do formato esperado.",
    };
  }

  // Charset allowlist. Nunca deixa `<`, `>`, `{`, `}`, `\n`, `\r` passar.
  if (logradouro && !PATTERN_STREET.test(logradouro)) {
    return {
      ok: false,
      code: "invalid_response",
      message: "Logradouro contém caracteres não permitidos.",
    };
  }
  if (bairro && !PATTERN_DISTRICT.test(bairro)) {
    return {
      ok: false,
      code: "invalid_response",
      message: "Bairro contém caracteres não permitidos.",
    };
  }
  if (!PATTERN_CITY.test(localidade)) {
    return {
      ok: false,
      code: "invalid_response",
      message: "Cidade contém caracteres não permitidos.",
    };
  }
  const ufUpper = uf.toUpperCase();
  if (!PATTERN_STATE.test(ufUpper)) {
    return {
      ok: false,
      code: "invalid_response",
      message: "UF deve ter 2 letras maiúsculas.",
    };
  }

  return {
    ok: true,
    cep,
    street: logradouro,
    district: bairro,
    city: localidade,
    state: ufUpper,
  };
}

function asString(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.normalize("NFC").trim();
}

/**
 * Expostas pra permitir que `patient-address.ts` compartilhe o mesmo
 * charset e limites — evita divergência entre quem sanitiza o CEP
 * retornado pelo ViaCEP e quem valida o endereço final submetido.
 */
export const CEP_CHARSET_PATTERNS = {
  street: PATTERN_STREET,
  district: PATTERN_DISTRICT,
  city: PATTERN_CITY,
  state: PATTERN_STATE,
} as const;

export const CEP_FIELD_LIMITS = LIMITS;
