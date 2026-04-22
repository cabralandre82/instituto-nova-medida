/**
 * Testes do guard de takeover de customer (PR-054 · D-065 · finding 5.8).
 *
 * Foco no comportamento PURO de `decideCustomerUpsert` (todos os ramos
 * da árvore de decisão + computeChangedFields) e no `logCustomerUpsertDecision`
 * (decide quando logar e o shape do payload).
 */

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  decideCustomerUpsert,
  logCustomerUpsertDecision,
  type ExistingCustomerSnapshot,
  type IncomingCustomerPii,
} from "./customer-pii-guard";

function baseExisting(
  overrides: Partial<ExistingCustomerSnapshot> = {}
): ExistingCustomerSnapshot {
  return {
    id: "cust-1",
    user_id: null,
    name: "Maria Souza",
    email: "maria@example.com",
    phone: "11999990000",
    address_zipcode: "01310100",
    address_street: "Av Paulista",
    address_number: "1000",
    address_complement: null,
    address_district: "Bela Vista",
    address_city: "São Paulo",
    address_state: "SP",
    ...overrides,
  };
}

function baseIncoming(
  overrides: Partial<IncomingCustomerPii> = {}
): IncomingCustomerPii {
  return {
    name: "Maria Souza",
    email: "maria@example.com",
    phone: "11999990000",
    address: {
      zipcode: "01310100",
      street: "Av Paulista",
      number: "1000",
      district: "Bela Vista",
      city: "São Paulo",
      state: "SP",
    },
    ...overrides,
  };
}

describe("decideCustomerUpsert — árvore de decisão", () => {
  it("permite update_full quando customer não tem user_id (paciente fantasma)", () => {
    const decision = decideCustomerUpsert({
      existing: baseExisting({ user_id: null }),
      incoming: baseIncoming({ email: "novo@example.com" }),
      sessionUserId: null,
    });
    expect(decision.action).toBe("update_full");
    if (decision.action !== "update_full") return;
    expect(decision.reason).toBe("no_user_id_link");
    expect(decision.changedFields).toEqual(["email"]);
  });

  it("permite update_full quando user_id existe E sessão patient bate", () => {
    const decision = decideCustomerUpsert({
      existing: baseExisting({ user_id: "user-abc" }),
      incoming: baseIncoming({ phone: "11900000000" }),
      sessionUserId: "user-abc",
    });
    expect(decision.action).toBe("update_full");
    if (decision.action !== "update_full") return;
    expect(decision.reason).toBe("session_matches_user_id");
    expect(decision.changedFields).toEqual(["phone"]);
  });

  it("BLOQUEIA quando user_id existe E nenhuma sessão (cenário de takeover anônimo)", () => {
    const decision = decideCustomerUpsert({
      existing: baseExisting({ user_id: "user-vitima" }),
      incoming: baseIncoming({
        email: "atacante@evil.com",
        phone: "11888887777",
      }),
      sessionUserId: null,
    });
    expect(decision.action).toBe("update_blocked");
    if (decision.action !== "update_blocked") return;
    expect(decision.reason).toBe("user_id_set_no_session");
    expect(decision.defendedCustomerUserId).toBe("user-vitima");
    expect(decision.changedFields).toEqual(["email", "phone"]);
  });

  it("BLOQUEIA quando user_id existe E sessão patient é de OUTRO usuário", () => {
    const decision = decideCustomerUpsert({
      existing: baseExisting({ user_id: "user-vitima" }),
      incoming: baseIncoming({ email: "atacante@evil.com" }),
      sessionUserId: "user-atacante",
    });
    expect(decision.action).toBe("update_blocked");
    if (decision.action !== "update_blocked") return;
    expect(decision.reason).toBe("user_id_set_other_session");
    expect(decision.defendedCustomerUserId).toBe("user-vitima");
  });

  it("permite update_full sem mudanças quando incoming === existing (changedFields vazio)", () => {
    const decision = decideCustomerUpsert({
      existing: baseExisting({ user_id: null }),
      incoming: baseIncoming(),
      sessionUserId: null,
    });
    expect(decision.action).toBe("update_full");
    if (decision.action !== "update_full") return;
    expect(decision.changedFields).toEqual([]);
  });
});

