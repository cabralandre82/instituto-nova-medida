/**
 * src/lib/logger.ts — PR-039 · D-057
 *
 * Logger canônico da plataforma. Substitui `console.*` nos caminhos que
 * importam (crons, webhooks, handlers admin, libs de lógica) com saída
 * estruturada, redação automática de PII e contexto encadeável.
 *
 * Objetivos:
 *
 *   1. JSON em produção (NODE_ENV === 'production'), uma linha por entry,
 *      parseável por qualquer drain (Vercel logs, Axiom, Datadog, Loki).
 *   2. Pretty-print legível em desenvolvimento, sem colorir (não temos
 *      tty garantido em serverless).
 *   3. Silencioso em test (`VITEST` ou `NODE_ENV === 'test'`), salvo se
 *      `LOGGER_ENABLED=1` explicitamente, pra não poluir a saída de 800+
 *      specs.
 *   4. Redação automática de PII em `msg` e nas strings dentro do
 *      `context`, via `redactForLog` (D-056). Logger nunca pode ser
 *      vetor de vazamento.
 *   5. Child loggers com binding de contexto: `logger.with({ route }).info(...)`
 *      preserva campos base em toda chamada subsequente.
 *   6. Sink pluggable (`setSink(fn)`): no futuro, o `PR-039+` pode
 *      instalar um sink que replica pra Axiom/Sentry/etc. Hoje o default
 *      é `console.*`.
 *
 * NÃO é design goal:
 *
 *   - Não instalamos bibliotecas externas (pino/winston/bunyan). A ABI
 *     mínima que precisamos cabe em <200 linhas e reduz superfície.
 *   - Não há sampling. Volume atual (<10 req/s) não justifica.
 *   - Não há queue nem buffer. Se o sink travar, o handler trava — é
 *     melhor que perder log de incidente.
 *
 * Uso típico:
 *
 *   import { logger } from "@/lib/logger";
 *
 *   const log = logger.with({ route: "/api/asaas/webhook" });
 *   log.info("evento recebido", { event_type: body.event });
 *   try { ... } catch (e) { log.error("falha", { err: e }); }
 *
 * Contrato:
 *
 *   - Nunca passar PII crua em `msg`. O redactor pega muito mas é melhor
 *     já formatar seguro (use `displayFirstName`, `redactForLLM` etc).
 *   - `context` é serializado via JSON; use apenas valores serializáveis
 *     (strings, números, booleans, null, arrays e objetos planos).
 *   - `err` pode ser `Error` real: o logger extrai `name`, `message` e
 *     `stack` (stack só em dev e warn+, nunca em prod info).
 */

import { redactForLog } from "./prompt-redact";

// ────────────────────────────────────────────────────────────────────────
// Tipos públicos
// ────────────────────────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = Record<string, unknown>;

export type LogEntry = {
  ts: string;
  level: LogLevel;
  msg: string;
  /** Contexto base + override. Já redigido. */
  context: LogContext;
  /** Erro normalizado (se houver). */
  err?: { name: string; message: string; stack?: string };
};

export type LogSink = (entry: LogEntry) => void;

// ────────────────────────────────────────────────────────────────────────
// Config / estado (singleton por processo)
// ────────────────────────────────────────────────────────────────────────

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveEnv(name: string): string | undefined {
  if (typeof process === "undefined") return undefined;
  return process.env[name];
}

function defaultLevel(): LogLevel {
  const raw = resolveEnv("LOG_LEVEL");
  if (raw && raw in LEVEL_ORDER) return raw as LogLevel;
  return resolveEnv("NODE_ENV") === "production" ? "info" : "debug";
}

function isTestEnv(): boolean {
  return (
    resolveEnv("VITEST") === "true" ||
    resolveEnv("VITEST") === "1" ||
    resolveEnv("NODE_ENV") === "test"
  );
}

function isProdEnv(): boolean {
  return resolveEnv("NODE_ENV") === "production";
}

function isLoggerEnabled(): boolean {
  if (!isTestEnv()) return true;
  return resolveEnv("LOGGER_ENABLED") === "1";
}

let activeSink: LogSink = defaultSink;
let activeLevel: LogLevel = defaultLevel();

/**
 * Instala um sink customizado. Usado por PR-039+ pra plugar Axiom/Sentry.
 * Retorna o sink anterior pra permitir restore em testes.
 */
export function setSink(sink: LogSink): LogSink {
  const previous = activeSink;
  activeSink = sink;
  return previous;
}

/**
 * Restaura o sink default (console). Útil em setup/teardown.
 */
export function resetSink(): void {
  activeSink = defaultSink;
}

/**
 * Ajusta o nível global em runtime. Não persiste entre invocações
 * serverless, mas é útil pra testes e debug ad-hoc.
 */
export function setLevel(level: LogLevel): void {
  activeLevel = level;
}

export function getLevel(): LogLevel {
  return activeLevel;
}

// ────────────────────────────────────────────────────────────────────────
// Redação + serialização de contexto
// ────────────────────────────────────────────────────────────────────────

/**
 * Percorre o contexto em profundidade e aplica `redactForLog` em toda
 * string encontrada. Não muta o input.
 *
 * Limite de profundidade: 6. Além disso, substitui por `[DEPTH]` pra
 * evitar recursão infinita de estruturas cíclicas.
 */
