-- ============================================================================
-- Migration · Campo pra idempotência do cron nudge-reconsulta (D-045 · 3.C)
-- ============================================================================
-- O cron `nudge-reconsulta` avisa o paciente que o ciclo do tratamento tá
-- perto do fim (ex: 7 dias antes de `delivered_at + cycle_days`) e que ele
-- precisa agendar reconsulta. Sem idempotência, um paciente receberia o
-- mesmo WA a cada execução do cron. Precisamos marcar "já nudgeado".
--
-- Decisão: um timestamptz `reconsulta_nudged_at` em `fulfillments`.
--   - NULL = nunca nudgeado.
--   - Não-NULL = nudgeado ao menos uma vez no timestamp gravado.
--
-- Por que em `fulfillments` e não em tabela separada:
--   - O escopo é 1 nudge por ciclo (1 fulfillment = 1 ciclo), não um log
--     de N nudges. Se no futuro quisermos cadência (3 nudges escalonados),
--     migramos pra tabela — mas hoje seria over-engineering.
--   - Mantém o tracking junto ao recurso principal (menos join).
--
-- ============================================================================

alter table public.fulfillments
  add column if not exists reconsulta_nudged_at timestamptz;

comment on column public.fulfillments.reconsulta_nudged_at is
  'Quando o cron nudge-reconsulta avisou o paciente. NULL = nunca. D-045 · 3.C.';

-- Índice parcial pra o cron encontrar apenas fulfillments ainda não nudgeados.
create index if not exists fulfillments_reconsulta_nudge_pending_idx
  on public.fulfillments (delivered_at)
  where reconsulta_nudged_at is null and status = 'delivered';

do $$ begin
  raise notice 'fulfillments.reconsulta_nudged_at criado; idx parcial ok.';
end $$;
