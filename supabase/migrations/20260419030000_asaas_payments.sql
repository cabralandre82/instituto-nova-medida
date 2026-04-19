-- ============================================================================
-- Migration 004 · Pagamentos Asaas (Sprint 3)
-- ============================================================================
-- Estrutura mínima pra rastrear:
--   plans         → catálogo de planos (Essencial / Avançado / Avançado Plus)
--   customers     → clientes Asaas vinculados a leads
--   payments      → cobranças geradas (1 por checkout, ou N por subscription)
--   subscriptions → assinaturas recorrentes (futuro — já criada estrutura)
--   asaas_events  → log raw de webhooks (pra auditoria + retry)
--
-- Filosofia:
--   - service_role escreve tudo via backend (anon e authenticated bloqueados)
--   - jsonb pra payload bruto sempre que vier do Asaas (a API evolui, e a
--     gente quer manter snapshot fiel pra debug)
--   - status segue exatamente os enums do Asaas pra evitar tradução perdida
--
-- Pra aplicar: SQL Editor do Supabase → cole o arquivo inteiro → Run.
-- ============================================================================

-- ──────────────────────────────────────────────────────────────────────────
-- ENUMs
-- ──────────────────────────────────────────────────────────────────────────

-- Status do pagamento (espelha o ciclo de vida do Asaas)
do $$ begin
  create type payment_status as enum (
    'PENDING',                     -- aguardando pagamento (PIX/boleto gerado)
    'RECEIVED',                    -- recebido (compensado)
    'CONFIRMED',                   -- confirmado mas não compensado (cartão)
    'OVERDUE',                     -- vencido sem pagamento
    'REFUNDED',                    -- estornado
    'RECEIVED_IN_CASH',            -- recebido em dinheiro (manual)
    'REFUND_REQUESTED',            -- estorno solicitado
    'REFUND_IN_PROGRESS',          -- estorno em processamento
    'CHARGEBACK_REQUESTED',        -- chargeback solicitado pela bandeira
    'CHARGEBACK_DISPUTE',          -- em disputa de chargeback
    'AWAITING_CHARGEBACK_REVERSAL',-- aguardando reversão
    'DUNNING_REQUESTED',           -- negativação solicitada
    'DUNNING_RECEIVED',            -- negativada com sucesso
    'AWAITING_RISK_ANALYSIS',      -- em análise de risco (cartão)
    'DELETED'                      -- excluída
  );
exception when duplicate_object then null; end $$;

-- Forma de pagamento (espelha o billingType do Asaas)
do $$ begin
  create type payment_billing_type as enum (
    'PIX',
    'CREDIT_CARD',
    'BOLETO',
    'UNDEFINED'                    -- paciente escolhe na invoice hospedada
  );
exception when duplicate_object then null; end $$;

-- Status da assinatura
do $$ begin
  create type subscription_status as enum (
    'ACTIVE',
    'INACTIVE',
    'EXPIRED'
  );
exception when duplicate_object then null; end $$;

-- ──────────────────────────────────────────────────────────────────────────
-- Tabela: plans (catálogo)
-- ──────────────────────────────────────────────────────────────────────────
-- Os preços e detalhes vivem aqui pra serem editáveis sem deploy. A página
-- /planos lê desta tabela. O slug é a chave estável usada na URL
-- (/checkout/[slug]) e não muda mesmo se o nome de marketing mudar.

