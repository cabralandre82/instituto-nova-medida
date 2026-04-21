/**
 * POST /api/paciente/fulfillments/[id]/cancel — D-045 · 3.E
 *
 * Paciente cancela oferta antes de pagar (status `pending_acceptance`
 * ou `pending_payment`). Depois do pagamento, cancelamento envolve
 * refund e passa pelo admin — a própria `transitionFulfillment` barra.
 *
 * Fluxo:
 *   1. `requirePatient()` → auth + customerId.
 *   2. Ownership check explícito (403 em mismatch, 404 em not found).
 *   3. `transitionFulfillment({ actor: 'patient', to: 'cancelled' })`
 *      — com `cancelled_reason` padronizado prefixado "Paciente: …".
 *   4. WA best-effort ao paciente confirmando.
 */

import { NextResponse } from "next/server";
import { requirePatient } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { transitionFulfillment } from "@/lib/fulfillment-transitions";
import { composePatientCancelledMessage } from "@/lib/fulfillment-messages";
import { sendText } from "@/lib/whatsapp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

/** Sanitiza e trunca o motivo livre do paciente (opcional). */
function sanitizeReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const clean = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (clean.length === 0) return null;
  return clean.slice(0, 280);
}

export async function POST(req: Request, { params }: RouteParams) {
  const { id: fulfillmentId } = await params;
  const { user, customerId } = await requirePatient();

  const body = (await req.json().catch(() => null)) as {
    reason?: unknown;
  } | null;
  const patientReason = sanitizeReason(body?.reason);

  const supabase = getSupabaseAdmin();

  // Ownership check — mesmo padrão do confirm-delivery
  const ownRes = await supabase
    .from("fulfillments")
    .select("id, customer_id, status")
    .eq("id", fulfillmentId)
    .maybeSingle();

  if (ownRes.error) {
    console.error("[paciente/cancel] ownership check:", ownRes.error);
    return NextResponse.json(
      {
        ok: false,
        error: "db_error",
        message: "Erro ao validar o pedido. Tente novamente.",
      },
      { status: 500 }
    );
  }
  if (!ownRes.data) {
    return NextResponse.json(
      { ok: false, error: "not_found", message: "Pedido não encontrado." },
      { status: 404 }
    );
  }
  if ((ownRes.data as { customer_id: string }).customer_id !== customerId) {
    return NextResponse.json(
      {
        ok: false,
        error: "forbidden",
        message: "Este pedido não pertence à sua conta.",
      },
      { status: 403 }
    );
  }

  // Compõe motivo com prefixo rastreável
  const cancelledReason = patientReason
    ? `Paciente cancelou: ${patientReason}`
    : "Paciente cancelou a indicação antes de pagar.";

  const result = await transitionFulfillment(supabase, {
    fulfillmentId,
    to: "cancelled",
    actor: "patient",
    actorUserId: user.id,
    cancelledReason,
  });

  if (!result.ok) {
    const statusByCode: Record<typeof result.code, number> = {
      not_found: 404,
      invalid_transition: 409,
      invalid_payload: 400,
      forbidden_actor: 403,
      db_error: 500,
    };
    return NextResponse.json(
      {
        ok: false,
        error: result.code,
        message: result.message,
        currentStatus: result.currentStatus ?? null,
      },
      { status: statusByCode[result.code] ?? 500 }
    );
  }

  // WA best-effort (só se a transição realmente aconteceu)
  let notificationSent = false;
  if (!result.alreadyAtTarget) {
    const ctxRes = await supabase
      .from("fulfillments_operational")
      .select("customer_name, customer_phone, plan_name")
      .eq("fulfillment_id", fulfillmentId)
      .maybeSingle();

    if (ctxRes.data) {
      const ctx = ctxRes.data as {
        customer_name: string;
        customer_phone: string | null;
        plan_name: string;
      };
      if (ctx.customer_phone) {
        try {
          const waRes = await sendText({
            to: ctx.customer_phone,
            text: composePatientCancelledMessage({
              customerName: ctx.customer_name,
              planName: ctx.plan_name,
              reason: patientReason,
            }),
          });
          if (waRes.ok) {
            notificationSent = true;
          } else {
            console.warn("[paciente/cancel] WA falhou:", waRes.message);
          }
        } catch (e) {
          console.error("[paciente/cancel] WA exception:", e);
        }
      }
    }
  }

  return NextResponse.json({
    ok: true,
    from: result.from,
    to: result.to,
    alreadyAtTarget: result.alreadyAtTarget,
    notificationSent,
  });
}