describe("decideCustomerUpsert — computeChangedFields normalização", () => {
  it("ignora diferença de case em email", () => {
    const decision = decideCustomerUpsert({
      existing: baseExisting({ email: "Maria@Example.COM" }),
      incoming: baseIncoming({ email: "maria@example.com" }),
      sessionUserId: null,
    });
    if (decision.action !== "update_full") throw new Error("expected update_full");
    expect(decision.changedFields).not.toContain("email");
  });

  it("ignora diferença de máscara em phone (só dígitos importam)", () => {
    const decision = decideCustomerUpsert({
      existing: baseExisting({ phone: "(11) 99999-0000" }),
      incoming: baseIncoming({ phone: "11999990000" }),
      sessionUserId: null,
    });
    if (decision.action !== "update_full") throw new Error("expected update_full");
    expect(decision.changedFields).not.toContain("phone");
  });

  it("ignora diferença de máscara em zipcode", () => {
    const decision = decideCustomerUpsert({
      existing: baseExisting({ address_zipcode: "01310-100" }),
      incoming: baseIncoming({
        address: { ...baseIncoming().address, zipcode: "01310100" },
      }),
      sessionUserId: null,
    });
    if (decision.action !== "update_full") throw new Error("expected update_full");
    expect(decision.changedFields).not.toContain("address_zipcode");
  });

  it("ignora trim em strings (espaços extras)", () => {
    const decision = decideCustomerUpsert({
      existing: baseExisting({ name: "Maria Souza" }),
      incoming: baseIncoming({ name: "  Maria Souza  " }),
      sessionUserId: null,
    });
    if (decision.action !== "update_full") throw new Error("expected update_full");
    expect(decision.changedFields).not.toContain("name");
  });

  it("complement: '' e null são equivalentes", () => {
    const decision = decideCustomerUpsert({
      existing: baseExisting({ address_complement: null }),
      incoming: baseIncoming({
        address: { ...baseIncoming().address, complement: "" },
      }),
      sessionUserId: null,
    });
    if (decision.action !== "update_full") throw new Error("expected update_full");
    expect(decision.changedFields).not.toContain("address_complement");
  });

  it("estado: 'sp' vs 'SP' não conta como diff", () => {
    const decision = decideCustomerUpsert({
      existing: baseExisting({ address_state: "SP" }),
      incoming: baseIncoming({
        address: { ...baseIncoming().address, state: "sp" },
      }),
      sessionUserId: null,
    });
    if (decision.action !== "update_full") throw new Error("expected update_full");
    expect(decision.changedFields).not.toContain("address_state");
  });

  it("retorna ordem alfabética estável", () => {
    const decision = decideCustomerUpsert({
      existing: baseExisting(),
      incoming: baseIncoming({
        name: "Outra Pessoa",
        email: "outro@example.com",
        phone: "11000000000",
      }),
      sessionUserId: null,
    });
    if (decision.action !== "update_full") throw new Error("expected update_full");
    expect(decision.changedFields).toEqual(["email", "name", "phone"]);
  });

  it("detecta diff em todos os campos de endereço", () => {
    const decision = decideCustomerUpsert({
      existing: baseExisting(),
      incoming: baseIncoming({
        address: {
          zipcode: "20040020",
          street: "Av Rio Branco",
          number: "1",
          complement: "Sala 100",
          district: "Centro",
          city: "Rio de Janeiro",
          state: "RJ",
        },
      }),
      sessionUserId: null,
    });
    if (decision.action !== "update_full") throw new Error("expected update_full");
    expect(decision.changedFields).toEqual([
      "address_city",
      "address_complement",
      "address_district",
      "address_number",
      "address_state",
      "address_street",
      "address_zipcode",
    ]);
  });
});

