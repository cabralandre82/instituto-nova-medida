/**
 * Testes — admin-audit-log.ts (PR-031 / audit [17.1]).
 *
 * Foco: contrato de não-bloqueio do helper, redação de inputs em insert,
 * extração de contexto HTTP.
 */

import { describe, expect, it, vi } from "vitest";
import { createSupabaseMock } from "@/test/mocks/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  logAdminAction,
  getAuditContextFromRequest,
} from "@/lib/admin-audit-log";
import { setSink, type LogEntry } from "@/lib/logger";

function asClient(mock: ReturnType<typeof createSupabaseMock>) {
  return mock.client as unknown as SupabaseClient;
}

function captureLogger(): { entries: LogEntry[]; restore: () => void } {
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

describe("logAdminAction", () => {
  it("persiste entrada completa e retorna id", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("admin_audit_log", {
      data: { id: "audit-1" },
      error: null,
    });

    const res = await logAdminAction(asClient(supa), {
      actorUserId: "user-1",
      actorEmail: "admin@example.com",
      action: "fulfillment.transition",
      entityType: "fulfillment",
      entityId: "ful-1",
      before: { status: "pending_acceptance" },
      after: { status: "pending_payment" },
      metadata: { reason: "Paciente aceitou via telefone" },
    });

    expect(res).toEqual({ ok: true, id: "audit-1" });
    expect(supa.calls).toHaveLength(1);
    expect(supa.calls[0].table).toBe("admin_audit_log");
    expect(supa.calls[0].chain).toContain("insert");

    // Confirma que o insert recebeu o payload esperado (argumento 0 de insert)
    const insertArgs = supa.calls[0].args[supa.calls[0].chain.indexOf("insert")];
    const payload = insertArgs?.[0] as Record<string, unknown>;
    expect(payload.actor_user_id).toBe("user-1");
    expect(payload.actor_email).toBe("admin@example.com");
    expect(payload.action).toBe("fulfillment.transition");
    expect(payload.entity_type).toBe("fulfillment");
    expect(payload.entity_id).toBe("ful-1");
    expect(payload.before_json).toEqual({ status: "pending_acceptance" });
    expect(payload.after_json).toEqual({ status: "pending_payment" });
    expect(payload.metadata).toEqual({
      reason: "Paciente aceitou via telefone",
    });
  });

  it("aceita campos omitidos (mapeia pra null) com actorKind='system'", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("admin_audit_log", {
      data: { id: "audit-2" },
      error: null,
    });

    // smoke/system actions — actorKind='system' exige actorUserId nulo.
    await logAdminAction(asClient(supa), {
      actorKind: "system",
      actorEmail: "system:smoke",
      action: "system.smoke_test",
    });

    const payload = supa.calls[0].args[
      supa.calls[0].chain.indexOf("insert")
    ]?.[0] as Record<string, unknown>;
    expect(payload.actor_user_id).toBeNull();
    expect(payload.actor_kind).toBe("system");
    expect(payload.entity_id).toBeNull();
    expect(payload.before_json).toBeNull();
    expect(payload.after_json).toBeNull();
    expect(payload.metadata).toBeNull();
  });

  it("NÃO bloqueia o caller quando o insert falha (default)", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("admin_audit_log", {
      data: null,
      error: { code: "42P01", message: "relation does not exist" },
    });

    const { entries, restore } = captureLogger();

    const res = await logAdminAction(asClient(supa), {
      actorUserId: "user-1",
      actorEmail: "admin@example.com",
      action: "payout.approve",
      entityType: "payout",
      entityId: "p-1",
    });

    expect(res).toEqual({ ok: true, id: null });
    expect(entries.some((e) => e.level === "error")).toBe(true);
    restore();
  });

  it("bloqueia o caller quando failHard=true e o insert falha", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("admin_audit_log", {
      data: null,
      error: { code: "42P01", message: "boom" },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await logAdminAction(
      asClient(supa),
      {
        actorUserId: "user-1",
        actorEmail: "admin@example.com",
        action: "customer.anonymize",
        entityType: "customer",
        entityId: "c-1",
      },
      { failHard: true }
    );

    expect(res).toEqual({ ok: false, error: "boom" });
  });

  it("trata exceções no cliente supabase sem vazar pro caller (default)", async () => {
    const throwingClient = {
      from: () => {
        throw new Error("supabase down");
      },
    } as unknown as SupabaseClient;
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await logAdminAction(throwingClient, {
      actorKind: "system",
      actorEmail: "system:test",
      action: "system.test",
    });
    expect(res).toEqual({ ok: true, id: null });
  });

  it("trata exceções como falha quando failHard=true", async () => {
    const throwingClient = {
      from: () => {
        throw new Error("supabase down");
      },
    } as unknown as SupabaseClient;
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await logAdminAction(
      throwingClient,
      {
        actorUserId: "user-1",
        actorEmail: "admin@example.com",
        action: "customer.anonymize",
      },
      { failHard: true }
    );
    expect(res).toEqual({ ok: false, error: "supabase down" });
  });

  it("rejeita actorKind='admin' sem actorUserId (constraint binding)", async () => {
    const supa = createSupabaseMock();
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await logAdminAction(asClient(supa), {
      action: "foo.bar",
    });
    expect(res.ok).toBe(true);
    expect((res as { id: string | null }).id).toBeNull();
    // Não chegou ao insert — rejeitado pela validação precoce.
    expect(supa.calls.filter((c) => c.chain.includes("insert"))).toHaveLength(
      0
    );
  });

  it("rejeita actorKind='system' com actorUserId (constraint binding)", async () => {
    const supa = createSupabaseMock();
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await logAdminAction(asClient(supa), {
      actorUserId: "user-1",
      actorKind: "system",
      action: "cron.retention",
    });
    expect(res.ok).toBe(true);
    expect((res as { id: string | null }).id).toBeNull();
    expect(supa.calls.filter((c) => c.chain.includes("insert"))).toHaveLength(
      0
    );
  });
});

describe("getAuditContextFromRequest", () => {
  it("extrai ip, user-agent, route", () => {
    const req = new Request("https://example.com/api/admin/fulfillments/abc", {
      headers: {
        "x-forwarded-for": "203.0.113.10, 10.0.0.1",
        "user-agent": "Mozilla/5.0",
      },
    });

    const ctx = getAuditContextFromRequest(req);
    expect(ctx.ip).toBe("203.0.113.10");
    expect(ctx.userAgent).toBe("Mozilla/5.0");
    expect(ctx.route).toBe("/api/admin/fulfillments/abc");
  });

  it("fallback pra x-real-ip quando x-forwarded-for ausente", () => {
    const req = new Request("https://example.com/api/admin/payouts/x", {
      headers: {
        "x-real-ip": "198.51.100.42",
      },
    });
    const ctx = getAuditContextFromRequest(req);
    expect(ctx.ip).toBe("198.51.100.42");
  });

  it("todos nulls quando nenhum header/URL válido", () => {
    const req = new Request("https://example.com/");
    const ctx = getAuditContextFromRequest(req);
    expect(ctx.ip).toBeNull();
    expect(ctx.userAgent).toBeNull();
    expect(ctx.route).toBe("/");
  });
});
