/**
 * src/lib/doctor-payment-methods.ts — D-042 · PIX self-service
 *
 * Fonte única de verdade pra CRUD de `doctor_payment_methods`:
 *   - validação por tipo de chave (cpf/cnpj/email/phone/random)
 *   - normalização (strip de máscaras em dígitos)
 *   - troca não-destrutiva: o default antigo vira `active=false,
 *     is_default=false, replaced_at=now, replaced_by=userId` e um
 *     novo registro é inserido com `is_default=true, active=true`.
 *   - deleção de histórico (não-default)
 *
 * Usado por:
 *   - UI da médica em /medico/perfil/pix (self-service)
 *   - API admin /api/admin/doctors/[id]/payment-method (compat)
 *
 * Manter em sincronia com o cron D-040 (monthly-payouts.ts), que lê
 * `active=true` pra snapshot do PIX no payout.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export const PIX_KEY_TYPES = ["cpf", "cnpj", "email", "phone", "random"] as const;
export type PixKeyType = (typeof PIX_KEY_TYPES)[number];

export type PaymentMethod = {
  id: string;
  doctor_id: string;
  pix_key_type: PixKeyType;
  pix_key: string;
  pix_key_holder: string | null;
  account_holder_name: string | null;
  account_holder_cpf_or_cnpj: string | null;
  is_default: boolean;
  active: boolean;
  verified_at: string | null;
  replaced_at: string | null;
  replaced_by: string | null;
  created_at: string;
  updated_at: string;
};

export type PixInput = {
  pix_key_type: PixKeyType;
  pix_key: string;
  account_holder_name: string;
  account_holder_cpf_or_cnpj: string;
};

export type ValidationError = {
  field: "pix_key_type" | "pix_key" | "account_holder_name" | "account_holder_cpf_or_cnpj";
  message: string;
};

// ────────────────────────────────────────────────────────────────────
// Validação / normalização
// ────────────────────────────────────────────────────────────────────

export function isValidPixKey(type: PixKeyType, key: string): boolean {
  const k = key.trim();
  if (!k) return false;
  switch (type) {
    case "cpf":
      return /^\d{11}$/.test(k.replace(/\D/g, ""));
    case "cnpj":
      return /^\d{14}$/.test(k.replace(/\D/g, ""));
    case "email":
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(k);
    case "phone":
      return /^\+?\d{10,14}$/.test(k.replace(/[\s()-]/g, ""));
    case "random":
      // EVP UUID: 30-40 chars com/sem hífens
      return /^[0-9a-f-]{30,40}$/i.test(k);
    default:
      return false;
  }
}

export function normalizePixKey(type: PixKeyType, key: string): string {
  const k = key.trim();
  switch (type) {
    case "cpf":
    case "cnpj":
      return k.replace(/\D/g, "");
    case "phone":
      return k.replace(/[\s()-]/g, "");
    case "email":
      return k.toLowerCase();
    case "random":
      return k.toLowerCase();
    default:
      return k;
  }
}

export function validatePixInput(input: PixInput): ValidationError | null {
  if (!PIX_KEY_TYPES.includes(input.pix_key_type)) {
    return { field: "pix_key_type", message: "Tipo de chave inválido" };
  }
  if (!isValidPixKey(input.pix_key_type, input.pix_key)) {
    return {
      field: "pix_key",
      message: "Chave PIX inválida para o tipo escolhido",
    };
  }
  const name = (input.account_holder_name ?? "").trim();
  if (name.length < 3) {
    return {
      field: "account_holder_name",
      message: "Nome do titular obrigatório (mínimo 3 caracteres)",
    };
  }
  const doc = (input.account_holder_cpf_or_cnpj ?? "").replace(/\D/g, "");
  if (doc.length !== 11 && doc.length !== 14) {
    return {
      field: "account_holder_cpf_or_cnpj",
      message: "CPF (11 dígitos) ou CNPJ (14 dígitos) do titular obrigatório",
    };
  }
  return null;
}

/**
 * Quando a chave PIX é CPF/CNPJ, o doc do titular deve bater.
 * Retorna `true` se é consistente ou se não se aplica.
 */
export function isHolderConsistent(input: PixInput): boolean {
  const doc = input.account_holder_cpf_or_cnpj.replace(/\D/g, "");
  if (input.pix_key_type === "cpf") {
    return doc === input.pix_key.replace(/\D/g, "") && doc.length === 11;
  }
  if (input.pix_key_type === "cnpj") {
    return doc === input.pix_key.replace(/\D/g, "") && doc.length === 14;
  }
  return true;
}

// ────────────────────────────────────────────────────────────────────
// Queries
// ────────────────────────────────────────────────────────────────────

const SELECT_COLS =
  "id, doctor_id, pix_key_type, pix_key, pix_key_holder, account_holder_name, account_holder_cpf_or_cnpj, is_default, active, verified_at, replaced_at, replaced_by, created_at, updated_at";

