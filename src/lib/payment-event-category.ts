/**
 * Classificador puro de eventos Asaas (PR-014 · D-050).
 *
 * Distinção financeira fundamental:
 *
 *  - CONFIRMED = cartão aprovado pelo adquirente, mas o dinheiro
 *    ainda NÃO caiu na conta do Instituto. Crédito só compensa D+30
 *    (débito D+2). Até lá o paciente pode abrir chargeback.
 *
 *  - RECEIVED = dinheiro efetivamente liquidado na conta (PIX instantâneo,
 *    boleto compensado, cartão compensado no D+30).
 *
 * Regras derivadas:
 *
 *  1. UX do paciente (ativar appointment pending_payment, provisionar
 *     sala Daily, enfileirar notificações de confirmação, promover
 *     fulfillment para `paid`) dispara em `confirmed` OU `received`,
 *     porque o paciente "pagou" do ponto de vista dele e precisa ver
 *     a consulta/medicação em andamento.
 *
 *  2. Earning da médica (créditos financeiros) dispara APENAS em
 *     `received`. Isso protege o Instituto do seguinte cenário:
 *     médica saca earning em repasse mensal (via PIX), cartão do
 *     paciente dá chargeback semanas depois, earning vira clawback —
 *     mas o dinheiro da médica já saiu e vira prejuízo operacional.
 *
 *  3. Reversão (estorno, chargeback, reembolso) sempre cria clawback,
 *     independente do lado do earning original.
 *
 * Mapeamento Asaas → categoria:
 *
 *  | Evento / status Asaas                | categoria   |
 *  |--------------------------------------|-------------|
 *  | PAYMENT_CONFIRMED / CONFIRMED        | confirmed   |
 *  | PAYMENT_RECEIVED / RECEIVED          | received    |
 *  | PAYMENT_RECEIVED_IN_CASH             | received    |
 *  | PAYMENT_REFUNDED / REFUNDED          | reversed    |
 *  | PAYMENT_REFUND_IN_PROGRESS           | reversed    |
 *  | PAYMENT_CHARGEBACK_REQUESTED         | reversed    |
 *  | PAYMENT_CHARGEBACK_DISPUTE           | reversed    |
 *  | CHARGEBACK_REQUESTED                 | reversed    |
 *  | qualquer outro (CREATED, UPDATED...) | other       |
 *
 * Obs.: PIX e boleto no Asaas costumam pular `CONFIRMED` e ir direto
 * para `RECEIVED`. Cartão passa pelos dois em momentos distintos.
 * A categorização é ortogonal ao meio de pagamento — depende só da
 * string do evento/status.
 */

export type PaymentEventCategory =
  | "received"
  | "confirmed"
  | "reversed"
  | "other";

const RECEIVED_EVENTS = new Set([
  "PAYMENT_RECEIVED",
  "PAYMENT_RECEIVED_IN_CASH",
]);

const RECEIVED_STATUSES = new Set(["RECEIVED", "RECEIVED_IN_CASH"]);

const CONFIRMED_EVENTS = new Set(["PAYMENT_CONFIRMED"]);

const CONFIRMED_STATUSES = new Set(["CONFIRMED"]);

const REVERSED_EVENTS = new Set([
  "PAYMENT_REFUNDED",
  "PAYMENT_REFUND_IN_PROGRESS",
  "PAYMENT_CHARGEBACK_REQUESTED",
  "PAYMENT_CHARGEBACK_DISPUTE",
]);

const REVERSED_STATUSES = new Set(["REFUNDED", "CHARGEBACK_REQUESTED"]);

/**
 * Classifica um evento Asaas em uma categoria de negócio.
 *
 * @param event    Nome do evento (ex: "PAYMENT_RECEIVED"). Case-sensitive.
 *                 Espelha o campo `event` do payload do webhook.
 * @param paymentStatus Status do objeto payment (ex: "CONFIRMED"). Opcional;
 *                 usado como fallback quando `event` não é conclusivo
 *                 (ex: PAYMENT_UPDATED sempre classifica pelo status).
 *
 * A ordem de precedência é: `received` → `reversed` → `confirmed` → `other`.
 * Um `PAYMENT_REFUNDED` de um payment que ainda aparece com status
 * `RECEIVED` (ponto-no-tempo anterior à atualização) precisa ser tratado
 * como reversão, não como recebimento. Por isso verificamos reversão
 * antes de confirmação.
 *
 * Mas `received` > `reversed` porque um webhook `PAYMENT_RECEIVED` é
 * sempre a fonte de verdade para registrar entrada de caixa; mesmo se
 * o status já tiver virado algo diferente, o earning daquele momento
 * precisa ser criado (idempotência no consumidor cuida de duplicação).
 */
export function classifyPaymentEvent(
  event: string | null | undefined,
  paymentStatus: string | null | undefined
): PaymentEventCategory {
  const e = (event ?? "").toUpperCase();
  const s = (paymentStatus ?? "").toUpperCase();

  if (RECEIVED_EVENTS.has(e) || RECEIVED_STATUSES.has(s)) {
    return "received";
  }
  if (REVERSED_EVENTS.has(e) || REVERSED_STATUSES.has(s)) {
    return "reversed";
  }
  if (CONFIRMED_EVENTS.has(e) || CONFIRMED_STATUSES.has(s)) {
    return "confirmed";
  }
  return "other";
}

/**
 * Helpers booleanos (açúcar pra uso no webhook).
 *
 * `shouldActivateAppointment` = dispara UX (ativa appointment, provisiona
 * sala, envia notificação de confirmação). Inclui `confirmed` para que
 * o paciente veja o status "pago" imediatamente ao aprovar o cartão.
 *
 * `shouldCreateEarning` = cria crédito financeiro para a médica. EXCLUI
 * `confirmed` — só em `received`. Este é o delta crítico do PR-014.
 */
export function shouldActivateAppointment(
  category: PaymentEventCategory
): boolean {
  return category === "confirmed" || category === "received";
}

export function shouldCreateEarning(category: PaymentEventCategory): boolean {
  return category === "received";
}

export function shouldReverseEarning(category: PaymentEventCategory): boolean {
  return category === "reversed";
}
