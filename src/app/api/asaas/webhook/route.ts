import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { isWebhookTokenValid, type AsaasWebhookEvent } from "@/lib/asaas";
import { createConsultationEarning, createClawback } from "@/lib/earnings";
import { activateAppointmentAfterPayment } from "@/lib/scheduling";
import { provisionConsultationRoom } from "@/lib/video";
import {
  enqueueImmediate,
  scheduleRemindersForAppointment,
} from "@/lib/notifications";
import { markRefundProcessed } from "@/lib/refunds";

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

      const { data: updatedPayment, error: updateErr } = await supabase
        .from("payments")
        .update(updates)
        .eq("asaas_payment_id", asaasPaymentId)
        .select("id")
        .maybeSingle();

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

        // === Geração de earnings para a médica vinculada ===
        // Se a payment tem appointment_id, criamos earning(s) ao receber
        // o pagamento, e clawback ao receber estorno.
        const internalPaymentId = updatedPayment?.id as string | undefined;
        if (internalPaymentId) {
          await handleEarningsLifecycle(
            supabase,
            body.event,
            payment.status,
            internalPaymentId,
            asaasPaymentId
          );
        }
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

// ────────────────────────────────────────────────────────────────────
// Helpers internos
// ────────────────────────────────────────────────────────────────────

/**
 * Roteador de eventos Asaas → criação/cancelamento de earnings.
 * Tudo silencioso por design: erros são logados mas não bloqueiam o
 * webhook (200 sempre).
 */
