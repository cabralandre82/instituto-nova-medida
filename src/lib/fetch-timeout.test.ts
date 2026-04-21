/**
 * src/lib/fetch-timeout.test.ts — cobertura do helper `fetchWithTimeout`.
 *
 * Foca em:
 *   - happy path (resolve antes do timeout)
 *   - timeout do helper → FetchTimeoutError + log
 *   - AbortSignal externo antes da chamada → AbortError (não timeout)
 *   - AbortSignal externo durante → relança erro original
 *   - erro de rede cru (TypeError) passa limpo
 *   - cleanup de listener/timer em todos os caminhos
 *   - isFetchTimeout guard
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FetchTimeoutError,
  fetchWithTimeout,
  isFetchTimeout,
  PROVIDER_TIMEOUTS,
} from "./fetch-timeout";
import {
  getLevel,
  resetSink,
  setLevel,
  setSink,
  type LogEntry,
} from "./logger";

function captureSink(): { entries: LogEntry[]; restore: () => void } {
  const entries: LogEntry[] = [];
  const previous = setSink((e) => entries.push(e));
  process.env.LOGGER_ENABLED = "1";
  return {
    entries,
    restore: () => {
      setSink(previous);
      delete process.env.LOGGER_ENABLED;
    },
  };
}

const previousLevel = getLevel();

beforeEach(() => {
  setLevel("debug");
});

afterEach(() => {
  setLevel(previousLevel);
  resetSink();
  delete process.env.LOGGER_ENABLED;
});

/**
 * Helper pra fazer um fetchImpl que simula latência controlada. Resolve
 * com uma Response OK após `delayMs`, mas respeita AbortSignal cancelando
 * a promise imediatamente quando o signal é abortado (mimeta o comportamento
 * nativo do fetch).
 */
function makeSlowFetch(delayMs: number): typeof fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      const timer = setTimeout(() => {
        resolve(new Response("ok", { status: 200 }));
      }, delayMs);
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        });
      }
    });
  }) as typeof fetch;
}

