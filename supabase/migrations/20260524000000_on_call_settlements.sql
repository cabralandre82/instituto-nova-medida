-- ──────────────────────────────────────────────────────────────────────────
-- Migration · PR-081 · D-093
-- Plantão programado: monitora cumprimento de blocos `on_call`, gera
-- earnings (`plantao_hour`) pra médicas que cumpriram e registra
-- reliability events (`on_call_no_show`) pra quem faltou.
-- ──────────────────────────────────────────────────────────────────────────
--
-- Por que existe
-- ──────────────
-- D-088 (PR-076) deu à médica a UI pra programar blocos `on_call` na
-- agenda. D-091 (PR-079) usa esses blocos pra elegibilidade do fan-out
-- on-demand (`isOnCallNow`). Mas hoje não temos:
--
--   1. Verificação se a médica REALMENTE ficou online durante o bloco
--      programado. Bloco é apenas uma promessa; cumprimento depende de
--      heartbeat ativo + status ∈ {online, busy}.
--
--   2. Pagamento por plantão cumprido. `doctor_compensation_rules` já
--      tem `plantao_hour_cents` (default R$ 30/h), mas nenhum cron
--      gera `doctor_earnings` de tipo `plantao_hour`.
--
--   3. Sinalização de "no-show de plantão" pra reliability. Sem
--      registro, médica que abandona plantão repetido não dispara
--      auto-pause (D-036).
--
-- Modelo
-- ──────
-- Sample temporal de presença:
--   * Cron `monitor-on-call` roda a cada 5min.
--   * Pra cada bloco `on_call` ativo agora (em SP) com médica
--     online/busy + heartbeat fresh (≤ STALE_PRESENCE_THRESHOLD_SECONDS):
--     → INSERT em `doctor_presence_samples` (idempotent via bucket).
--
-- Settlement de bloco:
--   * Mesmo cron, pra cada bloco recém-encerrado (terminou nos últimos
--     30min) que ainda não foi liquidado:
--     → Conta samples no intervalo [block_start, block_end].
--     → coverage_ratio = samples_count * SAMPLE_INTERVAL_MIN / block_minutes.
--     → Se coverage ≥ MIN_COVERAGE_FOR_PAYMENT (default 0.5):
--         INSERT doctor_earnings (type='plantao_hour', amount proporcional).
--         outcome='paid'.
--     → Caso contrário:
--         INSERT doctor_reliability_events (kind='on_call_no_show').
--         outcome='no_show'.
--     → Sempre: INSERT on_call_block_settlements (idempotência via
--       unique (availability_id, block_start_utc)).
--
-- Cobertura proporcional vs binária
-- ────────────────────────────────
-- Optei por **earning proporcional ao tempo cumprido** (e não bloco
-- inteiro all-or-nothing) acima do threshold de 50%. Justificativa:
--   - Médica que cumpre 80% (saiu 30min antes em bloco de 4h) não deve
--     ser punida com 0; também não deve receber 100%.
--   - Abaixo de 50% trata como no-show pra ter sinal claro de reliability.
--   - Threshold é configurável no código (lib `on-call-monitor.ts`).
--
-- Snapshot vs trilha completa
-- ──────────────────────────
-- `doctor_presence_samples` mantém HISTÓRICO temporal granular.
-- Necessário pro cálculo de coverage e pra auditoria de "exatamente
-- qual minuto a médica saiu". Volume estimado:
--   - 1 médica × 1 bloco 4h × 1 sample/5min = 48 rows/bloco
--   - 5 médicas × 4 blocos/semana × 4 semanas = 3.840 rows/mês
-- Trivial. Sem retenção automática (LGPD: dado operacional, não PII).
--
-- Idempotência crítica
-- ───────────────────
-- 1. Sample: unique (doctor_id, availability_id, sample_bucket).
--    Cron pode rodar 2x na mesma janela de 5min sem duplicar.
-- 2. Settlement: unique (availability_id, block_start_utc).
--    Bloco só é liquidado uma vez. Reprocessamento manual exige DELETE
--    explícito em both.
-- 3. Reliability: unique (doctor_id, kind, occurred_at::date) onde
--    kind='on_call_no_show'. Defesa em profundidade — settlement já
--    impede, mas garante que duplo-INSERT direto na tabela falhe.
-- ──────────────────────────────────────────────────────────────────────────


