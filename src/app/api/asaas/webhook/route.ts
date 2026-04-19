import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { isWebhookTokenValid, type AsaasWebhookEvent } from "@/lib/asaas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Webhook do Asaas — Instituto Nova Medida.
 *
 * Eventos relevantes (https://docs.asaas.com/docs/sobre-os-webhooks):
 *
 *  - PAYMENT_CREATED        → cobrança criada (geralmente já criamos via API)
 *  - PAYMENT_UPDATED        → mudança em campos da cobrança
 *  - PAYMENT_CONFIRMED      → confirmada (cartão), aguardando compensação
 *  - PAYMENT_RECEIVED       → recebida (PIX/boleto compensados)
 *  - PAYMENT_RECEIVED_IN_CASH → recebido em dinheiro (manual)
 *  - PAYMENT_OVERDUE        → venceu sem pagamento
 *  - PAYMENT_REFUNDED       → estorno concluído
 *  - PAYMENT_REFUND_IN_PROGRESS → estorno em andamento
 *  - PAYMENT_CHARGEBACK_REQUESTED → chargeback solicitado pela bandeira
 *  - PAYMENT_DELETED        → cobrança excluída
 *
 * Filosofia (mesma do wa/webhook):
 *
 *   1. Persistir o payload BRUTO em `asaas_events` ANTES de qualquer
 *      processamento. Idempotência via `asaas_event_id`.
 *   2. Processar e atualizar `payments`. Se falhar no processamento,
 *      o evento fica com `processed_at = null` e `processing_error`
 *      preenchido pra retry manual.
 *   3. SEMPRE responder 200 rápido — o Asaas faz retry agressivo se
 *      receber 5xx ou timeout.
 *
 * Autenticação:
 *   - O Asaas envia o header `asaas-access-token` com um valor fixo
 *     que a gente configura no painel (ASAAS_WEBHOOK_TOKEN).
 *   - Validamos em tempo constante.
 */

export async function POST(req: Request) {
  // 1) Lê o corpo cru pra logar mesmo se a auth falhar
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return NextResponse.json({ ok: false, error: "Body ilegível" }, { status: 400 });
  }

  let body: AsaasWebhookEvent;
  try {
    body = JSON.parse(raw) as AsaasWebhookEvent;
  } catch {
    return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }

  const headerToken = req.headers.get("asaas-access-token");
  const signatureValid = isWebhookTokenValid(headerToken);

  // Em produção exigimos o token. Em sandbox, aceitamos mesmo sem,
  // pra facilitar testes manuais com curl.
  const env = process.env.ASAAS_ENV ?? "sandbox";
  if (env === "production" && !signatureValid) {
    console.warn("[asaas-webhook] token inválido em produção, ignorando");
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const supabase = getSupabaseAdmin();
  const asaasPaymentId = body.payment?.id ?? null;

  // 2) Persiste raw (idempotente via asaas_event_id quando presente)
  let storedEventId: string | null = null;
  try {
    const { data: stored, error: storeErr } = await supabase
      .from("asaas_events")
      .insert({
        asaas_event_id: body.id ?? null,
        event_type: body.event,
        asaas_payment_id: asaasPaymentId,
        payload: body as unknown as Record<string, unknown>,
        signature: headerToken,
        signature_valid: signatureValid,
      })
      .select("id")
      .single();

    if (storeErr) {
      // Conflict por unique(asaas_event_id) significa "já recebemos esse" — ok
      if (storeErr.code === "23505") {
        console.log("[asaas-webhook] evento duplicado, ignorando:", body.id);
        return NextResponse.json({ ok: true, duplicate: true });
      }
      console.error("[asaas-webhook] persist raw failed:", storeErr);
      // Continua mesmo assim — o handler abaixo é importante demais pra
      // bloquear por falha no log.
    } else {
      storedEventId = stored?.id ?? null;
    }
  } catch (err) {
    console.error("[asaas-webhook] persist raw exception:", err);
  }

  // 3) Processamento
  try {
    if (asaasPaymentId && body.payment) {
      const payment = body.payment;

      const updates: Record<string, unknown> = {
        status: payment.status,
        asaas_raw: payment as unknown as Record<string, unknown>,
      };

      if (payment.invoiceUrl) updates.invoice_url = payment.invoiceUrl;
      if (payment.bankSlipUrl) updates.bank_slip_url = payment.bankSlipUrl;
      if (payment.dueDate) updates.due_date = payment.dueDate;
      if (payment.billingType) updates.billing_type = payment.billingType;

      // Marca timestamp de pagamento/estorno quando aplicável
      if (
        payment.status === "RECEIVED" ||
        payment.status === "CONFIRMED" ||
        payment.status === "RECEIVED_IN_CASH"
      ) {
        updates.paid_at = new Date().toISOString();
      }
      if (
        payment.status === "REFUNDED" ||
        payment.status === "REFUND_IN_PROGRESS"
      ) {
        updates.refunded_at = new Date().toISOString();
      }

      const { error: updateErr } = await supabase
        .from("payments")
        .update(updates)
        .eq("asaas_payment_id", asaasPaymentId);

      if (updateErr) {
        console.error("[asaas-webhook] update payment falhou:", updateErr);
        if (storedEventId) {
          await supabase
            .from("asaas_events")
            .update({ processing_error: updateErr.message })
            .eq("id", storedEventId);
        }
      } else {
        console.log("[asaas-webhook] payment atualizado:", {
          asaasPaymentId,
          event: body.event,
          status: payment.status,
        });
      }
    }

    if (storedEventId) {
      await supabase
        .from("asaas_events")
        .update({ processed_at: new Date().toISOString() })
        .eq("id", storedEventId);
    }
  } catch (err) {
    console.error("[asaas-webhook] processing exception:", err);
    if (storedEventId) {
      await supabase
        .from("asaas_events")
        .update({
          processing_error:
            err instanceof Error ? err.message : String(err),
        })
        .eq("id", storedEventId);
    }
  }

  // Sempre 200 — temos o payload bruto pra reprocessar
  return NextResponse.json({ ok: true });
}

/**
 * GET pra healthcheck rápido — útil pra verificar no painel do Asaas
 * que a URL responde antes de habilitar o webhook.
 */
export function GET() {
  return NextResponse.json({
    ok: true,
    service: "instituto-nova-medida-asaas-webhook",
    env: process.env.ASAAS_ENV ?? "sandbox",
  });
}
