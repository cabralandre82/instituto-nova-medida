/**
 * Testes de appointment-credits — PR-073 · D-081 · finding 2.4.
 *
 * Foco nas partes puras (`computeCurrentStatus`, `isCreditActive`,
 * `daysUntilExpiry`) e nas partes IO do caminho feliz via stub leve
 * (grant idempotente, list ativo, markConsumed, cancel). Objetivo:
 * travar o contrato, não cobrir todos os erros de banco.
 */

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  cancelCredit,
  computeCurrentStatus,
  CREDIT_EXPIRY_DAYS,
  daysUntilExpiry,
  grantNoShowCredit,
  isCreditActive,
  listActiveCreditsForCustomer,
  markCreditConsumed,
  type AppointmentCreditRow,
} from "./appointment-credits";
import type { ActorSnapshot } from "./actor-snapshot";

const CUSTOMER = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const APPT = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const CREDIT = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
const APPT2 = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
const ADMIN_ID = "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee";

const NOW = new Date("2026-05-16T12:00:00.000Z");

function baseRow(
  over: Partial<AppointmentCreditRow> = {},
): AppointmentCreditRow {
  return {
    id: CREDIT,
    customer_id: CUSTOMER,
    source_appointment_id: APPT,
    source_reason: "no_show_doctor",
    status: "active",
    created_at: "2026-05-10T10:00:00Z",
    expires_at: "2026-08-08T10:00:00Z",
    consumed_at: null,
    consumed_appointment_id: null,
    consumed_by: null,
    consumed_by_email: null,
    cancelled_at: null,
    cancelled_reason: null,
    cancelled_by: null,
    cancelled_by_email: null,
    metadata: {},
    ...over,
  };
}

const ADMIN_ACTOR: ActorSnapshot = {
  userId: ADMIN_ID,
  email: "admin@clinic.local",
  kind: "admin",
};

// ────────────────────────────────────────────────────────────────────
// Puros
// ────────────────────────────────────────────────────────────────────

describe("computeCurrentStatus", () => {
  it("active + expires_at > now → active", () => {
    expect(
      computeCurrentStatus(
        { status: "active", expires_at: "2026-05-20T00:00:00Z" },
        NOW,
      ),
    ).toBe("active");
  });

  it("active + expires_at <= now → expired (computado)", () => {
    expect(
      computeCurrentStatus(
        { status: "active", expires_at: "2026-05-10T00:00:00Z" },
        NOW,
      ),
    ).toBe("expired");
  });

  it("consumed permanece consumed mesmo com expires_at no passado", () => {
    expect(
      computeCurrentStatus(
        { status: "consumed", expires_at: "2020-01-01T00:00:00Z" },
        NOW,
      ),
    ).toBe("consumed");
  });

  it("cancelled permanece cancelled", () => {
    expect(
      computeCurrentStatus(
        { status: "cancelled", expires_at: "2099-01-01T00:00:00Z" },
        NOW,
      ),
    ).toBe("cancelled");
  });

  it("expires_at inválido devolve o status bruto (sem throw)", () => {
    expect(
      computeCurrentStatus(
        { status: "active", expires_at: "not-a-date" as unknown as string },
        NOW,
      ),
    ).toBe("active");
  });
});

describe("isCreditActive", () => {
  it("true quando active e dentro do prazo", () => {
    expect(
      isCreditActive(
        { status: "active", expires_at: "2026-05-20T00:00:00Z" },
        NOW,
      ),
    ).toBe(true);
  });

  it("false quando consumed, mesmo no prazo", () => {
    expect(
      isCreditActive(
        { status: "consumed", expires_at: "2099-01-01T00:00:00Z" },
        NOW,
      ),
    ).toBe(false);
  });

  it("false quando active mas já expirou", () => {
    expect(
      isCreditActive(
        { status: "active", expires_at: "2020-01-01T00:00:00Z" },
        NOW,
      ),
    ).toBe(false);
  });
});

