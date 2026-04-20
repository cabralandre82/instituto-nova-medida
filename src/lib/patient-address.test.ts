/**
 * Testes unitários de validação de endereço do paciente (D-044 · 2.C).
 *
 * Foco em:
 *   - Cobertura de todos os branches de erro (cada campo sozinho).
 *   - Robustez contra whitespace, máscaras e case.
 *   - Correto fallback de recipient_name pro nome do paciente.
 *   - Consistência das funções de conversão pra patches SQL.
 */

import { describe, it, expect } from "vitest";
import {
  customerToAddressInput,
  normalizeState,
  normalizeZipcode,
  snapshotToCustomerPatch,
  snapshotToFulfillmentPatch,
  validateAddress,
  type AddressInput,
} from "./patient-address";
import type { ShippingSnapshot } from "./fulfillments";

const valid: AddressInput = {
  zipcode: "01310-100",
  street: "Avenida Paulista",
  number: "1000",
  complement: "apto 12",
  district: "Bela Vista",
  city: "São Paulo",
  state: "SP",
};

const patientName = "Maria da Silva";

describe("normalizeZipcode", () => {
  it("remove tudo que não é dígito", () => {
    expect(normalizeZipcode("01310-100")).toBe("01310100");
    expect(normalizeZipcode("01310.100")).toBe("01310100");
    expect(normalizeZipcode(" 01310 100 ")).toBe("01310100");
  });
});

describe("normalizeState", () => {
  it("trim + uppercase", () => {
    expect(normalizeState(" sp ")).toBe("SP");
    expect(normalizeState("rj")).toBe("RJ");
    expect(normalizeState("MG")).toBe("MG");
  });
});

describe("validateAddress · happy paths", () => {
  it("aceita endereço válido e devolve snapshot canônico", () => {
    const result = validateAddress(valid, patientName);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot).toEqual<ShippingSnapshot>({
      recipient_name: patientName,
      zipcode: "01310100",
      street: "Avenida Paulista",
      number: "1000",
      complement: "apto 12",
      district: "Bela Vista",
      city: "São Paulo",
      state: "SP",
    });
  });

  it("usa recipient_name explícito quando informado", () => {
    const result = validateAddress(
      { ...valid, recipient_name: "João (vizinho)" },
      patientName
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.recipient_name).toBe("João (vizinho)");
  });

  it("usa fallback do paciente quando recipient_name vem vazio", () => {
    const result = validateAddress(
      { ...valid, recipient_name: "   " },
      patientName
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.recipient_name).toBe(patientName);
  });

  it("complement vazio vira null no snapshot", () => {
    const result = validateAddress(
      { ...valid, complement: "   " },
      patientName
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.complement).toBeNull();
  });

  it("state minúsculo é normalizado pra maiúsculo", () => {
    const result = validateAddress({ ...valid, state: "sp" }, patientName);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.state).toBe("SP");
  });

  it("CEP com máscara ou sem máscara produz o mesmo snapshot", () => {
    const masked = validateAddress(
      { ...valid, zipcode: "01310-100" },
      patientName
    );
    const unmasked = validateAddress(
      { ...valid, zipcode: "01310100" },
      patientName
    );
    expect(masked.ok && unmasked.ok).toBe(true);
    if (masked.ok && unmasked.ok) {
      expect(masked.snapshot).toEqual(unmasked.snapshot);
    }
  });

  it("colapsa whitespace duplo em campos de texto", () => {
    const result = validateAddress(
      {
        ...valid,
        street: "  Avenida   Paulista  ",
        city: " São  Paulo ",
        district: " Bela   Vista ",
      },
      patientName
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.street).toBe("Avenida Paulista");
    expect(result.snapshot.city).toBe("São Paulo");
    expect(result.snapshot.district).toBe("Bela Vista");
  });

  it("aceita número 'S/N' literal", () => {
    const result = validateAddress({ ...valid, number: "S/N" }, patientName);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.number).toBe("S/N");
  });
});

