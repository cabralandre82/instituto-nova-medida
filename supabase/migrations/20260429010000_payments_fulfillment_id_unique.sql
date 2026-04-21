-- PR-015 · fulfillment_id em payments + unique parcial — audit [5.3].
--
-- Contexto:
--   `ensurePaymentForFulfillment` era vulnerável a race condition.
--   Duas chamadas paralelas (double-click, retry de rede, polling do
--   front) para o mesmo fulfillment chegavam no banco com
--   `fulfillments.payment_id = NULL`, passavam do check de
--   idempotência e cada uma criava uma cobrança nova no Asaas. Apenas
--   a última gravava seu id em `fulfillments.payment_id`; a outra
--   ficava "zumbi" — paciente podia receber dois invoice_url, pagar
--   a "errada", e o webhook ainda conseguia casar (porque
--   `asaas_payment_id` tem UNIQUE), mas o modelo ficava inconsistente:
--   `fulfillments.payment_id` aponta pra uma cobrança e existe outra
--   órfã apontando pro mesmo fulfillment.
--
-- Solução:
--   - Adicionar coluna `fulfillment_id` em `public.payments` como FK.
--   - Criar UNIQUE PARTIAL INDEX que só considera cobranças "vivas"
--     (status NÃO em DELETED/REFUNDED/REFUND_REQUESTED). Assim:
--     * INSERT concorrente: só uma vence; a outra recebe 23505 e trata
--       como race perdida.
--     * Se uma cobrança for cancelada (DELETED/REFUNDED), o slot é
--       liberado e o sistema pode legitimamente criar uma nova.
--
-- Compatibilidade:
--   - A coluna é nullable porque os fluxos legacy (`/api/subscribe`)
--     ainda criam payments sem fulfillment — `LEGACY_PURCHASE_ENABLED`
--     controla esses.
--   - Backfill popula os payments já vinculados a partir de
--     `fulfillments.payment_id`.

alter table public.payments
  add column if not exists fulfillment_id uuid
    references public.fulfillments(id) on delete set null;

comment on column public.payments.fulfillment_id is
  'PR-015 / audit [5.3]: fulfillment ao qual esta cobrança pertence (fluxo D-044 pós-consulta). Unique parcial em (fulfillment_id) WHERE status in cobranças vivas previne race condition em ensurePaymentForFulfillment.';

-- Backfill a partir do vínculo inverso existente.
update public.payments p
   set fulfillment_id = f.id
  from public.fulfillments f
 where f.payment_id = p.id
   and p.fulfillment_id is null;

create index if not exists idx_payments_fulfillment
  on public.payments(fulfillment_id);

-- Unique parcial: só uma cobrança "viva" por fulfillment.
-- Status "vivos" = qualquer estado menos os que indicam ciclo encerrado:
--   DELETED       → foi apagada/cancelada no provedor
--   REFUNDED      → reembolsada integralmente
--   REFUND_REQUESTED → em processo de estorno (não usar mais pro pagamento)
-- Em qualquer outro status (PENDING, CONFIRMED, RECEIVED, etc.),
-- considera-se que aquela é a cobrança oficial do fulfillment, e uma
-- concorrente não pode ser criada.
drop index if exists payments_fulfillment_id_alive_uniq;
create unique index payments_fulfillment_id_alive_uniq
  on public.payments (fulfillment_id)
  where fulfillment_id is not null
    and status not in ('DELETED', 'REFUNDED', 'REFUND_REQUESTED');

comment on index public.payments_fulfillment_id_alive_uniq is
  'PR-015: garante no máximo UMA cobrança "viva" por fulfillment. Cobranças canceladas/reembolsadas liberam o slot para retentativa legítima.';