describe("daysUntilExpiry", () => {
  it("retorna dias positivos no futuro", () => {
    const fiveDays = new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000);
    expect(
      daysUntilExpiry({ expires_at: fiveDays.toISOString() }, NOW),
    ).toBe(5);
  });

  it("retorna negativo quando expirado", () => {
    const past = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000);
    expect(
      daysUntilExpiry({ expires_at: past.toISOString() }, NOW),
    ).toBeLessThan(0);
  });

  it("expires_at inválido devolve 0", () => {
    expect(
      daysUntilExpiry({ expires_at: "not-iso" as unknown as string }, NOW),
    ).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────
// IO — stubs manuais (não dependem de Supabase real)
// ────────────────────────────────────────────────────────────────────

/**
 * Stub mínimo do SupabaseClient que cobre só as chamadas que esta
 * lib faz: insert → select → single; update → eq.eq → select → maybeSingle;
 * select com eq/gt/order/limit/maybeSingle. Tipado como any no
 * retorno, o caller casta com `as unknown as SupabaseClient`.
 */
function makeClient(impls: {
  insert?: (payload: unknown) => { data: unknown; error: unknown };
  reselect?: (col: string, val: string) => { data: unknown; error: unknown };
  updateReturn?: { data: unknown; error: unknown };
  loadById?: (id: string) => { data: unknown; error: unknown };
  listActive?: () => { data: unknown[]; error: unknown };
}) {
  return {
    from(_table: string) {
      // ignora table; só 1 é usada por teste
      return {
        insert(payload: unknown) {
          return {
            select() {
              return {
                single: vi.fn(async () =>
                  impls.insert
                    ? impls.insert(payload)
                    : { data: null, error: null },
                ),
              };
            },
          };
        },
        update(_payload: unknown) {
          return {
            eq(_c1: string, _v1: string) {
              return {
                eq(_c2: string, _v2: string) {
                  return {
                    select() {
                      return {
                        maybeSingle: vi.fn(async () =>
                          impls.updateReturn ?? { data: null, error: null },
                        ),
                      };
                    },
                  };
                },
              };
            },
          };
        },
        // select encadeado: `.select(cols).eq(c,v)...`
        select(_cols: string) {
          const chain = {
            eq(col: string, val: string) {
              // Se for fetch por ID → loadById
              if (col === "id" && impls.loadById) {
                return {
                  maybeSingle: vi.fn(async () =>
                    impls.loadById!(val),
                  ),
                };
              }
              // list ativo: eq('customer_id')→eq('status')→gt(...)→order→limit
              return {
                eq(_c2: string, _v2: string) {
                  return {
                    gt(_c3: string, _v3: string) {
                      return {
                        order(_c4: string, _opts: unknown) {
                          return {
                            limit: undefined,
                            // listActive não usa limit; retorna direto Promise-like
                            then(
                              onFulfilled: (r: unknown) => unknown,
                            ) {
                              const res = impls.listActive?.() ?? {
                                data: [],
                                error: null,
                              };
                              return Promise.resolve(onFulfilled(res));
                            },
                          };
                        },
                      };
                    },
                  };
                },
                // reselect idempotente: eq('source_appointment_id')→neq(...)
                neq(_c: string, _v: string) {
                  return {
                    maybeSingle: vi.fn(async () =>
                      impls.reselect
                        ? impls.reselect(col, val)
                        : { data: null, error: null },
                    ),
                  };
                },
              };
            },
          };
          return chain;
        },
      };
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// grantNoShowCredit
// ────────────────────────────────────────────────────────────────────

describe("grantNoShowCredit", () => {
  it("rejeita customerId inválido sem tocar no banco", async () => {
    const supa = makeClient({
      insert: () => {
        throw new Error("não devia ser chamado");
      },
    });
    const r = await grantNoShowCredit({
      supabase: supa as unknown as SupabaseClient,
      customerId: "not-uuid",
      sourceAppointmentId: APPT,
      reason: "no_show_doctor",
    });
    expect(r).toEqual({ ok: false, error: "invalid_customer_id" });
  });

  it("rejeita reason inválido", async () => {
    const supa = makeClient({});
    const r = await grantNoShowCredit({
      supabase: supa as unknown as SupabaseClient,
      customerId: CUSTOMER,
      sourceAppointmentId: APPT,
      reason: "outro" as never,
    });
    expect(r).toEqual({ ok: false, error: "invalid_reason" });
  });

  it("feliz: insert bem-sucedido devolve ok=true, alreadyExisted=false", async () => {
    const supa = makeClient({
      insert: () => ({ data: baseRow(), error: null }),
    });
    const r = await grantNoShowCredit({
      supabase: supa as unknown as SupabaseClient,
      customerId: CUSTOMER,
      sourceAppointmentId: APPT,
      reason: "no_show_doctor",
      now: NOW,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.alreadyExisted).toBe(false);
      expect(r.credit.source_appointment_id).toBe(APPT);
    }
  });

  it("idempotente: 23505 aciona re-select e devolve alreadyExisted=true", async () => {
    const existing = baseRow();
    const supa = makeClient({
      insert: () => ({ data: null, error: { code: "23505" } }),
      reselect: () => ({ data: existing, error: null }),
    });
    const r = await grantNoShowCredit({
      supabase: supa as unknown as SupabaseClient,
      customerId: CUSTOMER,
      sourceAppointmentId: APPT,
      reason: "no_show_doctor",
      now: NOW,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.alreadyExisted).toBe(true);
      expect(r.credit.id).toBe(existing.id);
    }
  });

  it("insert falha não-23505 → ok=false", async () => {
    const supa = makeClient({
      insert: () => ({ data: null, error: { message: "rls", code: "42501" } }),
    });
    const r = await grantNoShowCredit({
      supabase: supa as unknown as SupabaseClient,
      customerId: CUSTOMER,
      sourceAppointmentId: APPT,
      reason: "no_show_doctor",
      now: NOW,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("insert_failed");
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// markCreditConsumed
// ────────────────────────────────────────────────────────────────────

describe("markCreditConsumed", () => {
  it("rejeita creditId inválido", async () => {
    const r = await markCreditConsumed({
      supabase: makeClient({}) as unknown as SupabaseClient,
      creditId: "bad",
      consumedAppointmentId: APPT2,
      actor: ADMIN_ACTOR,
    });
    expect(r).toEqual({ ok: false, error: "invalid_credit_id" });
  });

  it("feliz: update afetou 1 row → alreadyConsumed=false", async () => {
    const supa = makeClient({
      updateReturn: { data: { id: CREDIT }, error: null },
    });
    const r = await markCreditConsumed({
      supabase: supa as unknown as SupabaseClient,
      creditId: CREDIT,
      consumedAppointmentId: APPT2,
      actor: ADMIN_ACTOR,
    });
    expect(r).toEqual({ ok: true, alreadyConsumed: false });
  });

  it("update não afetou + row já consumed com mesmo appt → alreadyConsumed=true", async () => {
    const supa = makeClient({
      updateReturn: { data: null, error: null },
      loadById: () => ({
        data: {
          status: "consumed",
          consumed_appointment_id: APPT2,
        },
        error: null,
      }),
    });
    const r = await markCreditConsumed({
      supabase: supa as unknown as SupabaseClient,
      creditId: CREDIT,
      consumedAppointmentId: APPT2,
      actor: ADMIN_ACTOR,
    });
    expect(r).toEqual({ ok: true, alreadyConsumed: true });
  });

  it("row não encontrada → not_found", async () => {
    const supa = makeClient({
      updateReturn: { data: null, error: null },
      loadById: () => ({ data: null, error: null }),
    });
    const r = await markCreditConsumed({
      supabase: supa as unknown as SupabaseClient,
      creditId: CREDIT,
      consumedAppointmentId: APPT2,
      actor: ADMIN_ACTOR,
    });
    expect(r).toEqual({ ok: false, error: "not_found" });
  });

  it("row cancelled → not_active", async () => {
    const supa = makeClient({
      updateReturn: { data: null, error: null },
      loadById: () => ({
        data: { status: "cancelled", consumed_appointment_id: null },
        error: null,
      }),
    });
    const r = await markCreditConsumed({
      supabase: supa as unknown as SupabaseClient,
      creditId: CREDIT,
      consumedAppointmentId: APPT2,
      actor: ADMIN_ACTOR,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("not_active");
  });
});

// ────────────────────────────────────────────────────────────────────
// cancelCredit
// ────────────────────────────────────────────────────────────────────

describe("cancelCredit", () => {
  it("exige reason com ao menos 4 chars trimmados", async () => {
    const r = await cancelCredit({
      supabase: makeClient({}) as unknown as SupabaseClient,
      creditId: CREDIT,
      reason: "   ",
      actor: ADMIN_ACTOR,
    });
    expect(r).toEqual({ ok: false, error: "invalid_reason" });
  });

  it("feliz: cancel update afetou 1 → alreadyCancelled=false", async () => {
    const supa = makeClient({
      updateReturn: { data: { id: CREDIT }, error: null },
    });
    const r = await cancelCredit({
      supabase: supa as unknown as SupabaseClient,
      creditId: CREDIT,
      reason: "paciente avisou que mudou de cidade",
      actor: ADMIN_ACTOR,
    });
    expect(r).toEqual({ ok: true, alreadyCancelled: false });
  });

  it("update não afetou + já cancelled → alreadyCancelled=true", async () => {
    const supa = makeClient({
      updateReturn: { data: null, error: null },
      loadById: () => ({ data: { status: "cancelled" }, error: null }),
    });
    const r = await cancelCredit({
      supabase: supa as unknown as SupabaseClient,
      creditId: CREDIT,
      reason: "duplicidade",
      actor: ADMIN_ACTOR,
    });
    expect(r).toEqual({ ok: true, alreadyCancelled: true });
  });
});

// ────────────────────────────────────────────────────────────────────
// listActiveCreditsForCustomer
// ────────────────────────────────────────────────────────────────────

describe("listActiveCreditsForCustomer", () => {
  it("customerId inválido → lista vazia sem IO", async () => {
    const r = await listActiveCreditsForCustomer({
      supabase: makeClient({}) as unknown as SupabaseClient,
      customerId: "bad",
    });
    expect(r).toEqual([]);
  });

  it("devolve créditos transformados, daysRemaining nunca negativo", async () => {
    const expires = new Date(NOW.getTime() + 10 * 24 * 60 * 60 * 1000);
    const row = {
      id: CREDIT,
      source_appointment_id: APPT,
      source_reason: "no_show_doctor" as const,
      created_at: "2026-05-10T00:00:00Z",
      expires_at: expires.toISOString(),
      status: "active" as const,
    };
    const supa = makeClient({
      listActive: () => ({ data: [row], error: null }),
    });
    const r = await listActiveCreditsForCustomer({
      supabase: supa as unknown as SupabaseClient,
      customerId: CUSTOMER,
      now: NOW,
    });
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe(CREDIT);
    expect(r[0].sourceReason).toBe("no_show_doctor");
    expect(r[0].daysRemaining).toBe(10);
  });
});

// ────────────────────────────────────────────────────────────────────
// Constante de política
// ────────────────────────────────────────────────────────────────────

describe("CREDIT_EXPIRY_DAYS", () => {
  it("é 90 dias (valor explícito em D-081)", () => {
    expect(CREDIT_EXPIRY_DAYS).toBe(90);
  });
});
