/**
 * Testes unitários para src/lib/doctor-payment-methods.ts (D-042).
 *
 * Cobrimos:
 *   - validação por tipo de chave (cpf, cnpj, email, phone, random)
 *   - normalização (dígitos / lowercase)
 *   - createOrReplacePaymentMethod: insere, desativa antigo, retorna ids
 *   - deleteHistoricalPaymentMethod: bloqueio quando is_default, sucesso
 *     quando histórico, rejeição de id de outra médica
 *   - helpers de apresentação (mask, label)
 */

import { describe, it, expect } from "vitest";
import {
  PIX_KEY_TYPES,
  isValidPixKey,
  normalizePixKey,
  validatePixInput,
  isHolderConsistent,
  maskPixKey,
  labelForPixType,
  createOrReplacePaymentMethod,
  deleteHistoricalPaymentMethod,
  type PixInput,
} from "./doctor-payment-methods";
import { createSupabaseMock } from "@/test/mocks/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";

function asClient(mock: ReturnType<typeof createSupabaseMock>): SupabaseClient {
  return mock.client as unknown as SupabaseClient;
}

describe("PIX_KEY_TYPES", () => {
  it("exports the five canonical types", () => {
    expect(PIX_KEY_TYPES).toEqual(["cpf", "cnpj", "email", "phone", "random"]);
  });
});

describe("isValidPixKey", () => {
  it("accepts valid CPFs and rejects short/long", () => {
    expect(isValidPixKey("cpf", "12345678901")).toBe(true);
    expect(isValidPixKey("cpf", "123.456.789-01")).toBe(true);
    expect(isValidPixKey("cpf", "123")).toBe(false);
    expect(isValidPixKey("cpf", "123456789012")).toBe(false);
  });

  it("accepts valid CNPJs", () => {
    expect(isValidPixKey("cnpj", "12345678000199")).toBe(true);
    expect(isValidPixKey("cnpj", "12.345.678/0001-99")).toBe(true);
    expect(isValidPixKey("cnpj", "1234567800019")).toBe(false);
  });

  it("validates emails", () => {
    expect(isValidPixKey("email", "dra@joana.com")).toBe(true);
    expect(isValidPixKey("email", "no-at")).toBe(false);
    expect(isValidPixKey("email", "a@b")).toBe(false);
  });

  it("validates phones (10-14 digits, opcional +)", () => {
    expect(isValidPixKey("phone", "+5511999998888")).toBe(true);
    expect(isValidPixKey("phone", "(11) 99999-8888")).toBe(true);
    expect(isValidPixKey("phone", "1234")).toBe(false);
  });

  it("validates random EVP keys", () => {
    expect(isValidPixKey("random", "550e8400-e29b-41d4-a716-446655440000")).toBe(
      true,
    );
    expect(isValidPixKey("random", "short")).toBe(false);
  });

  it("rejects empty string for any type", () => {
    for (const t of PIX_KEY_TYPES) {
      expect(isValidPixKey(t, "")).toBe(false);
      expect(isValidPixKey(t, "   ")).toBe(false);
    }
  });
});

describe("normalizePixKey", () => {
  it("strips mask for CPF/CNPJ", () => {
    expect(normalizePixKey("cpf", "123.456.789-01")).toBe("12345678901");
    expect(normalizePixKey("cnpj", "12.345.678/0001-99")).toBe("12345678000199");
  });

  it("strips spaces/parentheses for phone but keeps +", () => {
    expect(normalizePixKey("phone", "+55 (11) 99999-8888")).toBe("+5511999998888");
  });

  it("lowercases email and random", () => {
    expect(normalizePixKey("email", "Dra@Joana.COM")).toBe("dra@joana.com");
    expect(normalizePixKey("random", "ABC-123")).toBe("abc-123");
  });
});

describe("validatePixInput", () => {
  const valid: PixInput = {
    pix_key_type: "cpf",
    pix_key: "12345678901",
    account_holder_name: "Joana Silva",
    account_holder_cpf_or_cnpj: "12345678901",
  };

  it("returns null when everything is valid", () => {
    expect(validatePixInput(valid)).toBeNull();
  });

  it("flags invalid pix key type", () => {
    const r = validatePixInput({ ...valid, pix_key_type: "zzz" as never });
    expect(r?.field).toBe("pix_key_type");
  });

  it("flags invalid key", () => {
    const r = validatePixInput({ ...valid, pix_key: "short" });
    expect(r?.field).toBe("pix_key");
  });

  it("flags short holder name", () => {
    const r = validatePixInput({ ...valid, account_holder_name: "Jo" });
    expect(r?.field).toBe("account_holder_name");
  });

  it("flags invalid CPF/CNPJ", () => {
    const r = validatePixInput({ ...valid, account_holder_cpf_or_cnpj: "123" });
    expect(r?.field).toBe("account_holder_cpf_or_cnpj");
  });
});

describe("isHolderConsistent", () => {
  it("requires doc to match key when type=cpf", () => {
    expect(
      isHolderConsistent({
        pix_key_type: "cpf",
        pix_key: "12345678901",
        account_holder_name: "X",
        account_holder_cpf_or_cnpj: "12345678901",
      }),
    ).toBe(true);
    expect(
      isHolderConsistent({
        pix_key_type: "cpf",
        pix_key: "12345678901",
        account_holder_name: "X",
        account_holder_cpf_or_cnpj: "99999999999",
      }),
    ).toBe(false);
  });

  it("is permissive for email/phone/random", () => {
    expect(
      isHolderConsistent({
        pix_key_type: "email",
        pix_key: "a@b.c",
        account_holder_name: "X",
        account_holder_cpf_or_cnpj: "12345678901",
      }),
    ).toBe(true);
  });
});

