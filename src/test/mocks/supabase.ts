/**
 * Mock do cliente Supabase pros testes unitários (D-038).
 *
 * Filosofia: em vez de simular um query builder real completo (que
 * seria propenso a bugs no próprio mock), o teste declara
 * explicitamente as respostas que cada chamada à tabela deve retornar,
 * em fila. O builder aceita toda a chain fluente que o código sob
 * teste usa, ignora os args (captura pra inspeção), e resolve com a
 * próxima resposta enfileirada pra aquela tabela.
 *
 * Uso típico em um teste:
 *
 *   const supa = createSupabaseMock();
 *   supa.enqueue("doctors", { data: { id: "d1", ... }, error: null });
 *   supa.enqueue("doctors", { data: null, error: null }); // update
 *
 *   // injeta o mock nos imports
 *   vi.mocked(getSupabaseAdmin).mockReturnValue(supa.client as any);
 *
 *   // roda a função e inspeciona as chamadas
 *   await pauseDoctor(...);
 *   expect(supa.calls).toHaveLength(2);
 *   expect(supa.calls[0].table).toBe("doctors");
 *   expect(supa.calls[0].chain).toContain("select");
 */

import { vi } from "vitest";

export type MockResponse<T = unknown> = {
  data?: T | null;
  error?: { code?: string; message: string } | null;
  count?: number | null;
};

export type RecordedCall = {
  table: string;
  chain: string[];
  args: unknown[][];
};

type Queued = MockResponse;

export type RecordedRpcCall = {
  fn: string;
  params: unknown;
};

export type SupabaseMock = {
  client: {
    from: (table: string) => unknown;
    rpc: (fn: string, params?: unknown) => Promise<MockResponse>;
  };
  enqueue: (table: string, response: MockResponse) => void;
  enqueueRpc: (fn: string, response: MockResponse) => void;
  calls: RecordedCall[];
  rpcCalls: RecordedRpcCall[];
  reset: () => void;
};

export function createSupabaseMock(): SupabaseMock {
  const responses = new Map<string, Queued[]>();
  const rpcResponses = new Map<string, Queued[]>();
  const calls: RecordedCall[] = [];
  const rpcCalls: RecordedRpcCall[] = [];

  function nextResponse(table: string, recorded: RecordedCall): Queued {
    calls.push(recorded);
    const queue = responses.get(table) ?? [];
    const next = queue.shift();
    if (!next) {
      return { data: null, error: null };
    }
    return next;
  }

  function makeBuilder(table: string) {
    const chain: string[] = [];
    const args: unknown[][] = [];

    const resolve = () =>
      Promise.resolve(nextResponse(table, { table, chain, args }));

    const builder: Record<string, unknown> = {};

    // Todos os métodos fluentes encadeáveis retornam `this`.
    const chainable = [
      "select",
      "insert",
      "update",
      "delete",
      "upsert",
      "eq",
      "neq",
      "is",
      "in",
      "gte",
      "lte",
      "gt",
      "lt",
      "like",
      "ilike",
      "not",
      "or",
      "match",
      "order",
      "limit",
      "range",
      "filter",
    ];
    for (const method of chainable) {
      builder[method] = (...params: unknown[]) => {
        chain.push(method);
        args.push(params);
        return builder;
      };
    }

    // Terminais: resolvem com a resposta enfileirada.
    builder.single = () => resolve();
    builder.maybeSingle = () => resolve();

    // Thenable: permite `await supabase.from(...).select(...)` direto.
    builder.then = (
      onFulfilled: (v: Queued) => unknown,
      onRejected?: (e: unknown) => unknown
    ) => resolve().then(onFulfilled, onRejected);

    return builder;
  }

  return {
    client: {
      from: vi.fn((table: string) => makeBuilder(table)),
      rpc: vi.fn(async (fn: string, params?: unknown) => {
        rpcCalls.push({ fn, params });
        const queue = rpcResponses.get(fn) ?? [];
        const next = queue.shift();
        if (!next) return { data: null, error: null };
        return next;
      }),
    },
    enqueue(table, response) {
      const queue = responses.get(table) ?? [];
      queue.push(response);
      responses.set(table, queue);
    },
    enqueueRpc(fn, response) {
      const queue = rpcResponses.get(fn) ?? [];
      queue.push(response);
      rpcResponses.set(fn, queue);
    },
    calls,
    rpcCalls,
    reset() {
      responses.clear();
      rpcResponses.clear();
      calls.length = 0;
      rpcCalls.length = 0;
    },
  };
}
