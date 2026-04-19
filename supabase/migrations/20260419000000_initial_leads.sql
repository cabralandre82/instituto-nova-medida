-- ============================================================================
-- Migration 001 · Tabela de leads do Instituto Nova Medida
-- ============================================================================
-- Esta é a primeira migration. Cria a tabela onde caem todos os leads
-- capturados pelo quiz da landing page.
--
-- Para aplicar: SQL Editor do Supabase → cole o arquivo inteiro → Run.
-- (No Sprint 2 mais à frente vamos automatizar com Supabase CLI.)
-- ============================================================================

-- ──────────────────────────────────────────────────────────────────────────
-- Extensions úteis
-- ──────────────────────────────────────────────────────────────────────────
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ──────────────────────────────────────────────────────────────────────────
-- ENUMs
-- ──────────────────────────────────────────────────────────────────────────
do $$ begin
  create type lead_status as enum (
    'novo',           -- recém-capturado, sem ação
    'contactado',     -- recebeu MSG 1 do WhatsApp
    'em_conversa',    -- respondeu pelo menos uma vez
    'agendado',       -- marcou consulta
    'consultado',     -- consulta realizada
    'convertido',     -- pagou ciclo
    'descartado'      -- não qualificado / desistiu / spam
  );
exception when duplicate_object then null; end $$;

-- ──────────────────────────────────────────────────────────────────────────
-- Tabela: leads
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists public.leads (
  id              uuid primary key default uuid_generate_v4(),

  -- dados pessoais (mínimos)
  name            text not null check (length(trim(name)) >= 2),
  phone           text not null check (length(phone) >= 10),

  -- respostas do quiz (jsonb para flexibilidade — perguntas podem evoluir)
  answers         jsonb not null default '{}'::jsonb,

  -- LGPD
  consent         boolean not null default false,
  consent_text    text,                          -- snapshot do texto aceito
  consent_at      timestamptz,                   -- quando o checkbox foi marcado

  -- atribuição de marketing
  utm             jsonb default '{}'::jsonb,     -- { source, medium, campaign, term, content }
  referrer        text,
  landing_path    text,

  -- evidência técnica
  ip              inet,
  user_agent      text,

  -- ciclo de vida
  status          lead_status not null default 'novo',
  status_notes    text,

  -- timestamps
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  contacted_at    timestamptz,
  converted_at    timestamptz,

  -- vínculo com paciente (criado depois quando converter)
  patient_id      uuid                            -- fk será adicionada quando criarmos a tabela 'pacientes'
);

comment on table public.leads is
  'Leads capturados pelo quiz da landing — fonte de verdade do funil topo.';

-- ──────────────────────────────────────────────────────────────────────────
-- Índices
-- ──────────────────────────────────────────────────────────────────────────
create index if not exists leads_phone_idx       on public.leads (phone);
create index if not exists leads_status_idx      on public.leads (status);
create index if not exists leads_created_at_idx  on public.leads (created_at desc);
create index if not exists leads_utm_idx         on public.leads using gin (utm);
create index if not exists leads_answers_idx     on public.leads using gin (answers);

-- ──────────────────────────────────────────────────────────────────────────
-- Trigger: updated_at automático
-- ──────────────────────────────────────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists leads_set_updated_at on public.leads;
create trigger leads_set_updated_at
  before update on public.leads
  for each row execute function public.set_updated_at();

-- ──────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- ──────────────────────────────────────────────────────────────────────────
-- Política deliberadamente restritiva: NINGUÉM acessa pela API pública.
-- Toda escrita/leitura passa pelo nosso backend usando SERVICE ROLE
-- (que bypassa RLS). Isso protege a tabela mesmo se a anon key vazar.
-- Quando criarmos o painel admin no Sprint 5, criaremos políticas que
-- permitam role 'admin' (claim no JWT) ler.
-- ──────────────────────────────────────────────────────────────────────────
alter table public.leads enable row level security;

-- Bloqueia acesso anônimo total (default já é deny, mas explicitamos)
drop policy if exists "deny anon all" on public.leads;
create policy "deny anon all" on public.leads
  for all
  to anon
  using (false)
  with check (false);

-- Bloqueia acesso authenticated (até criarmos roles específicas)
drop policy if exists "deny authenticated all" on public.leads;
create policy "deny authenticated all" on public.leads
  for all
  to authenticated
  using (false)
  with check (false);

-- service_role tem bypass automático pelo Supabase, não precisa de policy.

-- ──────────────────────────────────────────────────────────────────────────
-- View útil para o admin (sem PII desnecessária — futuro)
-- ──────────────────────────────────────────────────────────────────────────
-- Será criada no Sprint 5 quando montarmos o painel admin.
