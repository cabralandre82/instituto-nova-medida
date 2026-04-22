import { describe, expect, it } from "vitest";

import {
  validateAddressChangeSnapshot,
  validateSafeJsonbObject,
  validateSafeJsonbValue,
  validateShippingSnapshot,
} from "./jsonb-schemas";

describe("jsonb-schemas · validateSafeJsonbValue", () => {
  it("aceita primitivos JSON legítimos", () => {
    expect(validateSafeJsonbValue("hello")).toEqual({ ok: true, value: "hello" });
    expect(validateSafeJsonbValue(42)).toEqual({ ok: true, value: 42 });
    expect(validateSafeJsonbValue(0)).toEqual({ ok: true, value: 0 });
    expect(validateSafeJsonbValue(-3.14)).toEqual({ ok: true, value: -3.14 });
    expect(validateSafeJsonbValue(true)).toEqual({ ok: true, value: true });
    expect(validateSafeJsonbValue(false)).toEqual({ ok: true, value: false });
    expect(validateSafeJsonbValue(null)).toEqual({ ok: true, value: null });
  });

  it("aceita objeto literal com campos aninhados", () => {
    const input = {
      count: 10,
      warnings: ["slot_taken", "already_processed"],
      nested: { a: 1, b: null, c: false },
    };
    const res = validateSafeJsonbValue(input);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual(input);
  });

  it("aceita array root", () => {
    const res = validateSafeJsonbValue([1, "a", null, { x: true }]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual([1, "a", null, { x: true }]);
  });

  it("rejeita undefined", () => {
    const res = validateSafeJsonbValue({ a: undefined });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues.some((i) => i.includes("undefined"))).toBe(true);
  });

  it("rejeita NaN e Infinity", () => {
    const nan = validateSafeJsonbValue({ n: Number.NaN });
    expect(nan.ok).toBe(false);
    if (!nan.ok) expect(nan.issues.some((i) => i.includes("não-finito"))).toBe(true);

    const inf = validateSafeJsonbValue({ n: Number.POSITIVE_INFINITY });
    expect(inf.ok).toBe(false);
  });

  it("rejeita Date/Error/função/symbol/bigint/Promise", () => {
    expect(validateSafeJsonbValue({ d: new Date() }).ok).toBe(false);
    expect(validateSafeJsonbValue({ e: new Error("x") }).ok).toBe(false);
    expect(validateSafeJsonbValue({ f: () => 1 }).ok).toBe(false);
    expect(validateSafeJsonbValue({ s: Symbol("x") }).ok).toBe(false);
    expect(validateSafeJsonbValue({ b: BigInt(5) }).ok).toBe(false);
    expect(validateSafeJsonbValue({ p: Promise.resolve(1) }).ok).toBe(false);
    expect(validateSafeJsonbValue({ m: new Map() }).ok).toBe(false);
    expect(validateSafeJsonbValue({ s: new Set([1]) }).ok).toBe(false);
    expect(validateSafeJsonbValue({ r: /abc/ }).ok).toBe(false);
  });

  it("detecta referência circular", () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    const res = validateSafeJsonbValue(a);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.includes("circular"))).toBe(true);
    }
  });

  it("rejeita chaves proibidas __proto__/constructor/prototype", () => {
    // JSON.parse bypassa o setter; constrói via Object.defineProperty pra
    // garantir que a chave é enumerável e realmente aparece em entries.
    const evil = JSON.parse('{"__proto__": {"polluted": true}}');
    const res = validateSafeJsonbValue(evil);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.includes("__proto__"))).toBe(true);
    }
  });

  it("respeita maxDepth", () => {
    let deep: unknown = { leaf: 1 };
    for (let i = 0; i < 10; i += 1) deep = { nested: deep };
    const res = validateSafeJsonbValue(deep, { maxDepth: 3 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.includes("profundidade"))).toBe(true);
    }
  });

  it("respeita maxStringLength", () => {
    const res = validateSafeJsonbValue(
      { desc: "a".repeat(5000) },
      { maxStringLength: 1024 }
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.includes("máx 1024"))).toBe(true);
    }
  });

  it("respeita maxSerializedChars", () => {
    const big = { arr: Array.from({ length: 200 }, (_, i) => `item-${i}`) };
    const res = validateSafeJsonbValue(big, { maxSerializedChars: 500 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(
        res.issues.some((i) => i.includes("payload serializado"))
      ).toBe(true);
    }
  });

  it("cópia é defensiva: mutar input não afeta value retornado", () => {
    const input = { arr: [1, 2, 3], meta: { k: "v" } };
    const res = validateSafeJsonbValue(input);
    if (!res.ok) throw new Error("should be ok");
    (input.arr as number[]).push(99);
    (input.meta as Record<string, unknown>).k = "MUTATED";
    expect((res.value as { arr: number[] }).arr).toEqual([1, 2, 3]);
    expect((res.value as { meta: { k: string } }).meta.k).toBe("v");
  });
});

