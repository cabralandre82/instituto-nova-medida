/**
 * POST /api/paciente/meus-dados/anonymize-request — PR-017 · Onda 2A · D-051
 *
 * Self-service do direito de anonimização (LGPD Art. 18, IV e VI).
 * Não executa a anonimização direto: cria um pedido `pending` em
 * `lgpd_requests` que o operador admin triaga na inbox.
 *
 * Motivo pra não auto-executar:
 *
 *   1. Anonimização é **irreversível**. Exige revisão humana mínima
 *      (paciente com fulfillment ativo, pagamento em disputa, etc.).
 *
 *   2. Direito previsto na LGPD tem prazo de até 15 dias (Art. 19
 *      §1º); não é resposta imediata — é resposta dentro de SLA. O
 *      pedido fica registrado pra que o operador cumpra o prazo.
 *
 *   3. Se admin quiser automatizar no futuro, este endpoint não
 *      muda — apenas o cron que processa pending será mais agressivo.
 *
 * Body (opcional):
 *   { "confirm": "solicito" }  — evita POST acidental por ferramentas
 *
 * Responses:
 *   201 { ok: true, requestId, alreadyPending: false }
 *   200 { ok: true, requestId, alreadyPending: true }   (já havia pedido pendente)
 *   400 { ok: false, error: "confirmation_required" }
 *   404 { ok: false, error: "customer_not_found" }
 *   409 { ok: false, error: "customer_anonymized" }
 *   500 { ok: false, error: "insert_failed" }
 */

import { NextResponse } from "next/server";
import { requirePatient } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { createAnonymizeRequest } from "@/lib/patient-lgpd-requests";
import { getAuditContextFromRequest } from "@/lib/admin-audit-log";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/paciente/meus-dados/anonymize-request" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  confirm?: string;
};

export async function POST(req: Request) {
  const { customerId } = await requirePatient();
  const body = (await req.json().catch(() => ({}))) as Body;

  if ((body.confirm ?? "").trim().toLowerCase() !== "solicito") {
    return NextResponse.json(
      {
        ok: false,
        error: "confirmation_required",
        message:
          'Envie {"confirm":"solicito"} no body pra confirmar a solicitação.',
      },
      { status: 400 }
    );
  }

  try {
    const supabase = getSupabaseAdmin();
    const ctx = getAuditContextFromRequest(req);
    const res = await createAnonymizeRequest(supabase, {
      customerId,
      ip: typeof ctx.ip === "string" ? ctx.ip : null,
      userAgent: typeof ctx.userAgent === "string" ? ctx.userAgent : null,
    });

    if (!res.ok) {
      const status =
        res.code === "customer_not_found"
          ? 404
          : res.code === "customer_anonymized"
          ? 409
          : 500;
      return NextResponse.json(
        { ok: false, error: res.code, message: res.message },
        { status }
      );
    }

    return NextResponse.json(
      {
        ok: true,
        requestId: res.requestId,
        alreadyPending: res.alreadyPending,
      },
      { status: res.created ? 201 : 200 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown_error";
    log.error("failed", { err });
    return NextResponse.json(
      { ok: false, error: "internal_error", message },
      { status: 500 }
    );
  }
}
