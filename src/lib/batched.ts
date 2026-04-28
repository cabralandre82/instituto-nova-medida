/**
 * src/lib/batched.ts — PR-049 · D-098
 *
 * Helper genérico pra processar arrays de items com concorrência
 * controlada. Substitui o anti-pattern de `for (item of items) { await
 * process(item); }` (sequential) e a alternativa naive `Promise.all(
 * items.map(process))` (sem limite — pode esgotar pool de conexões DB,
 * estourar rate-limit de provider, derrubar o Lambda por OOM).
 *
 * Por que existe:
 *   - `monthly-payouts` itera ~100-1000 médicas em single Lambda call
 *     (Vercel maxDuration: 120s). Sequencial = O(N) latência. Naive
 *     paralelo = thundering herd.
 *   - Outros crons que iteram por médica (`monitor-on-call`,
 *     `doctor-daily-summary`) podem se beneficiar do mesmo pattern
 *     conforme volume crescer.
 *
 * Garantias:
 *   - Concorrência ≤ `concurrency` em qualquer instante.
 *   - Resultados em ordem original (idx 0 do input → idx 0 do output).
 *   - Erros isolados via `Promise.allSettled` — uma falha não derruba
 *     o batch nem aborta o resto.
 *   - Determinismo: mesmo input + mesma `process` (pura) → mesmo output.
 *     (Dependendo de IO, ordem de completion varia, mas resultado por
 *     idx é estável.)
 *
 * Não-objetivos:
 *   - Não retry (caller decide se retry faz sentido).
 *   - Não fairness avançado (não é Bottleneck.js).
 *   - Não rate-limiting por janela de tempo (usar circuit breaker
 *     PR-050 / token bucket separado se preciso).
 */

import { logger } from "./logger";

const log = logger.with({ mod: "batched" });

export type BatchedOutcome<T, R> =
  | { ok: true; item: T; index: number; value: R }
  | { ok: false; item: T; index: number; error: Error };

export type ProcessInBatchesOptions = {
  /** Concorrência máxima por janela (default 8, min 1, max 64). */
  concurrency?: number;
  /**
   * Hook de progresso opcional — chamado depois de cada batch fechar.
   * Útil pra log estruturado em crons longos.
   */
  onBatchComplete?: (info: {
    batchIndex: number;
    completed: number;
    total: number;
    okCount: number;
    errorCount: number;
  }) => void;
};

/**
 * Lê a env como int positivo dentro do range [min, max], com fallback.
 * Usado pra concorrência configurável (ex.: `MONTHLY_PAYOUTS_CONCURRENCY`).
 *
 * Defensivo: nunca lança. Cron crítico não pode quebrar por typo de env.
 */
export function envIntInRange(
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const truncated = Math.floor(parsed);
  if (truncated < min) return min;
  if (truncated > max) return max;
  return truncated;
}

/**
 * Processa `items` em lotes de até `concurrency` paralelo cada.
 *
 * Implementação: while loop sobre o array consumindo `concurrency`
 * por iteração via `Promise.allSettled`. Simples, sem dependência,
 * sem queue manager. Mais sofisticado seria uma "worker pool" que
 * mantém N workers ativos sempre — diferença de perf é ≤ 10% em
 * cargas mistas e custo de complexidade não compensa pro caso de
 * uso (cron infrequente).
 *
 * @example
 * const outcomes = await processInBatches(
 *   doctorIds,
 *   (id) => processSingleDoctor(supabase, id),
 *   { concurrency: 8 }
 * );
 * for (const o of outcomes) {
 *   if (o.ok) result.payoutsCreated += o.value.created;
 *   else result.errors += 1;
 * }
 */
export async function processInBatches<T, R>(
  items: readonly T[],
  process: (item: T, index: number) => Promise<R>,
  options: ProcessInBatchesOptions = {}
): Promise<BatchedOutcome<T, R>[]> {
  const concurrency = clampConcurrency(options.concurrency ?? 8);
  const total = items.length;

  if (total === 0) return [];
  if (concurrency === 1) {
    // Atalho: sem overhead de Promise.allSettled pra concurrency=1.
    const out: BatchedOutcome<T, R>[] = [];
    for (let i = 0; i < total; i++) {
      out.push(await runOne(items[i], i, process));
    }
    return out;
  }

  const out: BatchedOutcome<T, R>[] = new Array(total);
  let batchIndex = 0;
  let completed = 0;

  for (let i = 0; i < total; i += concurrency) {
    const end = Math.min(i + concurrency, total);
    const promises: Promise<BatchedOutcome<T, R>>[] = [];
    for (let j = i; j < end; j++) {
      promises.push(runOne(items[j], j, process));
    }

    // `runOne` já captura erros via try/catch — `Promise.allSettled`
    // aqui é redundante mas defensivo (se alguém alterar `runOne`
    // pra lançar throw, ainda não estoura o batch).
    const settled = await Promise.allSettled(promises);
    let okCount = 0;
    let errorCount = 0;
    for (let k = 0; k < settled.length; k++) {
      const idx = i + k;
      const s = settled[k];
      if (s.status === "fulfilled") {
        out[idx] = s.value;
        if (s.value.ok) okCount += 1;
        else errorCount += 1;
      } else {
        // Não deveria acontecer (runOne é try/catch). Mas defensivo:
        const err =
          s.reason instanceof Error ? s.reason : new Error(String(s.reason));
        out[idx] = {
          ok: false,
          item: items[idx],
          index: idx,
          error: err,
        };
        errorCount += 1;
        log.warn("processInBatches: unexpected rejection in runOne", {
          index: idx,
          err: err.message,
        });
      }
    }

    completed += end - i;
    if (options.onBatchComplete) {
      try {
        options.onBatchComplete({
          batchIndex,
          completed,
          total,
          okCount,
          errorCount,
        });
      } catch (e) {
        // Hook não pode derrubar o cron.
        log.warn("processInBatches: onBatchComplete threw", {
          err: e instanceof Error ? e.message : String(e),
        });
      }
    }
    batchIndex += 1;
  }

  return out;
}

function clampConcurrency(c: number): number {
  if (!Number.isFinite(c)) return 1;
  const n = Math.floor(c);
  if (n < 1) return 1;
  if (n > 64) return 64;
  return n;
}

async function runOne<T, R>(
  item: T,
  index: number,
  process: (item: T, index: number) => Promise<R>
): Promise<BatchedOutcome<T, R>> {
  try {
    const value = await process(item, index);
    return { ok: true, item, index, value };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    return { ok: false, item, index, error };
  }
}
