/**
 * /api/medico/payment-methods — D-042 · PIX self-service
 *
 * GET  → lista PIX da médica (default + histórico)
 * POST → cria novo default (invalida o anterior via replaced_at/replaced_by)
 *
 * Autenticação: requireDoctor → doctorId da médica logada.
 *
 * A lógica de troca não-destrutiva vive em `src/lib/doctor-payment-methods.ts`.
 */

import { NextResponse } from "next/server";
import { requireDoctor } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  createOrReplacePaymentMethod,
  listPaymentMethods,
  type PixInput,
  type PixKeyType,
  PIX_KEY_TYPES,
} from "@/lib/doctor-payment-methods";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { doctorId } = await requireDoctor();
  const supabase = getSupabaseAdmin();
  try {
    const methods = await listPaymentMethods(supabase, doctorId);
    return NextResponse.json({ ok: true, methods });
  } catch (e) {
    const message = e instanceof Error ? e.message : "erro";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

type Body = {
  pix_key_type?: string;
  pix_key?: string;
  account_holder_name?: string;
  account_holder_cpf_or_cnpj?: string;
};

export async function POST(req: Request) {
  const { user, doctorId } = await requireDoctor();

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }

  if (!body.pix_key_type || !PIX_KEY_TYPES.includes(body.pix_key_type as PixKeyType)) {
    return NextResponse.json(
      { ok: false, error: "Tipo de chave inválido" },
      { status: 400 },
    );
  }

  const input: PixInput = {
    pix_key_type: body.pix_key_type as PixKeyType,
    pix_key: body.pix_key ?? "",
    account_holder_name: body.account_holder_name ?? "",
    account_holder_cpf_or_cnpj: body.account_holder_cpf_or_cnpj ?? "",
  };

  const supabase = getSupabaseAdmin();
  const result = await createOrReplacePaymentMethod(supabase, doctorId, input, {
    replacedByUserId: user.id,
  });

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, field: result.validation?.field },
      { status: result.validation ? 400 : 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    id: result.id,
    replacedId: result.replacedId,
  });
}