describe("maskPixKey", () => {
  it("masks CPF", () => {
    expect(maskPixKey("cpf", "12345678901")).toContain("***");
    expect(maskPixKey("cpf", "12345678901")).toMatch(/^123\./);
    expect(maskPixKey("cpf", "12345678901")).toMatch(/01$/);
  });

  it("masks email keeping domain", () => {
    const m = maskPixKey("email", "joana@example.com");
    expect(m).toContain("@example.com");
    expect(m.startsWith("jo")).toBe(true);
  });

  it("truncates random uuid", () => {
    const m = maskPixKey("random", "550e8400-e29b-41d4-a716-446655440000");
    expect(m).toContain("…");
  });
});

describe("labelForPixType", () => {
  it("translates each type", () => {
    expect(labelForPixType("cpf")).toBe("CPF");
    expect(labelForPixType("cnpj")).toBe("CNPJ");
    expect(labelForPixType("email")).toBe("E-mail");
    expect(labelForPixType("phone")).toBe("Telefone");
    expect(labelForPixType("random")).toBe("Chave aleatória");
  });
});

describe("createOrReplacePaymentMethod", () => {
  const input: PixInput = {
    pix_key_type: "cpf",
    pix_key: "123.456.789-01",
    account_holder_name: "Joana Silva",
    account_holder_cpf_or_cnpj: "12345678901",
  };

  it("inserts new when no default exists", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("doctor_payment_methods", { data: null, error: null });
    supa.enqueue("doctor_payment_methods", { data: null, error: null });
    supa.enqueue("doctor_payment_methods", {
      data: { id: "new-pm-1" },
      error: null,
    });

    const result = await createOrReplacePaymentMethod(
      asClient(supa),
      "doc-1",
      input,
      { replacedByUserId: "user-1" },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.id).toBe("new-pm-1");
      expect(result.replacedId).toBeNull();
    }
  });

  it("marks antigo default como active=false, is_default=false e insere novo", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("doctor_payment_methods", {
      data: { id: "old-pm" },
      error: null,
    });
    supa.enqueue("doctor_payment_methods", { data: null, error: null });
    supa.enqueue("doctor_payment_methods", {
      data: { id: "new-pm" },
      error: null,
    });

    const result = await createOrReplacePaymentMethod(
      asClient(supa),
      "doc-1",
      input,
      { replacedByUserId: "user-1" },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.id).toBe("new-pm");
      expect(result.replacedId).toBe("old-pm");
    }

    const updateCall = supa.calls.find((c) => c.chain.includes("update"));
    expect(updateCall).toBeDefined();
    const updateArgs = updateCall?.args[updateCall.chain.indexOf("update")]?.[0];
    expect(updateArgs).toMatchObject({
      is_default: false,
      active: false,
      replaced_by: "user-1",
    });
    expect((updateArgs as { replaced_at?: string }).replaced_at).toBeTruthy();

    const insertCall = supa.calls.find((c) => c.chain.includes("insert"));
    expect(insertCall).toBeDefined();
    const insertArgs = insertCall?.args[insertCall.chain.indexOf("insert")]?.[0];
    expect(insertArgs).toMatchObject({
      doctor_id: "doc-1",
      pix_key_type: "cpf",
      pix_key: "12345678901",
      account_holder_cpf_or_cnpj: "12345678901",
      bank_holder_doc: "12345678901",
      is_default: true,
      active: true,
    });
  });

  it("retorna erro de validação sem tocar no banco", async () => {
    const supa = createSupabaseMock();
    const result = await createOrReplacePaymentMethod(
      asClient(supa),
      "doc-1",
      { ...input, pix_key: "oops" },
      { replacedByUserId: null },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.validation?.field).toBe("pix_key");
    expect(supa.calls).toHaveLength(0);
  });

  it("propaga erro do insert", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("doctor_payment_methods", { data: null, error: null });
    supa.enqueue("doctor_payment_methods", { data: null, error: null });
    supa.enqueue("doctor_payment_methods", {
      data: null,
      error: { message: "constraint violation" },
    });

    const result = await createOrReplacePaymentMethod(
      asClient(supa),
      "doc-1",
      input,
      { replacedByUserId: null },
    );
    expect(result.ok).toBe(false);
  });
});

describe("deleteHistoricalPaymentMethod", () => {
  it("remove registro não-default com sucesso", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("doctor_payment_methods", {
      data: { id: "m1", doctor_id: "doc-1", is_default: false },
      error: null,
    });
    supa.enqueue("doctor_payment_methods", { data: null, error: null });

    const r = await deleteHistoricalPaymentMethod(asClient(supa), "doc-1", "m1");
    expect(r).toEqual({ ok: true });
  });

  it("bloqueia remover o default vigente", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("doctor_payment_methods", {
      data: { id: "m1", doctor_id: "doc-1", is_default: true },
      error: null,
    });

    const r = await deleteHistoricalPaymentMethod(asClient(supa), "doc-1", "m1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/vigente/i);
  });

  it("rejeita registro de outra médica", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("doctor_payment_methods", {
      data: { id: "m1", doctor_id: "doc-2", is_default: false },
      error: null,
    });

    const r = await deleteHistoricalPaymentMethod(asClient(supa), "doc-1", "m1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/outra m[ée]dica/i);
  });

  it("falha se registro não existe", async () => {
    const supa = createSupabaseMock();
    supa.enqueue("doctor_payment_methods", { data: null, error: null });

    const r = await deleteHistoricalPaymentMethod(asClient(supa), "doc-1", "m1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/não encontrado/i);
  });
});
