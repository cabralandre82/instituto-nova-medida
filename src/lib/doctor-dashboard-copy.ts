/**
 * Copy helpers pro dashboard da médica (`/medico`).
 *
 * Contexto (PR-065 · D-073 · audit [2.5]):
 *   O card "Recebido neste mês" antes mostrava como hint:
 *     "+ N repasses em andamento"
 *   O sinal "+" induzia a médica a somar mentalmente o valor do card (já
 *   confirmado no mês) com os repasses em andamento — que podem **não**
 *   cair no mês corrente (o cron de confirmação roda no início do mês
 *   seguinte; `approved`/`pix_sent` pendentes podem só confirmar em M+1).
 *
 *   Mudanças defensivas:
 *     - Removemos o "+" do hint.
 *     - Deixamos explícito que o número é "aguardando confirmação bancária"
 *       (não é dinheiro já entrado na conta da médica neste mês).
 *     - Complemento no footer da grid (fora deste arquivo) explica que
 *       valores em andamento podem cair neste ou no próximo mês.
 */

export type DoctorPayoutsLifecycleCount = {
  /** payouts gerados mas ainda não aprovados pelo admin. */
  draft: number;
  /** aprovados (pronto pra PIX) — ainda não enviados ao banco. */
  approved: number;
  /** PIX enviado ao banco, aguardando confirmação de recebimento. */
  pixSent: number;
};

/**
 * Quantos repasses estão "aguardando confirmação" — somando approved +
 * pixSent. `draft` NÃO entra: é estado pre-approval do admin, sem nenhuma
 * expectativa de pagamento ainda.
 */
export function countAwaitingConfirmation(c: DoctorPayoutsLifecycleCount): number {
  return (c.approved ?? 0) + (c.pixSent ?? 0);
}

/**
 * Gera o hint do card "Recebido neste mês". Sem o "+" enganoso do copy
 * antigo (audit [2.5]).
 */
export function formatReceivedThisMonthHint(c: DoctorPayoutsLifecycleCount): string {
  const awaiting = countAwaitingConfirmation(c);
  if (awaiting <= 0) return "via PIX confirmados";
  const plural = awaiting === 1 ? "" : "s";
  return `${awaiting} repasse${plural} aguardando confirmação`;
}

/**
 * Texto longo pra nota de pé-de-grid (só exibir quando houver repasses em
 * andamento). Deixa explícito pra médica que "em andamento" não significa
 * "vai cair este mês".
 */
export function formatPendingConfirmationNote(c: DoctorPayoutsLifecycleCount): string | null {
  const awaiting = countAwaitingConfirmation(c);
  if (awaiting <= 0) return null;
  const plural = awaiting === 1 ? "" : "s";
  const isAre = awaiting === 1 ? "pode" : "podem";
  return (
    `Você tem ${awaiting} repasse${plural} em andamento. ` +
    `Esse valor ${isAre} cair neste mês ou no próximo, conforme confirmação bancária.`
  );
}
