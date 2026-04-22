/**
 * Testes de admin-inbox (D-045 · 3.A).
 *
 * Foco em:
 *   - Classificadores puros (classifyUrgency, formatAge, sortInboxItems)
 *   - Construção do InboxItem via `loadAdminInbox` com mocks
 *   - Regras de ocultação: count=0 não aparece; age < 50% SLA não
 *     aparece; sem SLA + count>0 vira overdue direto.
 */

import { describe, expect, it } from "vitest";
import { createSupabaseMock } from "../test/mocks/supabase";
import {
  classifyUrgency,
  formatAge,
  loadAdminInbox,
  sortInboxItems,
  SLA_HOURS,
  type InboxItem,
} from "./admin-inbox";

const NOW = new Date("2026-04-20T12:00:00.000Z");

function hoursAgoIso(h: number): string {
  return new Date(NOW.getTime() - h * 60 * 60 * 1000).toISOString();
}

// ────────────────────────────────────────────────────────────────────────
// classifyUrgency
// ────────────────────────────────────────────────────────────────────────

describe("classifyUrgency", () => {
  it("ageHours acima do SLA → overdue", () => {
    expect(classifyUrgency(30, 24)).toBe("overdue");
  });

  it("ageHours entre 50% e 100% do SLA → due_soon", () => {
    expect(classifyUrgency(13, 24)).toBe("due_soon");
    expect(classifyUrgency(23.99, 24)).toBe("due_soon");
  });

  it("ageHours <= 50% do SLA → null (não entra na inbox)", () => {
    expect(classifyUrgency(12, 24)).toBe(null);
    expect(classifyUrgency(1, 24)).toBe(null);
  });

  it("slaHours null com qualquer age → overdue (pendência de estado)", () => {
    expect(classifyUrgency(0, null)).toBe("overdue");
    expect(classifyUrgency(1000, null)).toBe("overdue");
    expect(classifyUrgency(null, null)).toBe("overdue");
  });

  it("ageHours negativo ou null com SLA → null", () => {
    expect(classifyUrgency(null, 24)).toBe(null);
    expect(classifyUrgency(-1, 24)).toBe(null);
  });
});

// ────────────────────────────────────────────────────────────────────────
// formatAge
// ────────────────────────────────────────────────────────────────────────

describe("formatAge", () => {
  it("< 1h", () => {
    expect(formatAge(0)).toBe("há menos de 1h");
    expect(formatAge(0.5)).toBe("há menos de 1h");
  });
  it("1h - 23h", () => {
    expect(formatAge(1)).toBe("há 1h");
    expect(formatAge(12)).toBe("há 12h");
    expect(formatAge(23.9)).toBe("há 23h");
  });
  it("1 dia", () => {
    expect(formatAge(24)).toBe("há 1 dia");
    expect(formatAge(47)).toBe("há 1 dia");
  });
  it("N dias", () => {
    expect(formatAge(48)).toBe("há 2 dias");
    expect(formatAge(24 * 10)).toBe("há 10 dias");
  });
  it("inválidos", () => {
    expect(formatAge(null)).toBe("—");
    expect(formatAge(undefined)).toBe("—");
    expect(formatAge(-5)).toBe("—");
    expect(formatAge(NaN)).toBe("—");
    expect(formatAge(Infinity)).toBe("—");
  });
});

// ────────────────────────────────────────────────────────────────────────
// sortInboxItems
// ────────────────────────────────────────────────────────────────────────

function mkItem(partial: Partial<InboxItem>): InboxItem {
  return {
    id: "fulfillment_paid",
    urgency: "overdue",
    category: "fulfillment_paid",
    title: "t",
    description: "d",
    count: 1,
    oldestAgeHours: 10,
    slaHours: 24,
    href: "/x",
    ...partial,
  };
}

describe("sortInboxItems", () => {
  it("overdue antes de due_soon", () => {
    const a = mkItem({ id: "fulfillment_paid", urgency: "due_soon" });
    const b = mkItem({ id: "offer_payment", urgency: "overdue" });
    const sorted = sortInboxItems([a, b]);
    expect(sorted[0].id).toBe("offer_payment");
    expect(sorted[1].id).toBe("fulfillment_paid");
  });

  it("dentro da mesma urgency, item mais antigo primeiro", () => {
    const a = mkItem({ id: "fulfillment_paid", oldestAgeHours: 10 });
    const b = mkItem({
      id: "offer_payment",
      category: "offer_payment",
      oldestAgeHours: 50,
    });
    const sorted = sortInboxItems([a, b]);
    expect(sorted[0].id).toBe("offer_payment");
    expect(sorted[1].id).toBe("fulfillment_paid");
  });

  it("empate em age → count desc, depois category alfabética", () => {
    const a = mkItem({
      id: "fulfillment_paid",
      oldestAgeHours: 10,
      count: 2,
    });
    const b = mkItem({
      id: "offer_payment",
      category: "offer_payment",
      oldestAgeHours: 10,
      count: 5,
    });
    const sorted = sortInboxItems([a, b]);
    expect(sorted[0].id).toBe("offer_payment"); // count maior
  });

  it("não muta o array original", () => {
    const input = [
      mkItem({ id: "fulfillment_paid", urgency: "due_soon" }),
      mkItem({ id: "offer_payment", urgency: "overdue" }),
    ];
    const before = input.map((i) => i.id);
    sortInboxItems(input);
    expect(input.map((i) => i.id)).toEqual(before);
  });
});

