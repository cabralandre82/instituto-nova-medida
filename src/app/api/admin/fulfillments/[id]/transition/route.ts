/**
 * POST /api/admin/fulfillments/[id]/transition — D-044 · 2.E
 *
 * Endpoint único para as transições operacionais do fulfillment:
 *
 *   - paid              → pharmacy_requested
 *   - pharmacy_requested → shipped           (requer tracking_note)
 *   - shipped           → delivered
 *   - não-terminal      → cancelled          (requer cancelled_reason)
 *
 * Body JSON:
 *   {
 *     "to": "pharmacy_requested" | "shipped" | "delivered" | "cancelled",
 *     "tracking_note"?: string,    // só pra shipped
 *     "cancelled_reason"?: string  // só pra cancelled
 *   }
 *
 * Depois da transição ocorrer no banco, dispara WhatsApp best-effort
 * com a mensagem composta correspondente (janela de 24h presumida
 * aberta pelo fluxo de aceite/pagamento). Falha no WhatsApp NÃO
 * regride a transição — só loga.
 *
 * Idempotência: clicar 2x no mesmo botão retorna 200 com
 * `alreadyAtTarget=true`. Webhook concorrente não duplica ações.
 */

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  transitionFulfillment,
  type TransitionInput,
} from "@/lib/fulfillment-transitions";
import type { FulfillmentStatus } from "@/lib/fulfillments";
import {
  composeCancelledMessage,
  composeDeliveredMessage,
  composePharmacyRequestedMessage,
  composeShippedMessage,
} from "@/lib/fulfillment-messages";
import { sendText } from "@/lib/whatsapp";
import {
  getAuditContextFromRequest,
  logAdminAction,
} from "@/lib/admin-audit-log";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/admin/fulfillments/[id]/transition" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  to?: unknown;
  tracking_note?: unknown;
  cancelled_reason?: unknown;
};

type RouteParams = { params: Promise<{ id: string }> };

const ALLOWED_TARGETS: readonly FulfillmentStatus[] = [
  "pharmacy_requested",
  "shipped",
  "delivered",
  "cancelled",
] as const;

function asString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export async function POST(req: Request, { params }: RouteParams) {
  const { id: fulfillmentId } = await params;
  const admin = await requireAdmin();

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_json", message: "JSON inválido." },
      { status: 400 }
    );
  }

  const to = asString(body.to) as FulfillmentStatus | null;
  if (!to || !ALLOWED_TARGETS.includes(to)) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_payload",
        message: "Destino de transição inválido.",
      },
      { status: 400 }
    );
  }

  const input: TransitionInput = {
    fulfillmentId,
    to,
    actor: "admin",
    actorUserId: admin.id,
    trackingNote: asString(body.tracking_note),
    cancelledReason: asString(body.cancelled_reason),
  };

  const supabase = getSupabaseAdmin();
  const result = await transitionFulfillment(supabase, input);

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

  // Se nada de fato mudou, economizamos WhatsApp.
  if (result.alreadyAtTarget) {
    return NextResponse.json({
      ok: true,
      from: result.from,
      to: result.to,
      alreadyAtTarget: true,
      notificationSent: false,
    });
  }

  // PR-031: registra a ação na trilha de auditoria (best-effort).
  // Captura a transição mesmo antes do WhatsApp pra que o rastro
  // exista se a notificação causar exceção logo depois.
  await logAdminAction(supabase, {
    actorUserId: admin.id,
    actorEmail: admin.email,
    action: "fulfillment.transition",
    entityType: "fulfillment",
    entityId: fulfillmentId,
    before: { status: result.from },
    after: { status: result.to },
    metadata: {
      ...getAuditContextFromRequest(req),
      trackingNote: input.trackingNote,
      cancelledReason: input.cancelledReason,
    },
  });

  // Carrega dados pra WA (customer nome/phone + plan nome)
  const ctxRes = await supabase
    .from("fulfillments_operational")
    .select("customer_name, customer_phone, plan_name, tracking_note")
    .eq("fulfillment_id", fulfillmentId)
    .maybeSingle();

  let notificationSent = false;
  if (ctxRes.error) {
    log.error("ctx load", { err: ctxRes.error, fulfillment_id: fulfillmentId });
  } else if (ctxRes.data) {
    const ctx = ctxRes.data as {
      customer_name: string;
      customer_phone: string | null;
      plan_name: string;
      tracking_note: string | null;
    };

    let message: string | null = null;
    switch (to) {
      case "pharmacy_requested":
        message = composePharmacyRequestedMessage({
          customerName: ctx.customer_name,
          planName: ctx.plan_name,
        });
        break;
      case "shipped":
        message = composeShippedMessage({
          customerName: ctx.customer_name,
          planName: ctx.plan_name,
          trackingNote: ctx.tracking_note ?? "",
        });
        break;
      case "delivered":
        message = composeDeliveredMessage({
          customerName: ctx.customer_name,
          planName: ctx.plan_name,
        });
        break;
      case "cancelled":
        message = composeCancelledMessage({
          customerName: ctx.customer_name,
          planName: ctx.plan_name,
          reason: input.cancelledReason ?? "Sem motivo declarado.",
        });
        break;
      default:
        message = null;
    }

    if (message && ctx.customer_phone) {
      try {
        const waRes = await sendText({
          to: ctx.customer_phone,
          text: message,
        });
        if (waRes.ok) {
          notificationSent = true;
          log.info("WA enviado", {
            fulfillment_id: fulfillmentId,
            to,
            message_id: waRes.messageId,
          });
        } else {
          log.warn("WA falhou", {
            fulfillment_id: fulfillmentId,
            to,
            error: waRes.message,
          });
        }
      } catch (e) {
        log.error("WA exception", { err: e, fulfillment_id: fulfillmentId });
      }
    }
  }

  return NextResponse.json({
    ok: true,
    from: result.from,
    to: result.to,
    alreadyAtTarget: false,
    notificationSent,
  });
}
