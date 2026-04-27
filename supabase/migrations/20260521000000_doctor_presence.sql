-- ───────────────────────────────────────────────────────────────────────
-- Migration: 20260521000000_doctor_presence
-- Decisão arquitetural: D-087 (PR-075-B · base pra plantão e on-demand)
--
-- Contexto
-- ────────
-- Pra ter atendimento on-demand (PR-079+) e visibilidade de plantão
-- (PR-078), precisamos saber em tempo real **quais médicas estão
-- online**. Hoje a única dimensão de "disponibilidade" é
-- `doctor_availability` (regra semanal recorrente), que diz
-- "Dra. Joana atende plantão segundas 14h-18h" — mas não diz se
-- ela tá com a aba do dashboard aberta agora, com câmera testada,
-- pronta pra atender.
--
-- O modelo aqui é **soft real-time**: a UI da médica em
-- `/medico/plantao` envia heartbeats periódicos pro backend
-- (a cada 30s); se o backend não recebeu heartbeat há
-- `STALE_THRESHOLD_SECONDS` (120s no MVP), um cron marca
-- a presença como `offline` automaticamente.
--
-- Esse modelo é deliberadamente **simples**:
--
--   1. Não usa WebSocket nem realtime do Supabase. A frequência
--      do heartbeat (30s) e do cron de varrição (60s) são
--      compatíveis com o SLA on-demand (paciente espera ~2-3min,
--      veja PR-079).
--   2. Uma linha por médica (UNIQUE doctor_id). Sem histórico
--      explícito — quando a médica vai offline, sobrescrevemos a
--      mesma linha. Trilha "quem atendeu paciente X" mora em
--      `appointments` + `appointment_notifications` + `cron_runs`.
--      Histórico granular de presença (login/logout) viraria PR
--      futuro só se a operação pedir.
--   3. Status discreto: 'online' | 'busy' | 'offline'.
--      'busy' = em consulta ativa (médica continua "logada" mas
--      não recebe novo on-demand). PR-079 usa 'online' como
--      filtro de elegibilidade.
--
-- Schema
-- ──────
-- doctor_presence (
--   doctor_id           uuid pk references doctors(id) on delete cascade
--   status              text check ('online'|'busy'|'offline')
--   last_heartbeat_at   timestamptz — UI ping mais recente
--   online_since        timestamptz — começo do trecho atual ≠ offline
--                                     (NULL quando offline)
--   source              text — 'manual' (doctor toggled) ou 'auto_offline'
--                              (cron stale-presence forçou offline)
--   client_meta         jsonb — { ua, app_version, ip_hash } (LGPD-safe)
--   updated_at          timestamptz
--   created_at          timestamptz
-- )
--
-- Índices forenses + operacionais:
--   - pk (doctor_id) — lookup por médica.
--   - (status, last_heartbeat_at desc) — varrição do cron e
--     "quem tá online agora" pra fan-out PR-079.
--
-- RLS: deny-by-default. Service role lê/escreve via getSupabaseAdmin().
-- A médica vê o próprio status na UI via server component que usa
-- getSupabaseServer + filtro doctor_id = self. Não há policy
-- RLS pra `authenticated` — o acesso da médica acontece sempre via
-- handler server-side autenticado.
-- ───────────────────────────────────────────────────────────────────────

-- 1) Tabela ──────────────────────────────────────────────────────────

create table if not exists public.doctor_presence (
  doctor_id uuid primary key references public.doctors(id) on delete cascade,

  status text not null
    check (status in ('online', 'busy', 'offline')),

  last_heartbeat_at timestamptz not null default now(),
  online_since timestamptz,

  source text not null default 'manual'
    check (source in ('manual', 'auto_offline')),

  client_meta jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Coerência: offline implica online_since IS NULL.
  -- online/busy implicam online_since IS NOT NULL.
  constraint doctor_presence_online_since_coerent
    check (
      (status = 'offline' and online_since is null) or
      (status in ('online', 'busy') and online_since is not null)
    ),

  -- Tamanho defensivo do client_meta serializado.
  constraint doctor_presence_client_meta_size
    check (octet_length(client_meta::text) <= 4096)
);

-- 2) Índices ─────────────────────────────────────────────────────────

create index if not exists ix_doctor_presence_status_heartbeat
  on public.doctor_presence (status, last_heartbeat_at desc);

create index if not exists ix_doctor_presence_online_since
  on public.doctor_presence (online_since desc)
  where status in ('online', 'busy');

-- 3) Trigger updated_at ──────────────────────────────────────────────

create or replace function public.tg_doctor_presence_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_doctor_presence_updated_at on public.doctor_presence;
create trigger trg_doctor_presence_updated_at
  before update on public.doctor_presence
  for each row execute function public.tg_doctor_presence_touch_updated_at();

-- 4) RPC: presence_heartbeat ─────────────────────────────────────────
--
-- Idempotente. Contrato:
--   - Linha não existe → cria como 'online' (UI só chama heartbeat
--     depois de ter feito set_status, mas ser permissivo é robusto).
--   - Linha existe e status != 'offline' → atualiza last_heartbeat_at.
--   - Linha existe e status == 'offline' → atualiza last_heartbeat_at
--     mas NÃO muda o status. Médica precisa explicitamente voltar
--     pra 'online' via /api/medico/presence/status (a UI só envia
--     heartbeat quando o toggle "estou de plantão" está ativo, então
--     na prática esse caso só acontece se cron stale-presence forçou
--     offline e a UI ainda mandou um heartbeat residual).
--
-- Retorna a linha atualizada pra UI mostrar "ping ok" ou pedir
-- re-toggle.

