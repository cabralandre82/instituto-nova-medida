/**
 * GET  /api/medico/availability  → lista blocos da médica logada.
 * POST /api/medico/availability  → cria bloco novo.
 *
 * PR-076 · D-088. Auth: requireDoctor (cookie). doctor_id vem da
 * sessão; nunca aceita do body.
 *
 * POST body:
 *   { weekday: 0..6, start_time: "HH:MM" | "HH:MM:SS",
 *     end_time:   "HH:MM" | "HH:MM:SS",
 *     type: 'scheduled'|'on_call'|'agendada'|'plantao' }
 *
 * Validação canônica via `validateAvailabilityInput`. Overlap
 * checado ANTES do INSERT contra a lista atual da médica
 * (active=true). Trade-off documentado em `doctor-availability.ts`:
 * race entre check e insert pode resultar em sobreposição
 * (sem índice unique no schema). Em produção solo, race
 * desprezível.
 */

import { NextResponse } from "next/server";
import { requireDoctor } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  createAvailability,
  hasOverlap,
  listAvailabilityForDoctor,
  validateAvailabilityInput,
} from "@/lib/doctor-availability";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/medico/availability" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { doctorId } = await requireDoctor();
  const rows = await listAvailabilityForDoctor(doctorId, {
    includeInactive: true,
  });
  return NextResponse.json({
    ok: true,
    blocks: rows,
  });
}

export async function POST(req: Request) {
  const { doctorId } = await requireDoctor();

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "JSON inválido" },
      { status: 400 }
    );
  }
  if (!raw || typeof raw !== "object") {
    return NextResponse.json(
      { ok: false, error: "payload_invalid" },
      { status: 400 }
    );
  }

  const body = raw as Record<string, unknown>;
  const validated = validateAvailabilityInput({
    weekday: body.weekday,
    start_time: body.start_time,
    end_time: body.end_time,
    type: body.type,
  });
  if (!validated.ok) {
    return NextResponse.json(
      { ok: false, error: validated.error },
      { status: 400 }
    );
  }

  const supabase = getSupabaseAdmin();
  const existing = await listAvailabilityForDoctor(doctorId, {
    includeInactive: false,
  });
  if (
    hasOverlap(existing, {
      weekday: validated.weekday,
      start_time: validated.start_time,
      end_time: validated.end_time,
    })
  ) {
    return NextResponse.json(
      { ok: false, error: "overlap" },
      { status: 409 }
    );
  }

  const created = await createAvailability(supabase, doctorId, {
    weekday: validated.weekday,
    start_time: validated.start_time,
    end_time: validated.end_time,
    type: validated.type,
  });

  if (!created.ok) {
    log.error("create_failed", { doctor_id: doctorId, err: created.error });
    return NextResponse.json(
      { ok: false, error: "internal" },
      { status: 500 }
    );
  }

  log.info("block_created", {
    doctor_id: doctorId,
    block_id: created.row.id,
    weekday: created.row.weekday,
    type: created.row.type,
  });

  return NextResponse.json({ ok: true, block: created.row }, { status: 201 });
}