describe("validateAddress · erros", () => {
  it("rejeita CEP inválido", () => {
    const r1 = validateAddress({ ...valid, zipcode: "123" }, patientName);
    expect(r1.ok).toBe(false);
    if (r1.ok) return;
    expect(r1.errors.zipcode).toBeTruthy();

    const r2 = validateAddress({ ...valid, zipcode: "" }, patientName);
    expect(r2.ok).toBe(false);
  });

  it("rejeita UF fora da lista", () => {
    const r = validateAddress({ ...valid, state: "XX" }, patientName);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.state).toBeTruthy();
  });

  it("rejeita rua, número, bairro e cidade vazios", () => {
    const r = validateAddress(
      {
        ...valid,
        street: " ",
        number: " ",
        district: " ",
        city: " ",
      },
      patientName
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.street).toBeTruthy();
    expect(r.errors.number).toBeTruthy();
    expect(r.errors.district).toBeTruthy();
    expect(r.errors.city).toBeTruthy();
  });

  it("rejeita recipient_name muito curto (e fallback também curto)", () => {
    const r = validateAddress(
      { ...valid, recipient_name: "ab" },
      // fallback curto também é insuficiente, garantindo o erro
      "a"
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.recipient_name).toBeTruthy();
  });

  it("agrega múltiplos erros num único retorno (UX: mostrar tudo)", () => {
    const r = validateAddress(
      {
        zipcode: "xx",
        street: "",
        number: "",
        district: "",
        city: "",
        state: "ZZ",
      },
      patientName
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).length).toBeGreaterThanOrEqual(5);
  });
});

describe("snapshotToCustomerPatch / snapshotToFulfillmentPatch", () => {
  const snap: ShippingSnapshot = {
    recipient_name: "Maria da Silva",
    zipcode: "01310100",
    street: "Avenida Paulista",
    number: "1000",
    complement: "apto 12",
    district: "Bela Vista",
    city: "São Paulo",
    state: "SP",
  };

  it("customerPatch traduz nomes: shipping_* → address_*", () => {
    const patch = snapshotToCustomerPatch(snap);
    expect(patch).toMatchObject({
      address_zipcode: "01310100",
      address_street: "Avenida Paulista",
      address_state: "SP",
    });
    // recipient_name NÃO vai pro customer (é informação de despacho)
    expect("recipient_name" in patch).toBe(false);
  });

  it("fulfillmentPatch preserva shipping_recipient_name", () => {
    const patch = snapshotToFulfillmentPatch(snap);
    expect(patch.shipping_recipient_name).toBe("Maria da Silva");
    expect(patch.shipping_state).toBe("SP");
    expect(patch.shipping_complement).toBe("apto 12");
  });

  it("preserva complement = null (não traduz pra string vazia)", () => {
    const withNull: ShippingSnapshot = { ...snap, complement: null };
    expect(snapshotToCustomerPatch(withNull).address_complement).toBeNull();
    expect(snapshotToFulfillmentPatch(withNull).shipping_complement).toBeNull();
  });
});

describe("customerToAddressInput", () => {
  const fullCustomer = {
    name: "Maria da Silva",
    address_zipcode: "01310100",
    address_street: "Avenida Paulista",
    address_number: "1000",
    address_complement: "apto 12",
    address_district: "Bela Vista",
    address_city: "São Paulo",
    address_state: "SP",
  };

  it("converte customer completo num AddressInput utilizável", () => {
    const input = customerToAddressInput(fullCustomer);
    expect(input).not.toBeNull();
    if (!input) return;
    expect(input.zipcode).toBe("01310100");
    expect(input.recipient_name).toBe("Maria da Silva");
  });

  it("valida o input resultante direto (round-trip)", () => {
    const input = customerToAddressInput(fullCustomer);
    expect(input).not.toBeNull();
    if (!input) return;
    const r = validateAddress(input, fullCustomer.name);
    expect(r.ok).toBe(true);
  });

  it("devolve null se faltar qualquer campo obrigatório", () => {
    const fields: Array<keyof typeof fullCustomer> = [
      "address_zipcode",
      "address_street",
      "address_number",
      "address_district",
      "address_city",
      "address_state",
    ];
    for (const f of fields) {
      const result = customerToAddressInput({
        ...fullCustomer,
        [f]: null,
      });
      expect(result).toBeNull();
    }
  });

  it("não exige address_complement (opcional)", () => {
    const input = customerToAddressInput({
      ...fullCustomer,
      address_complement: null,
    });
    expect(input).not.toBeNull();
    if (!input) return;
    expect(input.complement).toBeNull();
  });
});