async function handleEarningsLifecycle(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  event: string,
  paymentStatus: string,
  internalPaymentId: string,
  asaasPaymentId: string | null
): Promise<void> {
  // Busca appointment vinculado ao payment (se houver)
  const { data: appt } = await supabase
    .from("appointments")
    .select(
      "id, doctor_id, kind, customer_id, status, scheduled_at, recording_consent, video_room_url, video_patient_token, refund_required, refund_processed_at, customers ( name )"
    )
    .eq("payment_id", internalPaymentId)
    .maybeSingle();

  // Sem appointment → payment de plano genérico, sem earning de
  // consulta direta. Sair silenciosamente.
  if (!appt) return;

  const isReceived =
    event === "PAYMENT_RECEIVED" ||
    event === "PAYMENT_CONFIRMED" ||
    event === "PAYMENT_RECEIVED_IN_CASH" ||
    paymentStatus === "RECEIVED" ||
    paymentStatus === "CONFIRMED" ||
    paymentStatus === "RECEIVED_IN_CASH";

  const isReversed =
    event === "PAYMENT_REFUNDED" ||
    event === "PAYMENT_REFUND_IN_PROGRESS" ||
    event === "PAYMENT_CHARGEBACK_REQUESTED" ||
    event === "PAYMENT_CHARGEBACK_DISPUTE" ||
    paymentStatus === "REFUNDED" ||
    paymentStatus === "CHARGEBACK_REQUESTED";

  if (isReceived) {
    // 1) Ativa appointment se ainda estiver em pending_payment
    const activation = await activateAppointmentAfterPayment(
      appt.id as string,
      internalPaymentId
    );
    if (!activation.ok) {
      console.error("[asaas-webhook] activate falhou:", activation.error);
    } else if (activation.wasActivated) {
      console.log("[asaas-webhook] appointment ativado:", appt.id);
    }

    // 2) Provisiona sala Daily (best-effort, idempotente)
    const alreadyHasRoom = Boolean(
      (appt as { video_room_url?: string | null }).video_room_url
    );
    if (!alreadyHasRoom && process.env.DAILY_API_KEY && process.env.DAILY_DOMAIN) {
      try {
        const customerName =
          (appt as { customers?: { name?: string } }).customers?.name ?? "Paciente";
        // Carrega doctor display_name + consultation_minutes
        const { data: doctorRow } = await supabase
          .from("doctors")
          .select("full_name, display_name, consultation_minutes")
          .eq("id", appt.doctor_id as string)
          .maybeSingle();

        const doctorName =
          doctorRow?.display_name || doctorRow?.full_name || "Médica";
        const durationMinutes = doctorRow?.consultation_minutes ?? 30;

        const { room, tokens } = await provisionConsultationRoom({
          appointmentId: appt.id as string,
          scheduledAt: new Date(appt.scheduled_at as string),
          durationMinutes,
          patientName: customerName,
          doctorName,
          recordingConsent: Boolean(appt.recording_consent),
        });

        await supabase
          .from("appointments")
          .update({
            video_provider: "daily",
            video_room_name: room.name,
            video_room_url: room.url,
            video_doctor_token: tokens.doctorToken,
            video_patient_token: tokens.patientToken,
            daily_room_id: room.providerId,
            daily_raw: room.raw as unknown as Record<string, unknown>,
          })
          .eq("id", appt.id as string);

        console.log(
          "[asaas-webhook] sala Daily provisionada:",
          room.name,
          "appt=",
          appt.id
        );
      } catch (e) {
        // Não bloqueia o webhook — admin pode reprovisionar via UI/API depois.
        console.error("[asaas-webhook] provisionConsultationRoom falhou:", e);
      }
    }

    // 3) Cria earning pra médica
    const customerName =
      (appt as { customers?: { name?: string } }).customers?.name ?? "paciente";
    const result = await createConsultationEarning(supabase, {
      paymentId: internalPaymentId,
      doctorId: appt.doctor_id as string,
      appointmentId: appt.id as string,
      appointmentKind: (appt.kind as "scheduled" | "on_demand" | undefined) ?? "scheduled",
      description: `Consulta · ${customerName}`,
    });
    if (!result.ok) {
      console.error("[asaas-webhook] earning falhou:", result.error);
    } else if (result.created) {
      console.log("[asaas-webhook] earning criado:", result.earningId);
    }

    // 4) Enfileira notificações WhatsApp (D-031).
    //    - Confirmação imediata (disparo em ~1 min pelo cron wa-reminders).
    //    - 4 lembretes temporais agendados pro futuro (T-24h, T-1h, T-15min, T+10min).
    //    Todos idempotentes — webhook Asaas pode chegar em duplicata sem efeito colateral.
    try {
      const immediateId = await enqueueImmediate(appt.id as string, "confirmacao");
      const reminders = await scheduleRemindersForAppointment(appt.id as string);
      console.log(
        "[asaas-webhook] notificações enfileiradas:",
        JSON.stringify({
          appointment_id: appt.id,
          confirmacao_id: immediateId,
          reminders: reminders.scheduled,
        })
      );
    } catch (e) {
      console.error("[asaas-webhook] enqueue notifications falhou:", e);
    }
    return;
  }

  if (isReversed) {
    const reason =
      event === "PAYMENT_CHARGEBACK_REQUESTED" || event === "PAYMENT_CHARGEBACK_DISPUTE"
        ? "Chargeback"
        : "Estorno";
    const result = await createClawback(supabase, {
      paymentId: internalPaymentId,
      doctorId: appt.doctor_id as string,
      reason,
    });
    if (!result.ok) {
      console.error("[asaas-webhook] clawback falhou:", result.error);
    } else if (result.clawbacks > 0) {
      console.log("[asaas-webhook] clawbacks criados:", result.clawbacks);
    }

    // ── Dedupe de refund processed (D-034) ────────────────────────
    // Quando o webhook chega pra um appointment que a política de
    // no-show marcou como `refund_required=true` mas que ainda não
    // foi processado, fechamos o ciclo automaticamente. Três casos
    // possíveis cobertos:
    //
    //   1. Admin clicou "Estornar no Asaas" na nossa UI → nossa API
    //      já marcou refund_processed_at ANTES deste webhook chegar.
    //      `markRefundProcessed` retorna alreadyProcessed=true, noop.
    //
    //   2. Admin abriu o painel Asaas e estornou por lá sem usar a
    //      nossa UI. Este webhook é a única forma do sistema saber.
    //      Marcamos agora com processedBy=null (assinatura do webhook).
    //
    //   3. Paciente abriu chargeback direto na operadora do cartão.
    //      Mesmo tratamento do caso 2 — é estorno igual, mesmo motivo.
    //
    // Rodar apenas em PAYMENT_REFUNDED (estorno efetivamente concluído).
    // PAYMENT_REFUND_IN_PROGRESS é transiente — esperamos o final.
    const apptRefundFlagged =
      (appt as { refund_required?: boolean }).refund_required === true;
    const apptNotProcessed =
      (appt as { refund_processed_at?: string | null })
        .refund_processed_at == null;
    const isFinalRefund =
      event === "PAYMENT_REFUNDED" || paymentStatus === "REFUNDED";

    if (apptRefundFlagged && apptNotProcessed && isFinalRefund) {
      const markResult = await markRefundProcessed({
        appointmentId: appt.id as string,
        method: "asaas_api",
        externalRef: asaasPaymentId,
        notes:
          event === "PAYMENT_CHARGEBACK_REQUESTED" ||
          event === "PAYMENT_CHARGEBACK_DISPUTE"
            ? "Fechado via webhook — chargeback do paciente."
            : "Fechado via webhook — estorno concluído no Asaas.",
        processedBy: null, // null = sem admin humano direto nesta ação
      });
      if (!markResult.ok) {
        console.error(
          "[asaas-webhook] markRefundProcessed via webhook falhou:",
          markResult
        );
      } else {
        console.log("[asaas-webhook] refund marcado via webhook:", {
          appointment_id: appt.id,
          already: markResult.alreadyProcessed,
        });
      }
    }
  }
}
