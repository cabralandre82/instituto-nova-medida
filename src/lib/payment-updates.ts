/**
 * Lógica pura de decisão de mudanças em `payments` a partir de eventos
 * do webhook do Asaas.
 *
 * Extraído de `src/app/api/asaas/webhook/route.ts` para ser testável
 * isoladamente e garantir o contrato crítico do PR-013 / audit [5.1]:
 *
 *   `paid_at` e `refunded_at` são **first-write-wins**: o primeiro
 *   evento que os define fixa o valor. Eventos subsequentes (retries,
 *   PAYMENT_UPDATED, PAYMENT_RECEIVED após PAYMENT_CONFIRMED) não
 *   sobrescrevem — se sobrescrevessem, a reconciliação contábil ficaria
 *   impossível (o "dia do pagamento" precisa ser imutável).
 *
 * Defense in depth: o trigger `payments_immutable_timestamps` (migration
 * 20260428000000) garante o mesmo comportamento no nível do banco.
 */

export type PaymentExistingState = {
  paid_at: string | null;
  refunded_at: string | null;
} | null;

export type PaymentTimestampDecision = {
  /** Novo valor pra `paid_at`. Só presente se deve ser gravado. */
  paid_at?: string;
  /** Novo valor pra `refunded_at`. Só presente se deve ser gravado. */
  refunded_at?: string;
  /**
   * Se o status exige `paid_at` mas ele já está fixado, devolve o valor
   * atual aqui pra caller logar. Não deve entrar no UPDATE.
   */
  paid_at_skipped?: string;
  /**
   * Análogo para `refunded_at`.
   */
  refunded_at_skipped?: string;
};

export function isReceivedStatus(status: string): boolean {
  return (
    status === "RECEIVED" ||
    status === "CONFIRMED" ||
    status === "RECEIVED_IN_CASH"
  );
}

export function isRefundStatus(status: string): boolean {
  return status === "REFUNDED" || status === "REFUND_IN_PROGRESS";
}

/**
 * Decide o que fazer com `paid_at` / `refunded_at` na row de `payments`
 * dado o status do webhook e o estado atual da row.
 *
 * @param paymentStatus — status do payment conforme chegou no webhook.
 * @param existing — row atual do banco (ou null se ainda não existe).
 * @param now — timestamp ISO a usar caso precise setar (injeção pra
 *   facilitar teste determinístico).
 */
export function decidePaymentTimestampUpdate(
  paymentStatus: string,
  existing: PaymentExistingState,
  now: string = new Date().toISOString()
): PaymentTimestampDecision {
  const out: PaymentTimestampDecision = {};

  if (isReceivedStatus(paymentStatus)) {
    if (!existing?.paid_at) {
      out.paid_at = now;
    } else {
      out.paid_at_skipped = existing.paid_at;
    }
  }

  if (isRefundStatus(paymentStatus)) {
    if (!existing?.refunded_at) {
      out.refunded_at = now;
    } else {
      out.refunded_at_skipped = existing.refunded_at;
    }
  }

  return out;
}
