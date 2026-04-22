/**
 * src/lib/dashboard-health.ts — PR-057 · D-068 · finding 8.5
 *
 * Heurísticas puras para o dashboard `/admin`. Vivem aqui em vez de
 * inline na página pra serem testadas isoladamente sem subir Next.
 *
 * `evaluateUnknownSourceRatio` — sinaliza quando o ratio de
 * `reconciled_by_source = NULL` ("unknown") fica acima do limite de
 * tolerância (5%). Isso vira alerta visual no dashboard porque significa
 * uma de duas coisas (ambas exigem ação):
 *
 *   1. Webhook Daily caindo silenciosamente — o cron de reconciliação
 *      pega o appointment, mas a fonte fica `NULL` porque o webhook
 *      original nunca preencheu `reconciled_by_source`.
 *   2. Regressão na coluna `reconciled_by_source` (alguma rota nova
 *      atualiza `appointments.status` sem setar a coluna).
 *
 * Threshold + minimum sample size:
 *
 *   - 5% é tolerante o suficiente pra ruído operacional, severo o
 *     suficiente pra capturar regressão real.
 *   - Mínimo 20 reconciliações antes de alertar — em volume baixo
 *     (e.g. 1 unknown em 5) o ratio é volátil demais.
 */

const UNKNOWN_SOURCE_ALERT_THRESHOLD = 0.05;
const UNKNOWN_SOURCE_MIN_SAMPLE = 20;

export type UnknownSourceEvaluation = {
  total: number;
  unknown: number;
  ratio: number;
  alert: boolean;
};

export function evaluateUnknownSourceRatio(
  bySource: Record<string, number>
): UnknownSourceEvaluation {
  let total = 0;
  for (const v of Object.values(bySource)) total += v;
  const unknown = bySource.unknown ?? 0;
  const ratio = total === 0 ? 0 : unknown / total;
  return {
    total,
    unknown,
    ratio,
    alert:
      total >= UNKNOWN_SOURCE_MIN_SAMPLE &&
      ratio > UNKNOWN_SOURCE_ALERT_THRESHOLD,
  };
}
