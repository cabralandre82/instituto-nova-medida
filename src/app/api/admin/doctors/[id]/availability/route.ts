/**
 * POST   /api/admin/doctors/[id]/availability
 *   body: { weekday, start_time, end_time, type }
 *   Adiciona um slot de disponibilidade.
 *
 * DELETE /api/admin/doctors/[id]/availability?slotId=...
 *   Remove um slot.
 *
 * Não há PATCH — pra editar, deletar e recriar.
 */

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { requireAdmin } from "@/lib/auth";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/admin/doctors/[id]/availability" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  weekday?: number;
  start_time?: string;
  end_time?: string;
  type?: "scheduled" | "on_call";
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id: doctorId } = await params;
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }

  const weekday = Number(body.weekday);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    return NextResponse.json({ ok: false, error: "Dia da semana inválido (0-6)" }, { status: 400 });
  }
  if (!body.start_time || !TIME_RE.test(body.start_time)) {
    return NextResponse.json({ ok: false, error: "Horário inicial inválido" }, { status: 400 });
  }
  if (!body.end_time || !TIME_RE.test(body.end_time)) {
    return NextResponse.json({ ok: false, error: "Horário final inválido" }, { status: 400 });
  }
  if (body.start_time >= body.end_time) {
    return NextResponse.json({ ok: false, error: "Início deve ser antes do fim" }, { status: 400 });
  }
  if (body.type !== "scheduled" && body.type !== "on_call") {
    return NextResponse.json({ ok: false, error: "Tipo inválido" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("doctor_availability")
    .insert({
      doctor_id: doctorId,
      weekday,
      start_time: body.start_time,
      end_time: body.end_time,
      type: body.type,
      active: true,
    })
    .select("id")
    .single();
  if (error || !data) {
    log.error("insert", { err: error, doctor_id: doctorId });
    return NextResponse.json({ ok: false, error: error?.message ?? "Falha" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, id: data.id });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id: doctorId } = await params;
  const slotId = new URL(req.url).searchParams.get("slotId");
  if (!slotId) {
    return NextResponse.json({ ok: false, error: "slotId obrigatório" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("doctor_availability")
    .delete()
    .eq("id", slotId)
    .eq("doctor_id", doctorId);
  if (error) {
    log.error("delete", { err: error, doctor_id: doctorId, slot_id: slotId });
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
