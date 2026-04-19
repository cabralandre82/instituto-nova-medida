-- ============================================================================
-- Migration 005 · Multi-médico + Agenda + Financeiro (Sprint 4.1)
-- ============================================================================
-- Estrutura completa pra:
--   doctors                    → cadastro de médicas (PJ — D-024)
--   doctor_availability        → agenda semanal (slots agendada/plantão)
--   doctor_payment_methods     → PIX + dados bancários
--   doctor_compensation_rules  → regras de remuneração (versionadas)
--   appointments               → consultas agendadas/on-demand
--   appointment_notifications  → log de WhatsApp/email enviados por consulta
--   doctor_earnings            → ganhos imutáveis (D-022)
--   doctor_payouts             → lotes mensais de repasse
--   doctor_billing_documents   → NF-e enviadas pela médica
--
-- Filosofia (resumida — completa em docs/COMPENSATION.md):
--   - earnings imutáveis (não editamos depois)
--   - payouts são "draft → approved → pix_sent → confirmed"
--   - clawback = nova earning negativa, nunca update destrutivo
--   - regra de compensação versionada (effective_from/to) — mudança
--     não retroage pra earnings já criadas
--
-- Aplicar via: SQL Editor Supabase → cole inteiro → Run.
-- ============================================================================

-- ──────────────────────────────────────────────────────────────────────────
-- ENUMs
-- ──────────────────────────────────────────────────────────────────────────

-- Status da médica no sistema
do $$ begin
  create type doctor_status as enum (
    'invited',     -- convidada, aguardando primeiro login
    'pending',     -- logada, perfil incompleto (sem PIX ou sem agenda)
    'active',      -- atendendo normalmente
    'suspended',   -- temporariamente suspensa (decisão clínica/operacional)
    'archived'     -- desligada (mantém histórico)
  );
exception when duplicate_object then null; end $$;

-- Tipo de slot na agenda
do $$ begin
  create type availability_type as enum (
    'agendada',    -- horário fixo pra consulta marcada
    'plantao'     -- janela disponível pra fila on-demand (paga por hora)
  );
exception when duplicate_object then null; end $$;

-- Tipo de chave PIX
do $$ begin
  create type pix_key_type as enum (
    'cpf', 'cnpj', 'email', 'phone', 'random'
  );
exception when duplicate_object then null; end $$;

-- Status do appointment
do $$ begin
  create type appointment_status as enum (
    'scheduled',     -- agendado (paciente pagou e marcou)
    'confirmed',     -- confirmado (paciente recebeu confirmação)
    'in_progress',   -- consulta começou (Daily meeting.started)
    'completed',     -- consulta terminou (Daily meeting.ended)
    'no_show_patient',  -- paciente não apareceu
    'no_show_doctor',   -- médica não apareceu
    'cancelled_by_patient',
    'cancelled_by_doctor',
    'cancelled_by_admin'
  );
exception when duplicate_object then null; end $$;

-- Tipo de earning
do $$ begin
  create type earning_type as enum (
    'consultation',     -- consulta agendada concluída
    'on_demand_bonus',  -- bônus por atender via fila on-demand
    'plantao_hour',     -- hora em plantão (status verde)
    'after_hours_bonus',-- adicional noturno/fim de semana (não ativo MVP)
    'adjustment',       -- ajuste manual (positivo ou negativo)
    'bonus',            -- bônus discricionário (meta, NPS)
    'refund_clawback'   -- estorno de earning paga (refund/chargeback)
  );
exception when duplicate_object then null; end $$;

-- Status de earning
do $$ begin
  create type earning_status as enum (
    'pending',     -- aguardando janela de risco do meio de pagamento
    'available',   -- elegível pro próximo payout
    'in_payout',   -- já vinculado a um payout draft/approved
    'paid',        -- payout foi confirmado (médica recebeu)
    'cancelled'    -- estornada antes de virar paid
  );
exception when duplicate_object then null; end $$;

