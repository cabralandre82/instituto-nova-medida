/**
 * POST /api/admin/doctors/[id]/payment-method
 *
 * Upsert do PIX default da médica. Não permitimos mais de uma chave
 * default — toda atualização sobrescreve a anterior.
 *
 * Validação leve da chave PIX por tipo. CPF/CNPJ nesse cadastro é
 * só dígitos; máscaras são responsabilidade do front.
 */

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  pix_key_type?: "cpf" | "cnpj" | "email" | "phone" | "random";
  pix_key?: string;
  account_holder_name?: string;
  account_holder_cpf_or_cnpj?: string;
};

const PIX_TYPES = ["cpf", "cnpj", "email", "phone", "random"] as const;

function isValidKey(type: string, key: string): boolean {
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
      return /^\+?\d{10,14}$/.test(k.replace(/[\s-]/g, ""));
    case "random":
      // EVP UUID, 32-36 chars
      return /^[0-9a-f-]{30,40}$/i.test(k);
    default:
      return false;
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id: doctorId } = await params;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }

  const type = body.pix_key_type;
  if (!type || !PIX_TYPES.includes(type)) {
    return NextResponse.json({ ok: false, error: "Tipo de chave inválido" }, { status: 400 });
  }
  const key = (body.pix_key ?? "").trim();
  if (!isValidKey(type, key)) {
    return NextResponse.json({ ok: false, error: "Chave PIX inválida pro tipo escolhido" }, { status: 400 });
  }
  const holder = (body.account_holder_name ?? "").trim();
  if (holder.length < 3) {
    return NextResponse.json({ ok: false, error: "Nome do titular obrigatório" }, { status: 400 });
  }
  const doc = (body.account_holder_cpf_or_cnpj ?? "").replace(/\D/g, "");
  if (doc.length !== 11 && doc.length !== 14) {
    return NextResponse.json({ ok: false, error: "CPF/CNPJ do titular inválido" }, { status: 400 });
  }

  // Normaliza chave por tipo (só dígitos pra cpf/cnpj/phone)
  const normalizedKey =
    type === "cpf" || type === "cnpj"
      ? key.replace(/\D/g, "")
      : type === "phone"
        ? key.replace(/[\s-]/g, "")
        : key;

  const supabase = getSupabaseAdmin();

  // Existe método default?
  const { data: existing } = await supabase
    .from("doctor_payment_methods")
    .select("id")
    .eq("doctor_id", doctorId)
    .eq("is_default", true)
    .maybeSingle();

  const payload = {
    doctor_id: doctorId,
    pix_key_type: type,
    pix_key: normalizedKey,
    pix_key_holder: holder,
    account_holder_name: holder,
    account_holder_cpf_or_cnpj: doc,
    bank_holder_doc: doc,
    is_default: true,
    active: true,
  };

  if (existing) {
    const { error } = await supabase
      .from("doctor_payment_methods")
      .update(payload)
      .eq("id", existing.id);
    if (error) {
      console.error("[payment-method] update:", error);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, id: existing.id, action: "updated" });
  }

  // Sem método default — antes de inserir, desativa qualquer outro
  // ativo da médica pra não conflitar com idx_dpm_one_active.
  await supabase
    .from("doctor_payment_methods")
    .update({ active: false, is_default: false })
    .eq("doctor_id", doctorId);

  const { data, error } = await supabase
    .from("doctor_payment_methods")
    .insert(payload)
    .select("id")
    .single();
  if (error || !data) {
    console.error("[payment-method] insert:", error);
    return NextResponse.json({ ok: false, error: error?.message ?? "Falha" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, id: data.id, action: "created" });
}