describe("jsonb-schemas · validateSafeJsonbObject", () => {
  it("aceita objeto literal safe", () => {
    const res = validateSafeJsonbObject({ job: "cron", count: 10 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ job: "cron", count: 10 });
  });

  it("rejeita array, null, string, número no root", () => {
    expect(validateSafeJsonbObject([1, 2]).ok).toBe(false);
    expect(validateSafeJsonbObject(null).ok).toBe(false);
    expect(validateSafeJsonbObject("str").ok).toBe(false);
    expect(validateSafeJsonbObject(42).ok).toBe(false);
  });

  it("propaga limites pra primitivos aninhados", () => {
    const res = validateSafeJsonbObject(
      { msg: "a".repeat(500) },
      { maxStringLength: 100 }
    );
    expect(res.ok).toBe(false);
  });
});

describe("jsonb-schemas · validateShippingSnapshot", () => {
  const base = {
    recipient_name: "Maria Silva",
    zipcode: "01310100",
    street: "Avenida Paulista",
    number: "1000",
    complement: "Apto 42",
    district: "Bela Vista",
    city: "São Paulo",
    state: "SP",
  };

  it("aceita snapshot válido", () => {
    const res = validateShippingSnapshot(base);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual(base);
  });

  it("aceita complement = null", () => {
    const res = validateShippingSnapshot({ ...base, complement: null });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.complement).toBeNull();
  });

  it("normaliza complement vazio pra null", () => {
    const res = validateShippingSnapshot({ ...base, complement: "   " });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.complement).toBeNull();
  });

  it("trima strings", () => {
    const res = validateShippingSnapshot({
      ...base,
      recipient_name: "  Maria Silva  ",
      street: " Avenida Paulista ",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.recipient_name).toBe("Maria Silva");
      expect(res.value.street).toBe("Avenida Paulista");
    }
  });

  it("rejeita zipcode com traço ou menos de 8 dígitos", () => {
    const a = validateShippingSnapshot({ ...base, zipcode: "01310-100" });
    expect(a.ok).toBe(false);
    const b = validateShippingSnapshot({ ...base, zipcode: "1234567" });
    expect(b.ok).toBe(false);
  });

  it("rejeita state minúsculo ou com 3 letras", () => {
    const a = validateShippingSnapshot({ ...base, state: "sp" });
    expect(a.ok).toBe(false);
    const b = validateShippingSnapshot({ ...base, state: "SPX" });
    expect(b.ok).toBe(false);
  });

  it("rejeita recipient_name vazio ou maior que 120 chars", () => {
    const a = validateShippingSnapshot({ ...base, recipient_name: "" });
    expect(a.ok).toBe(false);
    const b = validateShippingSnapshot({
      ...base,
      recipient_name: "x".repeat(121),
    });
    expect(b.ok).toBe(false);
  });

  it("rejeita number com mais de 30 chars (campo curto)", () => {
    const res = validateShippingSnapshot({
      ...base,
      number: "x".repeat(31),
    });
    expect(res.ok).toBe(false);
  });

  it("rejeita campos extras não tipados corretamente", () => {
    const res = validateShippingSnapshot({
      ...base,
      state: 42 as unknown as string,
    });
    expect(res.ok).toBe(false);
  });

  it("rejeita quando não é objeto", () => {
    expect(validateShippingSnapshot(null).ok).toBe(false);
    expect(validateShippingSnapshot("json").ok).toBe(false);
    expect(validateShippingSnapshot([]).ok).toBe(false);
  });

  it("acumula múltiplos issues no mesmo retorno", () => {
    const res = validateShippingSnapshot({
      recipient_name: "",
      zipcode: "bad",
      street: "",
      number: "",
      complement: 42,
      district: "",
      city: "",
      state: "badstate",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.length).toBeGreaterThanOrEqual(6);
    }
  });
});

