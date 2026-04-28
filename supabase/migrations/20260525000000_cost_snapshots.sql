-- PR-045 · D-096
-- ──────────────────────────────────────────────────────────────────────────
-- cost_snapshots — fotografia diária de custo por provider externo.
-- ──────────────────────────────────────────────────────────────────────────
-- Contexto:
--   Operador solo precisa de sinal precoce quando algum provider externo
--   começar a custar fora do esperado (campanha viral, bug em loop, ataque
--   de API, mudança de plano sem aviso). Hoje só descobre na fatura mensal.
--
--   Audit [19.1 🟠 ALTO] (PR-045) cobra um dashboard `/admin/custos` com
--   custo estimado por provider + comparação mês-a-mês + alerta inline
--   pra picos.
--
-- Estratégia de coleta:
--   Cron diário (`/api/internal/cron/cost-snapshot`, 06:00 UTC ≈ 03:00 BRT)
--   computa MÉTRICAS DE USO interno como proxy para custo:
--
--   • whatsapp  → count(appointment_notifications.sent_at) +
--                 count(doctor_notifications.sent_at) +
--                 count(on_demand_request_dispatches WHERE dispatch_status='sent')
--                 × WA_COST_CENTS_PER_MESSAGE
--   • asaas     → count(payments.created_at) × ASAAS_FEE_FIXED_CENTS +
--                 sum(payments.amount_cents) × ASAAS_FEE_PCT_BPS / 10000
--   • daily     → count(appointments.scheduled_at WHERE status='completed') ×
--                 avg_duration_min × DAILY_COST_CENTS_PER_MINUTE
--   • vercel    → VERCEL_MONTHLY_CENTS / days_in_month (rateio diário)
--   • supabase  → SUPABASE_MONTHLY_CENTS / days_in_month (rateio diário)
--
--   Rates são configuráveis via env (defaults sensatos pra plano comum
--   PRO/Brasil). Não substituem fatura real — são early-warning.
--
-- Idempotência:
--   UNIQUE (snapshot_date, provider). Cron upsertea com ON CONFLICT
--   DO UPDATE: re-runs no mesmo dia atualizam o valor (uso real cresce
--   ao longo do dia, último compute vale).
--
-- Retenção:
--   Sem cron de purge dedicado. Volume é trivial (1 row por dia × 5
--   providers = 1825 linhas/ano). Sweep manual via SQL Studio se algum
--   dia incomodar.
-- ──────────────────────────────────────────────────────────────────────────

create table if not exists public.cost_snapshots (
  id              uuid primary key default gen_random_uuid(),

  -- Dia coberto pelo snapshot (UTC date — alinhado com cron diário).
  snapshot_date   date not null,

  -- Provider externo. Allowlist explícita; novos providers exigem
  -- migration nova (evita typo silencioso quebrar a UI).
  provider        text not null check (provider in (
    'asaas',
    'whatsapp',
    'daily',
    'vercel',
    'supabase'
  )),

  -- Quantidade de unidades consumidas no dia (msgs, transações, etc.).
  units           integer not null default 0 check (units >= 0),

  -- Rótulo de unidade pra UI ("mensagens", "transações", "minutos", "dias").
  unit_label      text not null default 'units' check (
    char_length(unit_label) between 1 and 32
  ),

  -- Estimativa de custo em centavos BRL. Não é fatura — é proxy pelas
  -- rates configuradas em env. A UI deixa isso explícito.
  estimated_cents integer not null default 0 check (estimated_cents >= 0),

  -- Breakdown adicional (ex.: { wa_messages: 100, doctor_messages: 20,
  -- on_demand: 5, rate_cents_per_message: 10 }). Source-of-truth pra
  -- auditoria de "por que esse valor?".
  metadata        jsonb not null default '{}'::jsonb,

  -- Quando esse snapshot foi computado pela última vez (re-run no
  -- mesmo dia atualiza este timestamp).
  computed_at     timestamptz not null default now(),

  -- Quando a row foi inserida pela primeira vez (imutável).
  created_at      timestamptz not null default now()
);

comment on table public.cost_snapshots is
  'PR-045 · D-096. Fotografia diária de custo estimado por provider externo. '
  'Computado pelo cron `/api/internal/cron/cost-snapshot`. Não substitui '
  'fatura real — é early-warning pro operador solo.';

comment on column public.cost_snapshots.snapshot_date is
  'Dia coberto pelo snapshot (UTC). 1 row por (date, provider).';

comment on column public.cost_snapshots.estimated_cents is
  'Estimativa em centavos BRL via rates configuradas em env. Allowance ±20% '
  'comparado a fatura real é normal (rates de provider mudam, cobrança em '
  'USD com FX, IOF, etc.).';

-- Idempotência: cron pode re-rodar pro mesmo dia.
create unique index if not exists ux_cost_snapshots_date_provider
  on public.cost_snapshots (snapshot_date, provider);

-- Lookup primário: dashboard busca janela [date >= ?, date <= ?] ordenado
-- por data desc.
create index if not exists ix_cost_snapshots_date_desc
  on public.cost_snapshots (snapshot_date desc, provider);

-- Per-provider rollup: "mostre últimos 30 dias do WhatsApp".
create index if not exists ix_cost_snapshots_provider_date
  on public.cost_snapshots (provider, snapshot_date desc);

-- ──────────────────────────────────────────────────────────────────────────
-- RLS
-- ──────────────────────────────────────────────────────────────────────────

alter table public.cost_snapshots enable row level security;
alter table public.cost_snapshots force row level security;

-- Sem policies → service_role lê/escreve (cron + admin UI), demais roles
-- bloqueados. Operador acessa via `/admin/custos` (server component que
-- usa `getSupabaseAdmin()`).

-- Trigger pra atualizar `computed_at` em UPSERTs idempotentes.
create or replace function public.cost_snapshots_touch_computed_at()
returns trigger
language plpgsql
as $$
begin
  if (new.units is distinct from old.units)
     or (new.estimated_cents is distinct from old.estimated_cents)
     or (new.metadata is distinct from old.metadata)
     or (new.unit_label is distinct from old.unit_label) then
    new.computed_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_cost_snapshots_touch on public.cost_snapshots;
create trigger trg_cost_snapshots_touch
  before update on public.cost_snapshots
  for each row execute function public.cost_snapshots_touch_computed_at();
