-- ──────────────────────────────────────────────────────────────────────────
-- Migration · PR-077 · D-089
-- Fila de notificações WhatsApp **para a médica**.
-- ──────────────────────────────────────────────────────────────────────────
-- A tabela `appointment_notifications` (D-031, migration 011) governa
-- mensagens **para o paciente**. Esta tabela governa mensagens **para
-- a médica** — operacionais, não-CFM, com ciclos de vida mais soltos:
--
--   - `doctor_paid`              — disparada quando paciente paga
--                                  consulta/plano. 1 row por
--                                  appointment_id.
--   - `doctor_t_minus_15min`     — link da sala 15 min antes da consulta
--                                  agendada. 1 row por appointment_id.
--   - `doctor_daily_summary`     — resumo da agenda do próximo dia
--                                  enviado às ~20h. 1 row por
--                                  (doctor_id, summary_date).
--   - `doctor_on_call_t_minus_15min` — aviso 15 min antes do início de
--                                  bloco recorrente `on_call`. Idempotente
--                                  por (doctor_id, availability_id,
--                                  shift_starts_at) onde shift_starts_at
--                                  é o início concreto da próxima
--                                  ocorrência (truncado ao minuto).
--
-- Diferenças vs `appointment_notifications`:
--   - `appointment_id` é NULLABLE (resumo + plantão não amarram a 1
--     appointment).
--   - Sem trigger de imutabilidade do body — não temos requisito CFM
--     pra forense de mensagens internas. Body fica em `payload`.
--   - Sem coluna `kind` enum — usamos `kind` text com CHECK.
--
-- Por que não reusar `appointment_notifications`:
--
--   1. Lifecycle de "notificação operacional pra time" é diferente do de
--      "comunicação ao paciente" (CFM 2.314/2022 + retenção 5+).
--   2. Permite RLS independente. Médica pode ler as próprias notifs
--      no /medico/notifs futuro; paciente nunca.
--   3. Idempotência multi-key (appointment_id | availability_id |
--      summary_date) não cabe num único unique parcial em
--      `appointment_notifications`.
--
-- Filosofia operacional:
--   - Worker `processDuePendingDoctor()` em src/lib/doctor-notifications.ts
--     é gêmeo do existente em notifications.ts mas hidrata da `doctors`
--     em vez de `customers`.
--   - Mesmo cron `/api/internal/cron/wa-reminders` processa ambas as
--     filas → não precisa pagar custo de novo schedule.
-- ──────────────────────────────────────────────────────────────────────────

create table if not exists public.doctor_notifications (
  id              uuid primary key default gen_random_uuid(),
  doctor_id       uuid not null references public.doctors(id) on delete cascade,

  -- Pelo menos UM dos 3 anchors precisa estar setado, e tipicamente
  -- só UM. Não temos CHECK estrito porque o mesmo kind pode ser
  -- aproveitado pra cenários híbridos no futuro.
  appointment_id  uuid references public.appointments(id) on delete cascade,
  availability_id uuid references public.doctor_availability(id) on delete cascade,
  summary_date    date,

  kind text not null check (kind in (
    'doctor_paid',
    'doctor_t_minus_15min',
    'doctor_daily_summary',
    'doctor_on_call_t_minus_15min'
  )),

  -- Mesmo channel literal usado em `appointment_notifications` pra
  -- coerência operacional. Hoje só whatsapp.
  channel text not null default 'whatsapp' check (channel in ('whatsapp')),

  template_name text,

  -- Disparo programado. Vem preenchido na hora do enqueue.
  scheduled_for timestamptz not null,

  -- Estado da máquina simples.
  status text not null default 'pending' check (status in (
    'pending', 'sent', 'failed'
  )),

  payload   jsonb not null default '{}'::jsonb
              check (octet_length(payload::text) <= 16384),

  sent_at      timestamptz,
  message_id   text,
  target_phone text,
  body         text,
  rendered_at  timestamptz,
  error        text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint dn_anchor_present check (
    appointment_id is not null
    or availability_id is not null
    or summary_date is not null
  )
);

