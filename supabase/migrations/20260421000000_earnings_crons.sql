-- Instituto Nova Medida · Migration 014
-- D-040 · Crons financeiros observáveis em Node
--
-- Contexto:
--   A migration 005 criou `recalculate_earnings_availability()` e
--   `generate_monthly_payouts()` como RPCs Postgres agendadas via pg_cron.
--   Problemas identificados em produção:
--     1. pg_cron pode não estar habilitado em todos os ambientes (o próprio
--        CREATE EXTENSION dá `raise notice` sem falhar).
--     2. RPCs retornam só `int` — zero observabilidade sobre o que rodou
--        (quantas earnings promovidas, quais médicas sem pix_key, etc).
--     3. Médicas com saldo mas sem `doctor_payment_methods.active=true`
--        são silenciosamente puladas — admin nunca sabe.
--
-- Estratégia:
--   * Reimplementar a lógica em Node (src/lib/earnings-availability.ts
--     e src/lib/monthly-payouts.ts) chamada por Vercel Crons. As RPCs
--     continuam no banco como backup idempotente em caso de queda do
--     Vercel.
--   * Adicionar observabilidade via `cron_runs` (execução a execução)
--     e marca `auto_generated` no payout pra a UI admin destacar drafts
--     que nasceram do cron vs. manuais futuros.

-- ──────────────────────────────────────────────────────────────────────────
-- 1) doctor_payouts.auto_generated
-- ──────────────────────────────────────────────────────────────────────────

alter table public.doctor_payouts
  add column if not exists auto_generated boolean not null default false;

comment on column public.doctor_payouts.auto_generated is
  'true quando o payout foi criado pelo cron mensal (D-040). false para drafts manuais ou legado.';

-- ──────────────────────────────────────────────────────────────────────────
-- 2) cron_runs — trilha de execução dos crons financeiros (e futuros)
-- ──────────────────────────────────────────────────────────────────────────

create table if not exists public.cron_runs (
  id uuid primary key default gen_random_uuid(),
  job text not null,                                   -- 'recalc_earnings_availability' | 'generate_monthly_payouts' | ...
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running'               -- 'running' | 'ok' | 'error'
    check (status in ('running', 'ok', 'error')),
  duration_ms int,
  payload jsonb,                                       -- métricas da execução (counts, warnings, erros)
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists idx_cron_runs_job_started on public.cron_runs(job, started_at desc);
create index if not exists idx_cron_runs_status on public.cron_runs(status);

comment on table public.cron_runs is
  'Auditoria de execução de crons financeiros (D-040). Cada execução cria um registro, permitindo health check e debugging.';

-- ──────────────────────────────────────────────────────────────────────────
-- 3) Policy RLS — só service_role lê/escreve
-- ──────────────────────────────────────────────────────────────────────────

alter table public.cron_runs enable row level security;

-- Nenhuma policy pública: service_role bypasses RLS; roles autenticados
-- não veem nada (dashboards admin usam service key).
