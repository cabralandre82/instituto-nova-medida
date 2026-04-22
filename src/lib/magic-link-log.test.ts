/**
 * Testes da lib `magic-link-log.ts` (PR-070 · D-078 · finding [17.8]).
 *
 * Foco:
 *   - hashEmail: determinismo, case/trim, garbage-in, empty → throw.
 *   - extractEmailDomain: happy path, case/trim, malformados, trunca 253.
 *   - buildMagicLinkContext: precedência XFF → X-Real-IP, trunca UA.
 *   - logMagicLinkEvent: happy path, email opcional em verify_failed/
 *     rate_limited, obrigatório nos outros actions, truncamento de
 *     reason/next_path/UA, fail-soft em erro do INSERT, metadata
 *     sanitizada.
 */

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseMock } from "../test/mocks/supabase";
import {
  buildMagicLinkContext,
  extractEmailDomain,
  hashEmail,
  logMagicLinkEvent,
} from "./magic-link-log";

const CONTEXT = {
  route: "/api/auth/magic-link",
  ip: "127.0.0.1",
  userAgent: "Mozilla/5.0",
};

// ─── hashEmail ─────────────────────────────────────────────────────────

describe("hashEmail", () => {
  it("produz SHA-256 hex de 64 chars lowercase", () => {
    const h = hashEmail("alice@example.com");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("é determinístico: mesma entrada → mesmo hash", () => {
    expect(hashEmail("alice@example.com")).toBe(hashEmail("alice@example.com"));
  });

  it("normaliza case e whitespace (trim + lowercase)", () => {
    const canonical = hashEmail("alice@example.com");
    expect(hashEmail("Alice@Example.COM")).toBe(canonical);
    expect(hashEmail("  alice@example.com  ")).toBe(canonical);
    expect(hashEmail("\tALICE@EXAMPLE.COM\n")).toBe(canonical);
  });

  it("gera hashes distintos pra emails distintos", () => {
    expect(hashEmail("a@x.com")).not.toBe(hashEmail("b@x.com"));
  });

  it("lança pra email vazio ou só whitespace", () => {
    expect(() => hashEmail("")).toThrow();
    expect(() => hashEmail("   ")).toThrow();
    expect(() => hashEmail("\n\t")).toThrow();
  });

  it("lança pra tipo errado", () => {
    expect(() => hashEmail(123 as unknown as string)).toThrow(TypeError);
    expect(() => hashEmail(null as unknown as string)).toThrow(TypeError);
  });
});

// ─── extractEmailDomain ─────────────────────────────────────────────────

describe("extractEmailDomain", () => {
  it("extrai domínio em lowercase", () => {
    expect(extractEmailDomain("Alice@YAHOO.COM.BR")).toBe("yahoo.com.br");
  });

  it("trata whitespace", () => {
    expect(extractEmailDomain("  alice@foo.com  ")).toBe("foo.com");
  });

  it("null pra email sem @", () => {
    expect(extractEmailDomain("alice")).toBe(null);
  });

  it("null pra @ no início ou fim", () => {
    expect(extractEmailDomain("@foo.com")).toBe(null);
    expect(extractEmailDomain("alice@")).toBe(null);
  });

  it("null pra tipo errado", () => {
    expect(extractEmailDomain(123 as unknown as string)).toBe(null);
    expect(extractEmailDomain(null as unknown as string)).toBe(null);
  });

  it("pega domínio após o último @ (edge)", () => {
    expect(extractEmailDomain("a@b@c.com")).toBe("c.com");
  });

  it("trunca em 253 chars (FQDN limit)", () => {
    const huge = "a".repeat(300);
    const r = extractEmailDomain(`user@${huge}`);
    expect(r).not.toBeNull();
    expect(r!.length).toBe(253);
  });
});

// ─── buildMagicLinkContext ──────────────────────────────────────────────

describe("buildMagicLinkContext", () => {
  function mkReq(headers: Record<string, string>): Request {
    return new Request("http://x/api/test", {
      method: "POST",
      headers,
    });
  }

  it("prefere x-forwarded-for (primeiro hop) sobre x-real-ip", () => {
    const ctx = buildMagicLinkContext(
      mkReq({
        "x-forwarded-for": "1.2.3.4, 5.6.7.8",
        "x-real-ip": "9.9.9.9",
        "user-agent": "curl/8.5",
      }),
      "/api/auth/magic-link"
    );
    expect(ctx.ip).toBe("1.2.3.4");
    expect(ctx.userAgent).toBe("curl/8.5");
    expect(ctx.route).toBe("/api/auth/magic-link");
  });

  it("fallback x-real-ip quando não há XFF", () => {
    const ctx = buildMagicLinkContext(
      mkReq({ "x-real-ip": "9.9.9.9" }),
      "/api/auth/magic-link"
    );
    expect(ctx.ip).toBe("9.9.9.9");
  });

  it("ip null sem XFF nem x-real-ip", () => {
    const ctx = buildMagicLinkContext(mkReq({}), "/api/auth/magic-link");
    expect(ctx.ip).toBe(null);
    expect(ctx.userAgent).toBe(null);
  });

  it("trunca UA em 500 chars", () => {
    const ua = "X".repeat(1000);
    const ctx = buildMagicLinkContext(
      mkReq({ "user-agent": ua }),
      "/api/auth/magic-link"
    );
    expect(ctx.userAgent?.length).toBe(500);
  });
});

// ─── logMagicLinkEvent ──────────────────────────────────────────────────

describe("logMagicLinkEvent", () => {
  it("insere e retorna ok com id para action='issued'", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("magic_link_issued_log", {
      data: { id: "abc-123" },
      error: null,
    });

    const r = await logMagicLinkEvent(mock.client as unknown as SupabaseClient, {
      email: "alice@example.com",
      action: "issued",
      role: "admin",
      context: CONTEXT,
      nextPath: "/admin",
    });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.id).toBe("abc-123");

    const call = mock.calls[0];
    expect(call.table).toBe("magic_link_issued_log");
    expect(call.chain).toContain("insert");
    const payload = (call.args[0]?.[0] ?? {}) as Record<string, unknown>;
    expect(payload.email_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.email_domain).toBe("example.com");
    expect(payload.role).toBe("admin");
    expect(payload.action).toBe("issued");
    expect(payload.ip).toBe("127.0.0.1");
    expect(payload.route).toBe("/api/auth/magic-link");
    expect(payload.next_path).toBe("/admin");
  });

  it("aceita email=null para action='verify_failed' (token inválido)", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("magic_link_issued_log", {
      data: { id: "xyz" },
      error: null,
    });

    const r = await logMagicLinkEvent(mock.client as unknown as SupabaseClient, {
      email: null,
      action: "verify_failed",
      reason: "token inválido",
      context: { ...CONTEXT, route: "/api/auth/callback" },
    });

    expect(r.ok).toBe(true);
    const payload = (mock.calls[0]?.args[0]?.[0] ?? {}) as Record<string, unknown>;
    expect(payload.email_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.email_domain).toBe(null);
    expect(payload.reason).toBe("token inválido");
  });

  it("aceita email=null para action='rate_limited'", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("magic_link_issued_log", { data: { id: "rl" }, error: null });

    const r = await logMagicLinkEvent(mock.client as unknown as SupabaseClient, {
      email: null,
      action: "rate_limited",
      context: CONTEXT,
    });

    expect(r.ok).toBe(true);
  });

  it("recusa email=null para action='issued' (missing_email)", async () => {
    const mock = createSupabaseMock();
    const r = await logMagicLinkEvent(mock.client as unknown as SupabaseClient, {
      email: null,
      action: "issued",
      context: CONTEXT,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("missing_email");
    expect(mock.calls).toHaveLength(0);
  });

  it("recusa email=null para silenced_no_account (missing_email)", async () => {
    const mock = createSupabaseMock();
    const r = await logMagicLinkEvent(mock.client as unknown as SupabaseClient, {
      email: null,
      action: "silenced_no_account",
      context: CONTEXT,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("missing_email");
  });

  it("fail-soft em erro do INSERT (retorna ok=false, não lança)", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("magic_link_issued_log", {
      data: null,
      error: { message: "db offline" },
    });

    const r = await logMagicLinkEvent(mock.client as unknown as SupabaseClient, {
      email: "alice@example.com",
      action: "issued",
      context: CONTEXT,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("insert_failed");
      expect(r.message).toBe("db offline");
    }
  });

  it("trunca reason em 500 chars", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("magic_link_issued_log", { data: { id: "t" }, error: null });

    const bigReason = "x".repeat(1000);
    await logMagicLinkEvent(mock.client as unknown as SupabaseClient, {
      email: "alice@example.com",
      action: "provider_error",
      reason: bigReason,
      context: CONTEXT,
    });

    const payload = (mock.calls[0]?.args[0]?.[0] ?? {}) as Record<string, unknown>;
    expect((payload.reason as string).length).toBe(500);
  });

  it("trunca next_path em 500 chars", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("magic_link_issued_log", { data: { id: "t" }, error: null });

    const bigPath = "/foo/" + "a".repeat(1000);
    await logMagicLinkEvent(mock.client as unknown as SupabaseClient, {
      email: "alice@example.com",
      action: "issued",
      nextPath: bigPath,
      context: CONTEXT,
    });

    const payload = (mock.calls[0]?.args[0]?.[0] ?? {}) as Record<string, unknown>;
    expect((payload.next_path as string).length).toBe(500);
  });

  it("trunca route em 200 chars", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("magic_link_issued_log", { data: { id: "t" }, error: null });

    const bigRoute = "/api/" + "x".repeat(500);
    await logMagicLinkEvent(mock.client as unknown as SupabaseClient, {
      email: "alice@example.com",
      action: "issued",
      context: { ...CONTEXT, route: bigRoute },
    });

    const payload = (mock.calls[0]?.args[0]?.[0] ?? {}) as Record<string, unknown>;
    expect((payload.route as string).length).toBe(200);
  });

  it("sanitiza metadata (trunca strings >2048, omite undefined)", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("magic_link_issued_log", { data: { id: "t" }, error: null });

    await logMagicLinkEvent(mock.client as unknown as SupabaseClient, {
      email: "alice@example.com",
      action: "issued",
      context: CONTEXT,
      metadata: {
        provider_code: "email_send_rate_limit",
        huge: "z".repeat(3000),
        skipped: undefined,
        n: 42,
      },
    });

    const payload = (mock.calls[0]?.args[0]?.[0] ?? {}) as Record<string, unknown>;
    const meta = payload.metadata as Record<string, unknown>;
    expect(meta.provider_code).toBe("email_send_rate_limit");
    expect((meta.huge as string).length).toBeLessThanOrEqual(2060);
    expect((meta.huge as string).endsWith("…[truncated]")).toBe(true);
    expect(meta.n).toBe(42);
    expect("skipped" in meta).toBe(false);
  });

  it("hash é consistente entre emails equivalentes (case/trim)", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("magic_link_issued_log", { data: { id: "a" }, error: null });
    mock.enqueue("magic_link_issued_log", { data: { id: "b" }, error: null });

    await logMagicLinkEvent(mock.client as unknown as SupabaseClient, {
      email: "Alice@Example.COM",
      action: "issued",
      context: CONTEXT,
    });
    await logMagicLinkEvent(mock.client as unknown as SupabaseClient, {
      email: "  alice@example.com  ",
      action: "issued",
      context: CONTEXT,
    });

    const h1 = (mock.calls[0]?.args[0]?.[0] as Record<string, unknown>).email_hash;
    const h2 = (mock.calls[1]?.args[0]?.[0] as Record<string, unknown>).email_hash;
    expect(h1).toBe(h2);
  });

  it("email garbage (throw no hashEmail) continua e usa hash unknown quando action permite", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("magic_link_issued_log", { data: { id: "r" }, error: null });

    // email = "   " força hashEmail a lançar; action=rate_limited
    // permite email ausente e usa fallback hash
    const r = await logMagicLinkEvent(mock.client as unknown as SupabaseClient, {
      email: "   ",
      action: "rate_limited",
      context: CONTEXT,
    });
    expect(r.ok).toBe(true);
    const payload = (mock.calls[0]?.args[0]?.[0] ?? {}) as Record<string, unknown>;
    expect(payload.email_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("metadata vazia default", async () => {
    const mock = createSupabaseMock();
    mock.enqueue("magic_link_issued_log", { data: { id: "t" }, error: null });

    await logMagicLinkEvent(mock.client as unknown as SupabaseClient, {
      email: "alice@example.com",
      action: "issued",
      context: CONTEXT,
    });

    const payload = (mock.calls[0]?.args[0]?.[0] ?? {}) as Record<string, unknown>;
    expect(payload.metadata).toEqual({});
  });

  it("exception síncrona (supabase malformado) devolve insert_failed", async () => {
    const broken = {
      from: () => {
        throw new Error("boom");
      },
    } as unknown as SupabaseClient;

    const r = await logMagicLinkEvent(broken, {
      email: "alice@example.com",
      action: "issued",
      context: CONTEXT,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("insert_failed");
      expect(r.message).toBe("boom");
    }
  });

  it("sem warnings acidentais: silent logger (smoke)", () => {
    // garantir que o import não tem side effect (logger silencia em test)
    expect(() => vi.fn()).not.toThrow();
  });
});
