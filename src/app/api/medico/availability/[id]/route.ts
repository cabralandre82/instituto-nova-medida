/**
 * DELETE /api/medico/availability/[id]  → soft-delete (active=false).
 * PATCH  /api/medico/availability/[id]  → reativa (active=true).
 *
 * PR-076 · D-088. Edição completa de bloco (mudar weekday/horário/tipo)
 * NÃO é exposta — médica deleta + recria. Mantém invariantes simples
 * e evita confusão semântica (mexer em horário ativo de bloco que
 * já tem reservas).
 *
 * Auth: requireDoctor; só age em blocos do próprio doctor (filtro
 * `doctor_id = self` na query).
 */

import { NextResponse } from "next/server";
import { requireDoctor } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  deactivateAvailability,
  hasOverlap,
  listAvailabilityForDoctor,
  reactivateAvailability,
} from "@/lib/doctor-availability";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/medico/availability/[id]" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { doctorId } = await requireDoctor();
  const { id } = await ctx.params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { ok: false, error: "id_invalid" },
      { status: 400 }
    );
  }

  const supabase = getSupabaseAdmin();
  const result = await deactivateAvailability(supabase, doctorId, id);
  if (!result.ok) {
    if (result.error === "not_found") {
      return NextResponse.json(
        { ok: false, error: "not_found" },
        { status: 404 }
      );
    }
    log.error("deactivate_failed", { doctor_id: doctorId, id, err: result.error });
    return NextResponse.json({ ok: false, error: "internal" }, { status: 500 });
  }

  log.info("block_deactivated", { doctor_id: doctorId, id, was_active: result.wasActive });
  return NextResponse.json({ ok: true, was_active: result.wasActive });
}

/**
 * PATCH só aceita `{ active: true }` — reativar bloco previamente
 * desativado. Caller passa em headers ou body. Outros campos são
 * ignorados (médica precisa deletar+criar pra mudar horário).
 *
 * Aplica check de overlap com blocos atualmente ativos (sem o
 * próprio id na lista), pra prevenir que reativar crie sobreposição.
 */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { doctorId } = await requireDoctor();
  const { id } = await ctx.params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { ok: false, error: "id_invalid" },
      { status: 400 }
    );
  }

  let body: { active?: unknown } = {};
  try {
    const raw = await req.json();
    if (raw && typeof raw === "object") body = raw as { active?: unknown };
  } catch {
    return NextResponse.json(
      { ok: false, error: "JSON inválido" },
      { status: 400 }
    );
  }

  if (body.active !== true) {
    return NextResponse.json(
      {
        ok: false,
        error: "unsupported_change",
        hint: "Edição completa não é suportada — delete + recrie. Apenas { active: true } é aceito.",
      },
      { status: 400 }
    );
  }

  const supabase = getSupabaseAdmin();
  const all = await listAvailabilityForDoctor(doctorId, {
    includeInactive: true,
  });
  const target = all.find((row) => row.id === id);
  if (!target) {
    return NextResponse.json(
      { ok: false, error: "not_found" },
      { status: 404 }
    );
  }

  if (target.active) {
    return NextResponse.json({ ok: true, already_active: true });
  }

  const overlap = hasOverlap(
    all,
    {
      weekday: target.weekday,
      start_time: target.start_time,
      end_time: target.end_time,
    },
    target.id
  );
  if (overlap) {
    return NextResponse.json(
      { ok: false, error: "overlap" },
      { status: 409 }
    );
  }

  const result = await reactivateAvailability(supabase, doctorId, id);
  if (!result.ok) {
    log.error("reactivate_failed", {
      doctor_id: doctorId,
      id,
      err: result.error,
    });
    return NextResponse.json({ ok: false, error: "internal" }, { status: 500 });
  }

  log.info("block_reactivated", { doctor_id: doctorId, id });
  return NextResponse.json({ ok: true });
}