// ────────────────────────────────────────────────────────────────────────
// loadAdminInbox (integração com mock)
// ────────────────────────────────────────────────────────────────────────

/**
 * Helper que enfileira as 11 respostas esperadas por `loadAdminInbox`.
 * Todas são no-ops (count=0) por padrão, pra o teste habilitar só
 * as que importam.
 *
 * A ordem aqui TEM que casar com a ordem do Promise.all em
 * `loadAdminInbox`:
 *   1. fulfillments paid
 *   2. fulfillments pharmacy_requested
 *   3. fulfillments shipped
 *   4. fulfillments pending_acceptance
 *   5. fulfillments pending_payment
 *   6. appointments refund_required
 *   7. appointment_notifications status=failed
 *   8. appointments reconcile stuck
 *   9. doctors invited/pending
 *  10. lgpd_requests pending
 *  11. appointments pending_payment (LEGACY watchdog · PR-071 · D-079)
 */
function enqueueEmptyAll(supa: ReturnType<typeof createSupabaseMock>) {
  const tables = [
    "fulfillments",
    "fulfillments",
    "fulfillments",
    "fulfillments",
    "fulfillments",
    "appointments",
    "appointment_notifications",
    "appointments",
    "doctors",
    "lgpd_requests",
    "appointments",
  ];
  tables.forEach((t) =>
    supa.enqueue(t, { data: [], count: 0, error: null })
  );
}

