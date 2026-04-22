/**
 * Testes de patient-quick-links — PR-072 · D-080 · finding 1.7.
 *
 * Foco nas funções puras `toLatestPrescription`, `toShippingAddress`,
 * `pickIssuedAt`, `extractDoctorName`. A IO (`getPatientQuickLinks`)
 * é fail-soft por design — se falhar, cai no mesmo "none/missing"
 * que a UI já cobre; um smoke de integração seria caro e não
 * captaria regressões que os testes puros não captem.
 */

import { describe, expect, it } from "vitest";
import {
  extractDoctorName,
  pickIssuedAt,
  REQUIRED_ADDRESS_FIELDS,
  toLatestPrescription,
  toShippingAddress,
  type CustomerAddressRow,
} from "./patient-quick-links";

// ────────────────────────────────────────────────────────────────────
// pickIssuedAt
// ────────────────────────────────────────────────────────────────────

describe("pickIssuedAt", () => {
  it("prefere finalized_at quando presente", () => {
    expect(
      pickIssuedAt({
        finalized_at: "2026-04-01T10:00:00Z",
        ended_at: "2026-04-01T09:30:00Z",
      }),
    ).toBe("2026-04-01T10:00:00Z");
  });

  it("cai em ended_at se finalized_at é null", () => {
    expect(
      pickIssuedAt({
        finalized_at: null,
        ended_at: "2026-04-01T09:30:00Z",
      }),
    ).toBe("2026-04-01T09:30:00Z");
  });

  it("retorna null quando ambos null", () => {
    expect(pickIssuedAt({ finalized_at: null, ended_at: null })).toBeNull();
  });

  it("trata string vazia como null (defensivo)", () => {
    expect(pickIssuedAt({ finalized_at: "   ", ended_at: "" })).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────
// extractDoctorName
// ────────────────────────────────────────────────────────────────────

describe("extractDoctorName", () => {
  it("prefere display_name quando presente", () => {
    expect(
      extractDoctorName({
        display_name: "Dra. Camila",
        full_name: "Camila Silva",
      }),
    ).toBe("Dra. Camila");
  });

  it("cai em full_name quando display_name é null", () => {
    expect(
      extractDoctorName({ display_name: null, full_name: "Camila Silva" }),
    ).toBe("Camila Silva");
  });

  it('fallback "Médica" quando ambos null', () => {
    expect(
      extractDoctorName({ display_name: null, full_name: null }),
    ).toBe("Médica");
  });

  it("aceita array (PostgREST nested select) pegando o primeiro", () => {
    expect(
      extractDoctorName([
        { display_name: "Dra. A", full_name: null },
        { display_name: "Dra. B", full_name: null },
      ]),
    ).toBe("Dra. A");
  });

  it('fallback em array vazio → "Médica"', () => {
    expect(extractDoctorName([])).toBe("Médica");
  });

  it("null total → fallback", () => {
    expect(extractDoctorName(null)).toBe("Médica");
  });

  it("whitespace é tratado como null", () => {
    expect(
      extractDoctorName({ display_name: "   ", full_name: "\tCamila\n" }),
    ).toBe("Camila");
  });
});

// ────────────────────────────────────────────────────────────────────
// toLatestPrescription
// ────────────────────────────────────────────────────────────────────

describe("toLatestPrescription", () => {
  it('row null → {kind:"none"}', () => {
    expect(toLatestPrescription(null)).toEqual({ kind: "none" });
  });

  it("happy path com https → ready", () => {
    const out = toLatestPrescription({
      id: "appt-1",
      memed_prescription_url: "https://memed.com.br/r/abc",
      finalized_at: "2026-04-10T15:00:00Z",
      ended_at: "2026-04-10T14:30:00Z",
      doctors: { display_name: "Dra. Camila", full_name: null },
    });
    expect(out).toEqual({
      kind: "ready",
      url: "https://memed.com.br/r/abc",
      issuedAt: "2026-04-10T15:00:00Z",
      appointmentId: "appt-1",
      doctorName: "Dra. Camila",
    });
  });

  it("aceita http (HTTPS-first mas não-hostil a ambientes legados)", () => {
    const out = toLatestPrescription({
      id: "appt-2",
      memed_prescription_url: "http://memed.com.br/r/xyz",
      finalized_at: "2026-04-10T15:00:00Z",
      ended_at: null,
      doctors: null,
    });
    expect(out.kind).toBe("ready");
  });

  it('protocolo javascript: rejeitado → "none"', () => {
    const out = toLatestPrescription({
      id: "appt-3",
      memed_prescription_url: "javascript:alert(1)",
      finalized_at: "2026-04-10T15:00:00Z",
      ended_at: null,
      doctors: null,
    });
    expect(out).toEqual({ kind: "none" });
  });

  it('URL inválida → "none"', () => {
    const out = toLatestPrescription({
      id: "appt-4",
      memed_prescription_url: "not a url",
      finalized_at: "2026-04-10T15:00:00Z",
      ended_at: null,
      doctors: null,
    });
    expect(out).toEqual({ kind: "none" });
  });

  it('url null → "none"', () => {
    const out = toLatestPrescription({
      id: "appt-5",
      memed_prescription_url: null,
      finalized_at: "2026-04-10T15:00:00Z",
      ended_at: null,
      doctors: { display_name: "Dra. X", full_name: null },
    });
    expect(out).toEqual({ kind: "none" });
  });

  it('url só whitespace → "none"', () => {
    const out = toLatestPrescription({
      id: "appt-6",
      memed_prescription_url: "   ",
      finalized_at: "2026-04-10T15:00:00Z",
      ended_at: null,
      doctors: null,
    });
    expect(out).toEqual({ kind: "none" });
  });

  it('sem finalized_at nem ended_at → "none"', () => {
    const out = toLatestPrescription({
      id: "appt-7",
      memed_prescription_url: "https://memed.com.br/r/abc",
      finalized_at: null,
      ended_at: null,
      doctors: null,
    });
    expect(out).toEqual({ kind: "none" });
  });

  it("trim defensivo na URL", () => {
    const out = toLatestPrescription({
      id: "appt-8",
      memed_prescription_url: "  https://memed.com.br/r/trim  ",
      finalized_at: "2026-04-10T15:00:00Z",
      ended_at: null,
      doctors: null,
    });
    expect(out.kind).toBe("ready");
    if (out.kind === "ready") {
      expect(out.url).toBe("https://memed.com.br/r/trim");
    }
  });

  it("médica como array → pega a primeira", () => {
    const out = toLatestPrescription({
      id: "appt-9",
      memed_prescription_url: "https://memed.com.br/r/abc",
      finalized_at: "2026-04-10T15:00:00Z",
      ended_at: null,
      doctors: [
        { display_name: null, full_name: "Camila" },
      ],
    });
    expect(out.kind).toBe("ready");
    if (out.kind === "ready") expect(out.doctorName).toBe("Camila");
  });
});

// ────────────────────────────────────────────────────────────────────
// toShippingAddress
// ────────────────────────────────────────────────────────────────────

const FULL_ADDRESS: CustomerAddressRow = {
  address_zipcode: "04000-000",
  address_street: "Rua das Flores",
  address_number: "123",
  address_complement: "Apto 45",
  address_district: "Vila Mariana",
  address_city: "São Paulo",
  address_state: "SP",
};

describe("toShippingAddress", () => {
  it("row null → missing", () => {
    expect(toShippingAddress(null)).toEqual({ kind: "missing" });
  });

  it("todos campos null → missing", () => {
    expect(
      toShippingAddress({
        address_zipcode: null,
        address_street: null,
        address_number: null,
        address_complement: null,
        address_district: null,
        address_city: null,
        address_state: null,
      }),
    ).toEqual({ kind: "missing" });
  });

  it("todos whitespace → missing", () => {
    expect(
      toShippingAddress({
        address_zipcode: "  ",
        address_street: "\t",
        address_number: "",
        address_complement: null,
        address_district: " ",
        address_city: " ",
        address_state: " ",
      }),
    ).toEqual({ kind: "missing" });
  });

  it("happy path → ready com campos formatados", () => {
    const out = toShippingAddress(FULL_ADDRESS);
    expect(out).toEqual({
      kind: "ready",
      zipcode: "04000-000",
      summaryLine: "Rua das Flores, 123 · Vila Mariana",
      cityState: "São Paulo / SP",
      complement: "Apto 45",
    });
  });

  it("ready sem complement quando null", () => {
    const out = toShippingAddress({
      ...FULL_ADDRESS,
      address_complement: null,
    });
    expect(out).toEqual({
      kind: "ready",
      zipcode: "04000-000",
      summaryLine: "Rua das Flores, 123 · Vila Mariana",
      cityState: "São Paulo / SP",
      complement: null,
    });
  });

  it("complement whitespace vira null", () => {
    const out = toShippingAddress({
      ...FULL_ADDRESS,
      address_complement: "   ",
    });
    expect(out.kind).toBe("ready");
    if (out.kind === "ready") expect(out.complement).toBeNull();
  });

  it("faltando CEP → incomplete com missingFields", () => {
    const out = toShippingAddress({
      ...FULL_ADDRESS,
      address_zipcode: null,
    });
    expect(out.kind).toBe("incomplete");
    if (out.kind === "incomplete") {
      expect(out.missingFields).toContain("address_zipcode");
      expect(out.missingFields).toHaveLength(1);
    }
  });

  it("faltando UF + cidade → incomplete listando ambos", () => {
    const out = toShippingAddress({
      ...FULL_ADDRESS,
      address_city: null,
      address_state: null,
    });
    expect(out.kind).toBe("incomplete");
    if (out.kind === "incomplete") {
      expect(out.missingFields).toEqual([
        "address_city",
        "address_state",
      ]);
    }
  });

  it("faltando street mas com CEP → incomplete (não missing)", () => {
    const out = toShippingAddress({
      ...FULL_ADDRESS,
      address_street: null,
    });
    expect(out.kind).toBe("incomplete");
  });

  it("whitespace é tratado como faltando", () => {
    const out = toShippingAddress({
      ...FULL_ADDRESS,
      address_number: "   ",
    });
    expect(out.kind).toBe("incomplete");
    if (out.kind === "incomplete") {
      expect(out.missingFields).toContain("address_number");
    }
  });

  it("REQUIRED_ADDRESS_FIELDS contempla os 6 campos obrigatórios (invariante)", () => {
    expect(REQUIRED_ADDRESS_FIELDS).toEqual([
      "address_zipcode",
      "address_street",
      "address_number",
      "address_district",
      "address_city",
      "address_state",
    ]);
    // complement fica de fora de propósito
    expect(
      (REQUIRED_ADDRESS_FIELDS as readonly string[]).includes(
        "address_complement",
      ),
    ).toBe(false);
  });
});
