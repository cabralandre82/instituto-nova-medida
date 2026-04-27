import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { isWebhookTokenValid, type AsaasWebhookEvent } from "@/lib/asaas";
import { redactAsaasPayload } from "@/lib/asaas-event-redact";
import { createConsultationEarning, createClawback } from "@/lib/earnings";
import { activateAppointmentAfterPayment } from "@/lib/scheduling";
import { provisionConsultationRoom } from "@/lib/video";
import {
  enqueueImmediate,
  scheduleRemindersForAppointment,
} from "@/lib/notifications";
import {
  enqueueDoctorAppointmentReminder,
  enqueueDoctorPaid,
} from "@/lib/doctor-notifications";
import { markRefundProcessed } from "@/lib/refunds";
import {
  composePaidWhatsAppMessage,
  promoteFulfillmentAfterPayment,
} from "@/lib/fulfillment-promote";
import { sendText } from "@/lib/whatsapp";
import { decidePaymentTimestampUpdate } from "@/lib/payment-updates";
import {
  classifyPaymentEvent,
  shouldActivateAppointment,
  shouldCreateEarning,
  shouldReverseEarning,
} from "@/lib/payment-event-category";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/asaas/webhook" });

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
    log.warn("token inválido em produção, ignorando");
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const supabase = getSupabaseAdmin();
  const asaasPaymentId = body.payment?.id ?? null;

  // 2) Persiste raw (idempotente via asaas_event_id quando presente).
  //
  // PR-052 · D-063 · finding 5.12: o payload é passado pelo
  // `redactAsaasPayload()` antes do INSERT — PII (nome, CPF, email,
  // phone, endereço, dados do cartão, descrições livres) nunca chega
  // no banco. Só ficam os campos financeiros/operacionais necessários
  // pra reconciliação e classificação do evento. Purge final via cron
  // weekly (asaas-events-purge) esvazia payload para `{}` após 180d.
  //
  // Mesmo com falha no redact (bug futuro), marcamos `payload = {}`
  // e logamos — nunca serializamos raw com PII.
  let safePayload: Record<string, unknown> = {};
  let redactedAt: string | null = null;
  try {
    safePayload = redactAsaasPayload(body as unknown);
    redactedAt = new Date().toISOString();
  } catch (err) {
    log.error("redact falhou — gravando payload vazio", { err });
    safePayload = {};
    redactedAt = null;
  }

  let storedEventId: string | null = null;
  try {
    const { data: stored, error: storeErr } = await supabase
      .from("asaas_events")
      .insert({
        asaas_event_id: body.id ?? null,
        event_type: body.event,
        asaas_payment_id: asaasPaymentId,
        payload: safePayload,
        payload_redacted_at: redactedAt,
        signature: headerToken,
        signature_valid: signatureValid,
      })
      .select("id")
      .single();

    if (storeErr) {
      // Conflict por unique(asaas_event_id) significa "já recebemos esse" — ok
      if (storeErr.code === "23505") {
        log.debug("evento duplicado, ignorando", { asaas_event_id: body.id });
        return NextResponse.json({ ok: true, duplicate: true });
      }
      log.error("persist raw failed", { error: storeErr.message });
      // Continua mesmo assim — o handler abaixo é importante demais pra
      // bloquear por falha no log.
    } else {
      storedEventId = stored?.id ?? null;
    }
  } catch (err) {
    log.error("persist raw exception", { err });
  }

  // 3) Processamento
  try {
    if (asaasPaymentId && body.payment) {
      const payment = body.payment;

      // Busca estado atual pra decidir idempotência dos timestamps contábeis.
      // PR-013 / audit [5.1]: `paid_at` e `refunded_at` são first-write-wins.
      // O Asaas manda PAYMENT_CONFIRMED → PAYMENT_RECEIVED → PAYMENT_UPDATED
      // em sequência; sobrescrever a cada um destruía a reconciliação contábil.
      // Redundância: trigger `payments_immutable_timestamps` (migration
      // 20260428000000) impede sobrescrita no nível do banco.
      const { data: existing } = await supabase
        .from("payments")
        .select("id, paid_at, refunded_at")
        .eq("asaas_payment_id", asaasPaymentId)
        .maybeSingle();

      const updates: Record<string, unknown> = {
        status: payment.status,
        asaas_raw: payment as unknown as Record<string, unknown>,
      };

      if (payment.invoiceUrl) updates.invoice_url = payment.invoiceUrl;
      if (payment.bankSlipUrl) updates.bank_slip_url = payment.bankSlipUrl;
      if (payment.dueDate) updates.due_date = payment.dueDate;
      if (payment.billingType) updates.billing_type = payment.billingType;

      const tsDecision = decidePaymentTimestampUpdate(
        payment.status,
        existing ?? null
      );
      if (tsDecision.paid_at) updates.paid_at = tsDecision.paid_at;
      if (tsDecision.refunded_at) updates.refunded_at = tsDecision.refunded_at;
      if (tsDecision.paid_at_skipped) {
        log.info("paid_at já fixado, ignorando", {
          asaas_payment_id: asaasPaymentId,
          paid_at: tsDecision.paid_at_skipped,
          event: body.event,
        });
      }
      if (tsDecision.refunded_at_skipped) {
        log.info("refunded_at já fixado, ignorando", {
          asaas_payment_id: asaasPaymentId,
          refunded_at: tsDecision.refunded_at_skipped,
          event: body.event,
        });
      }

      const { data: updatedPayment, error: updateErr } = await supabase
        .from("payments")
        .update(updates)
        .eq("asaas_payment_id", asaasPaymentId)
        .select("id")
        .maybeSingle();

      if (updateErr) {
        log.error("update payment falhou", {
          asaas_payment_id: asaasPaymentId,
          error: updateErr.message,
        });
        if (storedEventId) {
          await supabase
            .from("asaas_events")
            .update({ processing_error: updateErr.message })
            .eq("id", storedEventId);
        }
      } else {
        log.info("payment atualizado", {
          asaas_payment_id: asaasPaymentId,
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

          // === Promoção de fulfillment (D-044 · 2.D) ===
          // Independente do earnings lifecycle (que é por appointment).
          // Se este payment está vinculado a um fulfillment, promovemos
          // pending_payment → paid e notificamos o paciente.
          await handleFulfillmentLifecycle(
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
    log.error("processing exception", { err, stored_event_id: storedEventId });
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

  // Classificação de eventos Asaas (PR-014 · D-050).
  //
  // `confirmed` = cartão aprovado MAS dinheiro não liquidado. Dispara UX
  //   (ativa appointment, provisiona sala, notifica paciente) para que
  //   o paciente veja "pago" imediatamente, mas NÃO cria earning — se
  //   der chargeback, o Instituto evita perda (médica não recebeu antes).
  //
  // `received` = dinheiro liquidado. Dispara UX (caso PIX/boleto tenham
  //   pulado o CONFIRMED) E cria earning da médica. Este é o único sinal
  //   financeiro autêntico para créditos.
  //
  // `reversed` = estorno/chargeback. Dispara clawback (earning negativo).
  const category = classifyPaymentEvent(event, paymentStatus);

  if (shouldActivateAppointment(category)) {
    // 1) Ativa appointment se ainda estiver em pending_payment (idempotente).
    //    Dispara em CONFIRMED ou RECEIVED — o paciente não sabe o que é
    //    "compensação financeira", ele quer ver a consulta confirmada.
    const activation = await activateAppointmentAfterPayment(
      appt.id as string,
      internalPaymentId
    );
    if (!activation.ok) {
      log.error("activate falhou", {
        appointment_id: appt.id,
        error: activation.error,
      });
    } else if (activation.wasActivated) {
      log.info("appointment ativado", { appointment_id: appt.id, category });
    }

    // 2) Provisiona sala Daily (best-effort, idempotente).
    const alreadyHasRoom = Boolean(
      (appt as { video_room_url?: string | null }).video_room_url
    );
    if (!alreadyHasRoom && process.env.DAILY_API_KEY && process.env.DAILY_DOMAIN) {
      try {
        const customerName =
          (appt as { customers?: { name?: string } }).customers?.name ?? "Paciente";
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

        log.info("sala Daily provisionada", {
          room_name: room.name,
          appointment_id: appt.id,
        });
      } catch (e) {
        log.error("provisionConsultationRoom falhou", {
          appointment_id: appt.id,
          err: e,
        });
      }
    }

    // 3) Cria earning pra médica — APENAS se dinheiro foi efetivamente
    //    liquidado (PR-014). CONFIRMED não dispara earning: o cartão
    //    ainda tem janela aberta pra chargeback (até D+30 em crédito).
    //    Se a médica sacasse earning nesse intervalo e o paciente
    //    estornasse depois, viraria prejuízo operacional do Instituto.
    //
    //    Para PIX/boleto o webhook pula direto para PAYMENT_RECEIVED,
    //    sem atraso. Para cartão, o earning cria no segundo webhook
    //    (PAYMENT_RECEIVED após compensação no adquirente).
    if (shouldCreateEarning(category)) {
      const customerName =
        (appt as { customers?: { name?: string } }).customers?.name ?? "paciente";
      const result = await createConsultationEarning(supabase, {
        paymentId: internalPaymentId,
        doctorId: appt.doctor_id as string,
        appointmentId: appt.id as string,
        appointmentKind:
          (appt.kind as "scheduled" | "on_demand" | undefined) ?? "scheduled",
        description: `Consulta · ${customerName}`,
      });
      if (!result.ok) {
        log.error("earning falhou", { error: result.error });
      } else if (result.created) {
        log.info("earning criado", { earning_id: result.earningId });
      }
    } else {
      log.info("earning postergado (CONFIRMED sem RECEIVED)", {
        appointment_id: appt.id,
        payment_id: internalPaymentId,
      });
    }

    // 4) Enfileira notificações WhatsApp (D-031). Idempotente no
    //    provider — webhook Asaas pode chegar em duplicata (CONFIRMED
    //    seguido de RECEIVED) sem efeito colateral.
    //    + Notificações pra MÉDICA (PR-077 · D-089): doctor_paid
    //    imediato + doctor_t_minus_15min agendado pra T-15.
    try {
      const scheduledAtIso = (appt as { scheduled_at?: string }).scheduled_at;
      const [immediateId, reminders, doctorPaidId, doctorReminderId] =
        await Promise.all([
          enqueueImmediate(appt.id as string, "confirmacao"),
          scheduleRemindersForAppointment(appt.id as string),
          enqueueDoctorPaid(appt.id as string, appt.doctor_id as string),
          scheduledAtIso
            ? enqueueDoctorAppointmentReminder(
                appt.id as string,
                appt.doctor_id as string,
                new Date(scheduledAtIso)
              )
            : Promise.resolve(null),
        ]);
      log.info("notificações enfileiradas", {
        appointment_id: appt.id,
        confirmacao_id: immediateId,
        reminders: reminders.scheduled,
        doctor_paid_id: doctorPaidId,
        doctor_reminder_id: doctorReminderId,
      });
    } catch (e) {
      log.error("enqueue notifications falhou", {
        appointment_id: appt.id,
        err: e,
      });
    }
    return;
  }

  if (shouldReverseEarning(category)) {
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
      log.error("clawback falhou", { error: result.error });
    } else if (result.clawbacks > 0) {
      log.info("clawbacks criados", { count: result.clawbacks });
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
        processedByEmail: "system:asaas-webhook", // PR-064 · D-072
      });
      if (!markResult.ok) {
        log.error("markRefundProcessed via webhook falhou", {
          appointment_id: appt.id,
          result: markResult,
        });
      } else {
        log.info("refund marcado via webhook", {
          appointment_id: appt.id,
          already_processed: markResult.alreadyProcessed,
        });
      }
    }
  }
}

/**
 * Roteador de eventos Asaas → promoção de fulfillment (D-044 · 2.D).
 *
 * Quando o pagamento de um fulfillment é confirmado:
 *   1. promove o fulfillment pra `paid` (idempotente);
 *   2. dispara WhatsApp "pagamento confirmado" best-effort.
 *
 * Não bloqueia o webhook — erros só viram log.
 */
async function handleFulfillmentLifecycle(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  event: string,
  paymentStatus: string,
  internalPaymentId: string,
  asaasPaymentId: string | null
): Promise<void> {
  // Promoção de fulfillment (D-044 · 2.D) dispara em CONFIRMED ou RECEIVED.
  // Ao contrário de earnings, aqui a UX é priorizada: o paciente precisa
  // ver "pagamento confirmado, estamos preparando sua medicação" assim
  // que o cartão é aprovado. Se chargeback acontecer depois, o webhook
  // PAYMENT_CHARGEBACK_* reverte o estado do fulfillment via fluxo próprio.
  const category = classifyPaymentEvent(event, paymentStatus);
  if (!shouldActivateAppointment(category)) return;

  const result = await promoteFulfillmentAfterPayment(supabase, {
    paymentId: internalPaymentId,
    asaasPaymentId,
  });

  if (!result.ok) {
    // payment_not_found / fulfillment_not_found são casos comuns
    // quando o payment é de uma consulta (fluxo antigo), não de um
    // plano prescrito. Loga em nível baixo pra não poluir.
    if (
      result.code === "payment_not_found" ||
      result.code === "fulfillment_not_found"
    ) {
      log.debug("fulfillment skip", {
        code: result.code,
        payment_id: internalPaymentId,
      });
      return;
    }
    log.error("promote fulfillment falhou", { result });
    return;
  }

  if (result.wasPromoted) {
    log.info("fulfillment promovido", {
      fulfillment_id: result.fulfillmentId,
      plan: result.planName,
    });
  } else if (result.alreadyPaid) {
    log.info("fulfillment já estava pago", {
      fulfillment_id: result.fulfillmentId,
      status: result.status,
    });
    // se já estava pago em webhook anterior, não reenviamos WA.
    return;
  }

  // Best-effort: notifica paciente.
  if (result.customerPhone && result.wasPromoted) {
    try {
      const message = composePaidWhatsAppMessage({
        customerName: result.customerName,
        planName: result.planName,
      });
      const waRes = await sendText({
        to: result.customerPhone,
        text: message,
      });
      if (waRes.ok) {
        log.info("WA pagamento-ok enviado", {
          fulfillment_id: result.fulfillmentId,
          message_id: waRes.messageId,
        });
      } else {
        log.warn("WA pagamento-ok falhou", {
          fulfillment_id: result.fulfillmentId,
          error: waRes.message,
        });
      }
    } catch (e) {
      log.error("WA pagamento-ok exception", {
        fulfillment_id: result.fulfillmentId,
        err: e,
      });
    }
  }
}