create or replace function public.presence_heartbeat(
  p_doctor_id uuid,
  p_client_meta jsonb default '{}'::jsonb
)
returns public.doctor_presence
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.doctor_presence;
  v_now timestamptz := now();
begin
  if p_doctor_id is null then
    raise exception 'p_doctor_id obrigatório' using errcode = '22023';
  end if;

  insert into public.doctor_presence (
    doctor_id, status, last_heartbeat_at, online_since,
    source, client_meta
  )
  values (
    p_doctor_id, 'online', v_now, v_now, 'manual',
    coalesce(p_client_meta, '{}'::jsonb)
  )
  on conflict (doctor_id) do update
    set
      last_heartbeat_at = v_now,
      client_meta = coalesce(excluded.client_meta, public.doctor_presence.client_meta)
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.presence_heartbeat is
  'PR-075-B · D-087. Refresca last_heartbeat_at sem forçar status. Use set_presence_status pra mudar online/busy/offline.';

-- 5) RPC: set_presence_status ────────────────────────────────────────
--
-- Mudança explícita de status pelo toggle da UI ou pelo cron.
-- Mantém consistência:
--
--   - 'online' → online_since := now() se vinha de offline; preserva
--     se vinha de busy.
--   - 'busy'   → online_since preserva (transição interna).
--   - 'offline'→ online_since := null.
--
-- p_source distingue toggle manual da médica vs auto-offline do cron.

create or replace function public.set_presence_status(
  p_doctor_id uuid,
  p_status text,
  p_source text default 'manual',
  p_client_meta jsonb default null
)
returns public.doctor_presence
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.doctor_presence;
  v_now timestamptz := now();
  v_existing public.doctor_presence;
  v_new_online_since timestamptz;
begin
  if p_doctor_id is null then
    raise exception 'p_doctor_id obrigatório' using errcode = '22023';
  end if;
  if p_status not in ('online', 'busy', 'offline') then
    raise exception 'status inválido: %', p_status using errcode = '22023';
  end if;
  if p_source not in ('manual', 'auto_offline') then
    raise exception 'source inválido: %', p_source using errcode = '22023';
  end if;

  select * into v_existing
    from public.doctor_presence
   where doctor_id = p_doctor_id;

  if not found then
    -- Linha nova: só faz sentido com 'online' ou 'busy' (offline é o
    -- estado default conceitual sem linha). Se quem chama pediu
    -- 'offline' pra um doutor sem registro, criamos a linha mesmo
    -- assim pra honrar o pedido — mas online_since fica null.
    if p_status = 'offline' then
      v_new_online_since := null;
    else
      v_new_online_since := v_now;
    end if;

    insert into public.doctor_presence (
      doctor_id, status, last_heartbeat_at, online_since,
      source, client_meta
    )
    values (
      p_doctor_id, p_status, v_now, v_new_online_since, p_source,
      coalesce(p_client_meta, '{}'::jsonb)
    )
    returning * into v_row;
    return v_row;
  end if;

  -- Linha existente: calcula novo online_since.
  if p_status = 'offline' then
    v_new_online_since := null;
  elsif v_existing.status = 'offline' then
    v_new_online_since := v_now;  -- voltou de offline
  else
    v_new_online_since := v_existing.online_since;  -- transição interna online↔busy
  end if;

  update public.doctor_presence
     set status = p_status,
         last_heartbeat_at = v_now,
         online_since = v_new_online_since,
         source = p_source,
         client_meta = coalesce(p_client_meta, client_meta)
   where doctor_id = p_doctor_id
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.set_presence_status is
  'PR-075-B · D-087. Mudança explícita de status. Mantém online_since coerente. p_source = manual (UI) ou auto_offline (cron).';

-- 6) RLS deny-by-default ─────────────────────────────────────────────

alter table public.doctor_presence enable row level security;
alter table public.doctor_presence force row level security;

-- Sem policies. Acesso só via service_role (admin lib + RPC com
-- security definer).

-- 7) Comentários ───────────────────────────────────────────────────────

comment on table public.doctor_presence is
  'PR-075-B · D-087. Presença real-time da médica no dashboard. UI envia heartbeat 30s; cron stale-presence força offline após 120s sem heartbeat.';

comment on column public.doctor_presence.status is
  'online (recebe on-demand) | busy (em consulta) | offline (não disponível).';

comment on column public.doctor_presence.last_heartbeat_at is
  'Último ping da UI. Cron compara com now() - STALE_THRESHOLD pra forçar offline.';

comment on column public.doctor_presence.online_since is
  'Início do trecho atual de online/busy. NULL quando offline. Usado pra contagem de tempo de plantão (PR-081).';

comment on column public.doctor_presence.source is
  'manual (médica toggled via UI) | auto_offline (cron stale-presence forçou).';

comment on column public.doctor_presence.client_meta is
  'JSONB com user_agent, app_version, ip_hash. Sem PII direta.';