comment on table public.doctor_notifications is
  'Fila de mensagens WhatsApp pra médica. Operacional (não-CFM). PR-077 · D-089.';

-- Índice pro worker: pega pendentes vencidas, em ordem de scheduled_for.
create index if not exists idx_dn_due
  on public.doctor_notifications (scheduled_for)
  where status = 'pending';

create index if not exists idx_dn_doctor_status
  on public.doctor_notifications (doctor_id, status);

-- Idempotência: 3 índices unique parciais (1 por anchor possível).
-- Restritos a status 'pending' OR 'sent' — falhas permitem re-enqueue.

-- (a) por (doctor_id, appointment_id, kind) — cobre doctor_paid e
-- doctor_t_minus_15min.
create unique index if not exists ux_dn_appt_kind_alive
  on public.doctor_notifications (doctor_id, appointment_id, kind)
  where appointment_id is not null and status in ('pending', 'sent');

-- (b) por (doctor_id, summary_date, kind) — cobre doctor_daily_summary.
create unique index if not exists ux_dn_summary_kind_alive
  on public.doctor_notifications (doctor_id, summary_date, kind)
  where summary_date is not null and status in ('pending', 'sent');

-- (c) por (doctor_id, availability_id, kind, scheduled_for) — cobre
-- doctor_on_call_t_minus_15min. scheduled_for entra na unique key
-- porque o MESMO availability_id (bloco recorrente) gera um aviso
-- por ocorrência semanal.
create unique index if not exists ux_dn_avail_kind_alive
  on public.doctor_notifications
     (doctor_id, availability_id, kind, scheduled_for)
  where availability_id is not null and status in ('pending', 'sent');

-- Touch updated_at em cada UPDATE.
create or replace function public.tg_dn_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tg_dn_touch_updated_at on public.doctor_notifications;
create trigger tg_dn_touch_updated_at
  before update on public.doctor_notifications
  for each row execute function public.tg_dn_touch_updated_at();

-- RLS: deny-by-default. Acesso só via service role no worker.
alter table public.doctor_notifications enable row level security;

-- ──────────────────────────────────────────────────────────────────────────
-- RPC: enqueue idempotente.
-- ──────────────────────────────────────────────────────────────────────────
-- Retorna o id se inseriu, ou NULL se ON CONFLICT suprimiu (já existia
-- viva). Caller decide se loga.
create or replace function public.enqueue_doctor_notification(
  p_doctor_id      uuid,
  p_kind           text,
  p_scheduled_for  timestamptz default null,
  p_appointment_id uuid default null,
  p_availability_id uuid default null,
  p_summary_date   date default null,
  p_payload        jsonb default null,
  p_template_name  text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_when timestamptz := coalesce(p_scheduled_for, now());
begin
  if p_doctor_id is null then
    raise exception 'doctor_id_required' using errcode = '22023';
  end if;

  if p_appointment_id is null
     and p_availability_id is null
     and p_summary_date is null then
    raise exception 'anchor_required' using errcode = '22023';
  end if;

  insert into public.doctor_notifications (
    doctor_id,
    appointment_id,
    availability_id,
    summary_date,
    kind,
    channel,
    template_name,
    scheduled_for,
    status,
    payload
  ) values (
    p_doctor_id,
    p_appointment_id,
    p_availability_id,
    p_summary_date,
    p_kind,
    'whatsapp',
    p_template_name,
    v_when,
    'pending',
    coalesce(p_payload, '{}'::jsonb)
  )
  on conflict do nothing
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.enqueue_doctor_notification is
  'Insere uma notificação na fila de doctor_notifications. Retorna id '
  'se criou ou NULL se ON CONFLICT suprimiu (já tinha viva). PR-077.';