export async function listPaymentMethods(
  supabase: SupabaseClient,
  doctorId: string,
): Promise<PaymentMethod[]> {
  const { data, error } = await supabase
    .from("doctor_payment_methods")
    .select(SELECT_COLS)
    .eq("doctor_id", doctorId)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listPaymentMethods: ${error.message}`);
  return (data ?? []) as unknown as PaymentMethod[];
}

export async function getActivePaymentMethod(
  supabase: SupabaseClient,
  doctorId: string,
): Promise<PaymentMethod | null> {
  const { data, error } = await supabase
    .from("doctor_payment_methods")
    .select(SELECT_COLS)
    .eq("doctor_id", doctorId)
    .eq("is_default", true)
    .maybeSingle();
  if (error) throw new Error(`getActivePaymentMethod: ${error.message}`);
  return (data as unknown as PaymentMethod | null) ?? null;
}

// ────────────────────────────────────────────────────────────────────
// Mutations
// ────────────────────────────────────────────────────────────────────

export type ReplaceResult =
  | { ok: true; id: string; replacedId: string | null }
  | { ok: false; error: string; validation?: ValidationError };

/**
 * Cria um novo PIX default ou substitui o existente.
 *
 * Estratégia (não-destrutiva):
 *   1. Se existir default ativo, desativa com `is_default=false,
 *      active=false, replaced_at=now, replaced_by=userId`.
 *   2. Desativa qualquer outro registro ainda `active=true` (garantia).
 *   3. Insere registro novo com `is_default=true, active=true`.
 *
 * Isso preserva o histórico pra auditoria e permite que cron D-040
 * continue usando `active=true` (sempre só 1) pra snapshot.
 */
export async function createOrReplacePaymentMethod(
  supabase: SupabaseClient,
  doctorId: string,
  input: PixInput,
  opts: { replacedByUserId: string | null },
): Promise<ReplaceResult> {
  const err = validatePixInput(input);
  if (err) return { ok: false, error: err.message, validation: err };

  const normalizedKey = normalizePixKey(input.pix_key_type, input.pix_key);
  const normalizedDoc = input.account_holder_cpf_or_cnpj.replace(/\D/g, "");
  const holderName = input.account_holder_name.trim();

  // 1. Busca default vigente
  const { data: current, error: selErr } = await supabase
    .from("doctor_payment_methods")
    .select("id")
    .eq("doctor_id", doctorId)
    .eq("is_default", true)
    .maybeSingle();
  if (selErr) {
    return { ok: false, error: `select default: ${selErr.message}` };
  }

  // 2. Desativa TODOS ativos (não só o default) pra não bater em
  //    idx_dpm_one_active caso haja resíduos.
  const { error: deactivateErr } = await supabase
    .from("doctor_payment_methods")
    .update({
      is_default: false,
      active: false,
      replaced_at: new Date().toISOString(),
      replaced_by: opts.replacedByUserId,
    })
    .eq("doctor_id", doctorId)
    .or("active.eq.true,is_default.eq.true");
  if (deactivateErr) {
    return { ok: false, error: `deactivate: ${deactivateErr.message}` };
  }

  // 3. Insere o novo como default + ativo
  const { data: inserted, error: insErr } = await supabase
    .from("doctor_payment_methods")
    .insert({
      doctor_id: doctorId,
      pix_key_type: input.pix_key_type,
      pix_key: normalizedKey,
      pix_key_holder: holderName,
      account_holder_name: holderName,
      account_holder_cpf_or_cnpj: normalizedDoc,
      bank_holder_doc: normalizedDoc,
      is_default: true,
      active: true,
    })
    .select("id")
    .single();
  if (insErr || !inserted) {
    return {
      ok: false,
      error: `insert: ${insErr?.message ?? "sem resposta do banco"}`,
    };
  }

  return {
    ok: true,
    id: (inserted as { id: string }).id,
    replacedId: (current as { id: string } | null)?.id ?? null,
  };
}

/**
 * Remove um registro do histórico. Só permite se NÃO for o default
 * atual (a médica não pode se deixar sem PIX).
 */
export async function deleteHistoricalPaymentMethod(
  supabase: SupabaseClient,
  doctorId: string,
  methodId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error: selErr } = await supabase
    .from("doctor_payment_methods")
    .select("id, doctor_id, is_default")
    .eq("id", methodId)
    .maybeSingle();
  if (selErr) return { ok: false, error: selErr.message };
  if (!data) return { ok: false, error: "Registro não encontrado" };
  const row = data as { id: string; doctor_id: string; is_default: boolean };
  if (row.doctor_id !== doctorId) {
    return { ok: false, error: "Registro de outra médica" };
  }
  if (row.is_default) {
    return {
      ok: false,
      error: "Não é possível remover o PIX vigente. Troque primeiro.",
    };
  }

  const { error: delErr } = await supabase
    .from("doctor_payment_methods")
    .delete()
    .eq("id", methodId);
  if (delErr) return { ok: false, error: delErr.message };
  return { ok: true };
}

// ────────────────────────────────────────────────────────────────────
// Helpers de apresentação
// ────────────────────────────────────────────────────────────────────

export function maskPixKey(type: PixKeyType, key: string): string {
  if (!key) return "";
  switch (type) {
    case "cpf": {
      const k = key.replace(/\D/g, "").padStart(11, "•");
      return `${k.slice(0, 3)}.***.***-${k.slice(-2)}`;
    }
    case "cnpj": {
      const k = key.replace(/\D/g, "").padStart(14, "•");
      return `${k.slice(0, 2)}.***.***/****-${k.slice(-2)}`;
    }
    case "email": {
      const [user, domain] = key.split("@");
      if (!user || !domain) return key;
      const visible = user.slice(0, Math.min(2, user.length));
      return `${visible}${"•".repeat(Math.max(1, user.length - 2))}@${domain}`;
    }
    case "phone": {
      const k = key.replace(/\D/g, "");
      return `${k.slice(0, 2)} ••••• ${k.slice(-4)}`;
    }
    case "random":
      return `${key.slice(0, 6)}…${key.slice(-4)}`;
    default:
      return key;
  }
}

export function labelForPixType(type: PixKeyType): string {
  switch (type) {
    case "cpf":
      return "CPF";
    case "cnpj":
      return "CNPJ";
    case "email":
      return "E-mail";
    case "phone":
      return "Telefone";
    case "random":
      return "Chave aleatória";
  }
}
