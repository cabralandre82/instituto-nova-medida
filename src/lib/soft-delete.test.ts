/**
 * src/lib/soft-delete.test.ts — PR-066 · D-074
 *
 * Testa o contrato puro da lib: validação de input, idempotência,
 * propagação de actor snapshot, tratamento de race entre SELECT e UPDATE.
 *
 * Mock do SupabaseClient é um builder encadeado minimalista — responde
 * em `maybeSingle()` com o que o handler registrar pra aquela query.
 */

import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  softDelete,
  SOFT_DELETE_TABLES,
  describeSoftDeleteProtection,
  type SoftDeleteTable,
} from "./soft-delete";

type MaybeSingleResult = {
  data: Record<string, unknown> | null;
  error: { message: string } | null;
};

type Queue = {
  select: MaybeSingleResult[];
  update: MaybeSingleResult[];
};

/**
 * Builder encadeado mínimo: cada chamada a `maybeSingle` retira o próximo
 * resultado da queue (por op `select` ou `update`). A lib usa `.update()`
 * seguido de `.select()` + `.maybeSingle()` — detectamos isso via flag
 * interna.
 */
function makeSupabaseStub(queue: Queue, spy?: { inserts: unknown[]; updates: unknown[] }) {
  const state = {
    op: "select" as "select" | "update",
    table: "",
    updatePatch: undefined as unknown,
  };

  const builder: Record<string, unknown> = {
    select: vi.fn(() => builder),
    update: vi.fn((patch: unknown) => {
      state.op = "update";
      state.updatePatch = patch;
      spy?.updates.push({ table: state.table, patch });
      return builder;
    }),
    eq: vi.fn(() => builder),
    is: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => {
      const q = state.op === "update" ? queue.update : queue.select;
      const next = q.shift();
      // Reseta pro próximo ciclo (lib encadeia múltiplos selects).
      state.op = "select";
      state.updatePatch = undefined;
      return next ?? { data: null, error: { message: "unexpected call" } };
    }),
  };

  const supabase = {
    from: vi.fn((tbl: string) => {
      state.table = tbl;
      state.op = "select";
      return builder;
    }),
  } as unknown as SupabaseClient;

  return supabase;
}