create table if not exists public.plans (
  id              uuid primary key default uuid_generate_v4(),
  slug            text not null unique check (slug ~ '^[a-z0-9-]+$'),
  name            text not null,
  description     text,
  medication      text,                                  -- ex: "Tirzepatida 2,5–7,5mg"
  cycle_days      int  not null default 90,

  price_cents     int  not null check (price_cents > 0), -- preço cheio (cartão 3x)
  price_pix_cents int  not null check (price_pix_cents > 0), -- preço à vista PIX/boleto

  features        jsonb not null default '[]'::jsonb,    -- bullets pra exibir no card
  highlight       boolean not null default false,        -- destaca no /planos
  active          boolean not null default true,
  sort_order      int not null default 0,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.plans is
  'Catálogo de planos vendidos no checkout. Editável sem deploy.';

create index if not exists plans_active_idx on public.plans (active, sort_order);

drop trigger if exists plans_set_updated_at on public.plans;
create trigger plans_set_updated_at
  before update on public.plans
  for each row execute function public.set_updated_at();

-- ──────────────────────────────────────────────────────────────────────────
-- Tabela: customers (clientes Asaas)
-- ──────────────────────────────────────────────────────────────────────────
-- Espelha o "Customer" do Asaas. Um lead pode virar customer no momento
-- do checkout. CPF é único — se o paciente voltar, reaproveitamos o
-- asaas_customer_id existente.

create table if not exists public.customers (
  id                  uuid primary key default uuid_generate_v4(),

  -- vínculo opcional com lead (paciente pode chegar direto pelo /planos
  -- sem ter passado pelo quiz da landing)
  lead_id             uuid references public.leads(id) on delete set null,

  -- identificação
  name                text not null check (length(trim(name)) >= 3),
  cpf                 text not null unique check (length(regexp_replace(cpf, '[^0-9]', '', 'g')) = 11),
  email               text not null check (email ~* '^[^@]+@[^@]+\.[^@]+$'),
  phone               text not null check (length(regexp_replace(phone, '[^0-9]', '', 'g')) >= 10),

  -- endereço (necessário pra entrega do medicamento)
  address_zipcode     text,
  address_street      text,
  address_number      text,
  address_complement  text,
  address_district    text,
  address_city        text,
  address_state       text check (address_state is null or length(address_state) = 2),

  -- ID retornado pelo Asaas após createCustomer
  asaas_customer_id   text unique,
  asaas_env           text not null default 'sandbox' check (asaas_env in ('sandbox','production')),
  asaas_raw           jsonb,                              -- snapshot da última sync

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.customers is
  'Clientes Asaas (pessoas físicas). 1:N pra payments.';

create index if not exists customers_lead_idx          on public.customers (lead_id);
create index if not exists customers_email_idx         on public.customers (email);
create index if not exists customers_asaas_id_idx      on public.customers (asaas_customer_id);

drop trigger if exists customers_set_updated_at on public.customers;
create trigger customers_set_updated_at
  before update on public.customers
  for each row execute function public.set_updated_at();

-- ──────────────────────────────────────────────────────────────────────────
-- Tabela: subscriptions (assinaturas recorrentes — pra Sprint 5+)
-- ──────────────────────────────────────────────────────────────────────────
-- Estrutura criada agora pra não precisar refatorar payments depois.
-- Por enquanto fica vazia — cobranças são avulsas (1 ciclo de 90 dias).

create table if not exists public.subscriptions (
  id                       uuid primary key default uuid_generate_v4(),
  customer_id              uuid not null references public.customers(id) on delete cascade,
  plan_id                  uuid not null references public.plans(id) on delete restrict,

  asaas_subscription_id    text unique,
  status                   subscription_status not null default 'ACTIVE',
  next_due_date            date,
  cycle                    text not null default 'QUARTERLY', -- enum no Asaas
  asaas_raw                jsonb,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists subscriptions_customer_idx on public.subscriptions (customer_id);
create index if not exists subscriptions_status_idx   on public.subscriptions (status);

drop trigger if exists subscriptions_set_updated_at on public.subscriptions;
create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

-- ──────────────────────────────────────────────────────────────────────────
-- Tabela: payments (cobranças)
-- ──────────────────────────────────────────────────────────────────────────
-- Cada checkout gera uma row. Subscription que dispara N cobranças
-- também gera N rows (1 por ciclo).

create table if not exists public.payments (
  id                    uuid primary key default uuid_generate_v4(),

  customer_id           uuid not null references public.customers(id) on delete restrict,
  plan_id               uuid not null references public.plans(id)     on delete restrict,
  subscription_id       uuid          references public.subscriptions(id) on delete set null,

  -- valores em centavos pra evitar float
  amount_cents          int  not null check (amount_cents > 0),
  billing_type          payment_billing_type not null default 'UNDEFINED',
  status                payment_status not null default 'PENDING',
  due_date              date not null,

  -- IDs e URLs do Asaas
  asaas_payment_id      text unique,
  asaas_env             text not null default 'sandbox' check (asaas_env in ('sandbox','production')),
  invoice_url           text,                          -- página hospedada do Asaas
  bank_slip_url         text,                          -- PDF do boleto
  pix_qr_code           text,                          -- payload PIX (copia-e-cola)
  pix_qr_code_image     text,                          -- base64 da imagem
  asaas_raw             jsonb,                         -- snapshot da última sync

  -- ciclo de vida
  paid_at               timestamptz,
  refunded_at           timestamptz,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table public.payments is
  'Cobranças geradas no Asaas. 1 row por checkout (ou por ciclo de subscription).';

create index if not exists payments_customer_idx       on public.payments (customer_id);
create index if not exists payments_plan_idx           on public.payments (plan_id);
create index if not exists payments_status_idx         on public.payments (status);
create index if not exists payments_asaas_id_idx       on public.payments (asaas_payment_id);
create index if not exists payments_created_at_idx     on public.payments (created_at desc);

drop trigger if exists payments_set_updated_at on public.payments;
create trigger payments_set_updated_at
  before update on public.payments
  for each row execute function public.set_updated_at();

-- ──────────────────────────────────────────────────────────────────────────
-- Tabela: asaas_events (log raw de webhooks)
-- ──────────────────────────────────────────────────────────────────────────
-- Mesma filosofia de whatsapp_events: persiste TUDO que chega antes de
-- processar, pra debug e retry. Eventos são idempotentes pelo asaas_event_id.

create table if not exists public.asaas_events (
  id                  uuid primary key default uuid_generate_v4(),

  asaas_event_id      text unique,                       -- id único do evento (Asaas)
  event_type          text,                              -- ex: PAYMENT_RECEIVED
  asaas_payment_id    text,                              -- pra correlacionar
  payload             jsonb not null,                    -- corpo bruto do POST
  signature           text,                              -- header asaas-access-token (verificação)
  signature_valid     boolean,                           -- resultado da validação HMAC
  processed_at        timestamptz,                       -- null = não processado ainda
  processing_error    text,

  received_at         timestamptz not null default now()
);

comment on table public.asaas_events is
  'Log raw dos webhooks do Asaas. Idempotência via asaas_event_id.';

create index if not exists asaas_events_event_type_idx     on public.asaas_events (event_type);
create index if not exists asaas_events_payment_id_idx     on public.asaas_events (asaas_payment_id);
create index if not exists asaas_events_received_at_idx    on public.asaas_events (received_at desc);
create index if not exists asaas_events_unprocessed_idx    on public.asaas_events (received_at) where processed_at is null;

-- ──────────────────────────────────────────────────────────────────────────
-- Row Level Security (mesmo padrão deny-by-default)
-- ──────────────────────────────────────────────────────────────────────────

alter table public.plans         enable row level security;
alter table public.customers     enable row level security;
alter table public.subscriptions enable row level security;
alter table public.payments      enable row level security;
alter table public.asaas_events  enable row level security;

-- plans: leitura pública (pra a página /planos funcionar com a anon key)
drop policy if exists "plans public read" on public.plans;
create policy "plans public read" on public.plans
  for select to anon, authenticated
  using (active = true);

-- demais tabelas: só service_role (que bypassa RLS automaticamente)
do $$
declare
  t text;
begin
  foreach t in array array['customers','subscriptions','payments','asaas_events']
  loop
    execute format('drop policy if exists "deny anon all" on public.%I', t);
    execute format(
      'create policy "deny anon all" on public.%I for all to anon using (false) with check (false)',
      t
    );
    execute format('drop policy if exists "deny authenticated all" on public.%I', t);
    execute format(
      'create policy "deny authenticated all" on public.%I for all to authenticated using (false) with check (false)',
      t
    );
  end loop;
end $$;

-- ──────────────────────────────────────────────────────────────────────────
-- Seed dos planos atuais (idempotente via on conflict)
-- ──────────────────────────────────────────────────────────────────────────

insert into public.plans (
  slug, name, description, medication, cycle_days,
  price_cents, price_pix_cents, features, highlight, sort_order
) values
  (
    'essencial',
    'Essencial',
    'Pra quem quer começar leve com semaglutida manipulada e acompanhamento médico completo.',
    'Semaglutida manipulada (até 1mg/sem)',
    90,
    179700, 161700,
    '[
      "Avaliação médica online inicial",
      "Semaglutida manipulada para 90 dias",
      "Reconsulta gratuita ao fim do ciclo",
      "Acompanhamento por WhatsApp ilimitado",
      "Entrega refrigerada em casa",
      "Cancelamento sem multa em 7 dias (CDC)"
    ]'::jsonb,
    false,
    10
  ),
  (
    'avancado',
    'Avançado',
    'Nosso plano mais escolhido. Tirzepatida com escalonamento gradual da dose, supervisão semanal e logística completa.',
    'Tirzepatida 2,5–7,5mg/sem (escalonamento)',
    90,
    299700, 269700,
    '[
      "Tudo do plano Essencial",
      "Tirzepatida manipulada com escalonamento de dose",
      "Acompanhamento semanal proativo da médica",
      "Solicitação de exames inclusa",
      "Suporte priorizado no WhatsApp",
      "Reembolso integral se a médica não indicar tratamento"
    ]'::jsonb,
    true,
    20
  ),
  (
    'avancado-plus',
    'Avançado Plus',
    'Dose alta de tirzepatida pra fase de manutenção, com suporte clínico intensivo.',
    'Tirzepatida 10–15mg/sem (manutenção)',
    90,
    419700, 377700,
    '[
      "Tudo do plano Avançado",
      "Tirzepatida em dose alta (manutenção)",
      "Reconsultas extras quando necessário",
      "Plano de manutenção pós-meta",
      "Atendimento médico premium"
    ]'::jsonb,
    false,
    30
  )
on conflict (slug) do update set
  name            = excluded.name,
  description     = excluded.description,
  medication      = excluded.medication,
  cycle_days      = excluded.cycle_days,
  price_cents     = excluded.price_cents,
  price_pix_cents = excluded.price_pix_cents,
  features        = excluded.features,
  highlight       = excluded.highlight,
  sort_order      = excluded.sort_order,
  updated_at      = now();
