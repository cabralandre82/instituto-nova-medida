/**
 * POST /api/admin/reliability/events/[id]/dismiss
 *
 * Dispensa um evento de confiabilidade individual (D-036) — ex:
 * admin determinou que o no-show foi por bug técnico comprovado, não
 * culpa da médica. Eventos dispensados não contam pro threshold de
 * auto-pause.
 *
 * Isso é separado do unpause — admin pode dispensar eventos sem
 * reativar a médica (ou o contrário), respeitando decisões caso-a-caso.
 *
 * Body JSON:
 *   {
 *     "reason": string    // obrigatório — justificativa é auditada
 *   }
 */

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { dismissEvent } from "@/lib/reliability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { reason?: string };

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
    // body vazio — exigimos reason explícito
  }

  const reason = (body.reason ?? "").trim();
  if (!reason || reason.length < 4) {
    return NextResponse.json(
      {
        ok: false,
        code: "reason_required",
        error: "Informe o motivo da dispensa (mín. 4 caracteres).",
      },
      { status: 400 }
    );
  }

  const result = await dismissEvent({
    eventId: id,
    dismissedBy: admin.id,
    reason,
  });

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, code: result.code, error: result.message },
      { status: result.code === "event_not_found" ? 404 : 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    event_id: result.eventId,
    already_dismissed: result.alreadyDismissed,
  });
}