describe("jsonb-schemas · validateAddressChangeSnapshot", () => {
  it("aceita null como 'sem endereço prévio'", () => {
    const res = validateAddressChangeSnapshot(null);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBeNull();
  });

  it("bloqueia null quando allowNullSnapshot=false", () => {
    const res = validateAddressChangeSnapshot(null, { allowNullSnapshot: false });
    expect(res.ok).toBe(false);
  });

  it("aceita snapshot completo", () => {
    const input = {
      shipping_recipient_name: "Maria",
      shipping_zipcode: "01310100",
      shipping_street: "Avenida Paulista",
      shipping_number: "1000",
      shipping_complement: "Apto 42",
      shipping_district: "Bela Vista",
      shipping_city: "São Paulo",
      shipping_state: "SP",
    };
    const res = validateAddressChangeSnapshot(input);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual(input);
  });

  it("aceita snapshot parcial (alguns campos null)", () => {
    const res = validateAddressChangeSnapshot({
      shipping_recipient_name: null,
      shipping_zipcode: null,
      shipping_street: "Rua X",
      shipping_number: "10",
      shipping_complement: null,
      shipping_district: "Centro",
      shipping_city: "SP",
      shipping_state: "SP",
    });
    expect(res.ok).toBe(true);
  });

  it("undefined vira null (serialização Supabase não distingue)", () => {
    const res = validateAddressChangeSnapshot({
      shipping_recipient_name: undefined,
      shipping_zipcode: "01310100",
      shipping_street: "Avenida Paulista",
      shipping_number: "1000",
      shipping_complement: undefined,
      shipping_district: "Bela Vista",
      shipping_city: "São Paulo",
      shipping_state: "SP",
    });
    expect(res.ok).toBe(true);
    if (res.ok && res.value) {
      expect(res.value.shipping_recipient_name).toBeNull();
      expect(res.value.shipping_complement).toBeNull();
    }
  });

  it("rejeita zipcode com formato errado", () => {
    const res = validateAddressChangeSnapshot({
      shipping_recipient_name: null,
      shipping_zipcode: "01310-100",
      shipping_street: null,
      shipping_number: null,
      shipping_complement: null,
      shipping_district: null,
      shipping_city: null,
      shipping_state: null,
    });
    expect(res.ok).toBe(false);
  });

  it("rejeita state minúsculo", () => {
    const res = validateAddressChangeSnapshot({
      shipping_recipient_name: null,
      shipping_zipcode: null,
      shipping_street: null,
      shipping_number: null,
      shipping_complement: null,
      shipping_district: null,
      shipping_city: null,
      shipping_state: "sp",
    });
    expect(res.ok).toBe(false);
  });

  it("rejeita valores não-string", () => {
    const res = validateAddressChangeSnapshot({
      shipping_recipient_name: 42,
      shipping_zipcode: null,
      shipping_street: null,
      shipping_number: null,
      shipping_complement: null,
      shipping_district: null,
      shipping_city: null,
      shipping_state: null,
    });
    expect(res.ok).toBe(false);
  });

  it("ignora chaves extras silenciosamente (tolerância evolutiva)", () => {
    const res = validateAddressChangeSnapshot({
      shipping_recipient_name: "Maria",
      shipping_zipcode: "01310100",
      shipping_street: "Av",
      shipping_number: "1",
      shipping_complement: null,
      shipping_district: "BV",
      shipping_city: "SP",
      shipping_state: "SP",
      extra_field: "meu payload custom",
      some_number: 42,
    });
    expect(res.ok).toBe(true);
  });

  it("rejeita string acima de 200 chars", () => {
    const res = validateAddressChangeSnapshot({
      shipping_recipient_name: "x".repeat(201),
      shipping_zipcode: null,
      shipping_street: null,
      shipping_number: null,
      shipping_complement: null,
      shipping_district: null,
      shipping_city: null,
      shipping_state: null,
    });
    expect(res.ok).toBe(false);
  });
});