describe("logCustomerUpsertDecision — política de log", () => {
  function makeSupabaseMock() {
    const inserts: unknown[] = [];
    const insert = vi.fn((row: unknown) => {
      inserts.push(row);
      return {
        select: () => ({
          single: () =>
            Promise.resolve({ data: { id: "log-1" }, error: null }),
        }),
      };
    });
    const supabase = {
      from: vi.fn(() => ({ insert })),
    } as unknown as SupabaseClient;
    return { supabase, inserts, insert };
  }

  it("não loga quando update_full sem mudanças (não-evento)", async () => {
    const { supabase, insert } = makeSupabaseMock();
    await logCustomerUpsertDecision(supabase, {
      decision: {
        action: "update_full",
        reason: "no_user_id_link",
        changedFields: [],
      },
      customerId: "cust-1",
      sessionUserId: null,
      routeName: "/api/checkout",
      ipAddress: "1.2.3.4",
      userAgent: "ua",
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it("loga 'pii_updated_unauthenticated' quando update_full com diff E sem sessão", async () => {
    const { supabase, inserts } = makeSupabaseMock();
    await logCustomerUpsertDecision(supabase, {
      decision: {
        action: "update_full",
        reason: "no_user_id_link",
        changedFields: ["email"],
      },
      customerId: "cust-1",
      sessionUserId: null,
      routeName: "/api/checkout",
      ipAddress: "1.2.3.4",
      userAgent: "ua",
    });
    expect(inserts).toHaveLength(1);
    const row = inserts[0] as Record<string, unknown>;
    expect(row.action).toBe("pii_updated_unauthenticated");
    expect(row.actor_kind).toBe("system");
    expect(row.customer_id).toBe("cust-1");
    expect((row.metadata as Record<string, unknown>).changed_fields).toEqual([
      "email",
    ]);
    expect((row.metadata as Record<string, unknown>).route).toBe(
      "/api/checkout"
    );
  });

  it("loga 'pii_updated_authenticated' quando update_full com diff E sessão bate", async () => {
    const { supabase, inserts } = makeSupabaseMock();
    await logCustomerUpsertDecision(supabase, {
      decision: {
        action: "update_full",
        reason: "session_matches_user_id",
        changedFields: ["phone"],
      },
      customerId: "cust-1",
      sessionUserId: "user-abc",
      routeName: "/api/agendar/reserve",
      ipAddress: null,
      userAgent: null,
    });
    expect(inserts).toHaveLength(1);
    const row = inserts[0] as Record<string, unknown>;
    expect(row.action).toBe("pii_updated_authenticated");
    expect((row.metadata as Record<string, unknown>).patient_user_id).toBe(
      "user-abc"
    );
  });

  it("SEMPRE loga 'pii_takeover_blocked' (mesmo sem mudanças)", async () => {
    const { supabase, inserts } = makeSupabaseMock();
    await logCustomerUpsertDecision(supabase, {
      decision: {
        action: "update_blocked",
        reason: "user_id_set_no_session",
        changedFields: [],
        defendedCustomerUserId: "user-vitima",
      },
      customerId: "cust-1",
      sessionUserId: null,
      routeName: "/api/checkout",
      ipAddress: "1.2.3.4",
      userAgent: "ua",
    });
    expect(inserts).toHaveLength(1);
    const row = inserts[0] as Record<string, unknown>;
    expect(row.action).toBe("pii_takeover_blocked");
    expect(
      (row.metadata as Record<string, unknown>).defended_customer_user_id
    ).toBe("user-vitima");
  });

  it("loga campos corretos de blocked com sessão de outro user", async () => {
    const { supabase, inserts } = makeSupabaseMock();
    await logCustomerUpsertDecision(supabase, {
      decision: {
        action: "update_blocked",
        reason: "user_id_set_other_session",
        changedFields: ["email", "phone"],
        defendedCustomerUserId: "user-vitima",
      },
      customerId: "cust-1",
      sessionUserId: "user-atacante",
      routeName: "/api/checkout",
      ipAddress: "9.9.9.9",
      userAgent: "evil-ua",
    });
    const row = inserts[0] as Record<string, unknown>;
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.decision_reason).toBe("user_id_set_other_session");
    expect(meta.changed_fields).toEqual(["email", "phone"]);
    expect(meta.patient_user_id).toBe("user-atacante");
    expect(meta.defended_customer_user_id).toBe("user-vitima");
    expect(meta.ip).toBe("9.9.9.9");
  });

  it("não lança quando o INSERT do log falha (failSoft)", async () => {
    const supabase = {
      from: vi.fn(() => ({
        insert: vi.fn(() => ({
          select: () => ({
            single: () =>
              Promise.resolve({
                data: null,
                error: { message: "boom" },
              }),
          }),
        })),
      })),
    };
    await expect(
      logCustomerUpsertDecision(
        supabase as unknown as SupabaseClient,
        {
          decision: {
            action: "update_blocked",
            reason: "user_id_set_no_session",
            changedFields: ["email"],
            defendedCustomerUserId: "user-vitima",
          },
          customerId: "cust-1",
          sessionUserId: null,
          routeName: "/api/checkout",
          ipAddress: null,
          userAgent: null,
        }
      )
    ).resolves.toBeUndefined();
  });
});
