/**
 * Testes do helper de audit trail de signed URLs (PR-055 · D-066 · 17.4).
 */

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildSignedUrlContext,
  logSignedUrlIssued,
  type LogSignedUrlInput,
} from "./signed-url-log";

function makeSupabaseMock(options: {
  insertError?: { message: string } | null;
  returnsData?: boolean;
}) {
  const inserts: unknown[] = [];
  const insert = vi.fn((row: unknown) => {
    inserts.push(row);
    return {
      select: () => ({
        single: () =>
          Promise.resolve({
            data: options.returnsData === false ? null : { id: "log-1" },
            error: options.insertError ?? null,
          }),
      }),
    };
  });
  const from = vi.fn(() => ({ insert }));
  const supabase = { from } as unknown as SupabaseClient;
  return { supabase, inserts, insert, from };
}

function baseInput(overrides: Partial<LogSignedUrlInput> = {}): LogSignedUrlInput {
  return {
    actor: {
      kind: "admin",
      userId: "user-admin-1",
      email: "admin@example.com",
    },
    resource: {
      type: "payout_proof",
      id: "payout-1",
      doctorId: "doc-1",
      storagePath: "payouts/abc.pdf",
    },
    context: {
      route: "/api/admin/payouts/[id]/proof",
      ip: "1.2.3.4",
      userAgent: "ua",
    },
    signedUrlExpiresAt: "2026-04-20T12:00:00.000Z",
    metadata: { ttl_seconds: 60 },
    ...overrides,
  };
}

describe("logSignedUrlIssued — happy paths", () => {
  it("insere payout_proof como admin com action default 'signed_url_issued'", async () => {
    const { supabase, inserts } = makeSupabaseMock({});
    const result = await logSignedUrlIssued(supabase, baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.id).toBe("log-1");
    expect(inserts).toHaveLength(1);
    const row = inserts[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      actor_user_id: "user-admin-1",
      actor_email: "admin@example.com",
      actor_kind: "admin",
      resource_type: "payout_proof",
      resource_id: "payout-1",
      doctor_id: "doc-1",
      storage_path: "payouts/abc.pdf",
      signed_url_expires_at: "2026-04-20T12:00:00.000Z",
      action: "signed_url_issued",
      route: "/api/admin/payouts/[id]/proof",
      ip: "1.2.3.4",
      user_agent: "ua",
    });
    expect(row.metadata).toEqual({ ttl_seconds: 60 });
  });

  it("insere billing_document como doctor", async () => {
    const { supabase, inserts } = makeSupabaseMock({});
    await logSignedUrlIssued(
      supabase,
      baseInput({
        actor: {
          kind: "doctor",
          userId: "user-doctor-1",
          email: "dr@example.com",
        },
        resource: {
          type: "billing_document",
          id: "payout-2",
          doctorId: "doc-1",
          storagePath: "billing/xyz.pdf",
        },
        metadata: { document_id: "doc-bill-99", ttl_seconds: 60 },
      })
    );
    const row = inserts[0] as Record<string, unknown>;
    expect(row.actor_kind).toBe("doctor");
    expect(row.resource_type).toBe("billing_document");
    expect(row.metadata).toEqual({
      document_id: "doc-bill-99",
      ttl_seconds: 60,
    });
  });

  it("action='external_url_returned' zera signed_url_expires_at mesmo se input envia", async () => {
    const { supabase, inserts } = makeSupabaseMock({});
    await logSignedUrlIssued(
      supabase,
      baseInput({
        action: "external_url_returned",
        signedUrlExpiresAt: "2099-01-01T00:00:00Z",
      })
    );
    const row = inserts[0] as Record<string, unknown>;
    expect(row.action).toBe("external_url_returned");
    expect(row.signed_url_expires_at).toBeNull();
  });
});

