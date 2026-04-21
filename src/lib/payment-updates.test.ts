/**
 * Testes — payment-updates.ts (PR-013 / audit [5.1]).
 *
 * Garante o contrato first-write-wins do timestamp contábil `paid_at` e
 * `refunded_at`. Essa é uma garantia forte — se regredirmos aqui, toda
 * a reconciliação financeira é afetada.
 */

import { describe, expect, it } from "vitest";
import {
  decidePaymentTimestampUpdate,
  isReceivedStatus,
  isRefundStatus,
} from "@/lib/payment-updates";

const FIXED_NOW = "2026-04-20T12:34:56.000Z";

describe("isReceivedStatus", () => {
  it.each(["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"])(
    "aceita %s",
    (s) => expect(isReceivedStatus(s)).toBe(true)
  );

  it.each(["PENDING", "OVERDUE", "REFUNDED", "CANCELLED", ""])(
    "rejeita %s",
    (s) => expect(isReceivedStatus(s)).toBe(false)
  );
});

describe("isRefundStatus", () => {
  it.each(["REFUNDED", "REFUND_IN_PROGRESS"])("aceita %s", (s) =>
    expect(isRefundStatus(s)).toBe(true)
  );

  it.each(["RECEIVED", "CONFIRMED", "PENDING", "CHARGEBACK_REQUESTED"])(
    "rejeita %s",
    (s) => expect(isRefundStatus(s)).toBe(false)
  );
});

describe("decidePaymentTimestampUpdate", () => {
  describe("status confirma pagamento", () => {
    it("primeiro evento: grava paid_at com now injetado", () => {
      const d = decidePaymentTimestampUpdate(
        "RECEIVED",
        { paid_at: null, refunded_at: null },
        FIXED_NOW
      );
      expect(d).toEqual({ paid_at: FIXED_NOW });
    });

    it("existing.paid_at já fixado: não grava nem sobrescreve", () => {
      const ORIGINAL_PAID = "2026-04-18T10:00:00.000Z";
      const d = decidePaymentTimestampUpdate(
        "RECEIVED",
        { paid_at: ORIGINAL_PAID, refunded_at: null },
        FIXED_NOW
      );
      expect(d.paid_at).toBeUndefined();
      expect(d.paid_at_skipped).toBe(ORIGINAL_PAID);
    });

    it("payment ainda não existe no banco (existing=null): grava paid_at", () => {
      const d = decidePaymentTimestampUpdate("RECEIVED", null, FIXED_NOW);
      expect(d).toEqual({ paid_at: FIXED_NOW });
    });

    it("CONFIRMED depois de CONFIRMED anterior: preserva o primeiro", () => {
      const FIRST = "2026-04-18T10:00:00.000Z";
      const d = decidePaymentTimestampUpdate(
        "CONFIRMED",
        { paid_at: FIRST, refunded_at: null },
        FIXED_NOW
      );
      expect(d.paid_at).toBeUndefined();
      expect(d.paid_at_skipped).toBe(FIRST);
    });

    it("sequência real: CONFIRMED fixa, depois RECEIVED não sobrescreve", () => {
      // Primeiro webhook: CONFIRMED (sem paid_at no banco ainda)
      const d1 = decidePaymentTimestampUpdate(
        "CONFIRMED",
        { paid_at: null, refunded_at: null },
        "2026-04-18T10:00:00.000Z"
      );
      expect(d1.paid_at).toBe("2026-04-18T10:00:00.000Z");

      // Segundo webhook: RECEIVED (com paid_at já fixado do passo 1)
      const d2 = decidePaymentTimestampUpdate(
        "RECEIVED",
        { paid_at: "2026-04-18T10:00:00.000Z", refunded_at: null },
        "2026-04-18T10:05:00.000Z" // 5 min depois
      );
      expect(d2.paid_at).toBeUndefined();
      expect(d2.paid_at_skipped).toBe("2026-04-18T10:00:00.000Z");
    });
  });

  describe("status de estorno", () => {
    it("primeiro REFUNDED: grava refunded_at", () => {
      const d = decidePaymentTimestampUpdate(
        "REFUNDED",
        { paid_at: "2026-04-18T10:00:00.000Z", refunded_at: null },
        FIXED_NOW
      );
      expect(d.refunded_at).toBe(FIXED_NOW);
    });

    it("REFUNDED depois de REFUND_IN_PROGRESS: preserva o primeiro", () => {
      const FIRST = "2026-04-19T11:00:00.000Z";
      const d = decidePaymentTimestampUpdate(
        "REFUNDED",
        { paid_at: "2026-04-18T10:00:00.000Z", refunded_at: FIRST },
        FIXED_NOW
      );
      expect(d.refunded_at).toBeUndefined();
      expect(d.refunded_at_skipped).toBe(FIRST);
    });

    it("status REFUND não toca paid_at", () => {
      const d = decidePaymentTimestampUpdate(
        "REFUNDED",
        { paid_at: "2026-04-18T10:00:00.000Z", refunded_at: null },
        FIXED_NOW
      );
      expect(d.paid_at).toBeUndefined();
      expect(d.paid_at_skipped).toBeUndefined();
    });
  });

  describe("status neutros (PENDING, OVERDUE, DELETED)", () => {
    it("não toca em nenhum timestamp", () => {
      expect(
        decidePaymentTimestampUpdate(
          "PENDING",
          { paid_at: null, refunded_at: null },
          FIXED_NOW
        )
      ).toEqual({});

      expect(
        decidePaymentTimestampUpdate(
          "OVERDUE",
          { paid_at: null, refunded_at: null },
          FIXED_NOW
        )
      ).toEqual({});

      expect(
        decidePaymentTimestampUpdate(
          "DELETED",
          { paid_at: "2026-04-18T10:00:00.000Z", refunded_at: null },
          FIXED_NOW
        )
      ).toEqual({});
    });
  });

  describe("status desconhecido (forward-compat)", () => {
    it("trata string vazia, strings randômicas como neutro", () => {
      expect(
        decidePaymentTimestampUpdate(
          "",
          { paid_at: null, refunded_at: null },
          FIXED_NOW
        )
      ).toEqual({});

      expect(
        decidePaymentTimestampUpdate(
          "SOME_NEW_ASAAS_STATUS",
          { paid_at: null, refunded_at: null },
          FIXED_NOW
        )
      ).toEqual({});
    });
  });
});
