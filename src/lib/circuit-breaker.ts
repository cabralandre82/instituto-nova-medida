/**
 * src/lib/circuit-breaker.ts — PR-050 · D-061
 *
 * Circuit breaker in-memory pra provedores externos (Asaas, Daily,
 * WhatsApp Meta, ViaCEP).
 *
 * ## Por que existe
 *
 * audit [13.2 · ALTO]: quando um provedor degrada, cada tentativa ainda
 * roda `fetchWithTimeout` até o fim (8–10s). Isso cascateia:
 *
 *   - webhook Asaas chega → 3 requests à API Asaas, cada uma espera 10s
 *     pra timeout → function queima 30s = maxDuration do hobby tier.
 *   - cron `admin-digest` dispara 20 mensagens no WhatsApp → Meta offline
 *     → 20×8s = 160s, muito além do window do Vercel Cron.
 *   - consulta CEP de um paciente no checkout → ViaCEP fora → paciente
 *     espera 2.5s pra UI mostrar erro, frustra.
 *
 * Com breaker, depois de N falhas na janela, o provider vira **fail-fast**
 * (throw `CircuitOpenError` em <1ms) até passar o cooldown. Reduz latência
 * percebida, protege pool do Node, dá tempo pro operador agir.
 *
 * ## Design
 *
 * In-memory, zero dependências. 3 estados clássicos:
 *
 *   CLOSED  (normal)        ─┐
 *     failure rate atinge    │
 *     threshold → OPEN       ▼
 *   OPEN    (fail-fast)     cooldownMs passa
 *     passa cooldown →       │
 *     HALF_OPEN              ▼
 *   HALF_OPEN (1 probe)    probe success → CLOSED
 *                          probe failure → OPEN (novo cooldown)
 *
 * ## Por que in-memory e não Postgres
 *
 * O audit sugeriu tabela `circuit_state`. Vantagem: compartilhado entre
 * instâncias Vercel. Desvantagem real:
 *
 *   - Cada chamada gastaria 1 roundtrip Supabase (~20–50ms) pra decidir
 *     se está aberto — já é metade do que queremos economizar.
 *   - Escrever o estado em cada falha/sucesso adiciona mais 1 roundtrip.
 *   - Serverless frio gera ~2–5 containers simultâneos em carga normal;
 *     perder 5 probes independentes não é catastrófico.
 *   - Operação solo hoje. Quando multi-médica chegar (PR-046), a carga
 *     ainda é pequena em relação à escala que justifica Postgres.
 *
 * Documentado em D-061 como decisão explícita. Migrar pra Postgres fica
 * como gancho sem reescrita — basta trocar a implementação do `CircuitBreaker`.
 *
 * ## Rolling window
 *
 * Em vez de "últimas N chamadas" com array que cresce/encolhe, guardamos
 * **dois contadores com decay lazy**:
 *
 *   - `window.successes`, `window.failures` (últimas `windowMs` ms)
 *   - Resetados na hora de avaliar se a janela inteira ficou vazia
 *     (`now - windowStart > windowMs`).
 *
 * Não é estatisticamente perfeito (é closest-to-current-window, não
 * exatamente as últimas N chamadas), mas pro fim prático de "abrir ou
 * não" é equivalente e muito mais barato (sem alocações por call).
 *
 * ## Thread-safety no Node / Vercel
 *
 * Node é single-thread por container (event loop). Race condition dentro
 * do mesmo processo só acontece se tivermos `await` entre ler e escrever
 * o contador — evitamos isso (tudo síncrono em `recordSuccess/Failure`).
 * Entre containers, o breaker é por-container — aceitável (ver "in-memory"
 * acima).
 *
 * ## Não inclui
 *
 *   - Retry/backoff: fica no caller, cada provedor tem política própria.
 *   - Throttling (rate-limit): escopo diferente, resolvido em outros PRs.
 *   - Persistência: explicitamente out-of-scope (ver "in-memory" acima).
 */

import { logger } from "./logger";

const log = logger.with({ mod: "circuit-breaker" });

/** Estados canônicos do breaker. */
export type CircuitState = "closed" | "open" | "half_open";

/**
 * Chaves canônicas por provider. Use uma das constantes abaixo — não
 * string literal — pra evitar typo silencioso em logs/snapshots.
 */
export const CIRCUIT_KEYS = {
  asaas: "asaas",
  whatsapp: "whatsapp",
  daily: "daily",
  viacep: "viacep",
} as const;

export type CircuitKey = (typeof CIRCUIT_KEYS)[keyof typeof CIRCUIT_KEYS];

/**
 * Config do breaker. Tudo opcional — defaults calibrados pra APIs
 * externas com latência humana (10s order).
 */
export type CircuitOptions = {
  /**
   * Tamanho da janela em ms. Default: 60_000 (1min). Falhas/sucessos
   * fora dessa janela são descartados na próxima avaliação.
   */
  windowMs?: number;

  /**
   * Fração de falhas (0.0-1.0) acima da qual abre o breaker. Default: 0.5.
   */
  failureThreshold?: number;

  /**
   * Mínimo de chamadas dentro da janela antes de o breaker considerar
   * abrir. Evita abrir com 1 única chamada que falhou. Default: 5.
   */
  minThroughput?: number;

  /**
   * Tempo em ms que fica OPEN antes de virar HALF_OPEN. Default: 30_000.
   */
  cooldownMs?: number;

  /**
   * Clock injetável (para testes). Default: Date.now.
   */
  now?: () => number;
};

