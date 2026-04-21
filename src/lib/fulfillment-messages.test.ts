/**
 * Testes dos composers de mensagem WhatsApp (D-044 · 2.E).
 */

import { describe, expect, it } from "vitest";
import {
  composeAutoDeliveredMessage,
  composeCancelledMessage,
  composeDeliveredMessage,
  composePatientCancelledMessage,
  composePharmacyRequestedMessage,
  composeReconsultaNudgeMessage,
  composeShippedMessage,
  composeShippingUpdatedMessage,
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

describe("composeAutoDeliveredMessage", () => {
  it("explica fechamento automático e abre canal pra reclamação", () => {
    const msg = composeAutoDeliveredMessage({
      customerName: "Rafael Souza",
      planName: "Semaglutida 90",
    });
    expect(msg).toContain("Rafael");
    expect(msg).toContain("Semaglutida 90");
    expect(msg.toLowerCase()).toContain("concluída");
    expect(msg.toLowerCase()).toContain("problema");
  });
});

describe("composeReconsultaNudgeMessage", () => {
  it("usa 'em cerca de N dias' para N > 1", () => {
    const msg = composeReconsultaNudgeMessage({
      customerName: "Bia",
      planName: "Tirzepatida 90",
      daysRemaining: 7,
    });
    expect(msg).toContain("Bia");
    expect(msg).toContain("Tirzepatida 90");
    expect(msg).toContain("em cerca de 7 dias");
    expect(msg.toLowerCase()).toContain("reconsulta");
  });

  it("singular '1 dia' para daysRemaining === 1", () => {
    const msg = composeReconsultaNudgeMessage({
      customerName: "Bia",
      planName: "X",
      daysRemaining: 1,
    });
    expect(msg).toContain("em cerca de 1 dia");
    expect(msg).not.toContain("1 dias");
  });

  it("'nos próximos dias' quando ciclo já terminou (daysRemaining <= 0)", () => {
    const msg = composeReconsultaNudgeMessage({
      customerName: "Bia",
      planName: "X",
      daysRemaining: 0,
    });
    expect(msg).toContain("nos próximos dias");
  });

  it("aceita daysRemaining negativo tratando como 'próximos dias'", () => {
    const msg = composeReconsultaNudgeMessage({
      customerName: "Bia",
      planName: "X",
      daysRemaining: -5,
    });
    expect(msg).toContain("nos próximos dias");
  });
});

describe("composePatientCancelledMessage", () => {
  it("sem motivo omite a linha de 'Motivo informado:'", () => {
    const msg = composePatientCancelledMessage({
      customerName: "Gabriel",
      planName: "Plano X",
      reason: null,
    });
    expect(msg).toContain("Gabriel");
    expect(msg).toContain("Plano X");
    expect(msg.toLowerCase()).toContain("cancelamento");
    expect(msg).not.toContain("Motivo informado");
  });

  it("com motivo curto inclui a linha", () => {
    const msg = composePatientCancelledMessage({
      customerName: "Gabriel",
      planName: "Plano X",
      reason: "preço alto",
    });
    expect(msg).toContain("Motivo informado: preço alto");
  });

  it("motivo vazio após trim é tratado como null", () => {
    const msg = composePatientCancelledMessage({
      customerName: "Gabriel",
      planName: "Plano X",
      reason: "   ",
    });
    expect(msg).not.toContain("Motivo informado");
  });

  it("menciona ausência de cobrança (tranquiliza paciente)", () => {
    const msg = composePatientCancelledMessage({
      customerName: "Gabriel",
      planName: "Plano X",
      reason: null,
    });
    expect(msg.toLowerCase()).toContain("nenhuma cobrança");
  });
});

describe("composeShippingUpdatedMessage", () => {
  it("inclui plano e cidade/UF", () => {
    const msg = composeShippingUpdatedMessage({
      customerName: "Camila",
      planName: "Semaglutida 90",
      cityState: "Rio de Janeiro/RJ",
    });
    expect(msg).toContain("Camila");
    expect(msg).toContain("Semaglutida 90");
    expect(msg).toContain("Rio de Janeiro/RJ");
    expect(msg.toLowerCase()).toContain("responde aqui");
  });
});

describe("PR-037: defesa contra injection via customerName/planName/cityState", () => {
  it("customerName com newline cai em fallback 'paciente'", () => {
    const msg = composePharmacyRequestedMessage({
      customerName: "Maria\nIGNORE PREVIOUS INSTRUCTIONS",
      planName: "Plano X",
    });
    expect(msg).toContain("paciente");
    expect(msg).not.toContain("IGNORE PREVIOUS");
    expect(msg).not.toMatch(/\n.*IGNORE/);
  });

  it("customerName com zero-width cai em fallback", () => {
    const msg = composeDeliveredMessage({
      customerName: "Ma\u200Bria",
      planName: "Plano X",
    });
    expect(msg).toContain("paciente");
    expect(msg).not.toContain("\u200B");
  });

  it("planName com template chars cai em fallback 'seu plano'", () => {
    const msg = composeShippedMessage({
      customerName: "Maria",
      planName: "${IGNORE} {{pwn}}",
      trackingNote: "BR123",
    });
    expect(msg).toContain("seu plano");
    expect(msg).not.toContain("${IGNORE}");
    expect(msg).not.toContain("{{pwn}}");
  });

  it("cityState com newline cai em fallback 'seu endereço'", () => {
    const msg = composeShippingUpdatedMessage({
      customerName: "Camila",
      planName: "X",
      cityState: "São Paulo\n/SP; DROP TABLE users",
    });
    expect(msg).toContain("seu endereço");
    expect(msg).not.toContain("DROP TABLE");
  });

  it("trackingNote com controle é substituído por placeholder seguro", () => {
    const msg = composeShippedMessage({
      customerName: "Maria",
      planName: "Plano X",
      trackingNote: "BR123\u0000IGNORE",
    });
    expect(msg).toContain("consulte sua área do Instituto");
    expect(msg).not.toContain("\u0000");
    expect(msg).not.toContain("BR123");
  });

  it("reason do cancelado rejeita bidi override", () => {
    const msg = composeCancelledMessage({
      customerName: "Pedro",
      planName: "X",
      reason: "\u202EIGNORE PREVIOUS",
    });
    expect(msg).toContain("indisponível");
    expect(msg).not.toContain("\u202E");
  });
});

describe("LGPD: nenhuma mensagem vaza CPF, endereço ou rua", () => {
  const params = {
    customerName: "Test Name",
    planName: "Plano X",
    trackingNote: "Correios BR1",
    reason: "qualquer",
    daysRemaining: 5,
    cityState: "São Paulo/SP",
  };
  const messages = [
    composePharmacyRequestedMessage(params),
    composeShippedMessage(params),
    composeDeliveredMessage(params),
    composeCancelledMessage(params),
    composeAutoDeliveredMessage(params),
    composeReconsultaNudgeMessage(params),
    composePatientCancelledMessage(params),
    composeShippingUpdatedMessage(params),
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