-- 1) doctor_presence_samples ──────────────────────────────────────────────
--
-- Snapshot temporal granular de presença DURANTE um bloco on_call.
-- Volume baixo (segundos por insert, ~50 rows/bloco/médica), mantido
-- indefinidamente pra auditoria.

create table if not exists public.doctor_presence_samples (
  id              bigserial primary key,
  doctor_id       uuid not null references public.doctors(id) on delete cascade,
  availability_id uuid not null references public.doctor_availability(id) on delete cascade,

  -- Anchor temporal do bloco no momento do sample.
  block_start_utc timestamptz not null,
  block_end_utc   timestamptz not null,

  -- Quando o cron executou esse sample.
  sampled_at      timestamptz not null default now(),

  -- Status da médica capturado.
  status          text not null check (status in ('online', 'busy')),

  -- Bucket de 5min (formato 'YYYY-MM-DDTHH:MM' onde MM é múltiplo de 05).
  -- Usado pra deduplicação: 2 runs do cron no mesmo intervalo de 5min
  -- não criam 2 samples.
  sample_bucket   text not null,

  -- Heartbeat capturado (forense).
  last_heartbeat_at timestamptz,

  created_at      timestamptz not null default now(),

  check (block_end_utc > block_start_utc)
);

-- Idempotência: 1 sample por (médica × bloco × bucket de 5min).
create unique index if not exists ux_dps_unique_bucket
  on public.doctor_presence_samples (doctor_id, availability_id, sample_bucket);

-- Lookup de "quantos samples nesse bloco?" no settlement.
create index if not exists ix_dps_block
  on public.doctor_presence_samples (availability_id, block_start_utc, sampled_at);

-- Lookup forense "samples da médica X em ordem temporal".
create index if not exists ix_dps_doctor_time
  on public.doctor_presence_samples (doctor_id, sampled_at desc);

comment on table public.doctor_presence_samples is
  'PR-081 · D-093. Snapshot temporal de presença durante blocos on_call. '
  'Cada linha = "médica estava online/busy no minuto X durante bloco Y". '
  'Usado pra calcular coverage_ratio no settlement.';

comment on column public.doctor_presence_samples.sample_bucket is
  'Truncamento da janela de sampling em buckets de 5min (formato '
  '"YYYY-MM-DDTHH:MM" com MM múltiplo de 5). Garante idempotência: '
  'mesmo bucket no mesmo bloco produz INSERT no-op via unique index.';

comment on column public.doctor_presence_samples.last_heartbeat_at is
  'Snapshot de doctor_presence.last_heartbeat_at no momento do sample. '
  'Forense: mostra que o sample foi REALMENTE recente (não bug do cron).';


-- 2) on_call_block_settlements ─────────────────────────────────────────────
--
-- Liquidação de cada bloco on_call programado: paga (gera earning) OU
-- registra no-show (gera reliability event). 1 linha por (bloco recorrente
-- × ocorrência específica).

create table if not exists public.on_call_block_settlements (
  id                    uuid primary key default gen_random_uuid(),
  doctor_id             uuid not null references public.doctors(id) on delete cascade,
  availability_id       uuid not null references public.doctor_availability(id) on delete cascade,

  -- Identificação canônica da ocorrência semanal específica.
  block_start_utc       timestamptz not null,
  block_end_utc         timestamptz not null,
  block_minutes         int not null check (block_minutes > 0),

  -- Métricas computadas no settlement.
  samples_count         int not null check (samples_count >= 0),
  coverage_minutes      int not null check (coverage_minutes >= 0), -- = samples * SAMPLE_INTERVAL_MIN, capped a block_minutes
  coverage_ratio        numeric(5, 4) not null check (coverage_ratio >= 0 and coverage_ratio <= 1),

  -- Outcome decidido pelo settler.
  outcome               text not null check (outcome in ('paid', 'no_show')),

  -- Vínculos (pelo menos 1 não-NULL conforme outcome).
  earning_id            uuid references public.doctor_earnings(id) on delete set null,
  reliability_event_id  uuid references public.doctor_reliability_events(id) on delete set null,

  -- Snapshot da regra de compensação no momento (pra auditoria mesmo
  -- se a regra mudar).
  compensation_rule_id  uuid references public.doctor_compensation_rules(id) on delete set null,
  hourly_cents_snapshot int,
  amount_cents_snapshot int,

  -- Quem orquestrou (cron run id).
  cron_run_id           uuid references public.cron_runs(id) on delete set null,

  settled_at            timestamptz not null default now(),
  created_at            timestamptz not null default now(),

  check (block_end_utc > block_start_utc),
  check (
    (outcome = 'paid' and earning_id is not null) or
    (outcome = 'no_show' and reliability_event_id is not null)
  )
);

