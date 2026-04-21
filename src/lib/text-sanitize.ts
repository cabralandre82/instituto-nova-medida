/**
 * src/lib/text-sanitize.ts — PR-036 · D-054 · D-055
 *
 * Helpers puros pra sanitização de texto de entrada. Extraídos pra cá
 * porque começaram a aparecer em mais de um lugar:
 *
 *   - `patient-address.ts` (PR-035 · D-053): endereço do paciente.
 *   - `lead-validate.ts` (PR-036 · D-054): /api/lead (quiz).
 *   - `cep.ts` (PR-035 · D-053): resposta do ViaCEP.
 *   - `appointment-finalize.ts` (PR-036-B · D-055): hipotese/conduta/anamnese.
 *   - `fulfillment-transitions.ts` (PR-036-B · D-055): tracking_note/cancelled_reason.
 *
 * Objetivo: ter **uma única fonte de verdade** pra "o que é caractere
 * aceitável num input de usuário". Isso importa porque o vetor de
 * attack [9.1] (prompt injection em campos livres) depende da
 * consistência — se um endpoint aceita `\n` e o outro não, o
 * atacante pega o mais permissivo.
 *
 * Dois modos:
 *
 *   - `sanitizeShortText` — campo curto, single-line (nome, cidade,
 *     resposta de quiz). Rejeita QUALQUER controle, inclusive `\n\t\r`.
 *     Charset allowlist obrigatório.
 *
 *   - `sanitizeFreeText` — campo longo, multi-linha (anamnese, notas
 *     operacionais). Aceita `\n\r\t` mas rejeita `hasEvilControlChars`
 *     (NULL, ESC, DEL, bidi override, zero-width, U+2028/29). Não usa
 *     charset allowlist (texto clínico legítimo tem palavras
 *     arbitrárias — a defesa contra prompt-injection AQUI é envelope
 *     + limite duro de tamanho, não charset; charset fica no consumo
 *     pelo LLM — PR-037).
 *
 * Tudo aqui é PURO: sem I/O, sem Supabase, sem fetch, sem headers.
 * Testável em milissegundos.
 */

// ────────────────────────────────────────────────────────────────────────
// Detectores
// ────────────────────────────────────────────────────────────────────────

/**
 * Detecta caracteres de controle (ASCII 0x00-0x1F, DEL 0x7F) +
 * separadores de linha Unicode (U+2028, U+2029).
 *
 * A regra não tem exceção: nenhum input de usuário legítimo num form
 * de clínica precisa de `\n`, `\t`, NULL, bell, ESC, etc. Newline é
 * vetor clássico de prompt injection ("Rua X\nIGNORE PREVIOUS
 * INSTRUCTIONS"). Tab é vetor de auto-completion em LLMs. U+2028/29
 * são pouco conhecidos e passam em regexes que só checam `\r\n`.
 *
 * A validação roda ANTES de qualquer `cleanText`, porque `cleanText`
 * colapsa `\s+` → ` ` e mascararia o problema.
 */
export function hasControlChars(raw: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x1F\x7F\u2028\u2029]/.test(raw);
}

// ────────────────────────────────────────────────────────────────────────
// Normalização
// ────────────────────────────────────────────────────────────────────────

/**
 * Normaliza um texto pra forma canônica:
 *   1. `.normalize("NFC")` — garante que "á" é 1 ponto (U+00E1) em vez
 *      de 2 (U+0061 + U+0301). Importante pra regex `\p{L}` que casa
 *      combining marks de forma imprevisível.
 *   2. Colapsa runs de whitespace em um único espaço.
 *   3. Trim nas extremidades.
 */
export function cleanText(raw: string): string {
  return raw.normalize("NFC").replace(/\s+/g, " ").trim();
}

// ────────────────────────────────────────────────────────────────────────
// Patterns reutilizáveis
// ────────────────────────────────────────────────────────────────────────

/**
 * Charsets compartilhados. Espaço LITERAL (` `), nunca `\s`, porque
 * `\s` casa com `\n`/`\r`/`\t` e abre o vetor de injection.
 *
 * `\p{L}` = qualquer letra Unicode (inclui acentos, cirílico etc —
 * não restringe só a Latin1). `\p{N}` = dígitos Unicode.
 */