describe("logSignedUrlIssued — validação de binding actor/kind", () => {
  it("rejeita admin sem userId", async () => {
    const { supabase, insert } = makeSupabaseMock({});
    const result = await logSignedUrlIssued(
      supabase,
      baseInput({
        actor: { kind: "admin", userId: null, email: "x" },
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("insert_failed");
    expect(result.message).toContain("exige actor.userId");
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejeita doctor sem userId", async () => {
    const { supabase, insert } = makeSupabaseMock({});
    const result = await logSignedUrlIssued(
      supabase,
      baseInput({
        actor: { kind: "doctor", userId: null, email: "x" },
      })
    );
    expect(result.ok).toBe(false);
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejeita system com userId (binding invertido)", async () => {
    const { supabase, insert } = makeSupabaseMock({});
    const result = await logSignedUrlIssued(
      supabase,
      baseInput({
        actor: { kind: "system", userId: "user-1", email: "system:x" },
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("não pode ter actor.userId");
    expect(insert).not.toHaveBeenCalled();
  });
});

describe("logSignedUrlIssued — failSoft", () => {
  it("retorna ok:false mas não lança quando INSERT falha", async () => {
    const { supabase } = makeSupabaseMock({
      insertError: { message: "db offline" },
    });
    const result = await logSignedUrlIssued(supabase, baseInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("insert_failed");
    expect(result.message).toBe("db offline");
  });

  it("retorna ok:false quando INSERT devolve sem linha", async () => {
    const { supabase } = makeSupabaseMock({ returnsData: false });
    const result = await logSignedUrlIssued(supabase, baseInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("insert_failed");
  });
});

describe("logSignedUrlIssued — sanitização de metadata", () => {
  it("trunca strings gigantes em metadata", async () => {
    const { supabase, inserts } = makeSupabaseMock({});
    const huge = "x".repeat(5000);
    await logSignedUrlIssued(
      supabase,
      baseInput({
        metadata: { evil: huge, ok: "short" },
      })
    );
    const row = inserts[0] as Record<string, unknown>;
    const meta = row.metadata as Record<string, unknown>;
    expect((meta.evil as string).length).toBeLessThanOrEqual(2048 + 20);
    expect(meta.evil).toContain("…[truncated]");
    expect(meta.ok).toBe("short");
  });

  it("metadata undefined vira objeto vazio", async () => {
    const { supabase, inserts } = makeSupabaseMock({});
    await logSignedUrlIssued(
      supabase,
      baseInput({ metadata: undefined })
    );
    const row = inserts[0] as Record<string, unknown>;
    expect(row.metadata).toEqual({});
  });
});

describe("logSignedUrlIssued — comportamento sem expires_at", () => {
  it("signed_url_issued sem expiresAt grava NULL e continua (warn apenas)", async () => {
    const { supabase, inserts } = makeSupabaseMock({});
    const result = await logSignedUrlIssued(
      supabase,
      baseInput({ signedUrlExpiresAt: null })
    );
    expect(result.ok).toBe(true);
    const row = inserts[0] as Record<string, unknown>;
    expect(row.signed_url_expires_at).toBeNull();
  });
});

describe("buildSignedUrlContext", () => {
  it("extrai ip, user-agent e route", () => {
    const req = new Request("https://x.test/api/admin/payouts/1/proof", {
      headers: {
        "x-forwarded-for": "203.0.113.4, 10.0.0.1",
        "user-agent": "Mozilla/5.0 test",
      },
    });
    const ctx = buildSignedUrlContext(req, "/api/admin/payouts/[id]/proof");
    expect(ctx.ip).toBe("203.0.113.4");
    expect(ctx.userAgent).toBe("Mozilla/5.0 test");
    expect(ctx.route).toBe("/api/admin/payouts/[id]/proof");
  });

  it("cai pra x-real-ip quando x-forwarded-for ausente", () => {
    const req = new Request("https://x.test/x", {
      headers: { "x-real-ip": "198.51.100.7" },
    });
    const ctx = buildSignedUrlContext(req, "/x");
    expect(ctx.ip).toBe("198.51.100.7");
  });

  it("devolve null pra headers ausentes", () => {
    const req = new Request("https://x.test/x");
    const ctx = buildSignedUrlContext(req, "/x");
    expect(ctx.ip).toBeNull();
    expect(ctx.userAgent).toBeNull();
    expect(ctx.route).toBe("/x");
  });
});
