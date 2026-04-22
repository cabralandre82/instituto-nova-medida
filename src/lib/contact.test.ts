import { afterEach, describe, expect, it } from "vitest";
import {
  getDpoEmail,
  getSupportWhatsappE164,
  getSupportWhatsappNumber,
  telSupportUrl,
  whatsappSupportUrl,
} from "./contact";

const ENV_KEYS = ["NEXT_PUBLIC_WA_SUPPORT_NUMBER", "NEXT_PUBLIC_DPO_EMAIL"] as const;
type EnvKey = (typeof ENV_KEYS)[number];

const FALLBACK = "5521998851851";
const FALLBACK_DPO = "lgpd@institutonovamedida.com.br";

function withEnv(values: Partial<Record<EnvKey, string | undefined>>) {
  const original: Partial<Record<EnvKey, string | undefined>> = {};
  for (const k of ENV_KEYS) {
    original[k] = process.env[k];
    if (Object.prototype.hasOwnProperty.call(values, k)) {
      const v = values[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return () => {
    for (const k of ENV_KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  };
}

describe("getSupportWhatsappNumber", () => {
  let restore: () => void = () => undefined;
  afterEach(() => restore());

  it("usa fallback quando env ausente", () => {
    restore = withEnv({ NEXT_PUBLIC_WA_SUPPORT_NUMBER: undefined });
    expect(getSupportWhatsappNumber()).toBe(FALLBACK);
  });

  it("normaliza máscara e prefixa DDI 55", () => {
    restore = withEnv({
      NEXT_PUBLIC_WA_SUPPORT_NUMBER: "(11) 99999-8888",
    });
    expect(getSupportWhatsappNumber()).toBe("5511999998888");
  });

  it("preserva DDI 55 já presente", () => {
    restore = withEnv({ NEXT_PUBLIC_WA_SUPPORT_NUMBER: "5511999998888" });
    expect(getSupportWhatsappNumber()).toBe("5511999998888");
  });

  it("aceita +55 e descarta caracteres", () => {
    restore = withEnv({ NEXT_PUBLIC_WA_SUPPORT_NUMBER: "+55 11 99999-8888" });
    expect(getSupportWhatsappNumber()).toBe("5511999998888");
  });

  it("usa fallback se número curto demais (lixo)", () => {
    restore = withEnv({ NEXT_PUBLIC_WA_SUPPORT_NUMBER: "123" });
    expect(getSupportWhatsappNumber()).toBe(FALLBACK);
  });

  it("usa fallback se número longo demais (lixo)", () => {
    restore = withEnv({
      NEXT_PUBLIC_WA_SUPPORT_NUMBER: "1234567890123456789",
    });
    expect(getSupportWhatsappNumber()).toBe(FALLBACK);
  });
});

describe("getSupportWhatsappE164", () => {
  let restore: () => void = () => undefined;
  afterEach(() => restore());

  it("formata 13 dígitos (celular pós-9)", () => {
    restore = withEnv({ NEXT_PUBLIC_WA_SUPPORT_NUMBER: "5511999998888" });
    expect(getSupportWhatsappE164()).toBe("+55 (11) 99999-8888");
  });

  it("formata 12 dígitos (fixo)", () => {
    restore = withEnv({ NEXT_PUBLIC_WA_SUPPORT_NUMBER: "551133334444" });
    expect(getSupportWhatsappE164()).toBe("+55 (11) 3333-4444");
  });
});

describe("whatsappSupportUrl", () => {
  let restore: () => void = () => undefined;
  afterEach(() => restore());

  it("monta URL sem mensagem", () => {
    restore = withEnv({ NEXT_PUBLIC_WA_SUPPORT_NUMBER: "5511999998888" });
    expect(whatsappSupportUrl()).toBe("https://wa.me/5511999998888");
  });

  it("monta URL com mensagem URL-encodada", () => {
    restore = withEnv({ NEXT_PUBLIC_WA_SUPPORT_NUMBER: "5511999998888" });
    expect(whatsappSupportUrl("Oi! Quero agendar.")).toBe(
      "https://wa.me/5511999998888?text=Oi!%20Quero%20agendar."
    );
  });

  it("encoda emoji/acentos sem quebrar", () => {
    restore = withEnv({ NEXT_PUBLIC_WA_SUPPORT_NUMBER: "5511999998888" });
    const url = whatsappSupportUrl("Olá! Açaí?");
    expect(url).toContain("https://wa.me/5511999998888?text=");
    expect(url).toContain(encodeURIComponent("Olá! Açaí?"));
  });
});

describe("telSupportUrl", () => {
  let restore: () => void = () => undefined;
  afterEach(() => restore());

  it("retorna tel:+55…", () => {
    restore = withEnv({ NEXT_PUBLIC_WA_SUPPORT_NUMBER: "5511999998888" });
    expect(telSupportUrl()).toBe("tel:+5511999998888");
  });
});

describe("getDpoEmail", () => {
  let restore: () => void = () => undefined;
  afterEach(() => restore());

  it("usa fallback quando env ausente", () => {
    restore = withEnv({ NEXT_PUBLIC_DPO_EMAIL: undefined });
    expect(getDpoEmail()).toBe(FALLBACK_DPO);
  });

  it("usa fallback quando env não tem @", () => {
    restore = withEnv({ NEXT_PUBLIC_DPO_EMAIL: "naoeumemail" });
    expect(getDpoEmail()).toBe(FALLBACK_DPO);
  });

  it("normaliza pra lowercase", () => {
    restore = withEnv({ NEXT_PUBLIC_DPO_EMAIL: "DPO@Acme.COM" });
    expect(getDpoEmail()).toBe("dpo@acme.com");
  });
});
