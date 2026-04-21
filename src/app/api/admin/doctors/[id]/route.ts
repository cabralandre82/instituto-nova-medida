/**
 * PATCH /api/admin/doctors/[id]
 *
 * Atualiza dados editáveis do perfil de uma médica (não inclui CRM/UF/email,
 * que são imutáveis depois do cadastro). Status só pode mudar via campos
 * permitidos. Mudanças de status registram o timestamp correspondente.
 */

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { requireAdmin } from "@/lib/auth";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/admin/doctors/[id]" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  full_name?: string;
  display_name?: string;
  phone?: string;
  bio?: string;
  cnpj?: string;
  consultation_minutes?: number;
  status?: "invited" | "pending" | "active" | "suspended" | "archived";
};

const STATUSES: Body["status"][] = ["invited", "pending", "active", "suspended", "archived"];

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};

  if (typeof body.full_name === "string" && body.full_name.trim().length >= 3) {
    update.full_name = body.full_name.trim();
  }
  if (body.display_name !== undefined) {
    const v = body.display_name.trim();
    update.display_name = v.length === 0 ? null : v;
  }
  if (typeof body.phone === "string") {
    const d = body.phone.replace(/\D/g, "");
    if (d.length < 10 || d.length > 11) {
      return NextResponse.json({ ok: false, error: "Telefone inválido" }, { status: 400 });
    }
    update.phone = d;
  }
  if (body.bio !== undefined) {
    update.bio = body.bio.trim().length === 0 ? null : body.bio.trim().slice(0, 500);
  }
  if (body.cnpj !== undefined) {
    const d = body.cnpj.replace(/\D/g, "");
    if (d.length > 0 && d.length !== 14) {
      return NextResponse.json({ ok: false, error: "CNPJ deve ter 14 dígitos" }, { status: 400 });
    }
    update.cnpj = d.length === 0 ? null : d;
  }
  if (typeof body.consultation_minutes === "number") {
    const n = Math.max(10, Math.min(120, Math.round(body.consultation_minutes)));
    update.consultation_minutes = n;
  }
  if (body.status && STATUSES.includes(body.status)) {
    update.status = body.status;
    if (body.status === "active") update.activated_at = new Date().toISOString();
    if (body.status === "suspended") update.suspended_at = new Date().toISOString();
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ ok: false, error: "Nada para atualizar" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("doctors").update(update).eq("id", id);
  if (error) {
    log.error("update", { err: error, doctor_id: id });
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