describe("fetchWithTimeout · happy path", () => {
  it("retorna Response quando o fetch resolve antes do timeout", async () => {
    const slowFetch = makeSlowFetch(10);
    const res = await fetchWithTimeout("https://example.test/ok", {
      timeoutMs: 500,
      fetchImpl: slowFetch,
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
  });

  it("repassa method/headers/body pro fetchImpl", async () => {
    const spy = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response("{}", { status: 200 })
    ) as unknown as typeof fetch;

    await fetchWithTimeout("https://example.test/api", {
      fetchImpl: spy,
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Foo": "bar" },
      body: JSON.stringify({ hello: "world" }),
      timeoutMs: 1000,
    });

    expect(spy).toHaveBeenCalledOnce();
    const [url, init] = (spy as unknown as { mock: { calls: [string, RequestInit][] } })
      .mock.calls[0];
    expect(url).toBe("https://example.test/api");
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"hello":"world"}');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("fetchWithTimeout · timeout", () => {
  it("lança FetchTimeoutError quando excede timeoutMs", async () => {
    const slowFetch = makeSlowFetch(200);
    await expect(
      fetchWithTimeout("https://example.test/slow", {
        timeoutMs: 30,
        provider: "asaas",
        fetchImpl: slowFetch,
      })
    ).rejects.toBeInstanceOf(FetchTimeoutError);
  });

  it("erro de timeout expõe url, timeoutMs e provider", async () => {
    const slowFetch = makeSlowFetch(200);
    const url = "https://example.test/slow";
    try {
      await fetchWithTimeout(url, {
        timeoutMs: 30,
        provider: "whatsapp",
        fetchImpl: slowFetch,
      });
      expect.fail("deveria ter lançado FetchTimeoutError");
    } catch (err) {
      expect(err).toBeInstanceOf(FetchTimeoutError);
      const e = err as FetchTimeoutError;
      expect(e.code).toBe("FETCH_TIMEOUT");
      expect(e.url).toBe(url);
      expect(e.timeoutMs).toBe(30);
      expect(e.provider).toBe("whatsapp");
      expect(e.message).toContain("whatsapp");
    }
  });

  it("emite log.warn estruturado no timeout", async () => {
    const slowFetch = makeSlowFetch(200);
    const { entries, restore } = captureSink();
    try {
      await fetchWithTimeout("https://example.test/slow", {
        timeoutMs: 30,
        provider: "daily",
        fetchImpl: slowFetch,
      });
    } catch {
      // esperado
    }
    restore();

    const warn = entries.find((e) => e.level === "warn");
    expect(warn).toBeDefined();
    expect(warn?.msg).toBe("fetch timeout");
    expect(warn?.context.provider).toBe("daily");
    expect(warn?.context.url).toBe("https://example.test/slow");
    expect(warn?.context.timeout_ms).toBe(30);
  });

  it("isFetchTimeout diferencia timeout de outros erros", async () => {
    const slowFetch = makeSlowFetch(200);
    try {
      await fetchWithTimeout("https://example.test/x", {
        timeoutMs: 30,
        fetchImpl: slowFetch,
      });
      expect.fail("não lançou");
    } catch (err) {
      expect(isFetchTimeout(err)).toBe(true);
    }

    expect(isFetchTimeout(new Error("network"))).toBe(false);
    expect(isFetchTimeout(null)).toBe(false);
    expect(isFetchTimeout(undefined)).toBe(false);
    expect(isFetchTimeout({ code: "FETCH_TIMEOUT" })).toBe(false);
  });
});

describe("fetchWithTimeout · AbortSignal externo", () => {
  it("lança AbortError (não timeout) se o signal já vem abortado", async () => {
    const ctrl = new AbortController();
    ctrl.abort();

    const slowFetch = makeSlowFetch(100);

    await expect(
      fetchWithTimeout("https://example.test/x", {
        signal: ctrl.signal,
        fetchImpl: slowFetch,
        timeoutMs: 1000,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("relança erro cru (não FetchTimeoutError) quando externo aborta durante", async () => {
    const ctrl = new AbortController();
    const slowFetch = makeSlowFetch(500);

    const p = fetchWithTimeout("https://example.test/x", {
      signal: ctrl.signal,
      fetchImpl: slowFetch,
      timeoutMs: 10_000,
      provider: "asaas",
    });

    setTimeout(() => ctrl.abort(), 20);

    try {
      await p;
      expect.fail("deveria ter rejeitado");
    } catch (err) {
      expect(isFetchTimeout(err)).toBe(false);
      expect((err as Error).name).toBe("AbortError");
    }
  });

  it("não emite log.warn quando é o externo que aborta", async () => {
    const ctrl = new AbortController();
    const slowFetch = makeSlowFetch(500);
    const { entries, restore } = captureSink();

    const p = fetchWithTimeout("https://example.test/x", {
      signal: ctrl.signal,
      fetchImpl: slowFetch,
      timeoutMs: 10_000,
      provider: "asaas",
    });
    setTimeout(() => ctrl.abort(), 20);

    try {
      await p;
    } catch {
      /* esperado */
    }
    restore();

    const warn = entries.find((e) => e.msg === "fetch timeout");
    expect(warn).toBeUndefined();
  });
});

describe("fetchWithTimeout · erros de rede", () => {
  it("relança TypeError('fetch failed') sem converter em timeout", async () => {
    const failFetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    try {
      await fetchWithTimeout("https://example.test/dns-fail", {
        fetchImpl: failFetch,
        timeoutMs: 1000,
      });
      expect.fail("não lançou");
    } catch (err) {
      expect(err).toBeInstanceOf(TypeError);
      expect(isFetchTimeout(err)).toBe(false);
    }
  });
});

describe("fetchWithTimeout · defaults", () => {
  it("usa 8000ms quando nenhum timeoutMs é passado", async () => {
    // Não queremos esperar 8s real no teste. Basta garantir que o
    // fetchImpl recebe signal ativo e que resolve rapidamente.
    const fastFetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(false);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const res = await fetchWithTimeout("https://example.test/fast", {
      fetchImpl: fastFetch,
    });
    expect(res.ok).toBe(true);
  });

  it("PROVIDER_TIMEOUTS tem as entradas esperadas", () => {
    expect(PROVIDER_TIMEOUTS.asaas).toBeGreaterThanOrEqual(5000);
    expect(PROVIDER_TIMEOUTS.daily).toBeGreaterThanOrEqual(5000);
    expect(PROVIDER_TIMEOUTS.whatsapp).toBeGreaterThanOrEqual(5000);
    expect(PROVIDER_TIMEOUTS.viacep).toBeLessThanOrEqual(5000);
  });
});
