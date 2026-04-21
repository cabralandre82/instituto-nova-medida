-- ============================================================================
-- 20260506000000_asaas_events_retention.sql
--
-- PR-052 · D-063 · finding [5.12 🟠 ALTO].
--
-- Contexto:
--   `asaas_events` acumula webhooks indefinidamente desde que o sistema
--   subiu. Cada payload inclui PII: nome, CPF, email, phone, endereço do
--   customer Asaas, dados do cartão (holderInfo), descrições livres.
--   Sem purge automático, em 12 meses o banco tem GBs de PII desnecessária
--   pra qualquer finalidade legítima — e retenção ilimitada viola LGPD
--   Art. 16 (adequação à finalidade) + princípio da necessidade.
--
-- Decisão (D-063):
--   1. `redactAsaasPayload()` no INSERT (lado aplicação, PR-052 · libs
--      `asaas-event-redact.ts`): allowlist-based, preserva campos
--      financeiros/operacionais; dropa PII do customer, address,
--      creditCardHolderInfo, descrições livres. PII NUNCA chega no banco
--      pra novos eventos.
--
--   2. Purge periódico (cron semanal): eventos com
--      `processed_at < now() - 180 dias` têm `payload` esvaziado pra
--      `{}::jsonb` (mantém NOT NULL constraint) e `payload_purged_at`
--      marcado. Preserva `event_type`, `asaas_event_id`,
--      `asaas_payment_id`, `received_at`, `processed_at` pra rastreio e
--      reconciliação histórica. 180d cobre:
--        - prazo de chargeback Mastercard/Visa = 120 dias após a data do
--          pagamento;
--        - 60d de folga operacional pra reconciliação tardia.
--
-- Campos novos:
--   - `payload_redacted_at`: timestamp em que o payload foi redacted
--     no INSERT (cedo na vida do evento). Nem todo evento é redacted
--     imediatamente — se o webhook falhar no redact, gravamos `{}`
--     e marcamos `null` aqui pra alertar.
--   - `payload_purged_at`: timestamp do purge pós-retention. Uma vez
--     setado, o payload está em `{}` e não volta.
--
-- Idempotência do purge:
--   Query `WHERE payload_purged_at IS NULL AND processed_at < cutoff`.
--   Se rodar 2×, a 2ª vez encontra zero candidatos.
--
-- Reversibilidade:
--   Colunas adicionadas são nullable. Dropá-las é trivial. O purge do
--   payload (`{}`) é destrutivo, mas o audit trail (cron_runs +
--   asaas_events row) permanece.
-- ============================================================================

alter table public.asaas_events
  add column if not exists payload_redacted_at timestamptz,
  add column if not exists payload_purged_at   timestamptz;

comment on column public.asaas_events.payload_redacted_at is
  'Timestamp em que o payload foi sanitizado (PII removida) no INSERT. NULL = payload veio bruto (falha do redact ou evento antigo pré-D-063).';

comment on column public.asaas_events.payload_purged_at is
  'Timestamp do purge pós-retention (180d). Uma vez setado, payload = ''{}''::jsonb. Idempotente pelo guard payload_purged_at IS NULL no UPDATE.';

comment on table public.asaas_events is
  'Log raw dos webhooks do Asaas. Idempotência via asaas_event_id. Retention LGPD: payload é redacted no INSERT (allowlist) e purgado pra {} após 180d de processado (D-063).';

-- Índice pra query de purge. Partial index só sobre candidatos (payload
-- ainda não purgado) mantém a árvore pequena mesmo com anos de histórico.
create index if not exists asaas_events_purge_candidates_idx
  on public.asaas_events (processed_at)
  where payload_purged_at is null and processed_at is not null;

comment on index public.asaas_events_purge_candidates_idx is
  'Otimiza SELECT de candidatos a purge (D-063). Partial por payload_purged_at IS NULL mantem o índice enxuto.';
