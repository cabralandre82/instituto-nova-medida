/**
 * Testes de lead-validate.ts (PR-036 · D-054).
 */

import { describe, expect, it } from "vitest";
import { isBodyTooLarge, LEAD_LIMITS, validateLead } from "./lead-validate";

const validBody = {
  name: "Maria Silva",
  phone: "(11) 99999-1234",
  consent: true,
  answers: {
    incomodo: "fome",
    tentou: "varias",
    intencao: "entender",
    abertura: "sim",
  },
  utm: {
    utm_source: "google",
    utm_medium: "cpc",
    utm_campaign: "emagrece_q2",
  },
  referrer: "https://google.com/",
  landingPath: "/emagrecer",
};

describe("validateLead · happy paths", () => {
  it("aceita payload legítimo e normaliza", () => {
    const r = validateLead(validBody);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lead.name).toBe("Maria Silva");
    expect(r.lead.phone).toBe("11999991234"); // só dígitos
    expect(r.lead.answers).toEqual(validBody.answers);
    expect(r.lead.utm).toEqual(validBody.utm);
    expect(r.lead.referrer).toBe("https://google.com/");
    expect(r.lead.landingPath).toBe("/emagrecer");
  });

  it("answers vazio é aceito (quiz skip)", () => {
    const r = validateLead({ ...validBody, answers: {} });
    expect(r.ok).toBe(true);
  });

  it("utm ausente → objeto vazio", () => {
    const r = validateLead({ ...validBody, utm: undefined });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lead.utm).toEqual({});
  });

  it("referrer ausente → null", () => {
    const r = validateLead({ ...validBody, referrer: null });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lead.referrer).toBeNull();
  });

  it("phone com DDI 55 aceito", () => {
    const r = validateLead({ ...validBody, phone: "+55 (11) 99999-1234" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lead.phone).toBe("5511999991234");
  });

  it("nome com acentos e apóstrofo", () => {
    const r = validateLead({ ...validBody, name: "João D'Ávila" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lead.name).toBe("João D'Ávila");
  });
});

