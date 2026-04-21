/**
 * src/lib/cron-guard.ts — PR-050 · D-061
 *
 * Guard centralizado pra crons que dependem de providers externos.
 *
 * Antes de executar o trabalho, o cron:
 *   1. `startCronRun` (insere linha 'running' em cron_runs).
 *   2. `skipIfCircuitOpen(breakerKey)` — se o circuit breaker do
 *      provider está OPEN, fecha a linha como 'skipped' com payload
 *      explicando o motivo, e retorna um early-return flag.
 *   3. Caso contrário, executa o trabalho e chama `finishCronRun`
 *      normal.
 *
 * Por que centralizado?
 *   - Os 4 crons WhatsApp-dependentes têm exatamente o mesmo boilerplate.
 *   - Mantém a semântica de `cron_runs.status='skipped'` consistente
 *     (mesmo `skip_reason`, mesma estrutura de `payload`).
 *   - Futuras adições (Asaas-dependent crons) usam o mesmo hook.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getBreaker, type CircuitKey } from "./circuit-breaker";
import { skipCronRun } from "./cron-runs";
import { logger } from "./logger";

const log = logger.with({ mod: "cron-guard" });

/**
 * Se o breaker `key` está OPEN, fecha o run como 'skipped' e retorna
 * `{ skipped: true, ... }`. Caller deve retornar early nesse caso.
 *
 * Se o breaker está CLOSED ou HALF_OPEN (pronto pra probe), retorna
 * `{ skipped: false }` — o cron segue normalmente.
 *
 * NÃO loga warning quando pula: logo no próprio open do breaker já
 * acontece (em circuit-breaker.ts). Aqui só logamos `info` pra
 * correlacionar run_id ↔ decisão.
 */
export async function skipIfCircuitOpen(
  supabase: SupabaseClient,
  runId: string | null,
  params: {
    circuitKey: CircuitKey;
    jobName: string;
    startedAtMs?: number;
  }
): Promise<{ skipped: boolean; retryAt: number | null }> {
  const breaker = getBreaker(params.circuitKey);
  const snapshot = breaker.snapshot();

  if (snapshot.state !== "open") {
    return { skipped: false, retryAt: null };
  }

  const retryAt = snapshot.retryAt;
  log.info("cron skipped", {
    run_id: runId,
    job: params.jobName,
    circuit_key: params.circuitKey,
    retry_at: retryAt ? new Date(retryAt).toISOString() : null,
  });

  await skipCronRun(supabase, runId, {
    reason: "circuit_open",
    details: {
      circuit_key: params.circuitKey,
      retry_at: retryAt ? new Date(retryAt).toISOString() : null,
      lifetime_failures: snapshot.lifetime.failures,
      lifetime_openings: snapshot.lifetime.openings,
    },
    startedAtMs: params.startedAtMs,
  });

  return { skipped: true, retryAt };
}
