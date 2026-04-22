import { describe, expect, it } from "vitest";
import {
  parseAndValidateUpdate,
  computeChangedFields,
  type CustomerSnapshot,
} from "./meus-dados-update";

// Payload completo válido reutilizado nos casos positivos.
const VALID_BODY = {
  name: "Maria da Silva",
  email: "maria@example.com",
  phone: "(11) 99999-8888",
  address: {
    zipcode: "01001-000",
    street: "Praça da Sé",
    number: "100",
    complement: "Apto 12",
    district: "Sé",
    city: "São Paulo",
    state: "sp",
  },
};

describe("parseAndValidateUpdate · happy path", () => {
  it("aceita payload bem-formado e normaliza campos", () => {
    const r = parseAndValidateUpdate(VALID_BODY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.name).toBe("Maria da Silva");
    expect(r.input.email).toBe("maria@example.com");
    expect(r.input.phone).toBe("11999998888");
    expect(r.input.address.zipcode).toBe("01001000");
    expect(r.input.address.state).toBe("SP");
    expect(r.input.address.complement).toBe("Apto 12");
  });

  it("normaliza email com uppercase e trim", () => {
    const r = parseAndValidateUpdate({
      ...VALID_BODY,
      email: "  MARIA@Example.COM  ",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.email).toBe("maria@example.com");
  });

  it("aceita phone com +55 (13 dígitos)", () => {
    const r = parseAndValidateUpdate({
      ...VALID_BODY,
      phone: "+55 11 99999-8888",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.phone).toBe("5511999998888");
  });

  it("aceita complemento vazio (null)", () => {
    const r = parseAndValidateUpdate({
      ...VALID_BODY,
      address: { ...VALID_BODY.address, complement: "" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.address.complement).toBeNull();
  });
});

describe("parseAndValidateUpdate · validação de body", () => {
  it("recusa body não-objeto", () => {
    const r = parseAndValidateUpdate(null);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("body_invalid");
  });

  it("recusa body string", () => {
    const r = parseAndValidateUpdate("foo");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("body_invalid");
  });
});

describe("parseAndValidateUpdate · nome", () => {
  it("recusa nome ausente", () => {
    const r = parseAndValidateUpdate({ ...VALID_BODY, name: undefined });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.fieldErrors?.name).toBeTruthy();
  });

  it("recusa nome curto", () => {
    const r = parseAndValidateUpdate({ ...VALID_BODY, name: "Ab" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.fieldErrors?.name).toMatch(/mínimo/i);
  });

  it("recusa nome com caractere de injection (<)", () => {
    const r = parseAndValidateUpdate({
      ...VALID_BODY,
      name: "Maria <script>",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.fieldErrors?.name).toBeTruthy();
  });

  it("recusa nome com newline (controle)", () => {
    const r = parseAndValidateUpdate({
      ...VALID_BODY,
      name: "Maria\nda Silva",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.fieldErrors?.name).toBeTruthy();
  });
});

describe("parseAndValidateUpdate · email", () => {
  it("recusa email vazio", () => {
    const r = parseAndValidateUpdate({ ...VALID_BODY, email: "" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.fieldErrors?.email).toBeTruthy();
  });

  it("recusa email sem @", () => {
    const r = parseAndValidateUpdate({ ...VALID_BODY, email: "mariasem.com" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.fieldErrors?.email).toBeTruthy();
  });

  it("recusa email sem TLD", () => {
    const r = parseAndValidateUpdate({ ...VALID_BODY, email: "maria@local" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.fieldErrors?.email).toBeTruthy();
  });

  it("recusa email absurdamente longo", () => {
    const local = "a".repeat(250);
    const r = parseAndValidateUpdate({
      ...VALID_BODY,
      email: `${local}@example.com`,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.fieldErrors?.email).toBeTruthy();
  });
});

describe("parseAndValidateUpdate · phone", () => {
  it("recusa phone com menos de 10 dígitos", () => {
    const r = parseAndValidateUpdate({ ...VALID_BODY, phone: "11999" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.fieldErrors?.phone).toBeTruthy();
  });

  it("recusa phone com mais de 13 dígitos", () => {
    const r = parseAndValidateUpdate({
      ...VALID_BODY,
      phone: "1".repeat(14),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.fieldErrors?.phone).toBeTruthy();
  });

  it("aceita phone fixo de 10 dígitos", () => {
    const r = parseAndValidateUpdate({
      ...VALID_BODY,
      phone: "(11) 3333-4444",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.phone).toBe("1133334444");
  });
});

describe("parseAndValidateUpdate · endereço", () => {
  it("recusa CEP curto", () => {
    const r = parseAndValidateUpdate({
      ...VALID_BODY,
      address: { ...VALID_BODY.address, zipcode: "123" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.fieldErrors?.zipcode).toBeTruthy();
  });

  it("recusa UF inválida", () => {
    const r = parseAndValidateUpdate({
      ...VALID_BODY,
      address: { ...VALID_BODY.address, state: "XX" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.fieldErrors?.state).toBeTruthy();
  });

  it("não vaza recipient_name como fieldError", () => {
    // Mesmo com tudo inválido no endereço, não deve surgir 'recipient_name'
    // (campo é de fulfillment, não aplicável em /meus-dados/atualizar).
    const r = parseAndValidateUpdate({
      ...VALID_BODY,
      address: {
        zipcode: "",
        street: "",
        number: "",
        complement: "",
        district: "",
        city: "",
        state: "",
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const keys = Object.keys(r.fieldErrors ?? {});
    expect(keys).not.toContain("recipient_name");
    expect(keys.length).toBeGreaterThan(0);
  });
});

describe("computeChangedFields", () => {
  const baseSnap: CustomerSnapshot = {
    name: "Maria da Silva",
    email: "maria@example.com",
    phone: "11999998888",
    address_zipcode: "01001000",
    address_street: "Praça da Sé",
    address_number: "100",
    address_complement: "Apto 12",
    address_district: "Sé",
    address_city: "São Paulo",
    address_state: "SP",
  };

  const baseParsed = {
    name: "Maria da Silva",
    email: "maria@example.com",
    phone: "11999998888",
    address: {
      zipcode: "01001000",
      street: "Praça da Sé",
      number: "100",
      complement: "Apto 12",
      district: "Sé",
      city: "São Paulo",
      state: "SP",
    },
  };

  it("retorna [] quando nada mudou", () => {
    expect(computeChangedFields(baseSnap, baseParsed)).toEqual([]);
  });

  it("detecta diff de email (case insensitive NÃO — case muda é mudança)", () => {
    // Mas como sempre lowercase antes de comparar, deve NÃO detectar diff só por case.
    const changes = computeChangedFields(
      { ...baseSnap, email: "MARIA@example.com" },
      baseParsed
    );
    expect(changes).toEqual([]);
  });

  it("detecta diff de phone (máscara não conta)", () => {
    const changes = computeChangedFields(
      { ...baseSnap, phone: "(11) 99999-8888" },
      baseParsed
    );
    expect(changes).toEqual([]);
  });

  it("detecta mudança real de nome", () => {
    const changes = computeChangedFields(
      { ...baseSnap, name: "Maria Silva" },
      baseParsed
    );
    expect(changes).toEqual(["name"]);
  });

  it("detecta mudança de CEP, rua, cidade simultâneas e ordena alfabeticamente", () => {
    const changes = computeChangedFields(
      {
        ...baseSnap,
        address_zipcode: "04001000",
        address_street: "Outra rua",
        address_city: "Campinas",
      },
      baseParsed
    );
    expect(changes).toEqual([
      "address_city",
      "address_street",
      "address_zipcode",
    ]);
  });

  it("trata complement null vs empty como iguais", () => {
    const changes = computeChangedFields(
      { ...baseSnap, address_complement: null },
      { ...baseParsed, address: { ...baseParsed.address, complement: null } }
    );
    expect(changes).toEqual([]);
  });

  it("detecta mudança de UF ignorando case", () => {
    const changes = computeChangedFields(
      { ...baseSnap, address_state: "sp" },
      baseParsed
    );
    expect(changes).toEqual([]);
  });
});
