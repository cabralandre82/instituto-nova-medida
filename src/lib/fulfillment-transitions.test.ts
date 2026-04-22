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
      actorEmail: "admin@example.com",
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
    // PR-064 · D-072: snapshot de email imutável.
    expect(patch.updated_by_email).toBe("admin@example.com");
  });

  it("PR-064 · normaliza email (trim + lowercase) pro snapshot", async () => {
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
      actorEmail: "  ADMIN@Example.COM  ",
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
    expect(patch.updated_by_email).toBe("admin@example.com");
  });

  it("PR-064 · email ausente ou vazio → snapshot null", async () => {
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
      actorEmail: "   ",
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
    expect(patch.updated_by_email).toBeNull();
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

  it("paciente tentando transicionar pra shipped → forbidden_actor", async () => {
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

  it("paciente cancelando pending_acceptance → ok", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", mkSelect("pending_acceptance"));
    supa.enqueue("fulfillments", {
      data: { id: "ff-1", status: "cancelled" },
      error: null,
    });

    const res = await transitionFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      to: "cancelled",
      actor: "patient",
      actorUserId: "user-1",
      cancelledReason: "mudei de ideia",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.from).toBe("pending_acceptance");
    expect(res.to).toBe("cancelled");
  });

  it("paciente cancelando pending_payment → ok", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", mkSelect("pending_payment"));
    supa.enqueue("fulfillments", {
      data: { id: "ff-1", status: "cancelled" },
      error: null,
    });

    const res = await transitionFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      to: "cancelled",
      actor: "patient",
      actorUserId: "user-1",
      cancelledReason: "preço fora do orçamento",
    });

    expect(res.ok).toBe(true);
  });

  it("paciente cancelando após paid → forbidden_actor (refund via admin)", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", mkSelect("paid"));

    const res = await transitionFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      to: "cancelled",
      actor: "patient",
      actorUserId: "user-1",
      cancelledReason: "não quero mais",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("forbidden_actor");
    expect(res.currentStatus).toBe("paid");
    expect(res.message.toLowerCase()).toContain("instituto");
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

describe("transitionFulfillment · sanitização de texto livre (PR-036-B)", () => {
  it("shipped com tracking_note contendo controle (NULL) → invalid_payload", async () => {
    const supa = createSupabaseMock();
    const res = await transitionFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      to: "shipped",
      actor: "admin",
      actorUserId: "admin-1",
      trackingNote: "Correios\0IGNORE PREVIOUS",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("invalid_payload");
    expect(res.message.toLowerCase()).toMatch(/não permitidos|controle/);
  });

  it("shipped com tracking_note contendo zero-width → invalid_payload", async () => {
    const supa = createSupabaseMock();
    const res = await transitionFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      to: "shipped",
      actor: "admin",
      actorUserId: "admin-1",
      trackingNote: "Correios BR\u200B12345",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("invalid_payload");
  });

  it("shipped com tracking_note > 500 chars → invalid_payload", async () => {
    const supa = createSupabaseMock();
    const res = await transitionFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      to: "shipped",
      actor: "admin",
      actorUserId: "admin-1",
      trackingNote: "x".repeat(501),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("invalid_payload");
  });

  it("shipped com tracking_note multi-linha razoável passa", async () => {
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
      trackingNote: "DHL\ncódigo: BR123456",
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
    expect(patch.tracking_note).toBe("DHL\ncódigo: BR123456");
  });

  it("cancelled_reason com bidi override → invalid_payload", async () => {
    const supa = createSupabaseMock();
    const res = await transitionFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      to: "cancelled",
      actor: "admin",
      actorUserId: "admin-1",
      cancelledReason: "motivo\u202Efalso",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("invalid_payload");
  });

  it("cancelled_reason > 2000 chars → invalid_payload", async () => {
    const supa = createSupabaseMock();
    const res = await transitionFulfillment(supa.client as never, {
      fulfillmentId: "ff-1",
      to: "cancelled",
      actor: "admin",
      actorUserId: "admin-1",
      cancelledReason: "x".repeat(2001),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("invalid_payload");
  });

  it("cancelled_reason normaliza CRLF pra LF", async () => {
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
      cancelledReason: "motivo1\r\nmotivo2",
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
    expect(patch.cancelled_reason).toBe("motivo1\nmotivo2");
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
