/**
 * POST /api/paciente/fulfillments/[id]/confirm-delivery — D-044 · 2.F
 *
 * O paciente confirma que recebeu a caixa. Transiciona o fulfillment
 * `shipped → delivered`. Usa a lib pura `transitionFulfillment` com
 * `actor: 'patient'` — a própria lib só aceita `delivered` pra esse
 * ator, então o endpoint fica focado em:
 *
 *   1. `requirePatient()` — autenticação + `customerId`.
 *   2. Ownership check explícito: carregar o fulfillment, comparar
 *      `customer_id` com o `customerId` da sessão. Retorna 403 em
 *      caso de mismatch (não 404 — evita enumerar IDs).
 *   3. Transição via lib.
 *   4. Best-effort: WhatsApp de "entrega confirmada" ao próprio
 *      paciente pra fechar o ciclo com as instruções de uso.
 *
 * Idempotente: duplo-clique → 200 com `alreadyAtTarget=true` e sem
 * notificação duplicada. Falhas de WA não regridem a transição.
 */

import { NextResponse } from "next/server";
import { requirePatient } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { transitionFulfillment } from "@/lib/fulfillment-transitions";
import { composeDeliveredMessage } from "@/lib/fulfillment-messages";
import { sendText } from "@/lib/whatsapp";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/paciente/fulfillments/[id]/confirm-delivery" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: RouteParams) {
  const { id: fulfillmentId } = await params;
  const { user, customerId } = await requirePatient();

  const supabase = getSupabaseAdmin();

  // 1) Ownership check — DEFESA CRÍTICA. `requirePatient` só confirma
  //    que o usuário é paciente; ele pode estar tentando confirmar o
  //    fulfillment de OUTRO paciente. Sem esse check, qualquer paciente
  //    autenticado poderia marcar entregas alheias como delivered.
  const ownRes = await supabase
    .from("fulfillments")
    .select("id, customer_id")
    .eq("id", fulfillmentId)
    .maybeSingle();

  if (ownRes.error) {
    log.error("ownership check", { err: ownRes.error, fulfillment_id: fulfillmentId });
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
      {
        ok: false,
        error: "not_found",
        message: "Pedido não encontrado.",
      },
      { status: 404 }
    );
  }

  if ((ownRes.data as { customer_id: string }).customer_id !== customerId) {
    // 403 em vez de 404 pra não virar oracle de IDs.
    return NextResponse.json(
      {
        ok: false,
        error: "forbidden",
        message: "Este pedido não pertence à sua conta.",
      },
      { status: 403 }
    );
  }

  // 2) Transição (idempotente, regras de ator defendem em profundidade)
  const result = await transitionFulfillment(supabase, {
    fulfillmentId,
    to: "delivered",
    actor: "patient",
    actorUserId: user.id,
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

  // 3) WhatsApp best-effort (só se a transição realmente aconteceu)
  let notificationSent = false;
  if (!result.alreadyAtTarget) {
    const ctxRes = await supabase
      .from("fulfillments_operational")
      .select("customer_name, customer_phone, plan_name")
      .eq("fulfillment_id", fulfillmentId)
      .maybeSingle();

    if (ctxRes.error) {
      log.error("ctx load", { err: ctxRes.error, fulfillment_id: fulfillmentId });
    } else if (ctxRes.data) {
      const ctx = ctxRes.data as {
        customer_name: string;
        customer_phone: string | null;
        plan_name: string;
      };
      if (ctx.customer_phone) {
        try {
          const waRes = await sendText({
            to: ctx.customer_phone,
            text: composeDeliveredMessage({
              customerName: ctx.customer_name,
              planName: ctx.plan_name,
            }),
          });
          if (waRes.ok) {
            notificationSent = true;
          } else {
            log.warn("WA falhou", {
              fulfillment_id: fulfillmentId,
              error: waRes.message,
            });
          }
        } catch (e) {
          log.error("WA exception", { err: e, fulfillment_id: fulfillmentId });
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
