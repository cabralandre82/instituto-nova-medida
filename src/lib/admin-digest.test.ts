/**
 * Testes do admin-digest (D-045 · 3.D).
 *
 * Cobre:
 *   - `composeAdminDigestMessage`: variações de saudação, inbox vazia,
 *     inbox populada com mix de urgências, link opcional.
 *   - `sendAdminDigest`: validação de phone, requireNonEmpty, erro WA.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AdminInbox, InboxItem } from "./admin-inbox";

vi.mock("@/lib/admin-inbox", async () => {
  const actual = await vi.importActual<typeof import("./admin-inbox")>(
    "./admin-inbox"
  );
  return {
    ...actual,
    loadAdminInbox: vi.fn(),
  };
});
vi.mock("@/lib/whatsapp", () => ({
  sendText: vi.fn(),
}));

import { loadAdminInbox } from "@/lib/admin-inbox";
import { sendText } from "@/lib/whatsapp";
import {
  composeAdminDigestMessage,
  sendAdminDigest,
} from "./admin-digest";

const loadInboxMock = vi.mocked(loadAdminInbox);
const waMock = vi.mocked(sendText);

function item(over: Partial<InboxItem> = {}): InboxItem {
  return {
    id: over.id ?? "fulfillment_paid",
    urgency: over.urgency ?? "overdue",
    category: over.category ?? "fulfillment_paid",
    title: over.title ?? "Enviar receita à farmácia",
    description: over.description ?? "descr",
    count: over.count ?? 2,
    oldestAgeHours: over.oldestAgeHours ?? 48,
    slaHours: over.slaHours ?? 24,
    href: over.href ?? "/admin/fulfillments",
  };
}

function inbox(over: Partial<AdminInbox> = {}): AdminInbox {
  const items = over.items ?? [];
  const overdue = items.filter((i) => i.urgency === "overdue").length;
  const dueSoon = items.filter((i) => i.urgency === "due_soon").length;
  return {
    items,
    counts: {
      overdue,
      dueSoon,
      total: items.length,
      ...(over.counts ?? {}),
    },
    generatedAt: over.generatedAt ?? "2026-04-20T12:00:00.000Z",
  };
}

describe("composeAdminDigestMessage", () => {
  // 11:30 UTC → 08:30 BRT (segunda-feira)
  const morningUtc = new Date("2026-04-20T11:30:00.000Z");

  it("saúda 'Bom dia' antes de 14 UTC", () => {
    const msg = composeAdminDigestMessage(inbox(), morningUtc);
    expect(msg.startsWith("Bom dia")).toBe(true);
  });

  it("saúda 'Boa tarde' entre 14 e 20 UTC", () => {
    const afternoonUtc = new Date("2026-04-20T17:00:00.000Z");
    const msg = composeAdminDigestMessage(inbox(), afternoonUtc);
    expect(msg.startsWith("Boa tarde")).toBe(true);
  });

  it("saúda 'Boa noite' após 20 UTC", () => {
    const eveningUtc = new Date("2026-04-20T22:00:00.000Z");
    const msg = composeAdminDigestMessage(inbox(), eveningUtc);
    expect(msg.startsWith("Boa noite")).toBe(true);
  });

  it("inclui dia da semana e data dd/mm", () => {
    // 2026-04-20 é segunda
    const msg = composeAdminDigestMessage(inbox(), morningUtc);
    expect(msg).toContain("segunda");
    expect(msg).toContain("20/04");
  });

  it("inbox vazia diz 'tudo tranquilo'", () => {
    const msg = composeAdminDigestMessage(inbox(), morningUtc);
    expect(msg.toLowerCase()).toContain("tudo tranquilo");
  });

  it("inbox populada mostra contagens e itens", () => {
    const msg = composeAdminDigestMessage(
      inbox({
        items: [
          item({
            id: "fulfillment_paid",
            title: "Enviar receita à farmácia",
            urgency: "overdue",
            count: 2,
            oldestAgeHours: 48,
          }),
          item({
            id: "offer_payment",
            title: "Ofertas sem pagamento",
            urgency: "overdue",
            count: 1,
            oldestAgeHours: 72,
          }),
          item({
            id: "fulfillment_shipped",
            title: "Conferir entregas",
            urgency: "due_soon",
            count: 1,
            oldestAgeHours: 200,
          }),
        ],
      }),
      morningUtc
    );
    expect(msg).toContain("2 overdue");
    expect(msg).toContain("1 em atenção");
    expect(msg).toContain("Enviar receita à farmácia: 2 itens");
    expect(msg).toContain("há 2d"); // 48h = 2d
    expect(msg).toContain("Ofertas sem pagamento: 1 item");
    expect(msg).toContain("há 3d");
    expect(msg).toContain("Conferir entregas: 1 item");
  });

  it("inclui link adminUrl quando provido", () => {
    const msg = composeAdminDigestMessage(
      inbox({ items: [item()] }),
      morningUtc,
      { adminUrl: "https://x.com/admin" }
    );
    expect(msg).toContain("Abrir painel: https://x.com/admin");
  });

  it("não inclui linha de link sem adminUrl", () => {
    const msg = composeAdminDigestMessage(
      inbox({ items: [item()] }),
      morningUtc
    );
    expect(msg).not.toContain("Abrir painel");
  });

  it("itens overdue usam bullet diferente de due_soon", () => {
    const msg = composeAdminDigestMessage(
      inbox({
        items: [
          item({ id: "fulfillment_paid", urgency: "overdue", title: "A" }),
          item({ id: "fulfillment_shipped", urgency: "due_soon", title: "B" }),
        ],
      }),
      morningUtc
    );
    const lineA = msg.split("\n").find((l) => l.includes("A:"));
    const lineB = msg.split("\n").find((l) => l.includes("B:"));
    expect(lineA?.startsWith("•")).toBe(true);
    expect(lineB?.startsWith("◦")).toBe(true);
  });
});

describe("sendAdminDigest", () => {
  const fakeSupabase = {} as SupabaseClient;
  const now = new Date("2026-04-20T11:30:00.000Z");

  beforeEach(() => {
    loadInboxMock.mockReset();
    waMock.mockReset();
    waMock.mockResolvedValue({
      ok: true,
      messageId: "wamid.1",
      waId: "5511999998888",
    });
  });

  it("retorna missing_phone quando env vazia e sem override", async () => {
    loadInboxMock.mockResolvedValue(inbox());
    const prev = process.env.ADMIN_DIGEST_PHONE;
    delete process.env.ADMIN_DIGEST_PHONE;

    const r = await sendAdminDigest(fakeSupabase, { now });

    expect(r.sent).toBe(false);
    expect(r.reason).toBe("missing_phone");
    expect(waMock).not.toHaveBeenCalled();

    if (prev !== undefined) process.env.ADMIN_DIGEST_PHONE = prev;
  });

  it("retorna empty_inbox quando requireNonEmpty=true e inbox vazia", async () => {
    loadInboxMock.mockResolvedValue(inbox());

    const r = await sendAdminDigest(fakeSupabase, {
      now,
      phone: "+5511999998888",
      requireNonEmpty: true,
    });

    expect(r.sent).toBe(false);
    expect(r.reason).toBe("empty_inbox_and_require_non_empty");
    expect(waMock).not.toHaveBeenCalled();
  });

  it("envia mesmo com inbox vazia por default (requireNonEmpty=false)", async () => {
    loadInboxMock.mockResolvedValue(inbox());

    const r = await sendAdminDigest(fakeSupabase, {
      now,
      phone: "+5511999998888",
    });

    expect(r.sent).toBe(true);
    expect(r.reason).toBe("sent");
    expect(waMock).toHaveBeenCalledTimes(1);
    const body = waMock.mock.calls[0][0].text;
    expect(body.toLowerCase()).toContain("tudo tranquilo");
  });

  it("envia com itens e inclui link quando adminUrl é explícito", async () => {
    loadInboxMock.mockResolvedValue(inbox({ items: [item()] }));

    const r = await sendAdminDigest(fakeSupabase, {
      now,
      phone: "+5511999998888",
      adminUrl: "https://example.com/admin",
    });

    expect(r.sent).toBe(true);
    expect(waMock.mock.calls[0][0].text).toContain(
      "https://example.com/admin"
    );
  });

  it("retorna wa_failed quando envio falha", async () => {
    loadInboxMock.mockResolvedValue(inbox({ items: [item()] }));
    waMock.mockResolvedValueOnce({
      ok: false,
      code: 131047,
      message: "fora da janela",
    });

    const r = await sendAdminDigest(fakeSupabase, {
      now,
      phone: "+5511999998888",
    });

    expect(r.sent).toBe(false);
    expect(r.reason).toBe("wa_failed");
    expect(r.waCode).toBe(131047);
    expect(r.waMessage).toContain("janela");
  });

  it("propaga exception se loadAdminInbox crasha", async () => {
    loadInboxMock.mockRejectedValue(new Error("db down"));
    await expect(
      sendAdminDigest(fakeSupabase, {
        now,
        phone: "+5511999998888",
      })
    ).rejects.toThrow(/db down/);
  });

  it("reporta inboxCounts mesmo quando pula envio", async () => {
    loadInboxMock.mockResolvedValue(
      inbox({
        items: [
          item({ urgency: "overdue" }),
          item({ id: "refund", category: "refund", urgency: "due_soon" }),
        ],
      })
    );

    const prev = process.env.ADMIN_DIGEST_PHONE;
    delete process.env.ADMIN_DIGEST_PHONE;

    const r = await sendAdminDigest(fakeSupabase, { now });

    expect(r.sent).toBe(false);
    expect(r.inboxCounts.overdue).toBe(1);
    expect(r.inboxCounts.dueSoon).toBe(1);
    expect(r.inboxCounts.total).toBe(2);

    if (prev !== undefined) process.env.ADMIN_DIGEST_PHONE = prev;
  });
});
