/**
 * src/lib/fetch-timeout.ts — PR-042 · D-058
 *
 * Helper canônico pra `fetch()` server-side com timeout via AbortController.
 *
 * ## Por que existe
 *
 * audit [13.1 · ALTO]: chamadas externas (Asaas, Daily, WhatsApp Graph,
 * ViaCEP) usavam `fetch()` cru sem `AbortController`. Em produção, um
 * provedor lento trava a function Vercel até o timeout da plataforma
 * (10s hobby / 60s pro). Impacto real: um webhook Asaas com latência
 * ruim + `/api/asaas/webhook` rodando 3 fetches em sequência = 30s de
 * function time queimado, cron subsequente começa atrasado, retries do
 * Asaas duplicam eventos.
 *
 * ## O que este helper garante
 *
 *   1. **Timeout por requisição** (default 8s, override por provider).
 *   2. **Classificação tipada** do erro via `FetchTimeoutError` —
 *      chamadores que diferenciam timeout de outros erros podem checar
 *      `err instanceof FetchTimeoutError`.
 *   3. **Composição com AbortSignal externo**. Se o caller já tem seu
 *      próprio sinal (ex.: timeout mais agressivo ou cancel do usuário),
 *      o helper respeita — qualquer um dos dois aborta o fetch.
 *   4. **Log estruturado** (PR-039) no caso de timeout, com tag do
 *      provider pra correlacionar no Vercel Logs.
 *   5. **Cleanup garantido** (clearTimeout + removeEventListener no
 *      finally) — nenhum timer vaza mesmo se o fetch resolver antes.
 *
 * ## Por que lança exceção em vez de retornar union
 *
 * Olhamos os call-sites (asaas.ts, whatsapp.ts, video.ts): todos já
 * envolvem o `fetch()` em try/catch e convertem exceção em seu próprio
 * union tipado (`AsaasResult`, `WhatsAppSendResult`, `DailyResult`).
 * Trocar a semântica pra union exigiria reescrever os 3 wrappers.
 * Mantendo `fetch()`-like, a migração é drop-in.
 *
 * ## Não inclui
 *
 *   - **Retries**. Cada provider tem política própria (Asaas é
 *     idempotente por `externalReference`, Daily não, Meta tem rate
 *     limit específico). Retries ficam no caller.
 *   - **Circuit breaker**. Over-engineering pra escala atual. Quando a
 *     operação justificar, plugamos aqui.
 */

import { logger } from "./logger";

/**
 * Erro específico pra timeout por `fetchWithTimeout`. Use
 * `err instanceof FetchTimeoutError` pra discriminar de outros erros
 * de rede (DNS, conn refused, TLS, etc.).
 */
export class FetchTimeoutError extends Error {
  readonly code = "FETCH_TIMEOUT";
  readonly url: string;
  readonly timeoutMs: number;
  readonly provider: string | null;

  constructor(url: string, timeoutMs: number, provider: string | null = null) {
    super(
      `fetch exceeded timeout of ${timeoutMs}ms${
        provider ? ` (${provider})` : ""
      }: ${url}`
    );
    this.name = "FetchTimeoutError";
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.provider = provider;
  }
}

export type FetchWithTimeoutOptions = RequestInit & {
  /** Timeout em ms. Default: 8000. */
  timeoutMs?: number;
  /**
   * Tag do provider pra correlacionar logs (ex.: "asaas", "whatsapp",
   * "daily", "viacep"). Aparece no log de timeout e na mensagem de
   * erro.
   */
  provider?: string;
  /**
   * Injetável pra testes unitários. Default: `globalThis.fetch`.
   * Quem consome não precisa mexer nisto em produção.
   */
  fetchImpl?: typeof fetch;
};

/**
 * Default relativamente agressivo pra impedir que uma function Vercel
 * fique em pé mais do que o razoável. Providers que sabidamente podem
 * demorar mais (ex.: Asaas listando milhares de cobranças) podem
 * override por chamada.
 */
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Defaults recomendados por provider. Guarde em um lugar só pra que
 * mudanças de operação (ex.: Asaas demora mais em Black Friday) sejam
 * centralizadas aqui.
 */
export const PROVIDER_TIMEOUTS = {
  asaas: 10_000,
  daily: 8_000,
  whatsapp: 8_000,
  viacep: 2_500,
  default: DEFAULT_TIMEOUT_MS,
} as const;

/**
 * Drop-in replacement para `fetch()` com timeout e observabilidade.
 *
 * Lança:
 *   - `FetchTimeoutError` se o timeout for atingido antes da resposta.
 *   - `DOMException("Aborted", "AbortError")` se um `AbortSignal`
 *     externo fornecido pelo caller abortar primeiro (pass-through).
 *   - Qualquer outro erro de rede (`TypeError: fetch failed`, etc.)
 *     que o `fetch()` subjacente jogaria — a gente não engole.
 *
 * Retorna a `Response` intacta (status 4xx/5xx continuam sendo
 * "sucesso" do ponto de vista do fetch — parse e validação ficam no
 * caller, como sempre foi).
 */
export async function fetchWithTimeout(
  input: string | URL,
  opts: FetchWithTimeoutOptions = {}
): Promise<Response> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    provider,
    fetchImpl = globalThis.fetch,
    signal: externalSignal,
    ...init
  } = opts;

  const url = typeof input === "string" ? input : input.toString();
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  // Compose com AbortSignal externo (caller já tem seu próprio timeout
  // ou cancel do usuário). Qualquer um dos dois aborta o fetch.
  const onExternalAbort = () => {
    // Não seta `timedOut`: isto é um abort do caller, não nosso timeout.
    controller.abort();
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      // Replica o comportamento nativo do fetch() quando recebe signal
      // já abortado: lança AbortError. Não classificamos como timeout.
      throw new DOMException(
        (externalSignal.reason as string | undefined) ?? "Aborted",
        "AbortError"
      );
    }
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (timedOut) {
      // Foi o NOSSO timer quem abortou. Converte em erro classificado.
      const e = new FetchTimeoutError(url, timeoutMs, provider ?? null);
      logger.warn("fetch timeout", {
        provider: provider ?? null,
        url,
        timeout_ms: timeoutMs,
      });
      throw e;
    }
    // Abort externo, DNS, TLS, ECONNREFUSED, etc. Relança cru —
    // caller classifica como achar melhor.
    throw err;
  } finally {
    clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

/**
 * Checagem útil em call-sites que precisam ramificar entre timeout
 * e outros erros de rede sem importar a classe diretamente.
 */
export function isFetchTimeout(err: unknown): err is FetchTimeoutError {
  return err instanceof FetchTimeoutError;
}