const DEFAULT_OPTIONS: Required<Omit<CircuitOptions, "now">> = {
  windowMs: 60_000,
  failureThreshold: 0.5,
  minThroughput: 5,
  cooldownMs: 30_000,
};

/**
 * Erro lançado quando o breaker está OPEN (ou HALF_OPEN com probe em
 * andamento). Callers que sabem diferenciar podem checar
 * `err instanceof CircuitOpenError` pra não logar como "erro inesperado".
 */
export class CircuitOpenError extends Error {
  readonly code = "CIRCUIT_OPEN";
  readonly key: string;
  readonly retryAt: number;

  constructor(key: string, retryAt: number) {
    super(
      `Circuit breaker "${key}" is OPEN. Retry after ${new Date(
        retryAt
      ).toISOString()}.`
    );
    this.name = "CircuitOpenError";
    this.key = key;
    this.retryAt = retryAt;
  }
}

/** Snapshot leitura-apenas do estado atual — consumido por /admin/health. */
export type CircuitSnapshot = {
  key: string;
  state: CircuitState;
  /** Sucessos dentro da janela atual. */
  windowSuccesses: number;
  /** Falhas dentro da janela atual. */
  windowFailures: number;
  /** Quando a janela começou (ms epoch). null se nunca houve call. */
  windowStart: number | null;
  /** Quando o breaker foi aberto (ms epoch). null se estado != open/half_open. */
  openedAt: number | null;
  /** Quando o breaker deve virar HALF_OPEN (ms epoch). null se closed. */
  retryAt: number | null;
  /** Contadores lifetime pra observabilidade. */
  lifetime: {
    successes: number;
    failures: number;
    openings: number;
    rejections: number;
  };
};

// ─────────────────────────────────────────────────────────────────────────
// Implementação
// ─────────────────────────────────────────────────────────────────────────

class CircuitBreaker {
  readonly key: string;
  private readonly opts: Required<Omit<CircuitOptions, "now">>;
  private readonly now: () => number;

  // Estado mutável
  private state: CircuitState = "closed";
  private windowStart: number | null = null;
  private windowSuccesses = 0;
  private windowFailures = 0;
  private openedAt: number | null = null;
  private retryAt: number | null = null;
  /** HALF_OPEN só permite 1 probe simultânea — guard síncrono. */
  private probeInFlight = false;

  // Counters lifetime
  private lifetime = { successes: 0, failures: 0, openings: 0, rejections: 0 };