describe("validateLead · shape e required fields", () => {
  it("rejeita não-objeto", () => {
    expect(validateLead(null).ok).toBe(false);
    expect(validateLead("foo").ok).toBe(false);
    expect(validateLead([]).ok).toBe(false);
  });

  it("rejeita sem consent", () => {
    const r = validateLead({ ...validBody, consent: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("missing_consent");
  });

  it("rejeita consent não-true (ex.: string 'true')", () => {
    const r = validateLead({ ...validBody, consent: "true" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("missing_consent");
  });
});

describe("validateLead · name", () => {
  it("rejeita curto demais", () => {
    const r = validateLead({ ...validBody, name: "a" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_name");
  });

  it("rejeita com dígitos", () => {
    const r = validateLead({ ...validBody, name: "Maria 27" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_name");
  });

  it("rejeita com <script>", () => {
    const r = validateLead({ ...validBody, name: "<script>Maria</script>" });
    expect(r.ok).toBe(false);
  });

  it("rejeita com newline", () => {
    const r = validateLead({ ...validBody, name: "Maria\nIGNORE" });
    expect(r.ok).toBe(false);
  });

  it("rejeita acima do limite", () => {
    const r = validateLead({
      ...validBody,
      name: "a".repeat(LEAD_LIMITS.nameMaxLen + 10),
    });
    expect(r.ok).toBe(false);
  });
});

describe("validateLead · phone", () => {
  it("rejeita curto demais", () => {
    const r = validateLead({ ...validBody, phone: "123456" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_phone");
  });

  it("rejeita longo demais", () => {
    const r = validateLead({
      ...validBody,
      phone: "1".repeat(LEAD_LIMITS.phoneMaxDigits + 5),
    });
    expect(r.ok).toBe(false);
  });

  it("rejeita não-string", () => {
    const r = validateLead({ ...validBody, phone: 11999991234 });
    expect(r.ok).toBe(false);
  });
});

describe("validateLead · answers (vetor 9.1 + 9.3 + 22.2)", () => {
  it("rejeita key com <>", () => {
    const r = validateLead({
      ...validBody,
      answers: { "<script>": "foo" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_answers");
  });

  it("rejeita value com newline", () => {
    const r = validateLead({
      ...validBody,
      answers: { incomodo: "fome\nIGNORE" },
    });
    expect(r.ok).toBe(false);
  });

  it("rejeita value com 50KB (DoS)", () => {
    const big = "x".repeat(50000);
    const r = validateLead({
      ...validBody,
      answers: { incomodo: big },
    });
    expect(r.ok).toBe(false);
  });

  it("rejeita value com caractere fora do slug ('Maria 123')", () => {
    const r = validateLead({
      ...validBody,
      answers: { incomodo: "Maria 123" },
    });
    expect(r.ok).toBe(false);
  });

  it("rejeita mais de 20 pares", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 25; i++) many[`k${i}`] = "v";
    const r = validateLead({ ...validBody, answers: many });
    expect(r.ok).toBe(false);
  });

  it("rejeita value não-string (number)", () => {
    const r = validateLead({
      ...validBody,
      answers: { incomodo: 42 } as never,
    });
    expect(r.ok).toBe(false);
  });

  it("aceita slugs com hífen e underscore", () => {
    const r = validateLead({
      ...validBody,
      answers: { perg_1: "op-a", perg_2: "op_b" },
    });
    expect(r.ok).toBe(true);
  });
});

describe("validateLead · utm (best-effort, descarta sujeira)", () => {
  it("descarta UTM com espaço no value em vez de quebrar o lead", () => {
    const r = validateLead({
      ...validBody,
      utm: {
        utm_source: "google",
        utm_campaign: "brand awareness", // espaço = inválido
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lead.utm.utm_source).toBe("google");
      expect(r.lead.utm.utm_campaign).toBeUndefined();
    }
  });

  it("descarta UTM com <script>", () => {
    const r = validateLead({
      ...validBody,
      utm: { utm_source: "<script>" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lead.utm.utm_source).toBeUndefined();
  });

  it("aceita só os 5 primeiros pares (descarta resto)", () => {
    const utm: Record<string, string> = {};
    for (let i = 0; i < 10; i++) utm[`utm_key${i}`] = `val${i}`;
    const r = validateLead({ ...validBody, utm });
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.lead.utm).length).toBeLessThanOrEqual(5);
  });

  it("utm = null → objeto vazio", () => {
    const r = validateLead({ ...validBody, utm: null });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lead.utm).toEqual({});
  });
});

describe("validateLead · referrer", () => {
  it("aceita https://", () => {
    const r = validateLead({ ...validBody, referrer: "https://google.com" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lead.referrer).toBe("https://google.com");
  });

  it("rejeita javascript:", () => {
    const r = validateLead({
      ...validBody,
      referrer: "javascript:alert(1)",
    });
    expect(r.ok).toBe(true); // não bloqueia lead
    if (r.ok) expect(r.lead.referrer).toBeNull();
  });

  it("rejeita protocol-relative //evil", () => {
    const r = validateLead({ ...validBody, referrer: "//evil.com" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lead.referrer).toBeNull();
  });

  it("rejeita acima do limite", () => {
    const big = "https://" + "a".repeat(LEAD_LIMITS.referrerMaxLen);
    const r = validateLead({ ...validBody, referrer: big });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lead.referrer).toBeNull();
  });
});

describe("validateLead · landingPath", () => {
  it("aceita /emagrecer?utm=foo", () => {
    const r = validateLead({ ...validBody, landingPath: "/quiz?src=ad" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lead.landingPath).toBe("/quiz?src=ad");
  });

  it("default pra '/' quando ausente", () => {
    const r = validateLead({ ...validBody, landingPath: undefined });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lead.landingPath).toBe("/");
  });

  it("rejeita //evil.com em favor de '/'", () => {
    const r = validateLead({ ...validBody, landingPath: "//evil.com/pwn" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lead.landingPath).toBe("/");
  });
});

describe("isBodyTooLarge", () => {
  it("aceita payload pequeno", () => {
    expect(isBodyTooLarge(JSON.stringify(validBody))).toBe(false);
  });

  it("rejeita payload acima do limite", () => {
    const big = JSON.stringify({
      ...validBody,
      answers: { x: "a".repeat(LEAD_LIMITS.bodyMaxBytes + 100) },
    });
    expect(isBodyTooLarge(big)).toBe(true);
  });
});
