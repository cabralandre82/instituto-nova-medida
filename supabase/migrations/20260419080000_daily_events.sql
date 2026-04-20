-- ──────────────────────────────────────────────────────────────────────────
-- Migration 009 — Webhook do Daily.co.
-- ──────────────────────────────────────────────────────────────────────────
-- Cria tabela `daily_events` para persistência crua (auditoria + idempotência)
-- dos eventos de meeting/participant. Padrão idêntico ao `asaas_events`.
--
-- Eventos relevantes (https://docs.daily.co/reference/rest-api/webhooks):
--   - meeting.started
--   - meeting.ended
--   - participant.joined
--   - participant.left
--   - recording.ready  (futuro — só persistimos)
--
-- Idempotência: chave única (event_id, event_type) em vez de só event_id
-- porque o Daily reusa ids entre tipos em alguns casos. Receber um evento
-- duplicado retorna 200 com flag `duplicate`.
-- ──────────────────────────────────────────────────────────────────────────

create table if not exists public.daily_events (
  id uuid primary key default uuid_generate_v4(),

  -- Identificação do evento (vinda do payload Daily)
  event_id text,                              -- payload.id ou auto se ausente
  event_type text not null,                   -- 'meeting.started', etc.
  event_ts timestamptz,                       -- payload.event_ts convertido
  daily_room_name text,                       -- payload.room (ex: 'c-12345678')
  daily_meeting_id text,                      -- payload.meeting_id
  appointment_id uuid references public.appointments(id) on delete set null,

  -- Validação da assinatura (HMAC ou secret-header)
  signature text,
  signature_valid boolean not null default false,

  -- Payload bruto pra reprocessamento manual se necessário
  payload jsonb not null,

  -- Processamento
  processed_at timestamptz,
  processing_error text,

  received_at timestamptz not null default now()
);

create unique index if not exists ux_daily_events_id_type
  on public.daily_events (event_id, event_type)
  where event_id is not null;

create index if not exists idx_daily_events_appointment
  on public.daily_events (appointment_id, event_type);

create index if not exists idx_daily_events_room
  on public.daily_events (daily_room_name);

create index if not exists idx_daily_events_unprocessed
  on public.daily_events (received_at desc)
  where processed_at is null;

comment on table public.daily_events is
  'Auditoria + idempotência de webhooks do Daily.co. Sempre persistir o raw '
  'antes de qualquer processamento. Resposta 200 mesmo em erro de processamento '
  'pra evitar retry agressivo do Daily.';

-- RLS: só service role escreve/lê. Não há leitura por médica/paciente.
alter table public.daily_events enable row level security;

-- (Sem políticas → deny-by-default. Service role bypassa RLS.)
