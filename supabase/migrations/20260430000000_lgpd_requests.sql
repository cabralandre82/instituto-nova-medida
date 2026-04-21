-- ============================================================================
-- Migration · lgpd_requests (PR-017 · D-051 · Onda 2A)
-- ============================================================================
-- Registro canônico das solicitações LGPD feitas pelo próprio paciente
-- em self-service na área logada (`/paciente/meus-dados`), em
-- cumprimento ao direito de portabilidade (Art. 18, V) e
-- anonimização/eliminação (Art. 18, IV e VI).
--
-- Motivação:
--
--   1. Até a Onda 2A, o único caminho para o paciente exercer seus
--      direitos LGPD era contatar o operador (admin) pedindo por
--      WhatsApp. Esse atrito contradiz o espírito do Art. 18 — o
--      titular tem direito a exercer seus direitos de forma "simples
--      e gratuita" (Art. 18 §5º).
--
--   2. A rota `POST /api/paciente/meus-dados/anonymize-request`
--      precisa de armazenamento persistente porque anonimização é
--      IRREVERSÍVEL e exige revisão do operador antes (ex.: verificar
--      se não há fulfillment ativo, se não há pagamento pendente com
--      risco de chargeback). Não dá pra disparar direto no POST do
--      paciente.
--
--   3. O export é entregue em tempo real (GET → JSON), mas ainda
--      registramos um row `kind='export_copy'` pra trilha de auditoria
--      LGPD — permite ao operador reconstruir "o paciente baixou seus
--      dados em X, fez Y solicitação em Z".
--
-- Decisões de modelagem:
--
-- - **Unique partial por (customer_id, kind)** sobre status='pending':
--   garante que cada paciente tem, no máximo, 1 pedido de anonimização
--   pendente e 1 pedido de export pendente ao mesmo tempo. Evita DoS
--   (spam de pedidos) e simplifica UI ("você tem uma solicitação
--   pendente").
--
-- - **`fulfilled_at` + `rejected_reason` separados**: solicitações não
--   processadas num ciclo ficam `pending` até decisão explícita. Isso
--   nos permite reportar para a ANPD prazos de atendimento (Art. 19
--   §1º — 15 dias) sem ambiguidade.
--
-- - **`requester_ip` / `requester_user_agent`**: anti-fraude. Se
--   alguém usar magic-link capturado pra solicitar anonimização do
--   paciente sem o saber, o admin pode comparar com outras sessões do
--   titular antes de aprovar.
--
-- - **RLS**: igual ao padrão deny-authenticated-all das outras tabelas
--   PII (customers, payments). Paciente não lê/escreve direto —
--   service_role via API controla tudo.
-- ============================================================================

do $$ begin
  create type lgpd_request_kind as enum (
    'export_copy',   -- direito de portabilidade (Art. 18, V)
    'anonymize'      -- direito à anonimização/eliminação (Art. 18, IV e VI)
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type lgpd_request_status as enum (
    'pending',       -- aguardando triagem do operador (ou auto-execução)
    'fulfilled',     -- atendida
    'rejected',      -- recusada com razão (raro — ex.: paciente em fulfillment ativo)
    'cancelled'      -- paciente desistiu antes da triagem
  );
exception when duplicate_object then null; end $$;

create table if not exists public.lgpd_requests (
  id                    uuid primary key default gen_random_uuid(),
  customer_id           uuid not null
                          references public.customers(id) on delete restrict,
  kind                  lgpd_request_kind   not null,
  status                lgpd_request_status not null default 'pending',

  requested_at          timestamptz not null default now(),
  fulfilled_at          timestamptz,
  rejected_reason       text,
  cancelled_at          timestamptz,

  fulfilled_by_user_id  uuid references auth.users(id) on delete set null,
  rejected_by_user_id   uuid references auth.users(id) on delete set null,

  -- anti-fraude / auditoria Art. 37
  requester_ip          inet,
  requester_user_agent  text,

  -- Para kind='export_copy' fulfilled automaticamente, guardamos o
  -- tamanho do JSON entregue (bytes). Útil pra métricas de "quanta PII
  -- cada paciente tem" sem armazenar o payload inteiro.
  export_bytes          bigint,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table public.lgpd_requests is
  'Solicitações LGPD feitas pelo próprio paciente (Art. 18). 1 row por pedido. '
  'Exports self-service viram fulfilled automaticamente; anonimização fica '
  'pending até triagem do operador. PR-017 · D-051.';

comment on column public.lgpd_requests.kind is
  'export_copy = portabilidade (Art. 18, V); anonymize = anonimização (Art. 18, IV e VI).';

comment on column public.lgpd_requests.status is
  'pending | fulfilled | rejected | cancelled. pending bloqueia novo pedido do mesmo kind.';

comment on column public.lgpd_requests.requester_ip is
  'IP do paciente no momento da solicitação. Anti-fraude + trilha Art. 37.';

comment on column public.lgpd_requests.export_bytes is
  'Tamanho do JSON de export entregue (bytes). Métrica operacional sem armazenar PII.';

create index if not exists lgpd_requests_customer_idx
  on public.lgpd_requests (customer_id, requested_at desc);

create index if not exists lgpd_requests_pending_idx
  on public.lgpd_requests (kind, requested_at)
  where status = 'pending';

-- Regra central: no máximo 1 request pendente por (customer, kind).
-- Isso protege contra spam do paciente ("me anonimiza 50x") e contra
-- lógica de UI duplicando solicitação.
create unique index if not exists lgpd_requests_one_pending_per_kind_uniq
  on public.lgpd_requests (customer_id, kind)
  where status = 'pending';

drop trigger if exists lgpd_requests_set_updated_at on public.lgpd_requests;
create trigger lgpd_requests_set_updated_at
  before update on public.lgpd_requests
  for each row execute function public.set_updated_at();

-- ──────────────────────────────────────────────────────────────────────────
-- RLS — mesmo padrão deny-all das outras tabelas de PII.
-- ──────────────────────────────────────────────────────────────────────────
alter table public.lgpd_requests enable row level security;

drop policy if exists "lgpd_requests_deny_anon" on public.lgpd_requests;
create policy "lgpd_requests_deny_anon" on public.lgpd_requests
  for all to anon using (false) with check (false);

drop policy if exists "lgpd_requests_deny_authenticated" on public.lgpd_requests;
create policy "lgpd_requests_deny_authenticated" on public.lgpd_requests
  for all to authenticated using (false) with check (false);

do $$ begin
  raise notice 'lgpd_requests criada com enums, índice único parcial e RLS deny-all.';
end $$;
