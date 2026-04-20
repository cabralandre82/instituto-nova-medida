/**
 * Testes dos composers de mensagem WhatsApp (D-044 · 2.E).
 */

import { describe, expect, it } from "vitest";
import {
  composeCancelledMessage,
  composeDeliveredMessage,
  composePharmacyRequestedMessage,
  composeShippedMessage,
} from "./fulfillment-messages";

describe("composePharmacyRequestedMessage", () => {
  it("usa primeiro nome e cita plano", () => {
    const msg = composePharmacyRequestedMessage({
      customerName: "Maria da Silva",
      planName: "Tirzepatida 90 dias",
    });
    expect(msg).toContain("Maria");
    expect(msg).not.toContain("Silva");
    expect(msg).toContain("Tirzepatida 90 dias");
    expect(msg.toLowerCase()).toContain("farmácia");
  });

  it("fallback pra 'paciente' sem nome", () => {
    const msg = composePharmacyRequestedMessage({
      customerName: "",
      planName: "X",
    });
    expect(msg).toContain("paciente");
  });
});

describe("composeShippedMessage", () => {
  it("inclui rastreio limpo e CTA de confirmar", () => {
    const msg = composeShippedMessage({
      customerName: "João",
      planName: "Plano Y",
      trackingNote: "Correios BR123456789",
    });
    expect(msg).toContain("João");
    expect(msg).toContain("Plano Y");
    expect(msg).toContain("Correios BR123456789");
    expect(msg.toLowerCase()).toContain("confirme");
  });
});

describe("composeDeliveredMessage", () => {
  it("fecha o ciclo citando plano", () => {
    const msg = composeDeliveredMessage({
      customerName: "Ana Clara",
      planName: "Semaglutida 90",
    });
    expect(msg).toContain("Ana");
    expect(msg).toContain("Semaglutida 90");
    expect(msg.toLowerCase()).toContain("entrega");
  });
});

describe("composeCancelledMessage", () => {
  it("cita motivo", () => {
    const msg = composeCancelledMessage({
      customerName: "Pedro",
      planName: "Plano Z",
      reason: "Estoque da farmácia parceira indisponível no momento.",
    });
    expect(msg).toContain("Pedro");
    expect(msg).toContain("Plano Z");
    expect(msg).toContain("Estoque da farmácia");
  });
});

describe("LGPD: nenhuma mensagem vaza CPF, endereço ou rua", () => {
  const params = {
    customerName: "Test Name",
    planName: "Plano X",
    trackingNote: "Correios BR1",
    reason: "qualquer",
  };
  const messages = [
    composePharmacyRequestedMessage(params),
    composeShippedMessage(params),
    composeDeliveredMessage(params),
    composeCancelledMessage(params),
  ];
  it.each(messages.map((m, i) => [i, m]))(
    "mensagem %i não contém padrões sensíveis",
    (_i, msg) => {
      // regex heurísticos: CPF = 11 dígitos, CEP = 5+3, rua costuma ter "Rua " ou "Av."
      expect(msg).not.toMatch(/\d{11}/);
      expect(msg).not.toMatch(/\d{5}-?\d{3}/);
      expect(msg).not.toMatch(/Rua\s|Avenida\s|Av\.\s/);
    }
  );
});