-- Status de payout
do $$ begin
  create type payout_status as enum (
    'draft',         -- gerado pelo cron, aguardando revisão admin
    'approved',      -- admin aprovou, pronto pra pagar
    'pix_sent',      -- PIX foi enviado (aguardando confirmação)
    'confirmed',     -- pagamento confirmado, comprovante anexado
    'cancelled',     -- payout cancelado (earnings voltam pra available)
    'failed'         -- PIX falhou (erro técnico ou chave inválida)
  );
exception when duplicate_object then null; end $$;

-- Tipo de documento fiscal
do $$ begin
  create type billing_document_type as enum (
    'nfse',          -- NF-e de serviço municipal
    'rpa',           -- recibo de pagamento autônomo (não usado no PJ)
    'recibo'         -- recibo simples (caso transitório)
  );
exception when duplicate_object then null; end $$;

-- Canal de notificação
do $$ begin
  create type notification_channel as enum (
    'whatsapp', 'email', 'sms', 'push'
  );
exception when duplicate_object then null; end $$;

-- Status de notificação
do $$ begin
  create type notification_status as enum (
    'pending', 'sent', 'delivered', 'read', 'failed'
  );
exception when duplicate_object then null; end $$;

-- ──────────────────────────────────────────────────────────────────────────
-- Tabela: doctors (cadastro)
-- ──────────────────────────────────────────────────────────────────────────
-- Médica = PJ contratada (D-024). user_id liga ao auth.users do Supabase
-- pra login. Email é o usado no magic link e na NF.

create table if not exists public.doctors (
  id                  uuid primary key default uuid_generate_v4(),
  user_id             uuid unique references auth.users(id) on delete set null,

  -- Identificação profissional
  full_name           text not null check (length(trim(full_name)) >= 3),
  crm_number          text not null,
  crm_uf              char(2) not null check (crm_uf ~ '^[A-Z]{2}$'),
  crm_status          text default 'active',         -- active|inactive|suspended (validação manual)
  specialty           text,

  -- Contato
  email               text not null check (email ~* '^[^@]+@[^@]+\.[^@]+$'),
  phone               text not null check (length(regexp_replace(phone, '[^0-9]', '', 'g')) >= 10),

  -- Perfil público (mostrado em /agendar pra paciente escolher)
  display_name        text,                          -- "Dra. Joana Silva" (se diferente do full_name)
  photo_url           text,
  bio                 text,
  consultation_minutes int not null default 30 check (consultation_minutes between 10 and 120),

  -- Dados PJ
  cnpj                text check (cnpj is null or length(regexp_replace(cnpj, '[^0-9]', '', 'g')) = 14),
  legal_name          text,                          -- razão social
  cnae                text,
  iss_municipal       text,                          -- número de inscrição municipal pra ISS

  -- Operacional
  status              doctor_status not null default 'invited',
  invited_at          timestamptz,
  activated_at        timestamptz,
  suspended_at        timestamptz,
  archived_at         timestamptz,

  -- Onboarding compliance (operador valida manual antes de active)
  contract_signed_at  timestamptz,                   -- contrato de prestação assinado
  lgpd_addendum_at    timestamptz,                   -- aditivo de operadora LGPD assinado

  -- Metadata livre
  notes               text,                          -- visível só pro admin

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- 1 médica por CRM/UF
  unique (crm_uf, crm_number)
);

create index if not exists idx_doctors_status on public.doctors(status);
create index if not exists idx_doctors_user_id on public.doctors(user_id);

-- ──────────────────────────────────────────────────────────────────────────
-- Tabela: doctor_availability (agenda semanal)
-- ──────────────────────────────────────────────────────────────────────────
-- Modela "Dra. Joana atende 14h-18h às quartas". Não modela datas
-- específicas — bloqueios de feriado/férias vão em `doctor_availability_overrides`
-- (próxima migration ou Sprint 4.2).

create table if not exists public.doctor_availability (
  id          uuid primary key default uuid_generate_v4(),
  doctor_id   uuid not null references public.doctors(id) on delete cascade,

  weekday     int  not null check (weekday between 0 and 6),  -- 0=domingo, 6=sábado
  start_time  time not null,
  end_time    time not null,
  type        availability_type not null default 'agendada',

  -- timezone americas/sao_paulo é assumido (não armazenamos por enquanto)

  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  check (end_time > start_time)
);

