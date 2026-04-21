/**
 * POST /api/admin/doctors/[id]/reliability/unpause
 *
 * Reativa uma médica que estava pausada por regra de confiabilidade
 * (D-036). Os eventos históricos permanecem — apenas o pause é
 * removido. Nova reserva volta a aparecer em `/agendar`.
 *
 * Body JSON:
 *   {
 *     "notes"?: string    // contexto da reativação (ex: "conversamos e
 *                         //  bloqueio era ferramenta que travava")
 *   }
 *
 * Não dispensa eventos sozinho. Se admin quiser zerar o contador, tem
 * endpoint separado `POST /api/admin/reliability/events/[id]/dismiss`
 * que precisa ser chamado pra cada evento — força decisão caso-a-caso.
 */

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { unpauseDoctor } from "@/lib/reliability";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  getAuditContextFromRequest,
  logAdminAction,
} from "@/lib/admin-audit-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  notes?: string;
};

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  const { id } = await params;

  let body: Body = {};
  try {
    const parsed = (await req.json()) as Body | null;
    if (parsed && typeof parsed === "object") body = parsed;
  } catch {
    // body vazio é aceitável
  }

  const result = await unpauseDoctor({
    doctorId: id,
    unpausedBy: admin.id,
    notes: body.notes ?? null,
  });

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, code: result.code, error: result.message },
      { status: result.code === "doctor_not_found" ? 404 : 500 }
    );
  }

  if (result.wasPaused) {
    await logAdminAction(getSupabaseAdmin(), {
      actorUserId: admin.id,
      actorEmail: admin.email,
      action: "doctor.reliability_unpause",
      entityType: "doctor",
      entityId: id,
      metadata: {
        ...getAuditContextFromRequest(req),
        notes: body.notes ?? null,
      },
    });
  }

  return NextResponse.json({
    ok: true,
    doctor_id: result.doctorId,
    was_paused: result.wasPaused,
  });
}
