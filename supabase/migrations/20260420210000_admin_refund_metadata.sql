-- ──────────────────────────────────────────────────────────────────────────
-- Migration 013 — Metadata de processamento manual/automático de refund.
-- ──────────────────────────────────────────────────────────────────────────
-- Contexto: a migration 012 (D-032) já adicionou as flags `refund_required`
-- e `refund_processed_at`. Elas respondem "precisa estornar?" e "quando foi
-- processado?", mas não respondem QUEM processou, COMO (manual no painel
-- Asaas vs via API), nem DEIXAM RASTRO do identificador externo (id do
-- refund no Asaas ou txid do PIX).
--
-- Esta migration adiciona essas 4 colunas de auditoria para que a tela
-- `/admin/refunds` (D-033) possa registrar o processamento manual de hoje
-- E, quando a Sprint 5 ligar o estorno automático via Asaas API, o mesmo
-- schema receba o resultado da chamada — zero re-modelagem depois.
--
-- Idempotência do próprio processamento continua sendo guiada pela coluna
-- `refund_processed_at` (preenchida = processado). Essa migration não
-- mexe no fluxo, só enriquece a trilha de auditoria.
--
-- Docs: D-033 em docs/DECISIONS.md.
-- ──────────────────────────────────────────────────────────────────────────

alter table public.appointments
  add column if not exists refund_external_ref text,
  add column if not exists refund_processed_by uuid references auth.users(id) on delete set null,
  add column if not exists refund_processed_notes text,
  add column if not exists refund_processed_method text
    check (refund_processed_method in ('manual', 'asaas_api'));

comment on column public.appointments.refund_external_ref is
  'Identificador externo do estorno. Quando processado manualmente, o '
  'admin cola o id do refund que gerou no painel Asaas (ex: "rf_abc123") '
  'ou o end-to-end do PIX. Quando a Sprint 5 automatizar via Asaas API, '
  'esta coluna recebe o `refund.id` retornado pelo POST /payments/{id}/refund.';

comment on column public.appointments.refund_processed_by is
  'FK pro auth.users do admin que acionou o processamento. Nulo se '
  'acionado por automação (cron futuro) ou se o processamento veio do '
  'próprio webhook do Asaas (PAYMENT_REFUNDED) — nesse caso o source '
  'fica implícito em refund_processed_method=asaas_api.';

comment on column public.appointments.refund_processed_notes is
  'Observações humanas sobre o caso (ex: "paciente enviou atestado, '
  'autorizei estorno parcial", "tive que falar com suporte Asaas"). '
  'Fica visível só no painel admin.';

comment on column public.appointments.refund_processed_method is
  'Como o estorno foi processado: "manual" (admin bateu no painel Asaas '
  'e marcou aqui) ou "asaas_api" (API automática da Sprint 5). '
  'Permite métricas de "quanto dos estornos ainda são manuais?" e '
  'distinguir responsabilidade em auditoria.';

-- Índice pra histórico no painel admin: lista últimos refunds processados
-- ordenados por quando foram processados. Só linhas que realmente foram
-- processadas entram no índice (partial), mantendo-o enxuto.
create index if not exists ix_appt_refund_processed
  on public.appointments (refund_processed_at desc)
  where refund_processed_at is not null;

comment on index public.ix_appt_refund_processed is
  'Acelera o histórico "últimos N refunds processados" na tela admin '
  'sem scanear toda a tabela appointments.';