export const TEXT_PATTERNS = {
  /**
   * Pessoa (nome próprio): letras + espaço + apóstrofo + hífen + ponto
   * + parênteses (pra anotação "Maria (vizinha)").
   * Rejeita dígitos.
   */
  personName: /^[\p{L} .,'()\-]+$/u,

  /**
   * Texto curto livre (ex.: resposta de quiz, cidade). Letras + espaço
   * + pontuação básica. Rejeita dígitos, template/shell chars (`<`,
   * `{`, `$`, `;`, etc).
   */
  freeTextStrict: /^[\p{L} .,'()\-?!]+$/u,

  /**
   * Texto curto com dígitos (ex.: resposta de quiz tipo "27 anos").
   */
  freeTextWithDigits: /^[\p{L}\p{N} .,'()\-?!]+$/u,

  /**
   * UTM/campaign keys e values. Charset típico de tracking: letras,
   * dígitos, `_`, `-`, `.`, `+`. Rejeita espaço (UTM campaign não tem
   * espaço real — vem sempre URL-encoded ou com underscore).
   */
  utmToken: /^[A-Za-z0-9_.+\-]+$/,

  /**
   * Path interno: começa com `/`, só chars seguros. Bloqueia `//`
   * (protocol-relative URL: `//evil.com/pwn`), `\` e `:`.
   */
  internalPath: /^\/(?!\/)[A-Za-z0-9._\-/?&=%]*$/,
} as const;

// ────────────────────────────────────────────────────────────────────────
// Sanitizer de alto nível
// ────────────────────────────────────────────────────────────────────────

export type SanitizeResult =
  | { ok: true; value: string }
  | { ok: false; reason: "empty" | "too_long" | "control_chars" | "charset" };

export type SanitizeOptions = {
  /** Tamanho máximo após `cleanText`. */
  maxLen: number;
  /** Tamanho mínimo após `cleanText`. Default: 1. */
  minLen?: number;
  /** Pattern permitido. Default: `TEXT_PATTERNS.freeTextWithDigits`. */
  pattern?: RegExp;
  /**
   * Se true, aceita string vazia (retorna `{ ok: true, value: "" }`).
   * Útil pra campos opcionais (ex.: complemento, status_notes).
   */
  allowEmpty?: boolean;
};

/**
 * Executa a pipeline padrão de sanitização:
 *   1. `hasControlChars(raw)` → rejeita sem perder o motivo.
 *   2. `cleanText(raw)` → normaliza.
 *   3. Check de tamanho min/max.
 *   4. Match de pattern.
 *
 * Retorna objeto discriminado pra que o caller possa produzir mensagem
 * de erro específica (campo "Nome" vs "Cidade" têm UX diferentes).
 */
export function sanitizeShortText(
  raw: unknown,
  opts: SanitizeOptions
): SanitizeResult {
  if (typeof raw !== "string") {
    // Não-string é tratado como empty pra simplificar UX.
    if (opts.allowEmpty) return { ok: true, value: "" };
    return { ok: false, reason: "empty" };
  }

  if (hasControlChars(raw)) {
    return { ok: false, reason: "control_chars" };
  }

  const cleaned = cleanText(raw);
  const minLen = opts.minLen ?? 1;
  const pattern = opts.pattern ?? TEXT_PATTERNS.freeTextWithDigits;

  if (cleaned.length === 0) {
    if (opts.allowEmpty) return { ok: true, value: "" };
    return { ok: false, reason: "empty" };
  }

  if (cleaned.length < minLen) {
    return { ok: false, reason: "empty" };
  }

  if (cleaned.length > opts.maxLen) {
    return { ok: false, reason: "too_long" };
  }

  if (!pattern.test(cleaned)) {
    return { ok: false, reason: "charset" };
  }

  return { ok: true, value: cleaned };
}

// ────────────────────────────────────────────────────────────────────────
// Sanitizer de texto livre multi-linha (clínico / operacional)
// ────────────────────────────────────────────────────────────────────────

/**
 * Detecta controles "malignos" num texto que DEVE aceitar multi-linha.
 *
 * Aceita: `\n` (0x0A), `\r` (0x0D), `\t` (0x09) — legítimos em texto
 * clínico / nota operacional (médica cola texto de prontuário, operador
 * separa linhas "DHL + código").
 *
 * Rejeita:
 *   - NULL (0x00), SOH–BS (0x01–0x08) — nunca são digitados.
 *   - VT (0x0B), FF (0x0C) — obsoletos, só aparecem em ataque.
 *   - SO–US (0x0E–0x1F), DEL (0x7F) — idem.
 *   - Zero-width (U+200B–U+200F, U+FEFF) — caracteres invisíveis usados
 *     pra burlar filtros (ex.: "IGN\u200BORE PREVIOUS" que parece
 *     "IGNORE PREVIOUS" mas passa em regex naïve).
 *   - Bidi override (U+202A–U+202E, U+2066–U+2069) — CVE-2021-42574
 *     "Trojan Source". Um atacante pode inverter a ordem de leitura do
 *     texto num viewer, escondendo "IGNORE" dentro de texto aparentemente
 *     inocente.
 *   - Line separator / Paragraph separator (U+2028, U+2029) — ataques
 *     JSON/JS que exploram parsers que não tratam esses como quebra.
 *
 * ESTA é a função usada em `appointments.hipotese/conduta/anamnese`,
 * `fulfillments.tracking_note/cancelled_reason` e demais campos
 * clínicos/operacionais. NÃO usar `hasControlChars` lá — ia rejeitar
 * a quebra de linha legítima.
 */
export function hasEvilControlChars(raw: string): boolean {
  return /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u200B-\u200F\u202A-\u202E\u2028\u2029\u2066-\u2069\uFEFF]/.test(
    raw
  );
}

/**
 * Normaliza texto livre multi-linha preservando estrutura:
 *   1. NFC normalize.
 *   2. `\r\n` e `\r` → `\n` (unifica Windows / Mac-antigo).
 *   3. Tab → espaço simples (tabs quebram alinhamento em render e
 *      viram vetor de auto-completion em alguns LLMs).
 *   4. Trim right em cada linha (remove trailing whitespace).
 *   5. Colapsa 3+ linhas em branco consecutivas em 2 (parágrafo duplo
 *      já separa suficientemente, evita payloads de "enche tela").
 *   6. Trim nas extremidades do texto inteiro.
 */
export function cleanFreeText(raw: string): string {
  const nfc = raw.normalize("NFC");
  const unixNl = nfc.replace(/\r\n?/g, "\n");
  const detabbed = unixNl.replace(/\t/g, " ");
  const lines = detabbed.split("\n").map((l) => l.replace(/[ ]+$/, ""));
  const collapsed: string[] = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line.trim() === "") {
      blankRun += 1;
      if (blankRun <= 2) collapsed.push(line);
    } else {
      blankRun = 0;
      collapsed.push(line);
    }
  }
  return collapsed.join("\n").trim();
}

