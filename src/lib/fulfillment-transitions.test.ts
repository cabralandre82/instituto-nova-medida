/**
 * Testes de transitionFulfillment (D-044 · 2.E).
 */

import { describe, expect, it } from "vitest";
import { createSupabaseMock } from "../test/mocks/supabase";
import { transitionFulfillment } from "./fulfillment-transitions";

const NOW = new Date("2026-04-20T18:00:00.000Z");

function mkSelect(status: string) {
  return {
    data: { id: "ff-1", status, tracking_note: null },
    error: null,
  } as const;
}

describe("transitionFulfillment · happy path", () => {
  it("paid → pharmacy_requested grava timestamp", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", mkSelect("paid"));
    supa.enqueue("fulfillments", {
      data: { id: "ff-1", status: "pharmacy_requested" },
      error: null,
    });

    const res = await transitionFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      to: "pharmacy_requested",
      actor: "admin",
      actorUserId: "admin-1",
      now: NOW,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.from).toBe("paid");
    expect(res.to).toBe("pharmacy_requested");
    expect(res.alreadyAtTarget).toBe(false);

    const updCall = supa.calls.find(
      (c) => c.table === "fulfillments" && c.chain.includes("update")
    );
    expect(updCall).toBeTruthy();
    const patch = updCall!.args[updCall!.chain.indexOf("update")][0] as Record<
      string,
      unknown
    >;
    expect(patch.status).toBe("pharmacy_requested");
    expect(patch.pharmacy_requested_at).toBe(NOW.toISOString());
    expect(patch.updated_by_user_id).toBe("admin-1");
  });

  it("pharmacy_requested → shipped grava tracking_note limpo", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", mkSelect("pharmacy_requested"));
    supa.enqueue("fulfillments", {
      data: { id: "ff-1", status: "shipped" },
      error: null,
    });

    const res = await transitionFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      to: "shipped",
      actor: "admin",
      actorUserId: "admin-1",
      trackingNote: "  Correios BR123456789BR  ",
      now: NOW,
    });
    expect(res.ok).toBe(true);

    const updCall = supa.calls.find(
      (c) => c.table === "fulfillments" && c.chain.includes("update")
    );
    const patch = updCall!.args[updCall!.chain.indexOf("update")][0] as Record<
      string,
      unknown
    >;
    expect(patch.tracking_note).toBe("Correios BR123456789BR");
    expect(patch.shipped_at).toBe(NOW.toISOString());
  });

  it("shipped → delivered feito por paciente é permitido", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", mkSelect("shipped"));
    supa.enqueue("fulfillments", {
      data: { id: "ff-1", status: "delivered" },
      error: null,
    });

    const res = await transitionFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      to: "delivered",
      actor: "patient",
      actorUserId: "user-123",
      now: NOW,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.to).toBe("delivered");
  });

  it("paid → cancelled com motivo grava cancelled_reason", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", mkSelect("paid"));
    supa.enqueue("fulfillments", {
      data: { id: "ff-1", status: "cancelled" },
      error: null,
    });

    const res = await transitionFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      to: "cancelled",
      actor: "admin",
      actorUserId: "admin-1",
      cancelledReason: "Paciente desistiu; estorno combinado no suporte.",
      now: NOW,
    });
    expect(res.ok).toBe(true);

    const updCall = supa.calls.find(
      (c) => c.table === "fulfillments" && c.chain.includes("update")
    );
    const patch = updCall!.args[updCall!.chain.indexOf("update")][0] as Record<
      string,
      unknown
    >;
    expect(patch.status).toBe("cancelled");
    expect(patch.cancelled_at).toBe(NOW.toISOString());
    expect(patch.cancelled_reason).toMatch(/estorno combinado/);
  });
});

