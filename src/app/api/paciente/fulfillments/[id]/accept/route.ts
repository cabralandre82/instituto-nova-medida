/**
 * POST /api/paciente/fulfillments/[id]/accept — D-044 · 2.C.2
 *
 * O paciente aceita formalmente o plano indicado pela médica e
 * informa endereço de entrega. Em sequência:
 *
 *   1. `acceptFulfillment` registra o aceite imutável em
 *      `plan_acceptances` (com hash do texto + endereço + prescrição
 *      + plano) e move o fulfillment pra `pending_payment`.
 *   2. `ensurePaymentForFulfillment` cria (ou reutiliza) a cobrança
 *      Asaas vinculada e devolve `invoice_url` pro front redirecionar.
 *
 * Ambas as funções são idempotentes, então clicar 2x em "Aceito"
 * resulta no mesmo aceite + mesma invoice.
 *
 * Auth: `requirePatient()`. Ownership extra é validado pela lib —
 * `customerId` do paciente autenticado é cruzado com o
 * `customer_id` do fulfillment.
 */

import { NextResponse } from "next/server";
import { requirePatient } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { acceptFulfillment } from "@/lib/fulfillment-acceptance";
import { ensurePaymentForFulfillment } from "@/lib/fulfillment-payment";
import type { AddressInput } from "@/lib/patient-address";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Body aceito. PR-011 / audit [6.1]:
 *   - `acceptance_text` foi **removido** do contrato público. O texto é
 *     re-renderizado server-side; qualquer string enviada é ignorada.
 *   - `terms_version` é opcional; se omitida usamos a vigente.
 */
type Body = {
  terms_version?: unknown;
  address?: unknown;
};

type RouteParams = { params: Promise<{ id: string }> };

function parseAddress(raw: unknown): AddressInput | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const get = (k: string): string =>
    typeof a[k] === "string" ? (a[k] as string) : "";
  const getOpt = (k: string): string | null =>
    typeof a[k] === "string" ? (a[k] as string) : null;

  return {
    recipient_name: getOpt("recipient_name"),
    zipcode: get("zipcode"),
    street: get("street"),
    number: get("number"),
    complement: getOpt("complement"),
    district: get("district"),
    city: get("city"),
    state: get("state"),
  };
}

export async function POST(req: Request, { params }: RouteParams) {
  const { id: fulfillmentId } = await params;
  const { user, customerId } = await requirePatient();

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_json", message: "JSON inválido." },
      { status: 400 }
    );
  }

  const termsVersion =
    typeof body.terms_version === "string" ? body.terms_version : undefined;
  const address = parseAddress(body.address);

  if (!address) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_payload",
        message: "Endereço não informado corretamente.",
      },
      { status: 400 }
    );
  }

  const supabase = getSupabaseAdmin();

  // Extração de IP e user-agent (entram no registro legal)
  const userAgent = req.headers.get("user-agent");
  const ipAddress =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    null;

  // 1) aceite
  const acc = await acceptFulfillment(supabase, {
    fulfillmentId,
    userId: user.id,
    customerId,
    input: {
      terms_version: termsVersion,
      address,
      user_agent: userAgent,
      ip_address: ipAddress,
    },
  });

  if (!acc.ok) {
    const statusByCode: Record<typeof acc.code, number> = {
      not_found: 404,
      forbidden: 403,
      invalid_state: 409,
      invalid_address: 400,
      invalid_payload: 400,
      db_error: 500,
    };
    return NextResponse.json(
      {
        ok: false,
        error: acc.code,
        message: acc.message,
        addressErrors: acc.addressErrors,
      },
      { status: statusByCode[acc.code] ?? 500 }
    );
  }

  // 2) pagamento (idempotente)
  const pay = await ensurePaymentForFulfillment(supabase, acc.fulfillmentId);

  if (!pay.ok) {
    // Aceite já foi gravado (imutável). O front consegue retentar
    // só o "gerar pagamento" sem re-aceitar.
    const statusByCode: Record<typeof pay.code, number> = {
      not_found: 404,
      invalid_state: 409,
      asaas_customer_error: 502,
      asaas_payment_error: 502,
      db_error: 500,
    };
    return NextResponse.json(
      {
        ok: false,
        error: pay.code,
        message: pay.message,
        details: pay.details,
        acceptanceId: acc.acceptanceId,
        fulfillmentStatus: acc.fulfillmentStatus,
      },
      { status: statusByCode[pay.code] ?? 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    fulfillmentId: acc.fulfillmentId,
    acceptanceId: acc.acceptanceId,
    alreadyAccepted: acc.alreadyAccepted,
    invoiceUrl: pay.invoiceUrl,
    paymentId: pay.paymentId,
    amountCents: pay.amountCents,
  });
}
