/**
 * Testes do circuit breaker (PR-050 · D-061).
 *
 * Estratégia:
 *   - Clock injetado (opts.now) pra controlar transições sem setTimeout.
 *   - Cada teste instancia seu próprio breaker pra não compartilhar
 *     estado com vizinhos.
 *   - Registry global (getBreaker/snapshotAllBreakers) testado por último
 *     com `resetAllBreakers` entre specs.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  CIRCUIT_KEYS,
  CircuitOpenError,
  getBreaker,
  isCircuitOpen,
  resetAllBreakers,
  snapshotAllBreakers,
} from "./circuit-breaker";

/**
 * Helper: cria um breaker ISOLADO (não usa o registry global) com
 * clock controlável. Uso: breaker + clock.advance(ms) pra fluxo temporal.
 */
function makeClock(initialMs = 1_700_000_000_000) {
  let t = initialMs;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

describe("CircuitBreaker · estado CLOSED", () => {
  it("chama fn e propaga retorno em sucesso", async () => {
    resetAllBreakers();
    const clock = makeClock();
    const br = getBreaker("test-closed-ok", { now: clock.now });
    br.reset();

    const out = await br.execute(async () => "hello");
    expect(out).toBe("hello");
    expect(br.snapshot().state).toBe("closed");
    expect(br.snapshot().lifetime.successes).toBe(1);
  });

  it("relança exceção de fn sem embrulhar", async () => {
    resetAllBreakers();
    const clock = makeClock();
    const br = getBreaker("test-closed-fail", { now: clock.now });
    br.reset();

    const err = new Error("boom");
    await expect(br.execute(async () => Promise.reject(err))).rejects.toBe(err);
    expect(br.snapshot().lifetime.failures).toBe(1);
  });

  it("não abre com menos chamadas do que minThroughput", async () => {
    resetAllBreakers();
    const clock = makeClock();
    const br = getBreaker("test-low-throughput", {
      now: clock.now,
      minThroughput: 5,
      failureThreshold: 0.5,
    });
    br.reset();

    // 4 falhas, abaixo do mínimo de 5 → ainda CLOSED
    for (let i = 0; i < 4; i++) {
      await expect(br.execute(async () => Promise.reject(new Error("x")))).rejects.toBeInstanceOf(
        Error
      );
    }
    expect(br.snapshot().state).toBe("closed");
  });

  it("não abre se failure rate < threshold, mesmo com throughput alto", async () => {
    resetAllBreakers();
    const clock = makeClock();
    const br = getBreaker("test-below-threshold", {
      now: clock.now,
      minThroughput: 5,
      failureThreshold: 0.5,
    });
    br.reset();

    // 3 sucessos + 2 falhas = 40% falha, abaixo de 50% → fica CLOSED
    for (let i = 0; i < 3; i++) await br.execute(async () => "ok");
    for (let i = 0; i < 2; i++) {
      await expect(br.execute(async () => Promise.reject(new Error("x")))).rejects.toBeTruthy();
    }
    expect(br.snapshot().state).toBe("closed");
  });

  it("abre quando failure rate >= threshold e throughput >= minimum", async () => {
    resetAllBreakers();
    const clock = makeClock();
    const br = getBreaker("test-opens", {
      now: clock.now,
      minThroughput: 5,
      failureThreshold: 0.5,
      cooldownMs: 30_000,
    });
    br.reset();

    // 2 sucessos + 3 falhas = 60% falha → abre
    for (let i = 0; i < 2; i++) await br.execute(async () => "ok");
    for (let i = 0; i < 3; i++) {
      await expect(br.execute(async () => Promise.reject(new Error("x")))).rejects.toBeTruthy();
    }

    expect(br.snapshot().state).toBe("open");
    expect(br.snapshot().retryAt).toBe(clock.now() + 30_000);
    expect(br.snapshot().lifetime.openings).toBe(1);
  });
});

describe("CircuitBreaker · estado OPEN", () => {
  it("fail-fast com CircuitOpenError, sem chamar fn", async () => {
    resetAllBreakers();
    const clock = makeClock();
    const br = getBreaker("test-fail-fast", {
      now: clock.now,
      minThroughput: 2,
      failureThreshold: 0.5,
      cooldownMs: 30_000,
    });
    br.reset();

    // Abre com 2 falhas
    for (let i = 0; i < 2; i++) {
      await expect(br.execute(async () => Promise.reject(new Error("x")))).rejects.toBeTruthy();
    }
    expect(br.snapshot().state).toBe("open");

    // Chamada seguinte: fn NÃO deve ser chamado
    let called = false;
    await expect(
      br.execute(async () => {
        called = true;
        return "nope";
      })
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(false);
    expect(br.snapshot().lifetime.rejections).toBe(1);
  });

  it("CircuitOpenError expõe retryAt e key", async () => {
    resetAllBreakers();
    const clock = makeClock();
    const br = getBreaker("test-retry-at", {
      now: clock.now,
      minThroughput: 2,
      cooldownMs: 15_000,
    });
    br.reset();

    for (let i = 0; i < 2; i++) {
      await expect(br.execute(async () => Promise.reject(new Error("x")))).rejects.toBeTruthy();
    }

    try {
      await br.execute(async () => "nope");
      throw new Error("should have rejected");
    } catch (e) {
      expect(e).toBeInstanceOf(CircuitOpenError);
      const ce = e as CircuitOpenError;
      expect(ce.key).toBe("test-retry-at");
      expect(ce.retryAt).toBe(clock.now() + 15_000);
      expect(ce.code).toBe("CIRCUIT_OPEN");
    }
  });
});

describe("CircuitBreaker · transição OPEN → HALF_OPEN → CLOSED", () => {
  it("probe sucedida fecha o breaker e limpa a janela", async () => {
    resetAllBreakers();
    const clock = makeClock();
    const br = getBreaker("test-halfopen-success", {
      now: clock.now,
      minThroughput: 2,
      cooldownMs: 10_000,
    });
    br.reset();

    // Abre
    for (let i = 0; i < 2; i++) {
      await expect(br.execute(async () => Promise.reject(new Error("x")))).rejects.toBeTruthy();
    }
    expect(br.getState()).toBe("open");

    // Passa cooldown → HALF_OPEN na próxima leitura
    clock.advance(10_000);
    expect(br.getState()).toBe("half_open");

    // Probe sucede → CLOSED, lifetime.successes aumenta
    const out = await br.execute(async () => "recovered");
    expect(out).toBe("recovered");
    expect(br.snapshot().state).toBe("closed");
    expect(br.snapshot().windowSuccesses).toBe(0);
    expect(br.snapshot().windowFailures).toBe(0);
  });

  it("probe falhada reabre o breaker com novo cooldown", async () => {
    resetAllBreakers();
    const clock = makeClock();
    const br = getBreaker("test-halfopen-fail", {
      now: clock.now,
      minThroughput: 2,
      cooldownMs: 5_000,
    });
    br.reset();

    // Abre
    for (let i = 0; i < 2; i++) {
      await expect(br.execute(async () => Promise.reject(new Error("x")))).rejects.toBeTruthy();
    }

    // Passa cooldown → HALF_OPEN
    clock.advance(5_000);
    expect(br.getState()).toBe("half_open");

    // Probe falha → volta pra OPEN com retryAt = now + cooldown
    await expect(br.execute(async () => Promise.reject(new Error("still broken")))).rejects.toThrow(
      "still broken"
    );

    expect(br.snapshot().state).toBe("open");
    expect(br.snapshot().retryAt).toBe(clock.now() + 5_000);
    expect(br.snapshot().lifetime.openings).toBe(2);
  });

  it("em HALF_OPEN, 2ª chamada simultânea é rejeitada (só 1 probe)", async () => {
    resetAllBreakers();
    const clock = makeClock();
    const br = getBreaker("test-halfopen-concurrent", {
      now: clock.now,
      minThroughput: 2,
      cooldownMs: 5_000,
    });
    br.reset();

    for (let i = 0; i < 2; i++) {
      await expect(br.execute(async () => Promise.reject(new Error("x")))).rejects.toBeTruthy();
    }
    clock.advance(5_000);
    expect(br.getState()).toBe("half_open");

    // Probe demorada (promise manual)
    let resolveProbe!: (v: string) => void;
    const probe = new Promise<string>((r) => {
      resolveProbe = r;
    });
    const p1 = br.execute(async () => probe);

    // Segunda chamada durante probe → CircuitOpenError imediato
    await expect(br.execute(async () => "second")).rejects.toBeInstanceOf(CircuitOpenError);

    // Conclui probe
    resolveProbe("first");
    await expect(p1).resolves.toBe("first");
    expect(br.snapshot().state).toBe("closed");
  });
});

describe("CircuitBreaker · janela rolante", () => {
  it("falhas fora da janela são descartadas no próximo call", async () => {
    resetAllBreakers();
    const clock = makeClock();
    const br = getBreaker("test-window-roll", {
      now: clock.now,
      windowMs: 10_000,
      minThroughput: 5,
      failureThreshold: 0.5,
    });
    br.reset();

    // 3 falhas na janela 1
    for (let i = 0; i < 3; i++) {
      await expect(br.execute(async () => Promise.reject(new Error("x")))).rejects.toBeTruthy();
    }
    expect(br.snapshot().windowFailures).toBe(3);

    // Avança além da janela → próxima chamada rola
    clock.advance(11_000);
    await br.execute(async () => "ok");

    // Janela resetou: 0 falhas + 1 sucesso
    expect(br.snapshot().windowFailures).toBe(0);
    expect(br.snapshot().windowSuccesses).toBe(1);
    expect(br.snapshot().state).toBe("closed");
  });
});

describe("CircuitBreaker · manual record", () => {
  it("recordFailure/recordSuccess podem ser chamados sem execute", async () => {
    resetAllBreakers();
    const clock = makeClock();
    const br = getBreaker("test-manual", {
      now: clock.now,
      minThroughput: 3,
      failureThreshold: 0.5,
    });
    br.reset();

    // 3 falhas manuais → abre
    br.recordFailure();
    br.recordFailure();
    br.recordFailure();
    expect(br.snapshot().state).toBe("open");
  });
});

describe("Registry global", () => {
  beforeEach(() => resetAllBreakers());

  it("getBreaker devolve a mesma instância pra mesma chave", () => {
    const a = getBreaker("shared-key");
    const b = getBreaker("shared-key");
    expect(a).toBe(b);
  });

  it("getBreaker cria instância distinta pra chaves diferentes", () => {
    const a = getBreaker("key-a");
    const b = getBreaker("key-b");
    expect(a).not.toBe(b);
  });

  it("snapshotAllBreakers lista todos os registrados", () => {
    getBreaker(CIRCUIT_KEYS.asaas);
    getBreaker(CIRCUIT_KEYS.whatsapp);
    const snaps = snapshotAllBreakers();
    const keys = snaps.map((s) => s.key).sort();
    expect(keys).toEqual(expect.arrayContaining(["asaas", "whatsapp"]));
  });

  it("isCircuitOpen retorna false pra chave não registrada", () => {
    expect(isCircuitOpen("nonexistent")).toBe(false);
  });

  it("isCircuitOpen reflete o estado atual após falhas", async () => {
    const clock = makeClock();
    const br = getBreaker("is-open-test", {
      now: clock.now,
      minThroughput: 2,
      cooldownMs: 30_000,
    });

    expect(isCircuitOpen("is-open-test")).toBe(false);
    for (let i = 0; i < 2; i++) {
      await expect(br.execute(async () => Promise.reject(new Error("x")))).rejects.toBeTruthy();
    }
    expect(isCircuitOpen("is-open-test")).toBe(true);
  });
});
