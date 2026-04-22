/**
 * src/lib/admin-list-filters.ts — PR-058 · D-069 · finding 8.7
 *
 * Helpers PUROS pra parsear query-string das listagens admin
 * (`/admin/fulfillments`, `/admin/payouts`, `/admin/refunds`):
 *
 *   - `parseSearch(raw)` → string limpa (trim, max 80 chars).
 *   - `parseStatusFilter(raw, allowlist)` → status válido ou null.
 *   - `parseDateRange(rawFrom, rawTo)` → `{ fromIso, toIso }` em UTC ISO,
 *     interpretando datas `YYYY-MM-DD` como BRT (00:00 e 23:59:59.999).
 *   - `parsePeriodFilter(raw)` → `YYYY-MM` válido ou null.
 *   - `escapeIlike(s)` / `escapeOrValue(s)` — re-export do pattern
 *     usado em `patient-search.ts` pra evitar drift.
 *   - `buildAdminListUrl(base, params)` → URL canônica pra rebuild
 *     dos links de "Limpar" / "Aplicar".
 *
 * Por que extrair lib pura em vez de fazer inline em cada page:
 *   - Cada page é server component. Testar inline exige subir Next.
 *   - 3 listagens (fulfillments, payouts, refunds) compartilham a
 *     mesma família de filtros. Drift entre elas é o pior cenário
 *     pra solo operator (search funciona aqui mas não ali).
 *
 * Convenções:
 *   - Datas: paciente/operador pensa em BRT; persistência é UTC. Esta
 *     lib faz a conversão (Brasil = UTC-3, sem DST desde 2019).
 *   - Status allowlist: page passa explicitamente quais statuses
 *     valem; lib valida. Status fora da lista vira null (sem erro,
 *     sem fail-loud — UX é "filtro não aplicado").
 *   - Search vazio: `null`, não `""`. Page consulta `if (q == null)`
 *     em vez de `if (!q)` pra deixar intent explícito.
 */

const MAX_SEARCH_LENGTH = 80;
const BRT_OFFSET_MINUTES = -180; // -03:00, sem DST desde 2019

// ────────────────────────────────────────────────────────────────────────
// SEARCH
// ────────────────────────────────────────────────────────────────────────

/**
 * Normaliza query de busca textual. Retorna `null` se vazio depois
 * de trim ou se exceder limite (defesa preventiva contra DoS).
 */
export function parseSearch(raw: string | string[] | undefined): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_SEARCH_LENGTH) {
    return trimmed.slice(0, MAX_SEARCH_LENGTH);
  }
  return trimmed;
}

// ────────────────────────────────────────────────────────────────────────
// STATUS / REASON FILTER (allowlist)
// ────────────────────────────────────────────────────────────────────────

/**
 * Valida `raw` contra `allowlist`. Retorna o valor exato da allowlist
 * ou null. NÃO faz lowercase — status são canônicos.
 */
export function parseStatusFilter<T extends string>(
  raw: string | string[] | undefined,
  allowlist: readonly T[]
): T | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  return (allowlist as readonly string[]).includes(trimmed)
    ? (trimmed as T)
    : null;
}

// ────────────────────────────────────────────────────────────────────────
// DATE RANGE (BRT → ISO)
// ────────────────────────────────────────────────────────────────────────

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parse de `YYYY-MM-DD` (BRT) → ISO string em UTC.
 * - `kind: 'start'` → `00:00:00.000` BRT (= 03:00:00.000Z)
 * - `kind: 'end'`   → `23:59:59.999` BRT (= 02:59:59.999Z do dia seguinte)
 *
 * Datas inválidas (mês 13, dia 32, formato errado) viram null.
 * Não usa `new Date(s)` direto — esse parser tem comportamentos
 * locale-dependentes em horário de verão antigo. Fazemos manual.
 */
function parseDateBoundary(
  raw: string,
  kind: "start" | "end"
): string | null {
  const m = DATE_RE.exec(raw);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (
    year < 2020 ||
    year > 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }
  const hour = kind === "start" ? 0 : 23;
  const minute = kind === "start" ? 0 : 59;
  const second = kind === "start" ? 0 : 59;
  const ms = kind === "start" ? 0 : 999;
  // Date.UTC trata como se fosse UTC; somamos o offset BRT pra
  // converter `00:00 BRT` → `03:00 UTC`.
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  if (Number.isNaN(utcMs)) return null;
  // Verifica se a data não rolou (ex.: dia 31 de fev → 3 de mar).
  const back = new Date(utcMs);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    return null;
  }
  return new Date(utcMs - BRT_OFFSET_MINUTES * 60 * 1000).toISOString();
}

export type ParsedDateRange = {
  fromIso: string | null;
  toIso: string | null;
  /** True se from > to (cliente errou) — page pode mostrar warning. */
  invertedRange: boolean;
};

export function parseDateRange(
  rawFrom: string | string[] | undefined,
  rawTo: string | string[] | undefined
): ParsedDateRange {
  const fromStr = typeof rawFrom === "string" ? rawFrom : Array.isArray(rawFrom) ? rawFrom[0] : "";
  const toStr = typeof rawTo === "string" ? rawTo : Array.isArray(rawTo) ? rawTo[0] : "";
  const fromIso = fromStr ? parseDateBoundary(fromStr, "start") : null;
  const toIso = toStr ? parseDateBoundary(toStr, "end") : null;
  const invertedRange =
    fromIso !== null && toIso !== null && fromIso > toIso;
  return { fromIso, toIso, invertedRange };
}

// ────────────────────────────────────────────────────────────────────────
// PERIOD FILTER (YYYY-MM)
// ────────────────────────────────────────────────────────────────────────

const PERIOD_RE = /^(\d{4})-(\d{2})$/;

/**
 * Valida `YYYY-MM` (ex.: "2026-04"). Usado em `/admin/payouts` pra
 * filtrar `reference_period` que é exact-match.
 */
export function parsePeriodFilter(
  raw: string | string[] | undefined
): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string") return null;
  const m = PERIOD_RE.exec(v.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (year < 2020 || year > 2100 || month < 1 || month > 12) return null;
  return `${m[1]}-${m[2]}`;
}

// ────────────────────────────────────────────────────────────────────────
// ESCAPE HELPERS (mesmas convenções de patient-search.ts)
// ────────────────────────────────────────────────────────────────────────

/** Escapa `%` e `_` pra uso em `ilike`. */
export function escapeIlike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Escapa caracteres reservados do `.or()` do PostgREST (vírgula,
 * parênteses) e descarta aspas pra evitar injection na query.
 */
export function escapeOrValue(s: string): string {
  return s.replace(/[,()]/g, " ").replace(/"/g, "");
}

// ────────────────────────────────────────────────────────────────────────
// URL HELPERS
// ────────────────────────────────────────────────────────────────────────

/**
 * Monta URL canônica pra os filtros admin. Omite chaves null/undefined/"".
 * Retorna apenas `base` se não houver param.
 */
export function buildAdminListUrl(
  base: string,
  params: Record<string, string | null | undefined>
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    const v = String(value).trim();
    if (v.length === 0) continue;
    search.set(key, v);
  }
  const qs = search.toString();
  return qs ? `${base}?${qs}` : base;
}

/** True se qualquer filtro foi aplicado (search/status/period/date). */
export function hasActiveFilters(
  params: Record<string, unknown>
): boolean {
  for (const v of Object.values(params)) {
    if (v == null) continue;
    if (typeof v === "string" && v.trim().length === 0) continue;
    return true;
  }
  return false;
}
