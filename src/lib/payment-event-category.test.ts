/**
 * Testes do classificador de eventos Asaas (PR-014 · D-050).
 *
 * O ponto central é provar a regra financeira: `confirmed` dispara UX
 * mas NÃO dispara earning. Só `received` dispara earning.
 */

import { describe, it, expect } from "vitest";
import {
  classifyPaymentEvent,
  shouldActivateAppointment,
  shouldCreateEarning,
  shouldReverseEarning,
} from "./payment-event-category";

describe("classifyPaymentEvent", () => {
  describe("received (dinheiro liquidado)", () => {
    it("PAYMENT_RECEIVED → received", () => {
      expect(classifyPaymentEvent("PAYMENT_RECEIVED", "RECEIVED")).toBe(
        "received"
      );
    });

    it("PAYMENT_RECEIVED_IN_CASH → received", () => {
      expect(
        classifyPaymentEvent("PAYMENT_RECEIVED_IN_CASH", "RECEIVED_IN_CASH")
      ).toBe("received");
    });

    it("status RECEIVED mesmo com event ambíguo (ex: PAYMENT_UPDATED) → received", () => {
      expect(classifyPaymentEvent("PAYMENT_UPDATED", "RECEIVED")).toBe(
        "received"
      );
    });

    it("status RECEIVED_IN_CASH mesmo sem evento correspondente → received", () => {
      expect(classifyPaymentEvent(null, "RECEIVED_IN_CASH")).toBe("received");
    });
  });

  describe("confirmed (cartão aprovado, dinheiro NÃO liquidado)", () => {
    it("PAYMENT_CONFIRMED → confirmed (NÃO received — delta crítico do PR-014)", () => {
      expect(classifyPaymentEvent("PAYMENT_CONFIRMED", "CONFIRMED")).toBe(
        "confirmed"
      );
    });

    it("status CONFIRMED via PAYMENT_UPDATED → confirmed", () => {
      expect(classifyPaymentEvent("PAYMENT_UPDATED", "CONFIRMED")).toBe(
        "confirmed"
      );
    });

    it("só event PAYMENT_CONFIRMED sem status → confirmed", () => {
      expect(classifyPaymentEvent("PAYMENT_CONFIRMED", null)).toBe("confirmed");
    });
  });

  describe("reversed (estorno / chargeback)", () => {
    it("PAYMENT_REFUNDED → reversed", () => {
      expect(classifyPaymentEvent("PAYMENT_REFUNDED", "REFUNDED")).toBe(
        "reversed"
      );
    });

    it("PAYMENT_REFUND_IN_PROGRESS → reversed", () => {
      expect(
        classifyPaymentEvent("PAYMENT_REFUND_IN_PROGRESS", "CONFIRMED")
      ).toBe("reversed");
    });

    it("PAYMENT_CHARGEBACK_REQUESTED → reversed", () => {
      expect(
        classifyPaymentEvent(
          "PAYMENT_CHARGEBACK_REQUESTED",
          "CHARGEBACK_REQUESTED"
        )
      ).toBe("reversed");
    });

    it("PAYMENT_CHARGEBACK_DISPUTE → reversed", () => {
      expect(
        classifyPaymentEvent("PAYMENT_CHARGEBACK_DISPUTE", "CONFIRMED")
      ).toBe("reversed");
    });
  });

  describe("other (não aciona side-effects financeiros)", () => {
    it("PAYMENT_CREATED → other", () => {
      expect(classifyPaymentEvent("PAYMENT_CREATED", "PENDING")).toBe("other");
    });

    it("PAYMENT_UPDATED sem status conclusivo → other", () => {
      expect(classifyPaymentEvent("PAYMENT_UPDATED", "PENDING")).toBe("other");
    });

    it("PAYMENT_OVERDUE → other", () => {
      expect(classifyPaymentEvent("PAYMENT_OVERDUE", "OVERDUE")).toBe("other");
    });

    it("PAYMENT_DELETED → other", () => {
      expect(classifyPaymentEvent("PAYMENT_DELETED", "DELETED")).toBe("other");
    });

    it("evento desconhecido → other", () => {
      expect(classifyPaymentEvent("FOO_BAR_BAZ", "UNKNOWN")).toBe("other");
    });

    it("event e status nulos → other", () => {
      expect(classifyPaymentEvent(null, null)).toBe("other");
      expect(classifyPaymentEvent(undefined, undefined)).toBe("other");
      expect(classifyPaymentEvent("", "")).toBe("other");
    });
  });

  describe("precedência (received > reversed > confirmed)", () => {
    it("received tem precedência sobre confirmed (PAYMENT_RECEIVED+status CONFIRMED)", () => {
      // edge-case teórico: webhook com event novo mas status stale
      expect(classifyPaymentEvent("PAYMENT_RECEIVED", "CONFIRMED")).toBe(
        "received"
      );
    });

    it("reversed tem precedência sobre confirmed (PAYMENT_REFUNDED+status CONFIRMED)", () => {
      expect(classifyPaymentEvent("PAYMENT_REFUNDED", "CONFIRMED")).toBe(
        "reversed"
      );
    });

    it("case-insensitive (payloads mal-formatados ainda classificam certo)", () => {
      expect(classifyPaymentEvent("payment_received", "received")).toBe(
        "received"
      );
      expect(classifyPaymentEvent("Payment_Confirmed", "confirmed")).toBe(
        "confirmed"
      );
    });
  });
});

describe("shouldActivateAppointment (UX)", () => {
  it("ativa em confirmed (paciente precisa ver 'pago' imediatamente)", () => {
    expect(shouldActivateAppointment("confirmed")).toBe(true);
  });

  it("ativa em received", () => {
    expect(shouldActivateAppointment("received")).toBe(true);
  });

  it("NÃO ativa em reversed", () => {
    expect(shouldActivateAppointment("reversed")).toBe(false);
  });

  it("NÃO ativa em other", () => {
    expect(shouldActivateAppointment("other")).toBe(false);
  });
});

describe("shouldCreateEarning (financeiro — delta do PR-014)", () => {
  it("NÃO cria earning em confirmed — cartão não compensou (chargeback window aberta)", () => {
    expect(shouldCreateEarning("confirmed")).toBe(false);
  });

  it("cria earning em received", () => {
    expect(shouldCreateEarning("received")).toBe(true);
  });

  it("NÃO cria earning em reversed", () => {
    expect(shouldCreateEarning("reversed")).toBe(false);
  });

  it("NÃO cria earning em other", () => {
    expect(shouldCreateEarning("other")).toBe(false);
  });
});

describe("shouldReverseEarning", () => {
  it("reverte earning apenas em reversed", () => {
    expect(shouldReverseEarning("reversed")).toBe(true);
    expect(shouldReverseEarning("received")).toBe(false);
    expect(shouldReverseEarning("confirmed")).toBe(false);
    expect(shouldReverseEarning("other")).toBe(false);
  });
});
