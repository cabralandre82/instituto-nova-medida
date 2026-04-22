/**
 * src/lib/cron-correlation.ts — PR-069 · D-077 · finding [17.5]
 *
 * Correlação temporal entre falhas de `cron_runs` e as demais fontes
 * de erro consolidadas em `error-log.ts` (asaas_webhook, daily_webhook,
 * notification, whatsapp_delivery).
 *
 * **Problema que resolve.**
 *
 * O operador solo abre `/admin/crons`, vê que `notify_pending_documents`
 * falhou 3× ontem às 14:00. Hoje a pergunta crítica é: *"foi bug do cron
 * ou a Meta/Asaas estava fora do ar?"*. Responder hoje exige abrir
 * `/admin/errors` separado, lembrar o horário, raciocinar por proximidade
 * temporal. Este módulo fecha essa lacuna: dado o `last_error_at` do
 * cron, lista automaticamente quantos erros de OUTRAS fontes aconteceram
 * em ±N min.
 *
 * **Por que não nova tabela.**
 *
 * A auditoria sugeria "unificar em `error_log` com `source: 'cron',
 * job, run_id`". Rejeitamos porque:
 *
 *   1. `src/lib/error-log.ts` (D-045 · 3.G) já é essa view lógica —
 *      consolida as 5 fontes em `ErrorEntry[]` via querying on-demand.
 *      Criar tabela física duplicaria dados (≠ fonte da verdade de
 *      cada tabela origem) e exigiria política de retenção própria.
 *   2. O gap real é *correlação temporal cruzada*, não consolidação.
 *      Este módulo entrega isso sem coluna nova, sem FK, sem cron de
 *      sync: cálculo puro sobre o que já existe.
 *
 * **Contrato da função principal.**
 *
 *   `correlateErrorsInWindow(entries, { anchorAt, windowMinutes,
 *    excludeReference? })` — puro, zero IO. Recebe a lista completa do
 *   `error-log` + um timestamp âncora + janela em minutos. Devolve
 *   `{ total, bySource, entries }` contendo apenas os que caíram em
 *   [anchor − window, anchor + window], opcionalmente excluindo uma
 *   `reference` (normalmente a própria linha do cron que deu âncora,
 *   pra não contar ele mesmo).
 *
 * **Decisões.**
 *
 *   - Janela default de **15 minutos** (±15). Escolhido assumindo que
 *     incidente sistêmico se manifesta em janela curta. Para incidentes
 *     longos, operador vê isso claramente na sparkline da UI.
 *   - Exclusão por `reference` (formato `tabela:uuid`), não por
 *     `source` — permite ver outros crons que falharam no mesmo
 *     momento.
 *   - Comparação de timestamps via `Date.getTime()` com fallback
 *     defensivo pra strings inválidas (ignora a entry, não quebra).
 */

import type { ErrorEntry, ErrorSource } from "./error-log";

// ─── Tipos ──────────────────────────────────────────────────────────────

export type CorrelationWindow = {
  /** Timestamp âncora (ISO ou Date) — normalmente o `last_error_at` do cron. */
  anchorAt: string | Date;
  /**
   * Raio da janela em minutos. Janela efetiva é
   * [anchor − windowMinutes, anchor + windowMinutes]. Clampado em
   * [1, 1440] (24h) pra evitar janela degenerada.
   */
  windowMinutes?: number;
  /**
   * `reference` (formato `tabela:uuid`) a excluir do resultado — útil
   * pra não contar o próprio cron como correlacionado. Pode ser null.
   */
  excludeReference?: string | null;
};

export type CorrelationResult = {
  /** Total de erros correlatos (depois do filtro). */
  total: number;
  /** Quebra por fonte. Todas as fontes aparecem, mesmo que com 0. */
  bySource: Record<ErrorSource, number>;
  /**
   * Entries correlatas ordenadas por proximidade (distância ao anchor
   * crescente). Empates resolvidos por `occurredAt` decrescente.
   */
  entries: ErrorEntry[];
  /** Janela efetiva em minutos (após clamping). */
  windowMinutes: number;
  /** ISO do limite inferior da janela (derivável mas útil pra UI). */
  sinceIso: string;
  /** ISO do limite superior. */
  untilIso: string;
};