  constructor(key: string, options: CircuitOptions = {}) {
    this.key = key;
    this.opts = {
      windowMs: options.windowMs ?? DEFAULT_OPTIONS.windowMs,
      failureThreshold:
        options.failureThreshold ?? DEFAULT_OPTIONS.failureThreshold,
      minThroughput: options.minThroughput ?? DEFAULT_OPTIONS.minThroughput,
      cooldownMs: options.cooldownMs ?? DEFAULT_OPTIONS.cooldownMs,
    };
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Estado atual. Tem efeito colateral: se estávamos OPEN e o cooldown
   * expirou, transitamos pra HALF_OPEN aqui (fail-lazy transition).
   */
  getState(): CircuitState {
    this.maybeTransitionOpenToHalfOpen();
    return this.state;
  }

  snapshot(): CircuitSnapshot {
    this.maybeTransitionOpenToHalfOpen();
    return {
      key: this.key,
      state: this.state,
      windowSuccesses: this.windowSuccesses,
      windowFailures: this.windowFailures,
      windowStart: this.windowStart,
      openedAt: this.openedAt,
      retryAt: this.retryAt,
      lifetime: { ...this.lifetime },
    };
  }

  /**
   * Executa `fn` sob o guard do breaker.
   *
   * Lança:
   *   - `CircuitOpenError` se estado é OPEN ou HALF_OPEN com probe em curso.
   *   - Qualquer exceção que `fn` lance (relança sem embrulhar).
   *
   * Contabiliza sucesso (fn resolveu) ou falha (fn rejeitou) na janela.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.maybeTransitionOpenToHalfOpen();

    if (this.state === "open") {
      this.lifetime.rejections += 1;
      throw new CircuitOpenError(this.key, this.retryAt ?? this.now());
    }

    if (this.state === "half_open") {
      if (this.probeInFlight) {
        // Já tem uma probe em voo; este request não é uma probe válida.
        this.lifetime.rejections += 1;
        throw new CircuitOpenError(this.key, this.retryAt ?? this.now());
      }
      this.probeInFlight = true;
      try {
        const out = await fn();
        this.recordSuccess();
        return out;
      } catch (err) {
        this.recordFailure(err);
        throw err;
      } finally {
        this.probeInFlight = false;
      }
    }

    // CLOSED: caminho normal
    try {
      const out = await fn();
      this.recordSuccess();
      return out;
    } catch (err) {
      this.recordFailure(err);
      throw err;
    }
  }

  /**
   * Marca sucesso. Útil pro caller que quer incrementar manualmente
   * (ex.: classificou um HTTP 200 como sucesso mesmo após custom parsing).
   */
  recordSuccess(): void {
    this.rollWindow();
    this.windowSuccesses += 1;
    this.lifetime.successes += 1;

    if (this.state === "half_open") {
      // Probe deu certo — fecha o breaker, limpa janela pra dar fresh start.
      this.state = "closed";
      this.windowSuccesses = 0;
      this.windowFailures = 0;
      this.windowStart = null;
      this.openedAt = null;
      this.retryAt = null;
      log.info("circuit closed after probe", { key: this.key });
    }
  }

  /**
   * Marca falha. Útil pro caller que classifica um `{ok:false}` como
   * falha mesmo sem exception (ex.: HTTP 503 retornado pelo provider).
   */
  recordFailure(cause?: unknown): void {
    this.rollWindow();
    this.windowFailures += 1;
    this.lifetime.failures += 1;

    if (this.state === "half_open") {
      // Probe falhou — reabre com novo cooldown.
      this.openCircuit(cause);
      return;
    }

    // CLOSED: avalia se passamos do threshold pra abrir.
    const total = this.windowSuccesses + this.windowFailures;
    if (total < this.opts.minThroughput) return;

    const rate = this.windowFailures / total;
    if (rate >= this.opts.failureThreshold) {
      this.openCircuit(cause);
    }
  }

  /** Reseta tudo. Usado em testes. Produção não deveria chamar. */
  reset(): void {
    this.state = "closed";
    this.windowStart = null;
    this.windowSuccesses = 0;
    this.windowFailures = 0;
    this.openedAt = null;
    this.retryAt = null;
    this.probeInFlight = false;
    this.lifetime = { successes: 0, failures: 0, openings: 0, rejections: 0 };
  }

  // ─────────── helpers privados ───────────

  private rollWindow(): void {
    const now = this.now();
    if (
      this.windowStart === null ||
      now - this.windowStart > this.opts.windowMs
    ) {
      this.windowStart = now;
      this.windowSuccesses = 0;
      this.windowFailures = 0;
    }
  }

  private maybeTransitionOpenToHalfOpen(): void {
    if (this.state !== "open") return;
    if (this.retryAt === null) return;
    if (this.now() >= this.retryAt) {
      this.state = "half_open";
      this.probeInFlight = false;
      log.info("circuit half-open", {
        key: this.key,
        cooldown_ms: this.opts.cooldownMs,
      });
    }
  }

  private openCircuit(cause: unknown): void {
    const now = this.now();
    this.state = "open";
    this.openedAt = now;
    this.retryAt = now + this.opts.cooldownMs;
    this.lifetime.openings += 1;
    log.warn("circuit opened", {
      key: this.key,
      window_failures: this.windowFailures,
      window_total: this.windowSuccesses + this.windowFailures,
      cooldown_ms: this.opts.cooldownMs,
      retry_at: new Date(this.retryAt).toISOString(),
      cause: cause instanceof Error ? cause.message : String(cause ?? ""),
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Registry global (process-scoped)
// ─────────────────────────────────────────────────────────────────────────

const breakers = new Map<string, CircuitBreaker>();

/**
 * Retorna (ou cria) o breaker global pra uma chave. Options só têm
 * efeito na PRIMEIRA chamada por chave — chamadas subsequentes ignoram
 * pra evitar reconfig silenciosa.
 *
 * Use `CIRCUIT_KEYS.xxx` em vez de string cru pra consistência.
 */
export function getBreaker(
  key: string,
  options?: CircuitOptions
): CircuitBreaker {
  const existing = breakers.get(key);
  if (existing) return existing;
  const fresh = new CircuitBreaker(key, options);
  breakers.set(key, fresh);
  return fresh;
}

/**
 * Snapshot de todos os breakers registrados. Usado por
 * `/admin/health` e `system-health.ts` pra expor estado operacional.
 */
export function snapshotAllBreakers(): CircuitSnapshot[] {
  return Array.from(breakers.values()).map((b) => b.snapshot());
}

/**
 * Reset de todos os breakers. **Uso estrito em testes.** Produção não
 * deveria precisar disso — se um breaker está OPEN, o que você quer
 * é corrigir o provider, não zerar o estado.
 */
export function resetAllBreakers(): void {
  for (const b of breakers.values()) b.reset();
}

/**
 * Checa se o breaker da `key` está actualmente OPEN (sem efeitos
 * colaterais observáveis pelo caller além da transição lazy). Usado
 * por crons pra decidir se devem skippar o trabalho inteiro antes
 * mesmo de tentar a 1ª chamada.
 */
export function isCircuitOpen(key: string): boolean {
  const b = breakers.get(key);
  if (!b) return false;
  return b.getState() === "open";
}

// Re-exporta a classe só pra type annotations em callers; instâncias
// devem vir sempre via `getBreaker()`.
export type { CircuitBreaker };
