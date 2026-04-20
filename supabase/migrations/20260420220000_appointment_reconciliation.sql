-- Migration 014 · Audit trail de reconciliação de appointments (D-035)
--
-- Contexto:
--   O webhook do Daily (D-029) está com registro bloqueado em produção
--   por bug no cliente `superagent` deles contra hosts do Vercel. D-035
--   introduz um cron de reconciliação via polling da REST API do Daily
--   (/meetings) que roda independente do webhook e aplica a mesma
--   política de no-show.
--
--   Pra observabilidade precisamos saber, pra cada appointment terminado,
--   *quem* fechou o ciclo: o webhook em tempo real, ou o cron de fallback.
--   Isso tem duas utilidades concretas:
--
--     1. Quando o webhook Daily voltar a funcionar, olhamos a razão
--        "% de fechamentos via webhook × cron" pra saber se o webhook
--        está cobrindo o que deveria.
--     2. Em debug ("por que esse appt virou no_show_doctor?"), sabemos
--        qual caminho de código disparou a decisão.
--
--   Idempotência: os updaters só preenchem `reconciled_at`/`reconciled_by_source`
--   se ainda estiverem nulos. Isso significa que quem chega primeiro
--   (webhook ou cron) deixa a marca. Posteriores são noop na audit trail
--   mas ainda rodam `applyNoShowPolicy` que é idempotente via próprio
--   guard (`no_show_policy_applied_at`).

alter table public.appointments
  add column if not exists reconciled_at timestamptz,
  add column if not exists reconciled_by_source text
    check (reconciled_by_source in ('daily_webhook', 'daily_cron', 'admin_manual'));

comment on column public.appointments.reconciled_at is
  'Momento em que o ciclo da consulta foi fechado (status virou terminal '
  'via processamento automatizado). Nulo pra appointments ainda ativos '
  'ou pra cancelamentos puramente administrativos que nunca chegaram à '
  'sala. Idempotente: uma vez preenchido, re-execuções não sobrescrevem.';

comment on column public.appointments.reconciled_by_source is
  'Que caminho fechou o ciclo: "daily_webhook" = evento meeting.ended '
  'em tempo real; "daily_cron" = reconciliação polling REST API (D-035, '
  'fallback ativo enquanto D-029 bloqueia o webhook em produção); '
  '"admin_manual" = override humano pelo painel admin.';

-- Index pra dashboards de observabilidade — "últimos N reconciliados",
-- "% por source nos últimos 7 dias", etc.
create index if not exists ix_appt_reconciled
  on public.appointments (reconciled_at desc, reconciled_by_source)
  where reconciled_at is not null;
