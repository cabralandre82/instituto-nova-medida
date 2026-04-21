-- ============================================================================
-- 20260505000000_cron_runs_skipped.sql
--
-- PR-050 · D-061 · Circuit breaker pra providers externos.
--
-- Contexto:
--   O CHECK atual de `cron_runs.status` só aceita ('running','ok','error').
--   Com circuit breaker, um cron que depende de provider externo (WhatsApp,
--   Asaas, Daily) pode *conscientemente* pular a execução quando o breaker
--   está OPEN — não é "erro" (não falhou), não é "ok" (não fez o trabalho),
--   nem "running" (nunca começou). Precisamos de um 4º estado explícito
--   pra auditoria não confundir com degradação.
--
-- Decisão:
--   Acrescentar 'skipped' ao CHECK. Semântica: o cron bate, vê que não vale
--   tentar, grava evidência (payload.skip_reason, payload.circuit_key) e
--   retorna. O dashboard /admin/crons (D-059) e o system-health mostram
--   essas execuções como "pulos" — não alertam, mas ficam visíveis.
--
--   `skipped` NÃO conta pra cálculo de success_rate no dashboard (elas não
--   representam trabalho feito nem trabalho falhado) — vira `skip_rate`
--   separado quando o dashboard quiser essa visão.
--
-- Reversibilidade:
--   Se precisar reverter: DROP CONSTRAINT + ADD com set antigo. Mas
--   destroy `skipped` rows (ou converter pra 'ok' com payload indicativo)
--   antes, senão o recheck falha.
-- ============================================================================

-- 1) Remove CHECK antigo (se existir — idempotência).
do $$
declare
  v_constraint_name text;
begin
  select con.conname into v_constraint_name
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
   where ns.nspname = 'public'
     and rel.relname = 'cron_runs'
     and con.contype = 'c'
     and pg_get_constraintdef(con.oid) ilike '%status%';

  if v_constraint_name is not null then
    execute format('alter table public.cron_runs drop constraint %I', v_constraint_name);
  end if;
end
$$;

-- 2) Re-adiciona com 'skipped' incluído. Default permanece 'running'.
alter table public.cron_runs
  add constraint cron_runs_status_check
  check (status in ('running', 'ok', 'error', 'skipped'));

comment on column public.cron_runs.status is
  'running | ok | error | skipped. ''skipped'' indica que o cron decidiu nao executar (ex.: circuit breaker do provider OPEN). Nao conta como falha.';
