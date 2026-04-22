/**
 * src/lib/user-retention.test.ts — PR-064 · D-072
 *
 * Testes unitários pra `anonymizeUserAccount` + helpers.
 * Mock do `supabase.auth.admin` (não temos mock framework de auth, mas
 * a superfície de chamada é pequena — criamos stub manual).
 */

import { describe, it, expect, vi } from "vitest";
import {
  anonymizedEmailForUser,
  anonymizeUserAccount,
  isAnonymizedEmail,
  ANON_USER_EMAIL_DOMAIN,
} from "./user-retention";
import type { SupabaseClient } from "@supabase/supabase-js";

function makeAdminStub(handlers: {
  getUserById?: (id: string) => unknown;
  updateUserById?: (id: string, attrs: unknown) => unknown;
}): SupabaseClient {
  const auth = {
    admin: {
      getUserById: vi.fn(async (id: string) => handlers.getUserById?.(id) ?? { data: null, error: { message: "not mocked" } }),
      updateUserById: vi.fn(async (id: string, attrs: unknown) =>
        handlers.updateUserById?.(id, attrs) ?? { data: null, error: { message: "not mocked" } }
      ),
    },
  };
  return { auth } as unknown as SupabaseClient;
}

describe("anonymizedEmailForUser", () => {
  it("produz email determinístico com dominio reservado", () => {
    const a = anonymizedEmailForUser("user-123");
    const b = anonymizedEmailForUser("user-123");
    expect(a).toBe(b);
    expect(a).toMatch(new RegExp(`@${ANON_USER_EMAIL_DOMAIN}$`));
    expect(a.startsWith("anon-")).toBe(true);
  });

  it("produz emails diferentes pra user_ids diferentes", () => {
    expect(anonymizedEmailForUser("a")).not.toBe(
      anonymizedEmailForUser("b")
    );
  });
});

describe("isAnonymizedEmail", () => {
  it("reconhece emails com sufixo deleted.local", () => {
    expect(isAnonymizedEmail("anon-abc@deleted.local")).toBe(true);
    expect(isAnonymizedEmail("ANON-abc@DELETED.LOCAL")).toBe(true);
  });

  it("rejeita emails comuns", () => {
    expect(isAnonymizedEmail("real@example.com")).toBe(false);
    expect(isAnonymizedEmail(null)).toBe(false);
    expect(isAnonymizedEmail("")).toBe(false);
    expect(isAnonymizedEmail(undefined)).toBe(false);
  });
});

describe("anonymizeUserAccount", () => {
  it("rejeita userId vazio", async () => {
    const stub = makeAdminStub({});
    const res = await anonymizeUserAccount(stub, "");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("invalid_user_id");
  });

  it("rejeita userId whitespace", async () => {
    const stub = makeAdminStub({});
    const res = await anonymizeUserAccount(stub, "   ");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("invalid_user_id");
  });

  it("retorna not_found quando user não existe", async () => {
    const stub = makeAdminStub({
      getUserById: () => ({ data: null, error: { message: "not found" } }),
    });
    const res = await anonymizeUserAccount(stub, "ghost-user");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not_found");
  });

  it("retorna already_anonymized (ok=true) se email já é placeholder", async () => {
    const stub = makeAdminStub({
      getUserById: () => ({
        data: {
          user: {
            id: "u-1",
            email: "anon-abc@deleted.local",
            user_metadata: { anonymized_at: "2026-04-01T00:00:00Z" },
            updated_at: "2026-04-01T00:00:00Z",
          },
        },
        error: null,
      }),
    });
    const res = await anonymizeUserAccount(stub, "u-1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.alreadyAnonymized).toBe(true);
      expect(res.anonymizedAt).toBe("2026-04-01T00:00:00Z");
      expect(res.anonymizedEmail).toBe("anon-abc@deleted.local");
    }
  });

  it("anonimiza user fresh: chama updateUserById com email placeholder + ban", async () => {
    const updateCalls: Array<{ id: string; attrs: unknown }> = [];
    const stub = makeAdminStub({
      getUserById: () => ({
        data: {
          user: {
            id: "u-1",
            email: "admin@example.com",
            phone: "+5511999999999",
          },
        },
        error: null,
      }),
      updateUserById: (id, attrs) => {
        updateCalls.push({ id, attrs });
        return { data: { user: { id } }, error: null };
      },
    });
    const now = new Date("2026-05-10T12:34:56Z");
    const res = await anonymizeUserAccount(stub, "u-1", { now });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.alreadyAnonymized).toBe(false);
      expect(res.anonymizedAt).toBe(now.toISOString());
      expect(res.anonymizedEmail).toMatch(/^anon-[0-9a-f]+@deleted\.local$/);
    }

    expect(updateCalls).toHaveLength(1);
    const attrs = updateCalls[0].attrs as Record<string, unknown>;
    expect(attrs.email).toMatch(/^anon-[0-9a-f]+@deleted\.local$/);
    expect(attrs.phone).toBe("");
    expect(attrs.ban_duration).toBe("876000h");
    const userMeta = attrs.user_metadata as Record<string, unknown>;
    expect(userMeta.anonymized_at).toBe(now.toISOString());
    expect(userMeta.anonymized_reason).toBe("user_retention");
  });

  it("retorna update_failed quando updateUserById falha", async () => {
    const stub = makeAdminStub({
      getUserById: () => ({
        data: {
          user: { id: "u-1", email: "admin@example.com" },
        },
        error: null,
      }),
      updateUserById: () => ({
        data: null,
        error: { message: "network timeout" },
      }),
    });
    const res = await anonymizeUserAccount(stub, "u-1");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("update_failed");
      expect(res.message).toContain("network timeout");
    }
  });

  it("email determinístico: mesmo user → mesmo placeholder", async () => {
    const stub = makeAdminStub({
      getUserById: () => ({
        data: { user: { id: "u-42", email: "x@y.com" } },
        error: null,
      }),
      updateUserById: () => ({ data: { user: { id: "u-42" } }, error: null }),
    });
    const a = await anonymizeUserAccount(stub, "u-42");
    const b = await anonymizeUserAccount(stub, "u-42");
    if (a.ok && b.ok) {
      expect(a.anonymizedEmail).toBe(b.anonymizedEmail);
    }
  });
});
