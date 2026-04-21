/**
 * src/lib/logger.test.ts — cobertura de `logger.ts`.
 *
 * Cada teste instala um sink de captura, restaura no final.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getLevel,
  logger,
  redactContext,
  resetSink,
  setLevel,
  setSink,
  type LogEntry,
  type LogLevel,
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

describe("logger · básico", () => {
  it("emite entries com ts, level, msg, context", () => {
    const { entries, restore } = captureSink();
    logger.info("hello", { route: "/x" });
    restore();

    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.level).toBe("info");
    expect(e.msg).toBe("hello");
    expect(e.context).toEqual({ route: "/x" });
    expect(e.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("respeita o nível — debug não emite quando nível é info", () => {
    const { entries, restore } = captureSink();
    setLevel("info");
    logger.debug("ignore me");
    logger.info("take me");
    restore();

    expect(entries).toHaveLength(1);
    expect(entries[0]!.msg).toBe("take me");
  });

  it("emite nos quatro níveis", () => {
    const { entries, restore } = captureSink();
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    restore();

    const levels = entries.map((x) => x.level);
    expect(levels).toEqual<LogLevel[]>(["debug", "info", "warn", "error"]);
  });

  it("silencia por default em teste (sem LOGGER_ENABLED)", () => {
    const previous = setSink(() => {
      throw new Error("sink não deveria ter sido chamado");
    });
    // NÃO setamos LOGGER_ENABLED.
    expect(() => logger.info("mute")).not.toThrow();
    setSink(previous);
  });
});

describe("logger · child com .with", () => {
  it("mergea base + ctx (ctx vence)", () => {
    const { entries, restore } = captureSink();
    const child = logger.with({ route: "/api/x", env: "dev" });
    child.info("ping", { env: "override" });
    restore();

    expect(entries[0]!.context).toEqual({ route: "/api/x", env: "override" });
  });

  it("child chain (with.with) preserva camadas", () => {
    const { entries, restore } = captureSink();
    const lvl1 = logger.with({ a: 1 });
    const lvl2 = lvl1.with({ b: 2 });
    lvl2.info("x", { c: 3 });
    restore();

    expect(entries[0]!.context).toEqual({ a: 1, b: 2, c: 3 });
  });
});

describe("logger · redação de PII", () => {
  it("redige email no msg", () => {
    const { entries, restore } = captureSink();
    logger.info("paciente cabralandre@yahoo.com.br criado");
    restore();

    expect(entries[0]!.msg).toBe("paciente [EMAIL] criado");
  });

  it("redige CPF em contexto aninhado", () => {
    const { entries, restore } = captureSink();
    logger.info("create customer", {
      customer: { doc: "123.456.789-09", nested: { email: "x@y.com" } },
    });
    restore();

    expect(entries[0]!.context).toEqual({
      customer: { doc: "[CPF]", nested: { email: "[EMAIL]" } },
    });
  });

  it("redige CEP e phone", () => {
    const { entries, restore } = captureSink();
    logger.info("endereço", { cep: "04538-132", tel: "(11) 98765-4321" });
    restore();

    expect(entries[0]!.context).toEqual({ cep: "[CEP]", tel: "[PHONE]" });
  });

  it("mantém UUID cru (preset `redactForLog`)", () => {
    const uuid = "11111111-2222-3333-4444-555555555555";
    const { entries, restore } = captureSink();
    logger.info("ref", { id: uuid });
    restore();

    expect(entries[0]!.context).toEqual({ id: uuid });
  });

  it("redige token Asaas em context", () => {
    const { entries, restore } = captureSink();
    logger.info("auth", {
      token: "$aact_MzkwODA2MTc5MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkw",
    });
    restore();

    expect(entries[0]!.context).toEqual({ token: "[TOKEN]" });
  });
});

describe("logger · err normalizado", () => {
  it("extrai Error de ctx.err pra top-level", () => {
    const { entries, restore } = captureSink();
    const boom = new Error("paciente x@y.com falhou");
    logger.error("webhook", { err: boom, extra: 1 });
    restore();

    expect(entries[0]!.err?.name).toBe("Error");
    expect(entries[0]!.err?.message).toBe("paciente [EMAIL] falhou");
    expect(entries[0]!.context).toEqual({ extra: 1 });
  });

  it("redige email dentro do stack", () => {
    const { entries, restore } = captureSink();
    const e = new Error("stop");
    e.stack = "Error: stop\n  at user@example.com (file.ts:1:1)";
    logger.error("x", { err: e });
    restore();

    expect(entries[0]!.err?.stack).toContain("[EMAIL]");
    expect(entries[0]!.err?.stack).not.toContain("user@example.com");
  });

  it("mantém err string em context se não for Error", () => {
    const { entries, restore } = captureSink();
    logger.error("x", { err: "raw string" });
    restore();

    expect(entries[0]!.err).toBeUndefined();
    expect(entries[0]!.context).toEqual({ err: "raw string" });
  });
});

describe("logger · redactContext helper", () => {
  it("lida com Date → ISO string", () => {
    const d = new Date("2026-04-20T12:00:00Z");
    expect(redactContext(d)).toBe("2026-04-20T12:00:00.000Z");
  });

  it("lida com BigInt → string", () => {
    expect(redactContext(BigInt(10))).toBe("10");
  });

  it("ignora functions e symbols", () => {
    const out = redactContext({ fn: () => 1, sym: Symbol("x"), ok: "y" });
    expect(out).toEqual({ fn: undefined, sym: undefined, ok: "y" });
  });

  it("detecta estruturas cíclicas", () => {
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic.self = cyclic;
    const out = redactContext(cyclic) as Record<string, unknown>;
    expect(out.name).toBe("root");
    expect(out.self).toBe("[CIRCULAR]");
  });

  it("limita profundidade (6)", () => {
    let deep: Record<string, unknown> = { leaf: "ok" };
    for (let i = 0; i < 10; i += 1) deep = { next: deep };
    const out = redactContext(deep);
    expect(JSON.stringify(out)).toContain("[DEPTH]");
  });

  it("redige string em array", () => {
    const out = redactContext(["x@y.com", "plain", "(11) 99999-8888"]);
    expect(out).toEqual(["[EMAIL]", "plain", "[PHONE]"]);
  });
});

describe("logger · robustez", () => {
  it("não derruba o handler se o sink custom lançar", () => {
    const previous = setSink(() => {
      throw new Error("sink exploded");
    });
    process.env.LOGGER_ENABLED = "1";
    expect(() => logger.info("hi")).not.toThrow();
    setSink(previous);
    delete process.env.LOGGER_ENABLED;
  });

  it("setSink retorna o sink anterior pra restore", () => {
    const captured: LogEntry[] = [];
    const restored: LogEntry[] = [];

    const previous = setSink((e) => captured.push(e));
    process.env.LOGGER_ENABLED = "1";
    logger.info("A");

    const temp = setSink((e) => restored.push(e));
    logger.info("B");
    setSink(temp);
    logger.info("C");
    setSink(previous);

    expect(captured.map((e) => e.msg)).toEqual(["A", "C"]);
    expect(restored.map((e) => e.msg)).toEqual(["B"]);
    delete process.env.LOGGER_ENABLED;
  });
});

describe("logger · integração console (dev)", () => {
  it("default sink escreve no console correspondente em dev", () => {
    // Força dev (NODE_ENV !== production). Já é default nos testes.
    process.env.LOGGER_ENABLED = "1";
    const spyInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    const spyWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const spyError = vi.spyOn(console, "error").mockImplementation(() => {});

    resetSink();
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    expect(spyInfo).toHaveBeenCalledTimes(1);
    expect(spyWarn).toHaveBeenCalledTimes(1);
    expect(spyError).toHaveBeenCalledTimes(1);

    spyInfo.mockRestore();
    spyWarn.mockRestore();
    spyError.mockRestore();
    delete process.env.LOGGER_ENABLED;
  });
});
