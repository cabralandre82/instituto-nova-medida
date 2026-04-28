/**
 * src/lib/cost-rates.ts — PR-045 · D-096
 *
 * Rates configuráveis pra estimativa de custo dos providers externos.
 * Lidas de env vars com defaults sensatos calibrados para planos PRO
 * comuns no mercado brasileiro em abril/2026. Não são fatura real —
 * são proxy pra cron `cost-snapshot` materializar `cost_snapshots.estimated_cents`.
 *
 * Por que centavos BRL como unidade canônica:
 *   - Toda contabilidade interna do app é em centavos BRL (D-049,
 *     `payments.amount_cents`, `doctor_earnings.amount_cents`, etc.).
 *   - Cobrança real chega em USD (Daily, Asaas USD inviável aqui),
 *     EUR (mesmo) ou BRL — operador converte na fatura. Pro
 *     dashboard interno, BRL fixo evita 3 unit-conversions por linha.
 *   - Quando o operador notar drift consistente entre estimativa e
 *     fatura real, ajusta a env e o próximo snapshot já corrige.
 *
 * Defaults adotados (atualizados conforme observação real em produção):
 *   - WhatsApp: ~R$ 0,10 / mensagem (média ponderada de utility +
 *     authentication templates Brasil; Meta cobra ~$0.024 utility +
 *     $0.05 authentication; com FX ~R$ 5 e dispersão de tipo, R$ 0,10
 *     é estimativa conservadora).
 *   - Asaas: 2,5% + R$ 0,99 fixo por transação (faixa típica BR para
 *     PIX/cartão; varia por plano comercial).
 *   - Daily.co: ~R$ 0,04 / minuto (cobra por participante-minuto;
 *     consulta de 30min × 2 participantes = 60 part-min × $0.004 ≈
 *     R$ 1,20/consulta; default rateado por minuto-uniparticipante
 *     pra simplificar — UI mostra breakdown).
 *   - Vercel Pro: $20/mês ≈ R$ 100. Custo dominante são function
 *     invocations (free tier inclui muito); tratamos como fixo.
 *   - Supabase Pro: $25/mês ≈ R$ 125. DB + auth + storage; tratamos
 *     como fixo (storage cresce devagar até bytes virarem problema).
 *
 * Todas as rates são lidas SEMPRE no momento do snapshot (não
 * cacheadas em module scope) — assim alterar a env não exige redeploy
 * pra próxima execução do cron pegar.
 */

/**
 * Lê uma env var como inteiro positivo. Retorna `fallback` em qualquer
 * caso de falha (não setada, não-numérica, negativa, NaN, Infinity).
 *
 * Defensivo: nunca lança — cost dashboard nunca pode quebrar em
 * cima de typo de env var. Logger interno avisa em PR-043 quando
 * drain externo entrar.
 */
function envIntOrDefault(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

/** Custo médio por mensagem WhatsApp em centavos BRL. */
export function getWaCostCentsPerMessage(): number {
  return envIntOrDefault("WA_COST_CENTS_PER_MESSAGE", 10);
}

/**
 * Fee fixo do Asaas por transação em centavos BRL.
 * (R$ 0,99 = 99 centavos, faixa típica PIX/Boleto.)
 */
export function getAsaasFeeFixedCents(): number {
  return envIntOrDefault("ASAAS_FEE_FIXED_CENTS", 99);
}

/**
 * Fee percentual do Asaas em basis points (1bp = 0.01%).
 * 250 bps = 2.5%, default conservador.
 */
export function getAsaasFeePctBps(): number {
  return envIntOrDefault("ASAAS_FEE_PCT_BPS", 250);
}

/**
 * Custo Daily.co por minuto-participante em centavos BRL.
 *
 * Daily cobra ~$0.004/min/participante. Com FX ~R$ 5 e ajuste
 * pra inflação histórica, default 4 centavos é razoável.
 *
 * Conservador: usamos 1 participante (médica) — paciente normalmente
 * não bate o ceiling do plano free de banda. Quando uso real subir,
 * operador ajusta env.
 */
export function getDailyCostCentsPerMinute(): number {
  return envIntOrDefault("DAILY_COST_CENTS_PER_MINUTE", 4);
}

/** Custo mensal fixo Vercel em centavos BRL. */
export function getVercelMonthlyCents(): number {
  return envIntOrDefault("VERCEL_MONTHLY_CENTS", 10000);
}

/** Custo mensal fixo Supabase em centavos BRL. */
export function getSupabaseMonthlyCents(): number {
  return envIntOrDefault("SUPABASE_MONTHLY_CENTS", 12500);
}

/**
 * Snapshot completo das rates atuais — usado pelo cron pra serializar
 * em `cost_snapshots.metadata.rates_snapshot`, e pela UI pra mostrar
 * "rates utilizadas" no rodapé do dashboard.
 *
 * Útil pra forensics: quando a fatura vier diferente, conferimos qual
 * rate estava ativa naquele dia.
 */
export type CostRatesSnapshot = {
  wa_cents_per_message: number;
  asaas_fee_fixed_cents: number;
  asaas_fee_pct_bps: number;
  daily_cents_per_minute: number;
  vercel_monthly_cents: number;
  supabase_monthly_cents: number;
};

export function snapshotCostRates(): CostRatesSnapshot {
  return {
    wa_cents_per_message: getWaCostCentsPerMessage(),
    asaas_fee_fixed_cents: getAsaasFeeFixedCents(),
    asaas_fee_pct_bps: getAsaasFeePctBps(),
    daily_cents_per_minute: getDailyCostCentsPerMinute(),
    vercel_monthly_cents: getVercelMonthlyCents(),
    supabase_monthly_cents: getSupabaseMonthlyCents(),
  };
}
