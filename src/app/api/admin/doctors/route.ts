/**
 * POST /api/admin/doctors
 *
 * Cria uma médica:
 *   1. Cria/encontra usuário no auth.users com role='doctor' (app_metadata)
 *   2. Insere registro em public.doctors vinculado ao user_id
 *   3. Cria doctor_compensation_rules default (R$ 200/240/30)
 *   4. Envia magic link de convite (a médica completa o perfil)
 *
 * Idempotente: se CRM já existe, retorna 409. Se e-mail existe mas
 * sem perfil de médica, cria o perfil e linka. Se ambos existem, 409.
 *
 * Auth: somente role='admin' (verificado via requireAdmin).
 */

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  fullName?: string;
  displayName?: string;
  email?: string;
  phone?: string;
  crmNumber?: string;
  crmUf?: string;
  cnpj?: string;
  consultationMinutes?: number;
};

function digits(s: string | undefined): string {
  return (s ?? "").replace(/\D/g, "");
}

function siteUrl(req: Request): string {
  const env = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "");
  if (env) return env;
  return new URL(req.url).origin;
}

export async function POST(req: Request) {
  await requireAdmin();

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }

  const fullName = (body.fullName ?? "").trim();
  const email = (body.email ?? "").trim().toLowerCase();
  const phoneDigits = digits(body.phone);
  const crmNumber = (body.crmNumber ?? "").trim();
  const crmUf = (body.crmUf ?? "").trim().toUpperCase();
  const cnpjDigits = digits(body.cnpj);
  const consultationMinutes = Math.max(10, Math.min(120, Number(body.consultationMinutes) || 30));

  if (fullName.length < 3) {
    return NextResponse.json({ ok: false, error: "Nome inválido" }, { status: 400 });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ ok: false, error: "E-mail inválido" }, { status: 400 });
  }
  if (phoneDigits.length < 10 || phoneDigits.length > 11) {
    return NextResponse.json({ ok: false, error: "Telefone inválido" }, { status: 400 });
  }
  if (!/^[A-Z]{2}$/.test(crmUf)) {
    return NextResponse.json({ ok: false, error: "UF inválida" }, { status: 400 });
  }
  if (!/^\d{3,10}$/.test(crmNumber)) {
    return NextResponse.json({ ok: false, error: "CRM inválido" }, { status: 400 });
  }
  if (cnpjDigits && cnpjDigits.length !== 14) {
    return NextResponse.json({ ok: false, error: "CNPJ deve ter 14 dígitos" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();

  // 1) CRM já cadastrado?
  const { data: existingByCrm } = await supabase
    .from("doctors")
    .select("id, full_name, crm_number, crm_uf")
    .eq("crm_uf", crmUf)
    .eq("crm_number", crmNumber)
    .maybeSingle();
  if (existingByCrm) {
    return NextResponse.json(
      { ok: false, error: `Já existe médica com CRM-${crmUf} ${crmNumber}: ${existingByCrm.full_name}` },
      { status: 409 }
    );
  }

  // 2) Cria/encontra usuário no auth.users
  const { data: usersList, error: listErr } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  if (listErr) {
    console.error("[admin/doctors] listUsers:", listErr);
    return NextResponse.json({ ok: false, error: "Falha ao consultar usuários" }, { status: 500 });
  }

  let userId: string;
  const existingUser = usersList.users.find((u) => u.email?.toLowerCase() === email);

  if (existingUser) {
    userId = existingUser.id;
    // Promove pra role 'doctor' (mantém admin se for admin que se autocadastrou)
    const currentRole = (existingUser.app_metadata as { role?: string } | null)?.role;
    if (currentRole !== "admin") {
      await supabase.auth.admin.updateUserById(userId, {
        app_metadata: { ...existingUser.app_metadata, role: "doctor" },
      });
    }

    // Existe doctor com esse user_id?
    const { data: existingDoctor } = await supabase
      .from("doctors")
      .select("id")
      .eq("user_id", userId)
      .maybeSingle();
    if (existingDoctor) {
      return NextResponse.json(
        { ok: false, error: "Esse e-mail já está vinculado a outro perfil de médica." },
        { status: 409 }
      );
    }
  } else {
    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
      email,
      email_confirm: true,
      app_metadata: { role: "doctor" },
      user_metadata: { display_name: body.displayName || fullName },
    });
    if (createErr || !created.user) {
      console.error("[admin/doctors] createUser:", createErr);
      return NextResponse.json(
        { ok: false, error: "Falha ao criar usuário de autenticação" },
        { status: 500 }
      );
    }
    userId = created.user.id;
  }

  // 3) Insere doctor
  const { data: doctor, error: docErr } = await supabase
    .from("doctors")
    .insert({
      user_id: userId,
      full_name: fullName,
      display_name: body.displayName?.trim() || null,
      email,
      phone: phoneDigits,
      crm_number: crmNumber,
      crm_uf: crmUf,
      cnpj: cnpjDigits || null,
      consultation_minutes: consultationMinutes,
      status: "invited",
      invited_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (docErr || !doctor) {
    console.error("[admin/doctors] insert doctor:", docErr);
    return NextResponse.json(
      { ok: false, error: "Falha ao criar registro de médica", details: docErr?.message },
      { status: 500 }
    );
  }

  // 4) Cria regra de compensação default
  const { error: ruleErr } = await supabase
    .from("doctor_compensation_rules")
    .insert({
      doctor_id: doctor.id,
      consultation_cents: 20000,
      on_demand_bonus_cents: 4000,
      plantao_hour_cents: 3000,
      after_hours_multiplier: 1.0,
      available_days_pix: 7,
      available_days_boleto: 3,
      available_days_card: 30,
      reason: "Default no cadastro inicial (D-024)",
    });
  if (ruleErr) {
    console.error("[admin/doctors] insert rule:", ruleErr);
    // não fatal — perfil foi criado
  }

  // 5) Dispara magic link convidando a completar perfil
  const redirectTo = `${siteUrl(req)}/api/auth/callback?next=${encodeURIComponent("/medico")}`;
  await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirectTo, shouldCreateUser: false },
  });

  return NextResponse.json({
    ok: true,
    doctorId: doctor.id,
    userId,
    inviteSent: true,
  });
}