create index if not exists idx_dav_doctor on public.doctor_availability(doctor_id, weekday) where active = true;

-- ──────────────────────────────────────────────────────────────────────────
-- Tabela: doctor_payment_methods (PIX + bancário)
-- ──────────────────────────────────────────────────────────────────────────
-- Snapshot do PIX da médica. Nunca armazenamos hash — usamos chave
-- direta porque precisamos copiar/colar pra fazer o PIX.

create table if not exists public.doctor_payment_methods (
  id              uuid primary key default uuid_generate_v4(),
  doctor_id       uuid not null references public.doctors(id) on delete cascade,

  pix_key         text not null,
  pix_key_type    pix_key_type not null,
  pix_key_holder  text,                              -- nome cadastrado no PIX (validação visual)

  -- Bancário tradicional (caso PIX falhe ou pra TED)
  bank_code       text,
  bank_agency     text,
  bank_account    text,
  bank_account_type text check (bank_account_type in ('checking', 'savings')),
  bank_account_holder text,
  bank_holder_doc text,                              -- CPF/CNPJ do titular

  active          boolean not null default true,
  verified_at     timestamptz,                       -- admin validou (PIX teste de R$ 0,01)

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- 1 método ativo por médica (regra de negócio + UI clara)
create unique index if not exists idx_dpm_one_active
  on public.doctor_payment_methods(doctor_id) where active = true;

-- ──────────────────────────────────────────────────────────────────────────
-- Tabela: doctor_compensation_rules (regras versionadas)
-- ──────────────────────────────────────────────────────────────────────────
-- Cada médica tem 1 regra ativa. Mudanças criam linha nova com
-- effective_from = now() e fecham a anterior com effective_to = now().
-- Earnings já criadas com a regra antiga ficam intactas.

create table if not exists public.doctor_compensation_rules (
  id                            uuid primary key default uuid_generate_v4(),
  doctor_id                     uuid not null references public.doctors(id) on delete cascade,

  -- Valores em centavos (consistente com payments)
  consultation_cents            int not null default 20000  check (consultation_cents >= 0),       -- R$ 200
  on_demand_bonus_cents         int not null default 4000   check (on_demand_bonus_cents >= 0),    -- R$ 40
  plantao_hour_cents            int not null default 3000   check (plantao_hour_cents >= 0),       -- R$ 30
  after_hours_multiplier        numeric(4,2) not null default 1.00 check (after_hours_multiplier >= 1.00 and after_hours_multiplier <= 5.00),

  -- Janelas de "available"
  available_days_pix            int not null default 7   check (available_days_pix >= 0),
  available_days_boleto         int not null default 3   check (available_days_boleto >= 0),
  available_days_card           int not null default 30  check (available_days_card >= 0),

  -- Versionamento
  effective_from                timestamptz not null default now(),
  effective_to                  timestamptz,                       -- null = vigente
  reason                        text,                              -- "Aumento por mérito", "MVP default"
  created_by                    uuid references auth.users(id) on delete set null,

  created_at                    timestamptz not null default now(),

  check (effective_to is null or effective_to > effective_from)
);

-- 1 regra vigente por médica
create unique index if not exists idx_dcr_one_active
  on public.doctor_compensation_rules(doctor_id) where effective_to is null;

create index if not exists idx_dcr_doctor_period
  on public.doctor_compensation_rules(doctor_id, effective_from desc);

-- ──────────────────────────────────────────────────────────────────────────
-- Tabela: appointments (consultas)
-- ──────────────────────────────────────────────────────────────────────────
-- Uma linha por consulta. payment_id é nullable porque na fila
-- on-demand (Sprint 4.2) o paciente pode estar usando crédito de
-- plano já comprado, sem nova cobrança individual. Pro MVP simples,
-- vincula 1:1 com um payment.

create table if not exists public.appointments (
  id                  uuid primary key default uuid_generate_v4(),
  doctor_id           uuid not null references public.doctors(id) on delete restrict,
  customer_id         uuid not null references public.customers(id) on delete restrict,
  payment_id          uuid          references public.payments(id) on delete set null,

  -- Tipo (define se gera on_demand_bonus na earning)
  kind                text not null default 'scheduled' check (kind in ('scheduled','on_demand')),

  -- Janela do agendamento
  scheduled_at        timestamptz not null,
  scheduled_until     timestamptz,                  -- pode ser scheduled_at + duration

  -- Vídeo (Daily.co)
  video_provider      text not null default 'daily',
  video_room_name     text,
  video_room_url      text,
  video_doctor_token  text,                          -- token estendido (pode ouvir/falar)
  video_patient_token text,                          -- token paciente (sem gravação UI)
  recording_consent   boolean not null default false,
  recording_url       text,

  -- Execução
  status              appointment_status not null default 'scheduled',
  started_at          timestamptz,
  ended_at            timestamptz,
  duration_seconds    int,                          -- preenchido em meeting.ended

  -- Conteúdo clínico (formulários renderizados pelo painel)
  anamnese            jsonb,                        -- estrutura definida no painel
  hipotese            text,
  conduta             text,
  memed_prescription_id text,
  memed_prescription_url text,

  -- Cancelamento
  cancelled_at        timestamptz,
  cancelled_reason    text,
  cancelled_by_user_id uuid references auth.users(id) on delete set null,

  -- Metadata Daily (raw)
  daily_room_id       text,
  daily_meeting_session_id text,
  daily_raw           jsonb,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_app_doctor_time on public.appointments(doctor_id, scheduled_at);
create index if not exists idx_app_customer on public.appointments(customer_id);
create index if not exists idx_app_status on public.appointments(status);
create index if not exists idx_app_payment on public.appointments(payment_id);

-- ──────────────────────────────────────────────────────────────────────────
-- Tabela: appointment_notifications (log de mensagens)
-- ──────────────────────────────────────────────────────────────────────────
-- Cada disparo de WhatsApp pra paciente vinculado a uma consulta.
-- Permite saber "já mandei lembrete T-24h dessa consulta?" antes do
-- cron disparar duplicado.

create table if not exists public.appointment_notifications (
  id              uuid primary key default uuid_generate_v4(),
  appointment_id  uuid not null references public.appointments(id) on delete cascade,

  channel         notification_channel not null default 'whatsapp',
  kind            text not null,        -- 'confirmacao' | 't_minus_24h' | 't_minus_1h' | 't_minus_15min' | 'on_demand_call' | 'pos_consulta' | 'no_show'
  template_name   text,                  -- ex: 'confirmacao_agendamento' (vazio se for free-form)
  payload         jsonb,                 -- request body enviado

  status          notification_status not null default 'pending',
  scheduled_for   timestamptz,
  sent_at         timestamptz,
  delivered_at    timestamptz,
  read_at         timestamptz,
  message_id      text,                  -- wa.mid:Xxx ou Asaas notification id
  error           text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_an_appt_kind on public.appointment_notifications(appointment_id, kind);
create index if not exists idx_an_status on public.appointment_notifications(status, scheduled_for) where status = 'pending';

-- ──────────────────────────────────────────────────────────────────────────
-- Tabela: doctor_earnings (ganhos imutáveis)
-- ──────────────────────────────────────────────────────────────────────────
-- Cada linha é um fato isolado e imutável. Editar = errado; ajustar =
-- criar nova linha tipo `adjustment` ou `refund_clawback`.

create table if not exists public.doctor_earnings (
  id                  uuid primary key default uuid_generate_v4(),
  doctor_id           uuid not null references public.doctors(id) on delete restrict,

  -- Origem do ganho (pelo menos um dos dois é preenchido)
  appointment_id      uuid          references public.appointments(id) on delete set null,
  payment_id          uuid          references public.payments(id) on delete set null,
  parent_earning_id   uuid          references public.doctor_earnings(id) on delete set null, -- pra clawback

  -- Snapshot da regra de compensação aplicada (auditoria)
  compensation_rule_id uuid         references public.doctor_compensation_rules(id) on delete set null,

  -- Conteúdo
  type                earning_type not null,
  amount_cents        int not null,                -- pode ser negativo (clawback/adjustment)
  description         text not null,               -- humano: "Consulta Maria S. em 28/05"
  metadata            jsonb,                       -- extra: hours: 4, reference_period: '2026-05', etc.

  -- Lifecycle
  earned_at           timestamptz not null default now(),
  status              earning_status not null default 'pending',
  available_at        timestamptz,                 -- preenchido quando passa a available
  paid_at             timestamptz,                 -- preenchido quando payout é confirmed
  cancelled_at        timestamptz,
  cancelled_reason    text,

  -- Vinculação ao payout
  payout_id           uuid,                        -- FK adicionada após criar tabela payouts (fwd ref)

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_de_doctor_status on public.doctor_earnings(doctor_id, status);
create index if not exists idx_de_appt on public.doctor_earnings(appointment_id);
create index if not exists idx_de_payment on public.doctor_earnings(payment_id);
create index if not exists idx_de_available on public.doctor_earnings(doctor_id, available_at) where status = 'available';
create index if not exists idx_de_payout on public.doctor_earnings(payout_id);

-- ──────────────────────────────────────────────────────────────────────────
-- Tabela: doctor_payouts (lotes mensais)
-- ──────────────────────────────────────────────────────────────────────────

create table if not exists public.doctor_payouts (
  id                  uuid primary key default uuid_generate_v4(),
  doctor_id           uuid not null references public.doctors(id) on delete restrict,

  reference_period    text not null,               -- 'YYYY-MM' do mês de competência
  amount_cents        int not null,                -- pode ser negativo se houver clawback grande
  earnings_count      int not null default 0,

  -- Snapshot do PIX no momento da geração (auditoria)
  pix_key_snapshot         text,
  pix_key_type_snapshot    pix_key_type,
  pix_key_holder_snapshot  text,

  -- Lifecycle
  status              payout_status not null default 'draft',
  approved_by         uuid references auth.users(id) on delete set null,
  approved_at         timestamptz,
  paid_at             timestamptz,
  pix_tx_id           text,                        -- end-to-end ID do PIX
  receipt_url         text,                        -- comprovante PDF (Supabase Storage)
  failed_reason       text,
  cancelled_reason    text,

  notes               text,                        -- visível só pro admin
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (doctor_id, reference_period)             -- 1 payout por médica/mês
);

-- Agora podemos adicionar a FK em earnings → payouts
do $$ begin
  alter table public.doctor_earnings
    add constraint fk_doctor_earnings_payout
    foreign key (payout_id) references public.doctor_payouts(id) on delete set null;
exception when duplicate_object then null; end $$;

create index if not exists idx_dp_doctor_period on public.doctor_payouts(doctor_id, reference_period desc);
create index if not exists idx_dp_status on public.doctor_payouts(status);

-- ──────────────────────────────────────────────────────────────────────────
-- Tabela: doctor_billing_documents (NF-e enviadas)
-- ──────────────────────────────────────────────────────────────────────────

create table if not exists public.doctor_billing_documents (
  id                  uuid primary key default uuid_generate_v4(),
  payout_id           uuid not null references public.doctor_payouts(id) on delete cascade,
  doctor_id           uuid not null references public.doctors(id) on delete restrict,

  type                billing_document_type not null default 'nfse',
  document_number     text,                       -- número/série da NF
  document_url        text not null,              -- PDF ou XML em Storage
  document_amount_cents int,                      -- valor que consta na NF (pra conferência)
  issued_at           timestamptz,                -- data de emissão da NF
  uploaded_at         timestamptz not null default now(),
  uploaded_by         uuid references auth.users(id) on delete set null,

  validated_at        timestamptz,
  validated_by        uuid references auth.users(id) on delete set null,
  validation_notes    text,

  created_at          timestamptz not null default now()
);

create index if not exists idx_dbd_payout on public.doctor_billing_documents(payout_id);
create index if not exists idx_dbd_doctor on public.doctor_billing_documents(doctor_id);

-- ──────────────────────────────────────────────────────────────────────────
-- Trigger: updated_at automático
-- ──────────────────────────────────────────────────────────────────────────
-- Reaproveita a função set_updated_at criada em migrations anteriores.

do $$ begin
  perform 1 from pg_proc where proname = 'set_updated_at';
  if not found then
    create or replace function public.set_updated_at()
    returns trigger language plpgsql as $f$
    begin
      new.updated_at = now();
      return new;
    end;
    $f$;
  end if;
end $$;

do $$ begin
  create trigger trg_doctors_updated_at before update on public.doctors
    for each row execute function public.set_updated_at();
exception when duplicate_object then null; end $$;

do $$ begin
  create trigger trg_dav_updated_at before update on public.doctor_availability
    for each row execute function public.set_updated_at();
exception when duplicate_object then null; end $$;

do $$ begin
  create trigger trg_dpm_updated_at before update on public.doctor_payment_methods
    for each row execute function public.set_updated_at();
exception when duplicate_object then null; end $$;

do $$ begin
  create trigger trg_app_updated_at before update on public.appointments
    for each row execute function public.set_updated_at();
exception when duplicate_object then null; end $$;

do $$ begin
  create trigger trg_an_updated_at before update on public.appointment_notifications
    for each row execute function public.set_updated_at();
exception when duplicate_object then null; end $$;

do $$ begin
  create trigger trg_de_updated_at before update on public.doctor_earnings
    for each row execute function public.set_updated_at();
exception when duplicate_object then null; end $$;

do $$ begin
  create trigger trg_dp_updated_at before update on public.doctor_payouts
    for each row execute function public.set_updated_at();
exception when duplicate_object then null; end $$;

-- ──────────────────────────────────────────────────────────────────────────
-- RLS — deny-by-default + políticas específicas
-- ──────────────────────────────────────────────────────────────────────────
-- Filosofia: backend (service_role) sempre passa por cima de RLS.
-- Usuários autenticados como "doctor" enxergam só os próprios dados.
-- Usuários autenticados como "admin" enxergam tudo.
-- Não-autenticados não enxergam nada (deny-by-default).
--
-- Roles são marcadas no JWT custom claim `role` ('doctor' | 'admin').

alter table public.doctors                   enable row level security;
alter table public.doctor_availability       enable row level security;
alter table public.doctor_payment_methods    enable row level security;
alter table public.doctor_compensation_rules enable row level security;
alter table public.appointments              enable row level security;
alter table public.appointment_notifications enable row level security;
alter table public.doctor_earnings           enable row level security;
alter table public.doctor_payouts            enable row level security;
alter table public.doctor_billing_documents  enable row level security;

-- Helper: extrai role do JWT
create or replace function public.jwt_role()
returns text language sql stable as $$
  select coalesce(
    auth.jwt() ->> 'role',
    (auth.jwt() -> 'app_metadata' ->> 'role'),
    (auth.jwt() -> 'user_metadata' ->> 'role'),
    ''
  );
$$;

-- Helper: doctor_id do médico autenticado
create or replace function public.current_doctor_id()
returns uuid language sql stable as $$
  select id from public.doctors where user_id = auth.uid() limit 1;
$$;

-- ── doctors ──
do $$ begin
  create policy "doctor_self_select" on public.doctors
    for select using (user_id = auth.uid() or public.jwt_role() = 'admin');
exception when duplicate_object then null; end $$;

-- Listagem pública (paciente escolhendo médica em /agendar) — só
-- expõe campos básicos via VIEW (criada abaixo). Deny direto na tabela.

-- ── doctor_availability ──
do $$ begin
  create policy "dav_doctor_self" on public.doctor_availability
    for all using (
      doctor_id = public.current_doctor_id() or public.jwt_role() = 'admin'
    ) with check (
      doctor_id = public.current_doctor_id() or public.jwt_role() = 'admin'
    );
exception when duplicate_object then null; end $$;

-- ── doctor_payment_methods ──
do $$ begin
  create policy "dpm_doctor_self" on public.doctor_payment_methods
    for all using (
      doctor_id = public.current_doctor_id() or public.jwt_role() = 'admin'
    ) with check (
      doctor_id = public.current_doctor_id() or public.jwt_role() = 'admin'
    );
exception when duplicate_object then null; end $$;

-- ── doctor_compensation_rules ──
do $$ begin
  create policy "dcr_select_self_or_admin" on public.doctor_compensation_rules
    for select using (
      doctor_id = public.current_doctor_id() or public.jwt_role() = 'admin'
    );
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "dcr_admin_write" on public.doctor_compensation_rules
    for all using (public.jwt_role() = 'admin')
    with check (public.jwt_role() = 'admin');
exception when duplicate_object then null; end $$;

-- ── appointments ──
do $$ begin
  create policy "app_doctor_self" on public.appointments
    for all using (
      doctor_id = public.current_doctor_id() or public.jwt_role() = 'admin'
    ) with check (
      doctor_id = public.current_doctor_id() or public.jwt_role() = 'admin'
    );
exception when duplicate_object then null; end $$;

-- ── appointment_notifications ──
do $$ begin
  create policy "an_admin_only" on public.appointment_notifications
    for all using (public.jwt_role() = 'admin')
    with check (public.jwt_role() = 'admin');
exception when duplicate_object then null; end $$;

-- ── doctor_earnings ──
do $$ begin
  create policy "de_doctor_self_select" on public.doctor_earnings
    for select using (
      doctor_id = public.current_doctor_id() or public.jwt_role() = 'admin'
    );
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "de_admin_write" on public.doctor_earnings
    for all using (public.jwt_role() = 'admin')
    with check (public.jwt_role() = 'admin');
exception when duplicate_object then null; end $$;

-- ── doctor_payouts ──
do $$ begin
  create policy "dp_doctor_self_select" on public.doctor_payouts
    for select using (
      doctor_id = public.current_doctor_id() or public.jwt_role() = 'admin'
    );
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "dp_admin_write" on public.doctor_payouts
    for all using (public.jwt_role() = 'admin')
    with check (public.jwt_role() = 'admin');
exception when duplicate_object then null; end $$;

-- ── doctor_billing_documents ──
do $$ begin
  create policy "dbd_doctor_self" on public.doctor_billing_documents
    for all using (
      doctor_id = public.current_doctor_id() or public.jwt_role() = 'admin'
    ) with check (
      doctor_id = public.current_doctor_id() or public.jwt_role() = 'admin'
    );
exception when duplicate_object then null; end $$;

-- ──────────────────────────────────────────────────────────────────────────
-- View: doctors_public (campos seguros pra exposição pública)
-- ──────────────────────────────────────────────────────────────────────────
-- Usada na página /agendar pra paciente escolher médica.
-- Mostra só dados não-sensíveis. Sem CNPJ, sem email, sem telefone.

create or replace view public.doctors_public as
  select
    id,
    coalesce(display_name, full_name) as name,
    crm_number,
    crm_uf,
    specialty,
    photo_url,
    bio,
    consultation_minutes
  from public.doctors
  where status = 'active';

grant select on public.doctors_public to anon, authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- Functions de domínio (chamadas pelo backend ou cron)
-- ──────────────────────────────────────────────────────────────────────────

-- Calcula available_at de uma earning específica usando a regra da
-- médica (puxada pelo doctor_id). Se a earning não tem payment
-- (plantão, bônus, ajuste), vira available imediatamente.
create or replace function public.compute_earning_available_at(
  p_doctor_id uuid,
  p_payment_id uuid
) returns timestamptz language plpgsql stable as $$
declare
  v_btype payment_billing_type;
  v_paid  timestamptz;
  v_days  int;
  v_dpix  int;
  v_dbol  int;
  v_dcc   int;
begin
  if p_payment_id is null then
    return now();
  end if;

  select billing_type, paid_at into v_btype, v_paid
    from public.payments where id = p_payment_id;

  if v_paid is null then
    return null;
  end if;

  select available_days_pix, available_days_boleto, available_days_card
    into v_dpix, v_dbol, v_dcc
    from public.doctor_compensation_rules
   where doctor_id = p_doctor_id and effective_to is null
   limit 1;

  -- defaults se médica não tem regra específica (não deveria acontecer)
  v_dpix := coalesce(v_dpix, 7);
  v_dbol := coalesce(v_dbol, 3);
  v_dcc  := coalesce(v_dcc, 30);

  v_days := case v_btype
    when 'PIX'         then v_dpix
    when 'BOLETO'      then v_dbol
    when 'CREDIT_CARD' then v_dcc
    else v_dpix
  end;

  return v_paid + (v_days || ' days')::interval;
end;
$$;

-- Recalcula availability de earnings pendentes
-- Roda diário via pg_cron às 00:00 BRT
create or replace function public.recalculate_earnings_availability()
returns int language plpgsql security definer as $$
declare
  v_count int := 0;
begin
  -- Calcula available_at faltando
  update public.doctor_earnings de
     set available_at = public.compute_earning_available_at(de.doctor_id, de.payment_id)
   where de.status = 'pending'
     and de.available_at is null
     and (de.payment_id is null or
          exists (select 1 from public.payments p
                   where p.id = de.payment_id and p.paid_at is not null));

  -- Promove para available
  update public.doctor_earnings
     set status = 'available', updated_at = now()
   where status = 'pending'
     and available_at is not null
     and available_at <= now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Gera payouts mensais a partir das earnings available
create or replace function public.generate_monthly_payouts(p_period text default null)
returns int language plpgsql security definer as $$
declare
  v_period text;
  v_period_end timestamptz;
  v_count int := 0;
  r record;
begin
  -- Default = mês passado (formato 'YYYY-MM')
  v_period := coalesce(
    p_period,
    to_char(date_trunc('month', now() - interval '1 month'), 'YYYY-MM')
  );
  v_period_end := (v_period || '-01')::timestamptz + interval '1 month';

  -- Pra cada médica com earnings available até o fim do período
  for r in
    select doctor_id, sum(amount_cents) as total, count(*) as cnt
      from public.doctor_earnings
     where status = 'available'
       and available_at < v_period_end
       and payout_id is null
     group by doctor_id
     having sum(amount_cents) <> 0
  loop
    -- Cria payout (idempotente: skip se já existe pra esse período)
    insert into public.doctor_payouts (
      doctor_id, reference_period, amount_cents, earnings_count,
      pix_key_snapshot, pix_key_type_snapshot, pix_key_holder_snapshot,
      status
    )
    select
      r.doctor_id, v_period, r.total, r.cnt,
      dpm.pix_key, dpm.pix_key_type, dpm.pix_key_holder,
      'draft'
    from public.doctor_payment_methods dpm
    where dpm.doctor_id = r.doctor_id and dpm.active = true
    on conflict (doctor_id, reference_period) do nothing;

    -- Vincula earnings ao payout (só se foi criado/encontrado)
    update public.doctor_earnings de
       set payout_id = dp.id, status = 'in_payout', updated_at = now()
      from public.doctor_payouts dp
     where dp.doctor_id = r.doctor_id
       and dp.reference_period = v_period
       and de.doctor_id = r.doctor_id
       and de.status = 'available'
       and de.available_at < v_period_end
       and de.payout_id is null;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- pg_cron: agenda os jobs (idempotente)
-- ──────────────────────────────────────────────────────────────────────────
-- Requer extensão pg_cron habilitada (Database → Extensions no Supabase).

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- Recalcular availability — diário às 00:00 BRT (03:00 UTC)
    perform cron.unschedule('inm_recalc_availability') where exists (
      select 1 from cron.job where jobname = 'inm_recalc_availability'
    );
    perform cron.schedule(
      'inm_recalc_availability',
      '0 3 * * *',
      $sql$ select public.recalculate_earnings_availability(); $sql$
    );

    -- Gerar payouts mensais — dia 1 às 06:00 BRT (09:00 UTC)
    perform cron.unschedule('inm_monthly_payouts') where exists (
      select 1 from cron.job where jobname = 'inm_monthly_payouts'
    );
    perform cron.schedule(
      'inm_monthly_payouts',
      '0 9 1 * *',
      $sql$ select public.generate_monthly_payouts(); $sql$
    );
  else
    raise notice 'pg_cron não está habilitado — habilite em Database → Extensions';
  end if;
end $$;

-- ============================================================================
-- FIM DA MIGRATION 005
-- ============================================================================