export function redactContext(
  input: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet()
): unknown {
  if (depth > 6) return "[DEPTH]";
  if (input === null || input === undefined) return input;
  if (typeof input === "string") return redactForLog(input);
  if (typeof input === "number" || typeof input === "boolean") return input;
  if (typeof input === "bigint") return input.toString();
  if (input instanceof Date) return input.toISOString();
  if (input instanceof Error) return normalizeError(input);
  if (Array.isArray(input)) {
    return input.map((item) => redactContext(item, depth + 1, seen));
  }
  if (typeof input === "object") {
    const obj = input as object;
    if (seen.has(obj)) return "[CIRCULAR]";
    seen.add(obj);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      out[key] = redactContext(value, depth + 1, seen);
    }
    return out;
  }
  // functions, symbols, etc. — não logamos.
  return undefined;
}

function normalizeError(err: Error): LogEntry["err"] {
  const stack = typeof err.stack === "string" ? redactForLog(err.stack) : undefined;
  return {
    name: err.name || "Error",
    message: redactForLog(err.message || String(err)),
    ...(stack && !isProdEnv() ? { stack } : {}),
  };
}

/**
 * Extrai um `err` fora do contexto pra ter campo top-level dedicado,
 * separando sinal (erro) de ruído (metadata). Se `context.err` existir
 * e for um Error, move pra top-level; senão preserva como está.
 */
function extractError(ctx: LogContext | undefined): {
  context: LogContext;
  err?: LogEntry["err"];
} {
  if (!ctx) return { context: {} };
  const { err, ...rest } = ctx as { err?: unknown } & LogContext;
  if (err instanceof Error) {
    return { context: rest, err: normalizeError(err) };
  }
  // err pode ser string ou objeto serializado — mantemos em context.
  return { context: ctx };
}

// ────────────────────────────────────────────────────────────────────────
// Sink default (console)
// ────────────────────────────────────────────────────────────────────────

function defaultSink(entry: LogEntry): void {
  if (isProdEnv()) {
    // Uma linha JSON — compatível com coletores padrão.
    const line = safeStringify(entry);
    writeToConsole(entry.level, line);
    return;
  }

  // Dev/pretty: legível, multiline, sem cor (terminal/IDE variados).
  const head = `[${entry.ts}] ${entry.level.toUpperCase().padEnd(5)} ${entry.msg}`;
  const ctxKeys = Object.keys(entry.context);
  const hasCtx = ctxKeys.length > 0;
  const lines: string[] = [head];
  if (hasCtx) lines.push(`  ${safeStringify(entry.context)}`);
  if (entry.err) {
    lines.push(`  err: ${entry.err.name}: ${entry.err.message}`);
    if (entry.err.stack) lines.push(entry.err.stack);
  }
  writeToConsole(entry.level, lines.join("\n"));
}

function writeToConsole(level: LogLevel, line: string): void {
  switch (level) {
    case "debug":
      // eslint-disable-next-line no-console
      console.debug(line);
      return;
    case "info":
      // eslint-disable-next-line no-console
      console.info(line);
      return;
    case "warn":
      // eslint-disable-next-line no-console
      console.warn(line);
      return;
    case "error":
      // eslint-disable-next-line no-console
      console.error(line);
      return;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ────────────────────────────────────────────────────────────────────────
// Core logger
// ────────────────────────────────────────────────────────────────────────

export type Logger = {
  debug: (msg: string, ctx?: LogContext) => void;
  info: (msg: string, ctx?: LogContext) => void;
  warn: (msg: string, ctx?: LogContext) => void;
  error: (msg: string, ctx?: LogContext) => void;
  /** Cria um child logger com contexto base permanente. */
  with: (base: LogContext) => Logger;
};

function buildLogger(base: LogContext): Logger {
  const emit = (level: LogLevel, msg: string, ctx?: LogContext): void => {
    if (!isLoggerEnabled()) return;
    if (LEVEL_ORDER[level] < LEVEL_ORDER[activeLevel]) return;

    // Merge: base + ctx (ctx vence).
    const merged: LogContext = { ...base, ...(ctx ?? {}) };
    const { context: rest, err } = extractError(merged);
    const redacted = redactContext(rest) as LogContext;

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      msg: redactForLog(msg),
      context: redacted,
      ...(err ? { err } : {}),
    };
    try {
      activeSink(entry);
    } catch {
      // Sink jamais deve derrubar o handler. Fallback silencioso pra
      // defaultSink com payload mínimo.
      try {
        defaultSink({ ...entry, context: { sinkError: true } });
      } catch {
        // desisto.
      }
    }
  };

  return {
    debug: (msg, ctx) => emit("debug", msg, ctx),
    info: (msg, ctx) => emit("info", msg, ctx),
    warn: (msg, ctx) => emit("warn", msg, ctx),
    error: (msg, ctx) => emit("error", msg, ctx),
    with: (extraBase) => buildLogger({ ...base, ...extraBase }),
  };
}

/**
 * Logger raiz. Em 99% dos casos prefira `logger.with({ route: "..." })`
 * pra sempre ter contexto de origem.
 */
export const logger: Logger = buildLogger({});