// ─── Helpers puros ──────────────────────────────────────────────────────

/** Clampa a janela em [1, 1440] minutos. */
export function clampWindowMinutes(n: number | undefined): number {
  if (!Number.isFinite(n ?? NaN)) return 15;
  const rounded = Math.round(n as number);
  if (rounded < 1) return 1;
  if (rounded > 1440) return 1440;
  return rounded;
}

function toMillis(value: string | Date): number | null {
  const t =
    value instanceof Date
      ? value.getTime()
      : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function emptyBySource(): Record<ErrorSource, number> {
  return {
    cron: 0,
    asaas_webhook: 0,
    daily_webhook: 0,
    notification: 0,
    whatsapp_delivery: 0,
  };
}

// ─── Função principal (pura) ────────────────────────────────────────────

/**
 * Filtra `entries` pro intervalo [anchor − window, anchor + window]
 * e retorna estatísticas + lista ordenada por proximidade.
 *
 * Entries com `occurredAt` inválido são ignoradas (fail-safe — nunca
 * quebra por data mal-formatada vinda do banco). Se `anchorAt` for
 * inválido, retorna `total=0` com contadores zerados; caller decide
 * se isso é erro ou no-op.
 */
export function correlateErrorsInWindow(
  entries: readonly ErrorEntry[],
  opts: CorrelationWindow
): CorrelationResult {
  const windowMinutes = clampWindowMinutes(opts.windowMinutes);
  const anchorMs = toMillis(opts.anchorAt);
  const exclude = opts.excludeReference ?? null;

  const bySource = emptyBySource();
  const sinceMs =
    anchorMs != null ? anchorMs - windowMinutes * 60_000 : 0;
  const untilMs =
    anchorMs != null ? anchorMs + windowMinutes * 60_000 : 0;

  if (anchorMs == null) {
    return {
      total: 0,
      bySource,
      entries: [],
      windowMinutes,
      sinceIso: new Date(0).toISOString(),
      untilIso: new Date(0).toISOString(),
    };
  }

  const matched: Array<{ entry: ErrorEntry; distance: number }> = [];

  for (const e of entries) {
    if (exclude && e.reference === exclude) continue;
    const t = toMillis(e.occurredAt);
    if (t == null) continue;
    if (t < sinceMs || t > untilMs) continue;

    matched.push({ entry: e, distance: Math.abs(t - anchorMs) });
    bySource[e.source] += 1;
  }

  matched.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    return b.entry.occurredAt.localeCompare(a.entry.occurredAt);
  });

  return {
    total: matched.length,
    bySource,
    entries: matched.map((m) => m.entry),
    windowMinutes,
    sinceIso: new Date(sinceMs).toISOString(),
    untilIso: new Date(untilMs).toISOString(),
  };
}

// ─── Helpers de UI (puros, sem JSX) ─────────────────────────────────────

/**
 * Compõe uma frase resumo "2 Asaas + 1 WhatsApp" pra exibir inline
 * na UI. Omite fontes com 0 e traduz pra labels curtas. Retorna
 * string vazia se `total == 0`, pra caller decidir se mostra nada ou
 * "sem correlação".
 */
export function formatCorrelationSummary(
  bySource: Record<ErrorSource, number>
): string {
  const order: Array<[ErrorSource, string]> = [
    ["cron", "cron"],
    ["asaas_webhook", "Asaas"],
    ["daily_webhook", "Daily"],
    ["notification", "envio WA"],
    ["whatsapp_delivery", "entrega WA"],
  ];
  const parts: string[] = [];
  for (const [src, label] of order) {
    const n = bySource[src];
    if (n > 0) parts.push(`${n} ${label}`);
  }
  return parts.join(" · ");
}
