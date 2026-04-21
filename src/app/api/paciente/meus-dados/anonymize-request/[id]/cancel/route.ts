/**
 * POST /api/paciente/meus-dados/anonymize-request/[id]/cancel
 * — PR-017 · Onda 2A · D-051
 *
 * Permite ao paciente desistir de uma solicitação de anonimização
 * enquanto ela ainda está `pending`. Evita que "cliquei sem querer"
 * vire problema irreversível.
 *
 * A autorização é dupla:
 *   1. `requirePatient()` garante sessão válida + customerId linkado.
 *   2. `cancelLgpdRequest` só cancela se o request pertence a esse
 *      mesmo customerId (e só se `status='pending'`).
 */

import { NextResponse } from "next/server";
import { requirePatient } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { cancelLgpdRequest } from "@/lib/patient-lgpd-requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { customerId } = await requirePatient();
  const { id } = await params;

  try {
    const supabase = getSupabaseAdmin();
    const res = await cancelLgpdRequest(supabase, {
      requestId: id,
      customerId,
    });
    if (!res.ok) {
      const status =
        res.code === "not_found"
          ? 404
          : res.code === "not_pending"
          ? 409
          : 500;
      return NextResponse.json(
        { ok: false, error: res.code, message: res.message },
        { status }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown_error";
    console.error(
      "[paciente/meus-dados/anonymize-request/cancel] failed",
      err
    );
    return NextResponse.json(
      { ok: false, error: "internal_error", message },
      { status: 500 }
    );
  }
}