export type FreeTextSanitizeResult =
  | { ok: true; value: string }
  | {
      ok: false;
      reason: "empty" | "too_long" | "too_many_lines" | "control_chars";
    };

export type FreeTextSanitizeOptions = {
  /** Limite hard de caracteres após `cleanFreeText`. */
  maxLen: number;
  /** Tamanho mínimo após `cleanFreeText`. Default: 1. */
  minLen?: number;
  /**
   * Limite hard de linhas (linhas em branco contam). Default: sem
   * limite. Útil pra `tracking_note` (≤ 10 linhas) ou `cancelled_reason`
   * (≤ 30 linhas).
   */
  maxLines?: number;
  /**
   * Se true, aceita string vazia/null/undefined → `{ ok: true, value: "" }`.
   * Default: false.
   */
  allowEmpty?: boolean;
};

/**
 * Pipeline padrão pra campos livres multi-linha:
 *   1. Tipo → string (ou allowEmpty).
 *   2. `hasEvilControlChars` → rejeita sem perder motivo.
 *   3. `cleanFreeText` → normaliza sem mutilar.
 *   4. Check de tamanho e de número de linhas.
 *
 * Não aplica charset allowlist. Texto clínico legítimo tem vocabulário
 * aberto e símbolos (↑, ↓, mg/dL, etc.). A defesa contra prompt-injection
 * no consumo-por-LLM virá no envelope pattern do PR-037.
 */
export function sanitizeFreeText(
  raw: unknown,
  opts: FreeTextSanitizeOptions
): FreeTextSanitizeResult {
  if (raw === null || raw === undefined) {
    if (opts.allowEmpty) return { ok: true, value: "" };
    return { ok: false, reason: "empty" };
  }
  if (typeof raw !== "string") {
    if (opts.allowEmpty) return { ok: true, value: "" };
    return { ok: false, reason: "empty" };
  }

  if (hasEvilControlChars(raw)) {
    return { ok: false, reason: "control_chars" };
  }

  const cleaned = cleanFreeText(raw);
  const minLen = opts.minLen ?? 1;

  if (cleaned.length === 0) {
    if (opts.allowEmpty) return { ok: true, value: "" };
    return { ok: false, reason: "empty" };
  }

  if (cleaned.length < minLen) {
    return { ok: false, reason: "empty" };
  }

  if (cleaned.length > opts.maxLen) {
    return { ok: false, reason: "too_long" };
  }

  if (opts.maxLines !== undefined) {
    const lineCount = cleaned.split("\n").length;
    if (lineCount > opts.maxLines) {
      return { ok: false, reason: "too_many_lines" };
    }
  }

  return { ok: true, value: cleaned };
}

// ────────────────────────────────────────────────────────────────────────
// Utilitários
// ────────────────────────────────────────────────────────────────────────

/**
 * Rejeita qualquer `landing_path` que possa ser usado pra redirecionar
 * pra fora do nosso domínio (via `//attacker.com/...`) ou interpretado
 * como URL absoluta (`http://`).
 *
 * Aceita só paths internos. Se o input for inválido, devolve "/".
 */
export function normalizeInternalPath(raw: unknown, maxLen = 200): string {
  if (typeof raw !== "string") return "/";
  const trimmed = raw.trim();
  if (!trimmed) return "/";
  if (trimmed.length > maxLen) return "/";
  if (hasControlChars(trimmed)) return "/";
  // Bloqueia protocol-relative (`//`), protocol absoluto (`http:`,
  // `javascript:`, `data:`) e backslash (Windows path).
  if (trimmed.startsWith("//")) return "/";
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return "/";
  if (trimmed.includes("\\")) return "/";
  if (!trimmed.startsWith("/")) return "/";
  return trimmed;
}
