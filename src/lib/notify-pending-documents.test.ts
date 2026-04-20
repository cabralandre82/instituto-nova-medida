/**
 * Testes do cron notify-pending-documents (D-041).
 *
 * Mocka o template WhatsApp (`sendMedicaDocumentoPendente`) + Supabase
 * pra verificar:
 *   - idempotência via last_nf_reminder_at (interval guard)
 *   - validação de phone / nome
 *   - marcação de last_nf_reminder_at mesmo quando template é stub
 *   - guard de MAX_NOTIFICATIONS_PER_RUN
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSupabaseMock } from "@/test/mocks/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/wa-templates", () => ({
  sendMedicaDocumentoPendente: vi.fn(),
}));

import { sendMedicaDocumentoPendente } from "@/lib/wa-templates";
import {
  notifyPendingDocuments,
  REMINDER_INTERVAL_HOURS,
} from "./notify-pending-documents";

const sendMock = vi.mocked(sendMedicaDocumentoPendente);

function payoutRow(
  over: Partial<{
    id: string;
    doctor_id: string;
    reference_period: string;
    amount_cents: number;
    paid_at: string | null;
    confirmed_at: string | null;
    last_nf_reminder_at: string | null;
    doctors:
      | {
          id: string;
          full_name: string | null;
          display_name: string | null;
          phone: string | null;
        }
      | null;
    doctor_billing_documents:
      | Array<{ id: string; validated_at: string | null }>
      | null;
  }> = {}
) {
  return {
    id: over.id ?? "p1",
    doctor_id: over.doctor_id ?? "doc1",
    reference_period: over.reference_period ?? "2026-02",
    amount_cents: over.amount_cents ?? 100000,
    paid_at: over.paid_at ?? "2026-03-01T10:00:00.000Z",
    confirmed_at: over.confirmed_at ?? "2026-03-01T15:00:00.000Z",
    last_nf_reminder_at:
      over.last_nf_reminder_at === undefined ? null : over.last_nf_reminder_at,
    doctors:
      over.doctors === undefined
        ? {
            id: "doc1",
            full_name: "Dra Ana",
            display_name: "Dra Ana",
            phone: "+5511999998888",
          }
        : over.doctors,
    doctor_billing_documents:
      over.doctor_billing_documents === undefined
        ? []
        : over.doctor_billing_documents,
  };
}

describe("notifyPendingDocuments", () => {
  let supa: ReturnType<typeof createSupabaseMock>;
  const now = new Date("2026-04-15T09:00:00.000Z");

  beforeEach(() => {
    supa = createSupabaseMock();
    sendMock.mockReset();
    sendMock.mockResolvedValue({
      ok: true,
      messageId: "wamid.1",
      waId: "5511999998888",
    });
  });

  it("retorna zeros quando não há payouts elegíveis", async () => {
    supa.enqueue("doctor_payouts", { data: [], error: null });
    const r = await notifyPendingDocuments(
      supa.client as unknown as SupabaseClient,
      now
    );
    expect(r.ok).toBe(true);
    expect(r.evaluated).toBe(0);
    expect(r.notified).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("notifica um payout elegível e marca last_nf_reminder_at", async () => {
    supa.enqueue("doctor_payouts", { data: [payoutRow()], error: null });
    // update do last_nf_reminder_at depois do send
    supa.enqueue("doctor_payouts", { data: null, error: null });

    const r = await notifyPendingDocuments(
      supa.client as unknown as SupabaseClient,
      now
    );
    expect(r.notified).toBe(1);
    expect(r.evaluated).toBe(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
    // Verifica que chamou com os dados certos
    expect(sendMock.mock.calls[0][0].to).toBe("+5511999998888");
    expect(sendMock.mock.calls[0][0].doctorNome).toBe("Dra Ana");
    // Update do last_nf_reminder_at aconteceu
    const updateCalls = supa.calls.filter((c) =>
      c.chain.includes("update")
    );
    expect(updateCalls).toHaveLength(1);
  });

  it("respeita interval guard (não cobra 2x dentro das N horas)", async () => {
    const recentReminder = new Date(
      now.getTime() - (REMINDER_INTERVAL_HOURS - 1) * 60 * 60 * 1000
    ).toISOString();
    supa.enqueue("doctor_payouts", {
      data: [payoutRow({ last_nf_reminder_at: recentReminder })],
      error: null,
    });

    const r = await notifyPendingDocuments(
      supa.client as unknown as SupabaseClient,
      now
    );
    expect(r.skippedInterval).toBe(1);
    expect(r.notified).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("permite novo lembrete depois do interval", async () => {
    const oldReminder = new Date(
      now.getTime() - (REMINDER_INTERVAL_HOURS + 2) * 60 * 60 * 1000
    ).toISOString();
    supa.enqueue("doctor_payouts", {
      data: [payoutRow({ last_nf_reminder_at: oldReminder })],
      error: null,
    });
    supa.enqueue("doctor_payouts", { data: null, error: null });

    const r = await notifyPendingDocuments(
      supa.client as unknown as SupabaseClient,
      now
    );
    expect(r.notified).toBe(1);
  });

  it("ignora payouts com NF já validada", async () => {
    supa.enqueue("doctor_payouts", {
      data: [
        payoutRow({
          doctor_billing_documents: [
            { id: "d1", validated_at: "2026-04-05T09:00:00.000Z" },
          ],
        }),
      ],
      error: null,
    });
    const r = await notifyPendingDocuments(
      supa.client as unknown as SupabaseClient,
      now
    );
    expect(r.evaluated).toBe(0);
    expect(r.notified).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("pula e marca last_nf_reminder_at quando médica não tem phone", async () => {
    supa.enqueue("doctor_payouts", {
      data: [
        payoutRow({
          doctors: {
            id: "doc1",
            full_name: "Dra Sem Fone",
            display_name: null,
            phone: null,
          },
        }),
      ],
      error: null,
    });
    supa.enqueue("doctor_payouts", { data: null, error: null });

    const r = await notifyPendingDocuments(
      supa.client as unknown as SupabaseClient,
      now
    );
    expect(r.skippedMissingPhone).toBe(1);
    expect(r.notified).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
    // mesmo pulando, marca pra não entrar em loop no próximo dia
    const updateCalls = supa.calls.filter((c) => c.chain.includes("update"));
    expect(updateCalls).toHaveLength(1);
  });

  it("conta stub do template (templates_not_approved) como skipped_template", async () => {
    sendMock.mockResolvedValueOnce({
      ok: false,
      code: null,
      message: "templates_not_approved",
    });
    supa.enqueue("doctor_payouts", { data: [payoutRow()], error: null });
    supa.enqueue("doctor_payouts", { data: null, error: null }); // update

    const r = await notifyPendingDocuments(
      supa.client as unknown as SupabaseClient,
      now
    );
    expect(r.notified).toBe(0);
    expect(r.skippedTemplate).toBe(1);
    // Mesmo com stub, marca last_nf_reminder_at pra evitar loop
    const updateCalls = supa.calls.filter((c) => c.chain.includes("update"));
    expect(updateCalls).toHaveLength(1);
  });

  it("captura exceção do send e conta como erro", async () => {
    sendMock.mockRejectedValueOnce(new Error("whatsapp timeout"));
    supa.enqueue("doctor_payouts", { data: [payoutRow()], error: null });

    const r = await notifyPendingDocuments(
      supa.client as unknown as SupabaseClient,
      now
    );
    expect(r.errors).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.details[0].outcome).toBe("error");
  });

  it("em caso de erro no load, retorna ok=false sem notificar", async () => {
    supa.enqueue("doctor_payouts", {
      data: null,
      error: { message: "db down" },
    });
    const r = await notifyPendingDocuments(
      supa.client as unknown as SupabaseClient,
      now
    );
    expect(r.ok).toBe(false);
    expect(r.errors).toBe(1);
    expect(r.notified).toBe(0);
  });
});
