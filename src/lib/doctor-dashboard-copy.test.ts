/**
 * Testes — doctor-dashboard-copy.ts (PR-065 · D-073 · audit [2.5]).
 *
 * Garante que o copy do card "Recebido neste mês" e a nota de pé-de-grid
 * não induzem a médica a somar valores que não vão entrar na conta no
 * mês corrente.
 */

import { describe, expect, it } from "vitest";
import {
  countAwaitingConfirmation,
  formatReceivedThisMonthHint,
  formatPendingConfirmationNote,
} from "@/lib/doctor-dashboard-copy";

describe("countAwaitingConfirmation", () => {
  it("soma approved + pixSent (draft não entra)", () => {
    expect(countAwaitingConfirmation({ draft: 5, approved: 2, pixSent: 3 })).toBe(5);
  });

  it("retorna 0 quando nada está aguardando", () => {
    expect(countAwaitingConfirmation({ draft: 10, approved: 0, pixSent: 0 })).toBe(0);
    expect(countAwaitingConfirmation({ draft: 0, approved: 0, pixSent: 0 })).toBe(0);
  });
});

describe("formatReceivedThisMonthHint", () => {
  it("sem awaiting: mostra 'via PIX confirmados'", () => {
    expect(
      formatReceivedThisMonthHint({ draft: 0, approved: 0, pixSent: 0 })
    ).toBe("via PIX confirmados");
  });

  it("draft-only conta como 0 awaiting (não aparece no hint)", () => {
    expect(
      formatReceivedThisMonthHint({ draft: 5, approved: 0, pixSent: 0 })
    ).toBe("via PIX confirmados");
  });

  it("1 awaiting: singular", () => {
    expect(
      formatReceivedThisMonthHint({ draft: 0, approved: 1, pixSent: 0 })
    ).toBe("1 repasse aguardando confirmação");
  });

  it("2+ awaiting: plural", () => {
    expect(
      formatReceivedThisMonthHint({ draft: 0, approved: 1, pixSent: 2 })
    ).toBe("3 repasses aguardando confirmação");
  });

  it("não usa '+' que induzia soma mental com o valor do card (audit [2.5])", () => {
    const hint = formatReceivedThisMonthHint({ draft: 0, approved: 2, pixSent: 1 });
    expect(hint).not.toContain("+");
    expect(hint).not.toContain("em andamento");
  });
});

describe("formatPendingConfirmationNote", () => {
  it("retorna null quando não há awaiting", () => {
    expect(
      formatPendingConfirmationNote({ draft: 0, approved: 0, pixSent: 0 })
    ).toBeNull();
    expect(
      formatPendingConfirmationNote({ draft: 10, approved: 0, pixSent: 0 })
    ).toBeNull();
  });

  it("1 awaiting: singular, 'pode cair'", () => {
    const note = formatPendingConfirmationNote({ draft: 0, approved: 1, pixSent: 0 });
    expect(note).toContain("1 repasse em andamento");
    expect(note).toContain("pode cair");
    expect(note).toContain("próximo");
  });

  it("2+ awaiting: plural, 'podem cair'", () => {
    const note = formatPendingConfirmationNote({ draft: 0, approved: 2, pixSent: 1 });
    expect(note).toContain("3 repasses em andamento");
    expect(note).toContain("podem cair");
  });

  it("deixa explícito que valor pode cair neste OU no próximo mês", () => {
    const note = formatPendingConfirmationNote({ draft: 0, approved: 1, pixSent: 1 });
    expect(note).toMatch(/neste mês ou no próximo/i);
  });
});
