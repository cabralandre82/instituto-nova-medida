/**
 * Testes de `redactAsaasPayload` (PR-052 · D-063).
 *
 * Cobre:
 *   - Envelope (id, event, dateCreated preservados).
 *   - payment.* allowlist (campos financeiros OK, description/metadata OFF).
 *   - payment.customer: string passa, object expandido reduzido a
 *     `{id, externalReference}`.
 *   - creditCard/creditCardHolderInfo: dropado.
 *   - refunds[]: metadados OK.
 *   - discount/fine/interest: só `value/type/dueDateLimitDays`.
 *   - pixTransaction: só `qrCode/endToEndIdentifier/txid` (sem payload EMV).
 *   - inputs inválidos (null, array, string).
 */

import { describe, it, expect } from "vitest";
import { redactAsaasPayload } from "./asaas-event-redact";

describe("redactAsaasPayload", () => {
  it("input nao-objeto → retorna {}", () => {
    expect(redactAsaasPayload(null)).toEqual({});
    expect(redactAsaasPayload(undefined)).toEqual({});
    expect(redactAsaasPayload("foo")).toEqual({});
    expect(redactAsaasPayload(123)).toEqual({});
    expect(redactAsaasPayload([])).toEqual({});
  });

  it("preserva envelope (id, event, dateCreated)", () => {
    const out = redactAsaasPayload({
      id: "evt_123",
      event: "PAYMENT_RECEIVED",
      dateCreated: "2026-04-20T12:00:00Z",
      // Campo não-listado ao nível envelope
      customFieldAtEnvelope: "sensitive",
    });
    expect(out.id).toBe("evt_123");
    expect(out.event).toBe("PAYMENT_RECEIVED");
    expect(out.dateCreated).toBe("2026-04-20T12:00:00Z");
    expect(out).not.toHaveProperty("customFieldAtEnvelope");
  });

  it("preserva campos financeiros em payment.* e dropa description/metadata", () => {
    const out = redactAsaasPayload({
      id: "evt_1",
      event: "PAYMENT_RECEIVED",
      payment: {
        id: "pay_abc",
        status: "RECEIVED",
        billingType: "PIX",
        value: 100.5,
        netValue: 99.0,
        dueDate: "2026-04-20",
        paymentDate: "2026-04-20",
        externalReference: "our-payment-uuid",
        invoiceNumber: "123",
        // PII em description
        description: "Paciente Maria Silva CPF 123.456.789-00",
        // Metadata com PII nao listada
        metadata: { cpf: "123.456.789-00", email: "a@b.com" },
        // Customer = string (ID Asaas)
        customer: "cus_xyz",
      },
    });
    expect(out.payment).toBeDefined();
    const p = out.payment as Record<string, unknown>;
    expect(p.id).toBe("pay_abc");
    expect(p.status).toBe("RECEIVED");
    expect(p.value).toBe(100.5);
    expect(p.externalReference).toBe("our-payment-uuid");
    expect(p.customer).toBe("cus_xyz");
    expect(p).not.toHaveProperty("description");
    expect(p).not.toHaveProperty("metadata");
  });

  it("payment.customer objeto expandido → reduzido a {id, externalReference}", () => {
    const out = redactAsaasPayload({
      id: "evt_1",
      event: "PAYMENT_RECEIVED",
      payment: {
        id: "pay_1",
        status: "RECEIVED",
        customer: {
          id: "cus_xyz",
          name: "Maria Silva",
          cpfCnpj: "12345678900",
          email: "maria@example.com",
          phone: "11999999999",
          mobilePhone: "11999999999",
          address: "Rua X",
          addressNumber: "123",
          complement: "Apto 45",
          province: "Bairro Y",
          postalCode: "01000000",
          city: "São Paulo",
          state: "SP",
          country: "Brasil",
          externalReference: "our-customer-uuid",
          company: "Acme",
        },
      },
    });
    const p = out.payment as Record<string, unknown>;
    const customer = p.customer as Record<string, unknown>;
    expect(customer.id).toBe("cus_xyz");
    expect(customer.externalReference).toBe("our-customer-uuid");
    // Nenhum campo PII deve estar presente
    expect(customer).not.toHaveProperty("name");
    expect(customer).not.toHaveProperty("cpfCnpj");
    expect(customer).not.toHaveProperty("email");
    expect(customer).not.toHaveProperty("phone");
    expect(customer).not.toHaveProperty("mobilePhone");
    expect(customer).not.toHaveProperty("address");
    expect(customer).not.toHaveProperty("addressNumber");
    expect(customer).not.toHaveProperty("postalCode");
    expect(customer).not.toHaveProperty("city");
    expect(customer).not.toHaveProperty("state");
    expect(customer).not.toHaveProperty("country");
    expect(customer).not.toHaveProperty("company");
    expect(customer).not.toHaveProperty("complement");
    expect(customer).not.toHaveProperty("province");
  });

  it("creditCard / creditCardHolderInfo / payer / billing completamente dropados", () => {
    const out = redactAsaasPayload({
      id: "evt_1",
      event: "PAYMENT_CONFIRMED",
      payment: {
        id: "pay_1",
        status: "CONFIRMED",
        billingType: "CREDIT_CARD",
        creditCard: {
          creditCardNumber: "4111111111111111",
          creditCardBrand: "VISA",
          creditCardToken: "tok_abc",
        },
        creditCardHolderInfo: {
          name: "Joao Silva",
          email: "joao@x.com",
          cpfCnpj: "12345678900",
          postalCode: "01000000",
          addressNumber: "1",
          phone: "11999999999",
        },
        creditCardToken: "tok_xyz",
        payer: {
          name: "Joao Silva",
          cpfCnpj: "12345678900",
        },
        billing: { address: "Rua X", cpfCnpj: "12345678900" },
      },
    });
    const p = out.payment as Record<string, unknown>;
    expect(p).not.toHaveProperty("creditCard");
    expect(p).not.toHaveProperty("creditCardHolderInfo");
    expect(p).not.toHaveProperty("creditCardToken");
    expect(p).not.toHaveProperty("payer");
    expect(p).not.toHaveProperty("billing");
  });

  it("payment.refunds[] preservado com allowlist por item", () => {
    const out = redactAsaasPayload({
      id: "evt_1",
      event: "PAYMENT_REFUNDED",
      payment: {
        id: "pay_1",
        status: "REFUNDED",
        refunds: [
          {
            id: "ref_1",
            status: "DONE",
            value: 50.0,
            dateCreated: "2026-04-20T10:00:00Z",
            refundDate: "2026-04-20",
            // Campo PII-ish nao-listado
            description: "Solicitacao do paciente Maria Silva CPF ...",
            endToEndIdentifier: "E12345-senstivo-maybe",
          },
          // Item invalido no array é filtrado
          "string-nao-esperada",
        ],
      },
    });
    const p = out.payment as Record<string, unknown>;
    const refunds = p.refunds as Array<Record<string, unknown>>;
    expect(refunds).toHaveLength(1);
    expect(refunds[0].id).toBe("ref_1");
    expect(refunds[0].value).toBe(50);
    expect(refunds[0]).not.toHaveProperty("description");
    expect(refunds[0]).not.toHaveProperty("endToEndIdentifier");
  });

  it("discount/fine/interest: so value/type/dueDateLimitDays", () => {
    const out = redactAsaasPayload({
      id: "evt_1",
      event: "PAYMENT_OVERDUE",
      payment: {
        id: "pay_1",
        status: "OVERDUE",
        discount: {
          value: 5.0,
          dueDateLimitDays: 7,
          type: "FIXED",
          description: "Desconto PIX CPF 123.456.789-00",
        },
        fine: {
          value: 2.0,
          type: "FIXED",
          description: "Multa por atraso (paciente Joao)",
        },
        interest: {
          value: 1.0,
          type: "PERCENTAGE",
          description: "Juros (paciente Maria)",
        },
      },
    });
    const p = out.payment as Record<string, unknown>;
    expect(p.discount).toEqual({
      value: 5.0,
      dueDateLimitDays: 7,
      type: "FIXED",
    });
    expect(p.fine).toEqual({ value: 2.0, type: "FIXED" });
    expect(p.interest).toEqual({ value: 1.0, type: "PERCENTAGE" });
  });

  it("pixTransaction: so qrCode/endToEndIdentifier/txid; dropa payload EMV", () => {
    const out = redactAsaasPayload({
      id: "evt_1",
      event: "PAYMENT_RECEIVED",
      payment: {
        id: "pay_1",
        status: "RECEIVED",
        billingType: "PIX",
        pixTransaction: {
          qrCode: "0002012653...",
          endToEndIdentifier: "E12345678202604200000123456",
          txid: "abc123",
          payload: "<EMV com CPF embutido>",
          payer: { name: "Joao Silva", cpfCnpj: "..." },
        },
      },
    });
    const p = out.payment as Record<string, unknown>;
    const pix = p.pixTransaction as Record<string, unknown>;
    expect(pix.qrCode).toBe("0002012653...");
    expect(pix.endToEndIdentifier).toBe("E12345678202604200000123456");
    expect(pix.txid).toBe("abc123");
    expect(pix).not.toHaveProperty("payload");
    expect(pix).not.toHaveProperty("payer");
  });

  it("campo fora da allowlist no envelope é dropado", () => {
    const out = redactAsaasPayload({
      id: "evt_1",
      event: "PAYMENT_RECEIVED",
      dateCreated: "2026-04-20T12:00:00Z",
      newFieldAsaasIntroduziu: {
        cpf: "12345678900",
      },
    });
    expect(out).not.toHaveProperty("newFieldAsaasIntroduziu");
  });

  it("nao muta o input", () => {
    const input = {
      id: "evt_1",
      event: "PAYMENT_RECEIVED",
      payment: {
        id: "pay_1",
        status: "RECEIVED",
        description: "PII aqui",
        customer: { id: "c1", name: "X" },
      },
    };
    const snapshotBefore = JSON.stringify(input);
    redactAsaasPayload(input);
    const snapshotAfter = JSON.stringify(input);
    expect(snapshotAfter).toBe(snapshotBefore);
  });

  it("payment ausente → envelope so tem id/event/dateCreated", () => {
    const out = redactAsaasPayload({
      id: "evt_1",
      event: "PAYMENT_UPDATED",
    });
    expect(out.id).toBe("evt_1");
    expect(out.event).toBe("PAYMENT_UPDATED");
    expect(out).not.toHaveProperty("payment");
  });

  it("payment.subscription/installment preservados (IDs de negocio)", () => {
    const out = redactAsaasPayload({
      id: "evt_1",
      event: "PAYMENT_RECEIVED",
      payment: {
        id: "pay_1",
        status: "RECEIVED",
        subscription: "sub_123",
        installment: "inst_456",
        installmentNumber: 2,
        installmentCount: 12,
      },
    });
    const p = out.payment as Record<string, unknown>;
    expect(p.subscription).toBe("sub_123");
    expect(p.installment).toBe("inst_456");
    expect(p.installmentNumber).toBe(2);
    expect(p.installmentCount).toBe(12);
  });
});