describe("loadAdminInbox", () => {
  it("inbox vazia quando todas as queries retornam count=0", async () => {
    const supa = createSupabaseMock();
    enqueueEmptyAll(supa);

    const inbox = await loadAdminInbox(supa.client as never, NOW);
    expect(inbox.items).toEqual([]);
    expect(inbox.counts.total).toBe(0);
    expect(inbox.counts.overdue).toBe(0);
    expect(inbox.counts.dueSoon).toBe(0);
    expect(inbox.generatedAt).toBe(NOW.toISOString());
  });

  it("fulfillments paid há 36h → item overdue (SLA=24h)", async () => {
    const supa = createSupabaseMock();
    // 1. paid: 3 items, mais antigo 36h
    supa.enqueue("fulfillments", {
      data: [{ paid_at: hoursAgoIso(36) }],
      count: 3,
      error: null,
    });
    // Resto: vazio
    for (let i = 0; i < 4; i++) {
      supa.enqueue("fulfillments", { data: [], count: 0, error: null });
    }
    supa.enqueue("appointments", { data: [], count: 0, error: null });
    supa.enqueue("appointment_notifications", {
      data: [],
      count: 0,
      error: null,
    });
    supa.enqueue("appointments", { data: [], count: 0, error: null });
    supa.enqueue("doctors", { data: [], count: 0, error: null });

    const inbox = await loadAdminInbox(supa.client as never, NOW);
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0].category).toBe("fulfillment_paid");
    expect(inbox.items[0].urgency).toBe("overdue");
    expect(inbox.items[0].count).toBe(3);
    expect(inbox.items[0].slaHours).toBe(SLA_HOURS.paid_to_pharmacy);
    expect(inbox.items[0].oldestAgeHours).toBeGreaterThanOrEqual(35);
    expect(inbox.items[0].oldestAgeHours).toBeLessThanOrEqual(37);
    expect(inbox.counts.overdue).toBe(1);
  });

  it("fulfillments paid há 18h (75% do SLA 24h) → due_soon", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", {
      data: [{ paid_at: hoursAgoIso(18) }],
      count: 1,
      error: null,
    });
    for (let i = 0; i < 4; i++) {
      supa.enqueue("fulfillments", { data: [], count: 0, error: null });
    }
    supa.enqueue("appointments", { data: [], count: 0, error: null });
    supa.enqueue("appointment_notifications", {
      data: [],
      count: 0,
      error: null,
    });
    supa.enqueue("appointments", { data: [], count: 0, error: null });
    supa.enqueue("doctors", { data: [], count: 0, error: null });

    const inbox = await loadAdminInbox(supa.client as never, NOW);
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0].urgency).toBe("due_soon");
    expect(inbox.counts.dueSoon).toBe(1);
  });

  it("fulfillments paid há 6h (25% do SLA) → NÃO entra na inbox", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", {
      data: [{ paid_at: hoursAgoIso(6) }],
      count: 1,
      error: null,
    });
    for (let i = 0; i < 4; i++) {
      supa.enqueue("fulfillments", { data: [], count: 0, error: null });
    }
    supa.enqueue("appointments", { data: [], count: 0, error: null });
    supa.enqueue("appointment_notifications", {
      data: [],
      count: 0,
      error: null,
    });
    supa.enqueue("appointments", { data: [], count: 0, error: null });
    supa.enqueue("doctors", { data: [], count: 0, error: null });

    const inbox = await loadAdminInbox(supa.client as never, NOW);
    expect(inbox.items).toEqual([]);
  });

  it("notificações failed com count>0 e sem SLA → overdue direto", async () => {
    const supa = createSupabaseMock();
    for (let i = 0; i < 5; i++) {
      supa.enqueue("fulfillments", { data: [], count: 0, error: null });
    }
    supa.enqueue("appointments", { data: [], count: 0, error: null });
    supa.enqueue("appointment_notifications", {
      data: [{ created_at: hoursAgoIso(0.1) }],
      count: 2,
      error: null,
    });
    supa.enqueue("appointments", { data: [], count: 0, error: null });
    supa.enqueue("doctors", { data: [], count: 0, error: null });

    const inbox = await loadAdminInbox(supa.client as never, NOW);
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0].category).toBe("notification");
    expect(inbox.items[0].urgency).toBe("overdue");
    expect(inbox.items[0].slaHours).toBeNull();
  });

  it("médicas pending sempre entram como overdue (pendência de estado)", async () => {
    const supa = createSupabaseMock();
    for (let i = 0; i < 5; i++) {
      supa.enqueue("fulfillments", { data: [], count: 0, error: null });
    }
    supa.enqueue("appointments", { data: [], count: 0, error: null });
    supa.enqueue("appointment_notifications", {
      data: [],
      count: 0,
      error: null,
    });
    supa.enqueue("appointments", { data: [], count: 0, error: null });
    supa.enqueue("doctors", {
      data: [{ created_at: hoursAgoIso(0.2) }],
      count: 1,
      error: null,
    });

    const inbox = await loadAdminInbox(supa.client as never, NOW);
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0].category).toBe("doctor_pending");
    expect(inbox.items[0].urgency).toBe("overdue");
    expect(inbox.items[0].slaHours).toBeNull();
  });

  it("múltiplas categorias são ordenadas por urgência e idade", async () => {
    const supa = createSupabaseMock();
    // 1. paid: 3 dias (overdue, 72h > 24h SLA)
    supa.enqueue("fulfillments", {
      data: [{ paid_at: hoursAgoIso(72) }],
      count: 1,
      error: null,
    });
    // 2. pharmacy_requested: 4h (muito abaixo do SLA 120h) → não entra
    supa.enqueue("fulfillments", {
      data: [{ pharmacy_requested_at: hoursAgoIso(4) }],
      count: 1,
      error: null,
    });
    // 3. shipped: 14.5 dias (overdue, 348h > 336h SLA)
    supa.enqueue("fulfillments", {
      data: [{ shipped_at: hoursAgoIso(14.5 * 24) }],
      count: 2,
      error: null,
    });
    // 4-5. acceptance/payment: vazios
    supa.enqueue("fulfillments", { data: [], count: 0, error: null });
    supa.enqueue("fulfillments", { data: [], count: 0, error: null });
    // 6. refunds: 50h (overdue, > 48h SLA)
    supa.enqueue("appointments", {
      data: [{ no_show_policy_applied_at: hoursAgoIso(50) }],
      count: 1,
      error: null,
    });
    // 7-9. vazios
    supa.enqueue("appointment_notifications", {
      data: [],
      count: 0,
      error: null,
    });
    supa.enqueue("appointments", { data: [], count: 0, error: null });
    supa.enqueue("doctors", { data: [], count: 0, error: null });

    const inbox = await loadAdminInbox(supa.client as never, NOW);
    expect(inbox.items.length).toBe(3);
    // overdue ordenados por idade desc:
    //   shipped 14.5d (348h) > paid 3d (72h) > refund 50h
    expect(inbox.items[0].category).toBe("fulfillment_shipped");
    expect(inbox.items[1].category).toBe("fulfillment_paid");
    expect(inbox.items[2].category).toBe("refund");
    expect(inbox.counts.overdue).toBe(3);
    expect(inbox.counts.dueSoon).toBe(0);
  });

  it("erro do supabase em qualquer query é propagado", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("fulfillments", {
      data: null,
      error: { message: "connection reset" },
    });
    // Resto do promise.all também precisa responder pra não pendurar
    for (let i = 0; i < 4; i++) {
      supa.enqueue("fulfillments", { data: [], count: 0, error: null });
    }
    supa.enqueue("appointments", { data: [], count: 0, error: null });
    supa.enqueue("appointment_notifications", {
      data: [],
      count: 0,
      error: null,
    });
    supa.enqueue("appointments", { data: [], count: 0, error: null });
    supa.enqueue("doctors", { data: [], count: 0, error: null });

    await expect(
      loadAdminInbox(supa.client as never, NOW)
    ).rejects.toThrow(/connection reset/);
  });

  it("generatedAt reflete o `now` passado (determinismo pra testes e UI)", async () => {
    const supa = createSupabaseMock();
    enqueueEmptyAll(supa);
    const fixed = new Date("2026-05-01T08:30:00.000Z");
    const inbox = await loadAdminInbox(supa.client as never, fixed);
    expect(inbox.generatedAt).toBe(fixed.toISOString());
  });

  // ──────────────────────────────────────────────────────────────────
  // PR-071 · D-079 · finding 1.4
  // Watchdog: appointments LEGADO presas em pending_payment > 24h.
  // ──────────────────────────────────────────────────────────────────

  it("PR-071 · appointment LEGADO em pending_payment há 36h → overdue (SLA=24h)", async () => {
    const supa = createSupabaseMock();
    // 1-5. fulfillments vazios
    for (let i = 0; i < 5; i++) {
      supa.enqueue("fulfillments", { data: [], count: 0, error: null });
    }
    // 6. refund vazio
    supa.enqueue("appointments", { data: [], count: 0, error: null });
    // 7. notifs vazio
    supa.enqueue("appointment_notifications", {
      data: [],
      count: 0,
      error: null,
    });
    // 8. reconcile vazio
    supa.enqueue("appointments", { data: [], count: 0, error: null });
    // 9. doctors vazio
    supa.enqueue("doctors", { data: [], count: 0, error: null });
    // 10. lgpd vazio
    supa.enqueue("lgpd_requests", { data: [], count: 0, error: null });
    // 11. appointments pending_payment LEGADO: 2 linhas, mais antiga há 36h
    supa.enqueue("appointments", {
      data: [{ created_at: hoursAgoIso(36) }],
      count: 2,
      error: null,
    });

    const inbox = await loadAdminInbox(supa.client as never, NOW);
    const legacy = inbox.items.find(
      (i) => i.category === "appointment_pending_payment_stale",
    );
    expect(legacy).toBeDefined();
    expect(legacy!.urgency).toBe("overdue");
    expect(legacy!.count).toBe(2);
    expect(legacy!.slaHours).toBe(
      SLA_HOURS.appointment_pending_payment_stale,
    );
    expect(legacy!.oldestAgeHours).toBeGreaterThanOrEqual(35);
    expect(legacy!.oldestAgeHours).toBeLessThanOrEqual(37);
    expect(legacy!.href).toBe("/admin/health");
    expect(legacy!.title).toContain("LEGADO");
  });

  it("PR-071 · appointment em pending_payment há 4h (<50% SLA) → NÃO entra na inbox", async () => {
    const supa = createSupabaseMock();
    for (let i = 0; i < 5; i++) {
      supa.enqueue("fulfillments", { data: [], count: 0, error: null });
    }
    supa.enqueue("appointments", { data: [], count: 0, error: null });
    supa.enqueue("appointment_notifications", {
      data: [],
      count: 0,
      error: null,
    });
    supa.enqueue("appointments", { data: [], count: 0, error: null });
    supa.enqueue("doctors", { data: [], count: 0, error: null });
    supa.enqueue("lgpd_requests", { data: [], count: 0, error: null });
    supa.enqueue("appointments", {
      data: [{ created_at: hoursAgoIso(4) }],
      count: 1,
      error: null,
    });

    const inbox = await loadAdminInbox(supa.client as never, NOW);
    expect(
      inbox.items.find(
        (i) => i.category === "appointment_pending_payment_stale",
      ),
    ).toBeUndefined();
  });

  it("PR-071 · SLA_HOURS.appointment_pending_payment_stale é 24h", () => {
    expect(SLA_HOURS.appointment_pending_payment_stale).toBe(24);
  });
});