describe("softDelete — input validation", () => {
  it("rejeita table fora do escopo", async () => {
    const stub = makeSupabaseStub({ select: [], update: [] });
    const res = await softDelete(stub, {
      // @ts-expect-error - teste de runtime
      table: "customers",
      id: "abcdef12-3456-7890-abcd-ef1234567890",
      reason: "motivo legítimo",
      actor: { userId: "u-1", email: "a@b.com", kind: "admin" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("invalid_table");
  });

  it("rejeita id vazio/curto", async () => {
    const stub = makeSupabaseStub({ select: [], update: [] });
    for (const bad of ["", "   ", "x", "short"]) {
      const res = await softDelete(stub, {
        table: "appointments",
        id: bad,
        reason: "motivo legítimo",
        actor: {},
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe("invalid_id");
    }
  });

  it("rejeita reason curto ou só com espaço", async () => {
    const stub = makeSupabaseStub({ select: [], update: [] });
    for (const bad of ["", "abc", "   ", "\n\t"]) {
      const res = await softDelete(stub, {
        table: "appointments",
        id: "abcdef12-3456-7890-abcd-ef1234567890",
        reason: bad,
        actor: {},
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe("invalid_reason");
    }
  });

  it("aceita reason com chars de controle removidos (sanitiza)", async () => {
    const stub = makeSupabaseStub({
      select: [{ data: { id: "id-1", deleted_at: null }, error: null }],
      update: [{ data: { id: "id-1", deleted_at: "2026-05-11T00:00:00Z" }, error: null }],
    });
    const res = await softDelete(stub, {
      table: "appointments",
      id: "abcdef12-3456-7890-abcd-ef1234567890",
      reason: "\u0000\u0001motivo legítimo\u0008",
      actor: { userId: "u-1", email: "Admin@Example.COM ", kind: "admin" },
    });
    expect(res.ok).toBe(true);
  });

  it("trunca reason longo em 500 chars", async () => {
    const spy = { inserts: [] as unknown[], updates: [] as unknown[] };
    const stub = makeSupabaseStub(
      {
        select: [{ data: { id: "id-1", deleted_at: null }, error: null }],
        update: [{ data: { id: "id-1", deleted_at: "2026-05-11T00:00:00Z" }, error: null }],
      },
      spy
    );
    const huge = "a".repeat(700);
    const res = await softDelete(stub, {
      table: "appointments",
      id: "abcdef12-3456-7890-abcd-ef1234567890",
      reason: huge,
      actor: {},
    });
    expect(res.ok).toBe(true);
    const patch = (spy.updates[0] as { patch: Record<string, unknown> }).patch;
    expect(typeof patch.deleted_reason).toBe("string");
    expect((patch.deleted_reason as string).length).toBe(500);
  });
});

describe("softDelete — idempotência", () => {
  it("row já soft-deletada: retorna alreadyDeleted=true, não faz UPDATE", async () => {
    const spy = { inserts: [] as unknown[], updates: [] as unknown[] };
    const stub = makeSupabaseStub(
      {
        select: [
          {
            data: { id: "id-1", deleted_at: "2026-05-01T00:00:00Z" },
            error: null,
          },
        ],
        update: [],
      },
      spy
    );
    const res = await softDelete(stub, {
      table: "appointments",
      id: "abcdef12-3456-7890-abcd-ef1234567890",
      reason: "motivo legítimo",
      actor: { userId: "u-1", email: "a@b.com", kind: "admin" },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.alreadyDeleted).toBe(true);
      expect(res.deletedAt).toBe("2026-05-01T00:00:00Z");
    }
    expect(spy.updates).toHaveLength(0);
  });

  it("row não encontrada: retorna not_found", async () => {
    const stub = makeSupabaseStub({
      select: [{ data: null, error: null }],
      update: [],
    });
    const res = await softDelete(stub, {
      table: "appointments",
      id: "abcdef12-3456-7890-abcd-ef1234567890",
      reason: "motivo legítimo",
      actor: {},
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("not_found");
  });

  it("erro de DB no select: retorna db_error", async () => {
    const stub = makeSupabaseStub({
      select: [{ data: null, error: { message: "connection lost" } }],
      update: [],
    });
    const res = await softDelete(stub, {
      table: "appointments",
      id: "abcdef12-3456-7890-abcd-ef1234567890",
      reason: "motivo legítimo",
      actor: {},
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("db_error");
  });
});

describe("softDelete — actor snapshot integration (D-072)", () => {
  it("persiste actor normalizado (email lowercase + trim) na patch", async () => {
    const spy = { inserts: [] as unknown[], updates: [] as unknown[] };
    const stub = makeSupabaseStub(
      {
        select: [{ data: { id: "id-1", deleted_at: null }, error: null }],
        update: [
          { data: { id: "id-1", deleted_at: "2026-05-11T00:00:00Z" }, error: null },
        ],
      },
      spy
    );
    const res = await softDelete(stub, {
      table: "fulfillments",
      id: "abcdef12-3456-7890-abcd-ef1234567890",
      reason: "cancelado a pedido do paciente",
      actor: { userId: "u-1", email: "  Admin@Example.COM  ", kind: "admin" },
    });
    expect(res.ok).toBe(true);
    const patch = (spy.updates[0] as { patch: Record<string, unknown> }).patch;
    expect(patch.deleted_by).toBe("u-1");
    expect(patch.deleted_by_email).toBe("admin@example.com");
    expect(patch.deleted_reason).toBe("cancelado a pedido do paciente");
    expect(typeof patch.deleted_at).toBe("string");
  });

  it("actor kind=system força userId=null mesmo se passado", async () => {
    const spy = { inserts: [] as unknown[], updates: [] as unknown[] };
    const stub = makeSupabaseStub(
      {
        select: [{ data: { id: "id-1", deleted_at: null }, error: null }],
        update: [
          { data: { id: "id-1", deleted_at: "2026-05-11T00:00:00Z" }, error: null },
        ],
      },
      spy
    );
    const res = await softDelete(stub, {
      table: "doctor_earnings",
      id: "abcdef12-3456-7890-abcd-ef1234567890",
      reason: "purge automático",
      actor: { userId: "u-should-be-null", email: "system:cron", kind: "system" },
    });
    expect(res.ok).toBe(true);
    const patch = (spy.updates[0] as { patch: Record<string, unknown> }).patch;
    expect(patch.deleted_by).toBeNull();
    expect(patch.deleted_by_email).toBe("system:cron");
  });

  it("actor vazio: userId e email null", async () => {
    const spy = { inserts: [] as unknown[], updates: [] as unknown[] };
    const stub = makeSupabaseStub(
      {
        select: [{ data: { id: "id-1", deleted_at: null }, error: null }],
        update: [
          { data: { id: "id-1", deleted_at: "2026-05-11T00:00:00Z" }, error: null },
        ],
      },
      spy
    );
    await softDelete(stub, {
      table: "appointments",
      id: "abcdef12-3456-7890-abcd-ef1234567890",
      reason: "legítimo",
      actor: {},
    });
    const patch = (spy.updates[0] as { patch: Record<string, unknown> }).patch;
    expect(patch.deleted_by).toBeNull();
    expect(patch.deleted_by_email).toBeNull();
  });
});

describe("softDelete — race handling", () => {
  it("UPDATE .is('deleted_at', null) não retorna row (race): relê e devolve idempotência", async () => {
    // Cenário: outra chamada soft-deletou entre nosso SELECT e nosso UPDATE.
    // O UPDATE tem guard `deleted_at IS NULL` e não bate. maybeSingle
    // devolve { data: null, error: null }. A lib re-lê e devolve ok.
    const stub = makeSupabaseStub({
      select: [
        { data: { id: "id-1", deleted_at: null }, error: null },
        { data: { id: "id-1", deleted_at: "2026-05-10T23:59:59Z" }, error: null },
      ],
      update: [{ data: null, error: null }],
    });
    const res = await softDelete(stub, {
      table: "appointments",
      id: "abcdef12-3456-7890-abcd-ef1234567890",
      reason: "legítimo",
      actor: {},
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.alreadyDeleted).toBe(true);
      expect(res.deletedAt).toBe("2026-05-10T23:59:59Z");
    }
  });

  it("UPDATE falha com error: retorna db_error", async () => {
    const stub = makeSupabaseStub({
      select: [{ data: { id: "id-1", deleted_at: null }, error: null }],
      update: [{ data: null, error: { message: "trigger raised" } }],
    });
    const res = await softDelete(stub, {
      table: "appointments",
      id: "abcdef12-3456-7890-abcd-ef1234567890",
      reason: "legítimo",
      actor: {},
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("db_error");
  });
});

describe("softDelete — tabelas aceitas", () => {
  it.each(SOFT_DELETE_TABLES)("aceita table='%s'", async (tbl) => {
    const stub = makeSupabaseStub({
      select: [{ data: { id: "id-1", deleted_at: null }, error: null }],
      update: [
        { data: { id: "id-1", deleted_at: "2026-05-11T00:00:00Z" }, error: null },
      ],
    });
    const res = await softDelete(stub, {
      table: tbl as SoftDeleteTable,
      id: "abcdef12-3456-7890-abcd-ef1234567890",
      reason: "motivo legítimo",
      actor: { kind: "admin" },
    });
    expect(res.ok).toBe(true);
  });
});

describe("describeSoftDeleteProtection", () => {
  it("retorna triggers + constraint + partial indexes corretos pra cada tabela", () => {
    for (const tbl of SOFT_DELETE_TABLES) {
      const info = describeSoftDeleteProtection(tbl);
      expect(info.table).toBe(tbl);
      expect(info.triggers).toContain(`trg_prevent_hard_delete_${tbl}`);
      expect(info.triggers).toContain(`trg_enforce_soft_delete_${tbl}`);
      expect(info.constraint).toBe(`${tbl}_soft_delete_reason_chk`);
      expect(info.partialIndexes.length).toBeGreaterThan(0);
    }
  });
});
