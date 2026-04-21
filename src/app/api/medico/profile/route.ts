/**
 * PATCH /api/medico/profile
 *
 * A médica edita um conjunto pequeno e seguro de campos do próprio perfil:
 *   - display_name      "Dra. Joana"
 *   - bio               texto livre exibido no /agendar
 *   - phone             contato do operador (não exibido pra paciente)
 *   - consultation_minutes  duração padrão da consulta (10–120)
 *
 * NUNCA aceita: crm_*, email, cnpj, status, dados de PJ "duros".
 * Mudanças nesses precisam passar pelo operador (D-024).
 */

import { NextResponse } from "next/server";
import { requireDoctor } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/medico/profile" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  display_name?: string | null;
  bio?: string | null;
  phone?: string | null;
  consultation_minutes?: number | null;
};

function digits(v: string | null | undefined): string {
  return (v ?? "").replace(/\D+/g, "");
}

export async function PATCH(req: Request) {
  const { doctorId } = await requireDoctor();

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if ("display_name" in body) {
    const v = (body.display_name ?? "").trim();
    if (v.length > 80) {
      return NextResponse.json(
        { ok: false, error: "Nome de exibição muito longo (máx 80)." },
        { status: 400 }
      );
    }
    update.display_name = v.length > 0 ? v : null;
  }

  if ("bio" in body) {
    const v = (body.bio ?? "").trim();
    if (v.length > 1500) {
      return NextResponse.json(
        { ok: false, error: "Biografia muito longa (máx 1500)." },
        { status: 400 }
      );
    }
    update.bio = v.length > 0 ? v : null;
  }

  if ("phone" in body) {
    const v = digits(body.phone);
    if (v.length > 0 && v.length < 10) {
      return NextResponse.json(
        { ok: false, error: "Telefone deve ter ao menos 10 dígitos (com DDD)." },
        { status: 400 }
      );
    }
    if (v.length > 0) update.phone = v;
  }

  if ("consultation_minutes" in body) {
    const v = Number(body.consultation_minutes);
    if (!Number.isInteger(v) || v < 10 || v > 120) {
      return NextResponse.json(
        { ok: false, error: "Duração precisa ser entre 10 e 120 minutos." },
        { status: 400 }
      );
    }
    update.consultation_minutes = v;
  }

  // Se ninguém setou nada além do updated_at, retorna sem tocar no banco
  if (Object.keys(update).length === 1) {
    return NextResponse.json({ ok: true, changed: false });
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("doctors")
    .update(update)
    .eq("id", doctorId)
    .select("id, display_name, bio, phone, consultation_minutes")
    .maybeSingle();

  if (error || !data) {
    log.error("update", { err: error, doctor_id: doctorId });
    return NextResponse.json(
      { ok: false, error: "Falha ao salvar perfil." },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, changed: true, doctor: data });
}
