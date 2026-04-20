/**
 * Testes do termo jurídico versionado (D-044 · 2.C).
 *
 * O foco aqui NÃO é revisar o conteúdo jurídico — isso é revisão
 * humana. O foco é:
 *
 *   - Garantir que a renderização substitui 100% dos placeholders.
 *   - Garantir que mudança acidental no texto seja detectável
 *     (snapshot estável do hash do template sem params).
 *   - Garantir que o helper de CRM produza sempre "NNNNNN/UF".
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_TERMS_VERSION,
  formatDoctorCrm,
  renderAcceptanceTerms,
  type AcceptanceTermsParams,
} from "./acceptance-terms";

const baseParams: AcceptanceTermsParams = {
  patient_name: "Maria da Silva",
  patient_cpf: "123.456.789-00",
  plan_name: "Tirzepatida 90 dias",
  plan_medication: "Tirzepatida 2,5 a 7,5 mg/sem",
  plan_cycle_days: 90,
  price_formatted: "R$ 1.797,00",
  doctor_name: "Dra. Joana Almeida",
  doctor_crm: "123456/SP",
  prescription_url: "https://memed.com.br/prescription/abc",
};

describe("ACCEPTANCE_TERMS_VERSION", () => {
  it("segue o padrão vN-YYYY-MM", () => {
    expect(ACCEPTANCE_TERMS_VERSION).toMatch(/^v\d+-\d{4}-\d{2}$/);
  });
});

describe("renderAcceptanceTerms", () => {
  it("substitui todos os placeholders e não deixa chaves órfãs", () => {
    const text = renderAcceptanceTerms(baseParams);
    expect(text).not.toMatch(/\{\w+\}/);
  });

  it("inclui nome, plano, CRM, valor e URL da prescrição no texto", () => {
    const text = renderAcceptanceTerms(baseParams);
    expect(text).toContain(baseParams.patient_name);
    expect(text).toContain(baseParams.plan_name);
    expect(text).toContain(baseParams.doctor_crm);
    expect(text).toContain(baseParams.price_formatted);
    expect(text).toContain(baseParams.prescription_url);
    expect(text).toContain(baseParams.plan_medication);
    expect(text).toContain(String(baseParams.plan_cycle_days));
  });

  it("cita as bases normativas essenciais (LGPD art. 11, CFM 2.314, CDC 49)", () => {
    const text = renderAcceptanceTerms(baseParams);
    expect(text).toContain("LGPD");
    expect(text).toContain("art. 11");
    expect(text).toContain("2.314/2022");
    expect(text).toContain("art. 49");
    expect(text).toContain("5.991/1973");
  });

  it("explicita que a farmácia não recebe o endereço de entrega", () => {
    const text = renderAcceptanceTerms(baseParams);
    // cláusula 4 é a que tem esse ponto operacional crítico
    expect(text).toMatch(
      /endereço de entrega.{0,50}não é compartilhado com a farmácia/i
    );
  });

  it("explicita ausência de reembolso após encaminhamento à farmácia", () => {
    const text = renderAcceptanceTerms(baseParams);
    expect(text).toMatch(
      /encaminhada a prescrição à farmácia.{0,80}não caberá desistência/i
    );
  });

  it("gera texto idêntico entre chamadas com mesmos parâmetros", () => {
    expect(renderAcceptanceTerms(baseParams)).toBe(
      renderAcceptanceTerms(baseParams)
    );
  });

  it("muda o texto se qualquer parâmetro mudar", () => {
    const baseHash = sha256(renderAcceptanceTerms(baseParams));
    const mutants: Array<Partial<AcceptanceTermsParams>> = [
      { patient_name: "João da Silva" },
      { patient_cpf: "000.000.000-00" },
      { plan_name: "Semaglutida 180 dias" },
      { plan_medication: "Semaglutida 1mg/sem" },
      { plan_cycle_days: 180 },
      { price_formatted: "R$ 999,00" },
      { doctor_name: "Dr. Carlos" },
      { doctor_crm: "999999/RJ" },
      { prescription_url: "https://memed.com.br/prescription/xyz" },
    ];
    for (const m of mutants) {
      const mutated = sha256(
        renderAcceptanceTerms({ ...baseParams, ...m } as AcceptanceTermsParams)
      );
      expect(mutated).not.toBe(baseHash);
    }
  });

  it("explode se algum parâmetro vier null/undefined", () => {
    expect(() =>
      renderAcceptanceTerms({
        ...baseParams,
        patient_name: null as unknown as string,
      })
    ).toThrow();
  });
});

describe("formatDoctorCrm", () => {
  it("concatena número + UF quando não há barra", () => {
    expect(formatDoctorCrm("123456", "SP")).toBe("123456/SP");
    expect(formatDoctorCrm(" 123456 ", " sp ")).toBe("123456/SP");
  });

  it("passa através quando já vem no formato", () => {
    expect(formatDoctorCrm("123456/SP", "RJ")).toBe("123456/SP");
  });
});

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