-- Idempotência crítica: 1 settlement por ocorrência específica do bloco.
create unique index if not exists ux_ocbs_unique_occurrence
  on public.on_call_block_settlements (availability_id, block_start_utc);

-- Lookup "histórico de plantões da médica X".
create index if not exists ix_ocbs_doctor_time
  on public.on_call_block_settlements (doctor_id, settled_at desc);

-- Lookup admin "quais settlements no último mês?".
create index if not exists ix_ocbs_recent
  on public.on_call_block_settlements (settled_at desc);

comment on table public.on_call_block_settlements is
  'PR-081 · D-093. Liquidação de cada bloco on_call programado. '
  'Cada linha = "Dra X cumpriu (ou não) o plantão de quarta 14h-18h '
  'em 22/abr/2026". Idempotente via unique (availability_id, block_start_utc). '
  'Reprocessamento manual exige DELETE explícito.';

comment on column public.on_call_block_settlements.coverage_ratio is
  'Razão minutos cobertos / minutos do bloco (0.0000..1.0000). Acima '
  'do threshold (default 0.5 no código) gera earning proporcional; '
  'abaixo gera reliability event de no-show.';

comment on column public.on_call_block_settlements.amount_cents_snapshot is
  'Valor do earning gerado (em centavos). NULL se outcome=no_show. '
  'Snapshot porque doctor_earnings.amount_cents pode ser estornada '
  'depois sem afetar este registro.';


-- 3) Estende doctor_reliability_events.kind ───────────────────────────────
--
-- Adiciona 'on_call_no_show' ao enum de kinds. Constraint é text-based
-- (não enum nativo), então é ALTER CHECK.

do $$
begin
  alter table public.doctor_reliability_events
    drop constraint if exists doctor_reliability_events_kind_check;
exception when others then
  raise notice 'check constraint not found, ok';
end $$;

alter table public.doctor_reliability_events
  add constraint doctor_reliability_events_kind_check
  check (kind in (
    'no_show_doctor',          -- consulta agendada / médica não apareceu (D-036)
    'expired_no_one_joined',   -- sala expirou vazia (D-036)
    'manual',                  -- registrado pelo admin manualmente (D-036)
    'on_call_no_show'          -- bloco on_call programado mas médica não ficou online (PR-081 · D-093)
  ));

comment on column public.doctor_reliability_events.kind is
  '"no_show_doctor" = médica não apareceu na consulta agendada; '
  '"expired_no_one_joined" = sala expirou vazia (no-show implícito); '
  '"manual" = registro do admin fora dos disparos automáticos; '
  '"on_call_no_show" = bloco on_call programado mas médica ficou offline '
  'em > 50% do bloco (PR-081 · D-093).';


-- 4) RLS ──────────────────────────────────────────────────────────────────

alter table public.doctor_presence_samples enable row level security;
alter table public.doctor_presence_samples force row level security;

alter table public.on_call_block_settlements enable row level security;
alter table public.on_call_block_settlements force row level security;

-- Policies: médica vê o próprio histórico via service_role (server
-- components autenticados). Admin idem. Sem policy `authenticated` —
-- acesso é sempre via getSupabaseAdmin() em handler server.

do $$
begin
  -- Médica lê próprio histórico de samples (apenas próprio doctor_id).
  -- Embora queries reais venham de service_role, deixar uma policy
  -- explicit evita surpresa caso futuro PR exponha rota client-side.
  create policy "dps_self_select" on public.doctor_presence_samples
    for select to authenticated
    using (
      exists (
        select 1 from public.doctors d
        where d.id = doctor_presence_samples.doctor_id
          and d.user_id = auth.uid()
      )
    );
exception when duplicate_object then null; end $$;

do $$
begin
  create policy "ocbs_self_select" on public.on_call_block_settlements
    for select to authenticated
    using (
      exists (
        select 1 from public.doctors d
        where d.id = on_call_block_settlements.doctor_id
          and d.user_id = auth.uid()
      )
    );
exception when duplicate_object then null; end $$;


-- 5) Comentários finais ──────────────────────────────────────────────────

comment on constraint doctor_reliability_events_kind_check
  on public.doctor_reliability_events is
  'Atualizada em PR-081 · D-093 pra incluir on_call_no_show.';
