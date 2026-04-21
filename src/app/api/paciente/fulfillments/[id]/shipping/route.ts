/**
 * PUT /api/paciente/fulfillments/[id]/shipping — D-045 · 3.E
 *
 * Paciente atualiza o endereço operacional do fulfillment entre
 * `paid` e `pharmacy_requested`. Antes de `paid`, endereço é coletado
 * no aceite; depois de `pharmacy_requested`, etiqueta já foi gerada.
 *
 * Fluxo:
 *   1. `requirePatient()` → auth + customerId.
 *   2. Ownership check (404/403).
 *   3. Carrega `customers.name` pra `recipientFallback`.
 *   4. `updateFulfillmentShipping()` — valida, atualiza fulfillments,
 *      loga em `fulfillment_address_changes`.
 *   5. WA best-effort confirmando a mudança.
 *
 * Idempotente: reenviar o mesmo endereço → `ok: true, noChanges: true`
 * sem duplicar update (mas ainda grava audit — bom pra rastrear
 * ansiedade).
 */

import { NextResponse } from "next/server";
import { requirePatient } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { updateFulfillmentShipping } from "@/lib/patient-update-shipping";
import { composeShippingUpdatedMessage } from "@/lib/fulfillment-messages";
import { sendText } from "@/lib/whatsapp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

function pickString(
  source: Record<string, unknown> | null | undefined,
  key: string
): string {
  if (!source) return "";
  const v = source[key];
  return typeof v === "string" ? v : "";
}

export async function PUT(req: Request, { params }: RouteParams) {
  const { id: fulfillmentId } = await params;
  const { user, customerId } = await requirePatient();

  const body = (await req.json().catch(() => null)) as {
    shipping?: Record<string, unknown>;
  } | null;
  const shippingRaw = body?.shipping ?? null;

  if (!shippingRaw) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_payload",
        message: "Corpo inválido: `shipping` é obrigatório.",
      },
      { status: 400 }
    );
  }

  const supabase = getSupabaseAdmin();

  // Ownership check (explícito, antes de tocar em lógica de negócio)
  const ownRes = await supabase
    .from("fulfillments")
    .select("id, customer_id")
    .eq("id", fulfillmentId)
    .maybeSingle();

  if (ownRes.error) {
    console.error("[paciente/shipping] ownership check:", ownRes.error);
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

  // Carrega nome do customer pra recipientFallback
  const custRes = await supabase
    .from("customers")
    .select("name")
    .eq("id", customerId)
    .maybeSingle();

  if (custRes.error || !custRes.data) {
    console.error(
      "[paciente/shipping] customer load:",
      custRes.error?.message
    );
    return NextResponse.json(
      {
        ok: false,
        error: "db_error",
        message: "Não conseguimos carregar seus dados. Tente novamente.",
      },
      { status: 500 }
    );
  }
  const recipientFallback = (custRes.data as { name: string }).name;

  const address = {
    recipient_name: pickString(shippingRaw, "recipient_name") || null,
    zipcode: pickString(shippingRaw, "zipcode"),
    street: pickString(shippingRaw, "street"),
    number: pickString(shippingRaw, "number"),
    complement: pickString(shippingRaw, "complement") || null,
    district: pickString(shippingRaw, "district"),
    city: pickString(shippingRaw, "city"),
    state: pickString(shippingRaw, "state"),
  };

  const result = await updateFulfillmentShipping(supabase, {
    fulfillmentId,
    customerId,
    actorUserId: user.id,
    source: "patient",
    address,
    recipientFallback,
  });

  if (!result.ok) {
    const statusByCode: Record<typeof result.code, number> = {
      not_found: 404,
      invalid_status: 409,
      invalid_payload: 400,
      db_error: 500,
    };
    return NextResponse.json(
      {
        ok: false,
        error: result.code,
        message: result.message,
        currentStatus: result.currentStatus ?? null,
        fieldErrors: result.fieldErrors ?? null,
      },
      { status: statusByCode[result.code] ?? 500 }
    );
  }

  // WA best-effort — só se houve mudança real
  let notificationSent = false;
  if (!result.noChanges) {
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
            text: composeShippingUpdatedMessage({
              customerName: ctx.customer_name,
              planName: ctx.plan_name,
              cityState: `${result.snapshot.shipping_city}/${result.snapshot.shipping_state}`,
            }),
          });
          if (waRes.ok) notificationSent = true;
        } catch (e) {
          console.error("[paciente/shipping] WA exception:", e);
        }
      }
    }
  }

  return NextResponse.json({
    ok: true,
    noChanges: result.noChanges,
    auditId: result.auditId,
    notificationSent,
  });
}