describe("transitionFulfillment · idempotência", () => {
  it("já no status alvo → alreadyAtTarget sem UPDATE", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", mkSelect("shipped"));

    const res = await transitionFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      to: "shipped",
      actor: "admin",
      actorUserId: "admin-1",
      trackingNote: "tracking",
      now: NOW,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.alreadyAtTarget).toBe(true);

    const updCall = supa.calls.find(
      (c) => c.table === "fulfillments" && c.chain.includes("update")
    );
    expect(updCall).toBeUndefined();
  });

  it("UPDATE guard falha (race) → invalid_transition", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", mkSelect("paid"));
    supa.enqueue("fulfillments", { data: null, error: null });

    const res = await transitionFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      to: "pharmacy_requested",
      actor: "admin",
      actorUserId: "admin-1",
      now: NOW,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("invalid_transition");
  });
});

describe("transitionFulfillment · validações", () => {
  it("shipped sem tracking_note → invalid_payload", async () => {
    const supa = createSupabaseMock();
    const res = await transitionFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      to: "shipped",
      actor: "admin",
      actorUserId: "admin-1",
      trackingNote: " ",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("invalid_payload");
  });

  it("cancelled sem motivo → invalid_payload", async () => {
    const supa = createSupabaseMock();
    const res = await transitionFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      to: "cancelled",
      actor: "admin",
      actorUserId: "admin-1",
      cancelledReason: "",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("invalid_payload");
  });

  it("paciente tentando transicionar pra qualquer coisa != delivered → forbidden_actor", async () => {
    const supa = createSupabaseMock();
    const res = await transitionFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      to: "shipped",
      actor: "patient",
      actorUserId: "user-1",
      trackingNote: "xxxx",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("forbidden_actor");
  });

  it("admin tentando promover pra paid → forbidden_actor", async () => {
    const supa = createSupabaseMock();
    const res = await transitionFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      to: "paid",
      actor: "admin",
      actorUserId: "admin-1",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("forbidden_actor");
  });

  it("transição proibida (paid → shipped pulando pharmacy_requested) → invalid_transition", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", mkSelect("paid"));

    const res = await transitionFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      to: "shipped",
      actor: "admin",
      actorUserId: "admin-1",
      trackingNote: "Correios BR123",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("invalid_transition");
    expect(res.currentStatus).toBe("paid");
  });

  it("fulfillment inexistente → not_found", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", { data: null, error: null });

    const res = await transitionFulfillment(supa.client as never, {
      fulfillmentId: "ff-inexistente",
      to: "pharmacy_requested",
      actor: "admin",
      actorUserId: "admin-1",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("not_found");
  });

  it("db_error do supabase é propagado", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", {
      data: null,
      error: { code: "XX000", message: "timeout" },
    });

    const res = await transitionFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      to: "pharmacy_requested",
      actor: "admin",
      actorUserId: "admin-1",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("db_error");
  });
});

describe("transitionFulfillment · sequência completa", () => {
  it("paid → pharmacy_requested → shipped → delivered cobre o caminho feliz", async () => {
    const supa = createSupabaseMock();
    // paid → pharmacy_requested
    supa.enqueue("fulfillments", mkSelect("paid"));
    supa.enqueue("fulfillments", {
      data: { id: "ff-1", status: "pharmacy_requested" },
      error: null,
    });

    let res = await transitionFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      to: "pharmacy_requested",
      actor: "admin",
      actorUserId: "admin-1",
      now: NOW,
    });
    expect(res.ok).toBe(true);

    // pharmacy_requested → shipped
    supa.enqueue("fulfillments", mkSelect("pharmacy_requested"));
    supa.enqueue("fulfillments", {
      data: { id: "ff-1", status: "shipped" },
      error: null,
    });
    res = await transitionFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      to: "shipped",
      actor: "admin",
      actorUserId: "admin-1",
      trackingNote: "Correios BR123",
      now: NOW,
    });
    expect(res.ok).toBe(true);

    // shipped → delivered
    supa.enqueue("fulfillments", mkSelect("shipped"));
    supa.enqueue("fulfillments", {
      data: { id: "ff-1", status: "delivered" },
      error: null,
    });
    res = await transitionFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      to: "delivered",
      actor: "patient",
      actorUserId: "user-1",
      now: NOW,
    });
    expect(res.ok).toBe(true);
  });
});
