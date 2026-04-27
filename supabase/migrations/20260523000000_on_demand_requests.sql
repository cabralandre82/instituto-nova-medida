-- ──────────────────────────────────────────────────────────────────────────
-- Migration · PR-079 · D-091
-- Backend de atendimento on-demand: paciente solicita consulta agora,
-- médica em plantão aceita, sistema cria appointment e link de sala.
-- ──────────────────────────────────────────────────────────────────────────
--
-- Por que existe
-- ──────────────
-- "Quero atendimento agora" é o caso mais frequente que o produto vai
-- atender pós-D-088 (médica edita plantão) e D-089 (notifs WA pra
-- médica). Hoje só temos:
--   - Agendamento programado: paciente escolhe horário > 30min no
--     futuro, espera. (PR-075-A.)
--   - Plantão: médica marca disponibilidade (D-088) e fica online
--     (D-087), mas paciente NÃO TEM como solicitar atendimento agora.
--
-- Esta migration introduz `on_demand_requests` (a fila) e
-- `on_demand_request_dispatches` (registro forense de fan-out pra
-- cada médica candidata).
--
-- Modelo de fila vs ranking
-- ─────────────────────────
-- Optei por **fan-out paralelo** em vez de fila ranqueada por
-- prioridade:
--
--   - Operação solo (1-2 médicas em produção). Ranking sofisticado
--     (round-robin, queueing-theory) é prematura optimization.
--   - Fan-out manda WA pra TODAS as médicas online (≤ MAX_FANOUT).
--     A primeira que responde "aceito" ganha — o restante recebe um
--     stale link (link com `request.status='accepted'` retornando 409).
--   - Race-safe via UPDATE ... WHERE status='pending' RETURNING (single
--     statement em SQL, sem transação explícita).
--
-- Lifecycle
-- ─────────
--   pending  →  accepted  (médica clicou no link)
--   pending  →  cancelled (paciente desistiu na UI)
--   pending  →  expired   (cron sweep após TTL)
--
-- Estados terminais (accepted/cancelled/expired) são **imutáveis**
-- via trigger.
--
-- Idempotência (paciente)
-- ──────────────────────
-- Cliente clica 2x no botão "Solicitar atendimento" → não cria 2
-- requests pending. Unique parcial em (customer_id, status='pending')
-- bloqueia. RPC `create_on_demand_request` retorna o id existente em
-- vez de erro — o caller fica sem saber se acabou de criar ou se a
-- linha já existia, mas isso é desejável ("clicou 2x mas só vê 1
-- request").
--
-- Idempotência (fan-out)
-- ─────────────────────
-- O dispatch repetido pra mesma (request, médica) é bloqueado por
-- unique (request_id, doctor_id). Permite retry da fan-out sem
-- duplicar mensagens WhatsApp.
--
-- Retenção / forense
-- ──────────────────
-- - `on_demand_requests` retém indefinidamente (LGPD: paciente tem
--   anonymize separado).
-- - `on_demand_request_dispatches` retém indefinidamente (forense
--   "avisamos a Dra. X às 14:32, ela não respondeu" pra disputa de
--   plantão / no-show).
-- ──────────────────────────────────────────────────────────────────────────

create table if not exists public.on_demand_requests (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references public.customers(id) on delete restrict,

  -- Lifecycle
  status text not null default 'pending' check (status in (
    'pending', 'accepted', 'cancelled', 'expired'
  )),

  -- TTL: paciente espera no máximo `expires_at - created_at`. Default
  -- na inserção é now() + 5 minutos (definido pela RPC).
  expires_at timestamptz not null,

  -- Anchor pro fan-out + lookup
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Conteúdo do request
  chief_complaint text not null
    check (char_length(chief_complaint) between 4 and 500),

  -- Quando aceito
  accepted_at timestamptz,
  accepted_doctor_id uuid references public.doctors(id) on delete set null,
  accepted_appointment_id uuid references public.appointments(id) on delete set null,

  -- Quando cancelado
  cancelled_at timestamptz,
  cancelled_reason text check (cancelled_reason is null or
    char_length(cancelled_reason) between 1 and 500),
  cancelled_by_kind text check (cancelled_by_kind is null or
    cancelled_by_kind in ('patient', 'admin', 'system')),

  -- Coerência: campos de aceite só existem se status=accepted.
  constraint on_demand_accepted_coherent check (
    (status = 'accepted'
       and accepted_at is not null
       and accepted_doctor_id is not null
       and accepted_appointment_id is not null)
    or
    (status <> 'accepted'
       and accepted_at is null
       and accepted_doctor_id is null
       and accepted_appointment_id is null)
  ),

  constraint on_demand_cancelled_coherent check (
    (status = 'cancelled' and cancelled_at is not null)
    or
    (status <> 'cancelled' and cancelled_at is null)
  )
);

comment on table public.on_demand_requests is
  'PR-079 · D-091. Fila de pacientes solicitando consulta agora.';

-- Índice forense pra dashboard admin: o que está pending e há quanto
-- tempo.
create index if not exists ix_odr_pending_age
  on public.on_demand_requests (created_at desc)
  where status = 'pending';

-- Índice pro cron: vencidos.
create index if not exists ix_odr_expired_sweep
  on public.on_demand_requests (expires_at)
  where status = 'pending';

create index if not exists ix_odr_customer_recent
  on public.on_demand_requests (customer_id, created_at desc);

create index if not exists ix_odr_doctor
  on public.on_demand_requests (accepted_doctor_id, accepted_at desc)
  where accepted_doctor_id is not null;

-- Idempotência paciente: 1 pending por customer.
create unique index if not exists ux_odr_one_pending_per_customer
  on public.on_demand_requests (customer_id)
  where status = 'pending';

-- Trigger touch updated_at.
create or replace function public.tg_odr_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tg_odr_touch_updated_at on public.on_demand_requests;
create trigger tg_odr_touch_updated_at
  before update on public.on_demand_requests
  for each row execute function public.tg_odr_touch_updated_at();

-- Trigger imutabilidade: estado terminal não pode ser alterado.
create or replace function public.tg_odr_terminal_immutable()
returns trigger
language plpgsql
as $$
begin
  if old.status in ('accepted', 'cancelled', 'expired')
     and new.status <> old.status then
    raise exception 'on_demand_requests.status terminal não pode ser alterado (% → %)',
      old.status, new.status using errcode = '22000';
  end if;
  return new;
end;
$$;

drop trigger if exists tg_odr_terminal_immutable on public.on_demand_requests;
create trigger tg_odr_terminal_immutable
  before update on public.on_demand_requests
  for each row execute function public.tg_odr_terminal_immutable();

-- RLS deny-by-default. Acesso só via service_role.
alter table public.on_demand_requests enable row level security;

-- ──────────────────────────────────────────────────────────────────────────
-- Tabela: on_demand_request_dispatches
-- ──────────────────────────────────────────────────────────────────────────
-- Forense do fan-out: pra cada médica que recebeu a notificação
-- WhatsApp daquele request, registra timestamp + outcome.
--
-- Decisão de não usar `doctor_notifications` (PR-077): o ciclo de vida
-- do fan-out é diferente — vários disparos quase-simultâneos, todos
-- pra mesma "ocasião" (1 paciente solicitando), e não há
-- appointment_id (o appointment só nasce quando uma médica aceita).
-- Reaproveitar `doctor_notifications` quebraria os 3 unique parciais
-- (não há anchor compatível). Custo de tabela nova: 1 migration; ROI:
-- semantica clara + observability dedicada em PR-082.

create table if not exists public.on_demand_request_dispatches (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references public.on_demand_requests(id) on delete cascade,
  doctor_id   uuid not null references public.doctors(id) on delete cascade,

  -- Forense
  channel text not null default 'whatsapp' check (channel = 'whatsapp'),
  dispatched_at timestamptz not null default now(),
  dispatch_status text not null default 'sent' check (dispatch_status in (
    'sent', 'failed', 'skipped'
  )),

  wa_message_id text,
  error text,

  -- Contexto pra dashboard
  doctor_was_online boolean,
  doctor_was_on_call boolean
);

comment on table public.on_demand_request_dispatches is
  'PR-079 · D-091. Forense de fan-out: 1 row por (request, médica).';

-- Idempotência: 1 dispatch por (request, doctor).
create unique index if not exists ux_odrd_request_doctor
  on public.on_demand_request_dispatches (request_id, doctor_id);

create index if not exists ix_odrd_request
  on public.on_demand_request_dispatches (request_id, dispatched_at desc);

create index if not exists ix_odrd_doctor_recent
  on public.on_demand_request_dispatches (doctor_id, dispatched_at desc);

alter table public.on_demand_request_dispatches enable row level security;

-- ──────────────────────────────────────────────────────────────────────────
-- RPC: create_on_demand_request
-- ──────────────────────────────────────────────────────────────────────────
-- Idempotente. Se o customer já tem 1 pending, retorna o id existente
-- (sem 23505) — bloqueia clique-duplo na UI sem oracle pra atacante.

create or replace function public.create_on_demand_request(
  p_customer_id uuid,
  p_chief_complaint text,
  p_ttl_seconds int default 300
)
returns table (
  request_id uuid,
  is_new boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing uuid;
  v_id uuid;
  v_now timestamptz := now();
  v_ttl int := greatest(60, least(p_ttl_seconds, 1800));
begin
  if p_customer_id is null then
    raise exception 'customer_id_required' using errcode = '22023';
  end if;
  if p_chief_complaint is null
     or char_length(trim(p_chief_complaint)) < 4 then
    raise exception 'chief_complaint_too_short' using errcode = '22023';
  end if;
  if char_length(p_chief_complaint) > 500 then
    raise exception 'chief_complaint_too_long' using errcode = '22023';
  end if;

  -- Idempotência: se já tem 1 pending pro mesmo customer, devolve.
  select id into v_existing
    from public.on_demand_requests
   where customer_id = p_customer_id
     and status = 'pending'
   for update skip locked;

  if v_existing is not null then
    return query select v_existing, false;
    return;
  end if;

  insert into public.on_demand_requests (
    customer_id,
    status,
    expires_at,
    chief_complaint
  ) values (
    p_customer_id,
    'pending',
    v_now + make_interval(secs => v_ttl),
    p_chief_complaint
  )
  returning id into v_id;

  return query select v_id, true;
end;
$$;

comment on function public.create_on_demand_request is
  'PR-079 · D-091. Cria on-demand request idempotente por customer. '
  'Retorna (request_id, is_new=true|false). Em is_new=false, o customer '
  'já tinha 1 pending e devolvemos o existente.';

-- ──────────────────────────────────────────────────────────────────────────
-- RPC: accept_on_demand_request
-- ──────────────────────────────────────────────────────────────────────────
-- Atomicidade: tudo em 1 chamada. Race-safe.
--
-- Sequência:
--   1. UPDATE com guard `WHERE status='pending' AND expires_at > now()`.
--      Se 0 rows afetadas, retorna `{accepted:false, reason}`.
--   2. INSERT em appointments com kind='on_demand', status='scheduled',
--      scheduled_at=now(), payment_id=NULL.
--   3. UPDATE on_demand_requests preenchendo accepted_*.
--
-- Por que kind='on_demand': geração de earning vai usar essa key pra
-- distinguir bonus (PR-081). Por que status='scheduled' (não
-- 'in_progress'): a transição vira 'in_progress' quando a médica
-- entra na sala via Daily (igual fluxo regular).

create or replace function public.accept_on_demand_request(
  p_request_id uuid,
  p_doctor_id uuid,
  p_duration_minutes int default 30,
  p_recording_consent boolean default false
)
returns table (
  accepted boolean,
  appointment_id uuid,
  reason text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_request public.on_demand_requests;
  v_appt_id uuid;
  v_ends timestamptz := v_now + make_interval(mins => coalesce(p_duration_minutes, 30));
begin
  if p_request_id is null then
    raise exception 'request_id_required' using errcode = '22023';
  end if;
  if p_doctor_id is null then
    raise exception 'doctor_id_required' using errcode = '22023';
  end if;
  if p_duration_minutes is null
     or p_duration_minutes <= 0
     or p_duration_minutes > 120 then
    raise exception 'duration_minutes_out_of_range' using errcode = '22023';
  end if;

  -- 1. Lock + valida.
  select * into v_request
    from public.on_demand_requests
   where id = p_request_id
   for update;

  if not found then
    return query select false, null::uuid, 'not_found'::text;
    return;
  end if;

  if v_request.status <> 'pending' then
    return query select false, null::uuid, ('already_' || v_request.status)::text;
    return;
  end if;

  if v_request.expires_at <= v_now then
    -- Marca expirado e retorna falha.
    update public.on_demand_requests
       set status = 'expired'
     where id = p_request_id and status = 'pending';
    return query select false, null::uuid, 'expired'::text;
    return;
  end if;

  -- 2. Cria appointment (sem checar overlap — on-demand é "agora",
  --    se a médica decidiu aceitar, ela está ciente que vai
  --    entrar em consulta).
  insert into public.appointments (
    doctor_id,
    customer_id,
    kind,
    scheduled_at,
    scheduled_until,
    status,
    pending_payment_expires_at,
    recording_consent
  ) values (
    p_doctor_id,
    v_request.customer_id,
    'on_demand',
    v_now,
    v_ends,
    'scheduled',
    null,
    coalesce(p_recording_consent, false)
  )
  returning id into v_appt_id;

  -- 3. Marca aceito.
  update public.on_demand_requests
     set status = 'accepted',
         accepted_at = v_now,
         accepted_doctor_id = p_doctor_id,
         accepted_appointment_id = v_appt_id
   where id = p_request_id;

  return query select true, v_appt_id, null::text;
end;
$$;

comment on function public.accept_on_demand_request is
  'PR-079 · D-091. Médica aceita on-demand request. Atomic: cria '
  'appointment kind=on_demand status=scheduled E marca request '
  'accepted. Retorna (accepted, appointment_id, reason).';

-- ──────────────────────────────────────────────────────────────────────────
-- RPC: cancel_on_demand_request
-- ──────────────────────────────────────────────────────────────────────────
-- Cancela um pending. Idempotente (já cancelado = no-op).

create or replace function public.cancel_on_demand_request(
  p_request_id uuid,
  p_actor_kind text,
  p_reason text default null
)
returns table (
  cancelled boolean,
  reason text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_status text;
begin
  if p_request_id is null then
    raise exception 'request_id_required' using errcode = '22023';
  end if;
  if p_actor_kind not in ('patient', 'admin', 'system') then
    raise exception 'actor_kind_invalid' using errcode = '22023';
  end if;

  select status into v_status
    from public.on_demand_requests
   where id = p_request_id
   for update;

  if not found then
    return query select false, 'not_found'::text;
    return;
  end if;

  if v_status = 'cancelled' then
    return query select true, 'already_cancelled'::text;
    return;
  end if;

  if v_status <> 'pending' then
    return query select false, ('cannot_cancel_' || v_status)::text;
    return;
  end if;

  update public.on_demand_requests
     set status = 'cancelled',
         cancelled_at = v_now,
         cancelled_by_kind = p_actor_kind,
         cancelled_reason = nullif(trim(coalesce(p_reason, '')), '')
   where id = p_request_id and status = 'pending';

  return query select true, null::text;
end;
$$;

comment on function public.cancel_on_demand_request is
  'PR-079 · D-091. Cancela on-demand request pending. Idempotente. '
  'p_actor_kind ∈ (patient, admin, system).';

-- ──────────────────────────────────────────────────────────────────────────
-- RPC: expire_stale_on_demand_requests
-- ──────────────────────────────────────────────────────────────────────────
-- Sweep do cron. Marca expired qualquer pending com expires_at ≤ now.

create or replace function public.expire_stale_on_demand_requests(
  p_limit int default 200
)
returns table (
  expired_count int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_lim int := greatest(1, least(p_limit, 5000));
  v_count int;
begin
  with cand as (
    select id from public.on_demand_requests
     where status = 'pending'
       and expires_at <= v_now
     order by expires_at asc
     limit v_lim
     for update skip locked
  ),
  upd as (
    update public.on_demand_requests
       set status = 'expired'
     where id in (select id from cand)
       and status = 'pending'
    returning 1
  )
  select count(*)::int into v_count from upd;

  return query select coalesce(v_count, 0);
end;
$$;

comment on function public.expire_stale_on_demand_requests is
  'PR-079 · D-091. Sweep do cron expire-on-demand-requests. Marca '
  'expired qualquer pending com expires_at <= now(). Idempotente '
  'via guard status=pending. Limit clampado em [1, 5000].';
