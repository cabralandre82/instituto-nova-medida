-- ============================================================================
-- Migration · Fulfillments + aceite formal do plano (D-044 · onda 2.A)
-- ============================================================================
-- Até D-043, o fluxo financeiro assumia que o paciente pagava **antes** da
-- consulta: `/checkout/[slug]` criava payment → pós-pagamento gerava
-- appointment → médica atendia. Essa ordem é errada pro modelo clínico
-- real do Instituto:
--
--   1. Consulta inicial é **gratuita** — médica avalia sem cobrar.
--   2. Se houver indicação clínica, a médica **prescreve** um plano
--      (escolhido entre os planos cadastrados) e gera a receita Memed.
--   3. Paciente lê a prescrição dentro da área logada, **aceita
--      formalmente** o plano (texto + checkbox + submit imutável) e
--      só então é levado ao checkout (Asaas) pra pagar o ciclo inteiro
--      (pacote fechado, não recorrente).
--   4. Pagamento confirmado dispara o **fulfillment**: operador (admin)
--      recebe a receita, encaminha pra farmácia de manipulação, marca
--      "enviado" quando o medicamento sai, e "entregue" quando chega.
--
-- Essa migração cria **só o schema** (tabelas, enums, índices, RLS,
-- triggers) e o domínio de transição fica encapsulado em
-- `src/lib/fulfillments.ts`. As telas e endpoints chegam nas ondas
-- seguintes (2.B em diante) sem precisar mexer neste DDL.
--
-- Decisões-chave:
--
-- - `fulfillments` 1:1 com `appointments` via UNIQUE(appointment_id).
--   Paciente que não aceitar / não pagar deixa o fulfillment na 1ª
--   etapa e, pra começar de novo, precisa de **nova consulta**. Isso
--   reflete a realidade clínica (prescrição tem validade, não pode
--   ser reusada meses depois).
--
-- - `plan_acceptances` é **imutável** (trigger bloqueia UPDATE/DELETE)
--   porque é prova legal. Guardamos snapshot do texto exato aceito +
--   hash determinístico pra detectar qualquer alteração posterior.
--
-- - `appointments.prescription_status` distingue 3 desfechos clínicos:
--   `none` (consulta sem conclusão ainda) / `prescribed` (médica
--   indicou plano) / `declined` (médica avaliou e não indicou — sem
--   cobrança). A distinção importa pra analytics e pra médica não
--   receber repasse em consulta grátis sem prescrição.
--
-- - RLS segue o padrão já em uso: deny-by-default + policy pra médica
--   ver só o próprio + admin ALL. Acesso do paciente às próprias
--   rows fica no backend (service_role + filter por customer_id),
--   igual ao padrão do D-043.
-- ============================================================================

-- ──────────────────────────────────────────────────────────────────────────
-- 1. Enum fulfillment_status
-- ──────────────────────────────────────────────────────────────────────────
-- Estados legais (transições válidas em src/lib/fulfillments.ts):
--
--   pending_acceptance ──┬── accepted ──► pending_payment ──┬── paid ──► pharmacy_requested ──► shipped ──► delivered
--                        │                                   │
--                        └───────── cancelled ◄──────────────┘     (em qualquer etapa pré-delivered)
--
-- `cancelled` é sumidouro terminal. `delivered` também (fim do ciclo).

do $$ begin
  create type fulfillment_status as enum (
    'pending_acceptance',   -- médica finalizou com plano indicado; aguardando aceite do paciente
    'pending_payment',      -- paciente aceitou; cobrança Asaas criada; aguardando PAYMENT_RECEIVED
    'paid',                 -- pago; operador ainda não encaminhou à farmácia
    'pharmacy_requested',   -- receita enviada à farmácia de manipulação
    'shipped',              -- medicamento despachado ao paciente
    'delivered',            -- paciente confirmou recebimento (ou operador marcou)
    'cancelled'             -- cancelado em qualquer etapa pré-delivered
  );
exception when duplicate_object then null; end $$;

-- ──────────────────────────────────────────────────────────────────────────
-- 2. Colunas novas em appointments
-- ──────────────────────────────────────────────────────────────────────────
-- `prescribed_plan_id` — qual plano a médica indicou ao finalizar.
-- `prescription_status` — desfecho clínico da consulta.
-- `finalized_at` — momento em que a médica clicou "finalizar" no
--    painel. A partir daí, a prescrição e a conduta ficam imutáveis
--    (a aplicação valida isso; o banco só guarda o timestamp).

alter table public.appointments
  add column if not exists prescribed_plan_id uuid
    references public.plans(id) on delete set null,
  add column if not exists prescription_status text not null default 'none'
    check (prescription_status in ('none', 'prescribed', 'declined')),
  add column if not exists finalized_at timestamptz;

comment on column public.appointments.prescribed_plan_id is
  'Plano indicado pela médica nesta consulta (D-044). null = sem indicação clínica.';

comment on column public.appointments.prescription_status is
  'Desfecho clínico: none (ainda em aberto) · prescribed (médica indicou plano) · declined (médica avaliou sem indicar — consulta grátis sem cobrança).';

comment on column public.appointments.finalized_at is
  'Quando a médica finalizou a consulta no painel (D-044). A partir deste instante, a prescrição vira imutável na UI.';

create index if not exists idx_app_prescribed_plan
  on public.appointments(prescribed_plan_id)
  where prescribed_plan_id is not null;

-- Nota sobre `appointment_status = 'scheduled'`:
-- até D-043 o comment deste enum value era "paciente pagou e marcou".
-- Com D-044 o significado é simplesmente "consulta marcada" (a
-- cobrança acontece DEPOIS). Enum values não aceitam comment próprio
-- em Postgres, então atualizamos o comment da tabela.
comment on column public.appointments.status is
  'Estado da consulta. Desde D-044: scheduled = marcada (pode ser sem cobrança prévia — cobrança só acontece se houver prescrição e aceite pós-consulta).';

-- ──────────────────────────────────────────────────────────────────────────
-- 3. Tabela fulfillments
-- ──────────────────────────────────────────────────────────────────────────
-- 1 row por consulta que gerou prescrição. O unique(appointment_id)
-- impede múltiplos fulfillments pela mesma consulta — se o paciente
-- não aceitar ou desistir, precisa de nova consulta pra nova chance.

create table if not exists public.fulfillments (
  id                    uuid primary key default gen_random_uuid(),

  -- chaves de negócio
  appointment_id        uuid not null unique
                          references public.appointments(id) on delete restrict,
  customer_id           uuid not null
                          references public.customers(id) on delete restrict,
  doctor_id             uuid not null
                          references public.doctors(id) on delete restrict,
  plan_id               uuid not null
                          references public.plans(id) on delete restrict,
  payment_id            uuid unique
                          references public.payments(id) on delete set null,

  -- máquina de estados (transições validadas em src/lib/fulfillments.ts)
  status                fulfillment_status not null default 'pending_acceptance',

  -- timestamps de transição (idempotência: só setamos uma vez)
  accepted_at           timestamptz,
  paid_at               timestamptz,
  pharmacy_requested_at timestamptz,
  shipped_at            timestamptz,
  delivered_at          timestamptz,
  cancelled_at          timestamptz,

  -- operacional
  tracking_note         text,                           -- ex: "Transportadora X, código BR1234"
  cancelled_reason      text,                           -- livre (operador escreve)
  updated_by_user_id    uuid references auth.users(id) on delete set null,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table public.fulfillments is
  'Ciclo pós-consulta: aceite → pagamento → farmácia → envio → entrega. 1:1 com appointment (D-044).';

comment on column public.fulfillments.tracking_note is
  'Campo livre preenchido pelo operador quando marca shipped — transportadora, código de rastreio ou observação.';

create index if not exists idx_ff_customer   on public.fulfillments(customer_id);
create index if not exists idx_ff_doctor     on public.fulfillments(doctor_id);
create index if not exists idx_ff_status     on public.fulfillments(status);
create index if not exists idx_ff_created    on public.fulfillments(created_at desc);
create index if not exists idx_ff_open
  on public.fulfillments(status, created_at)
  where status not in ('delivered', 'cancelled');

drop trigger if exists ff_set_updated_at on public.fulfillments;
create trigger ff_set_updated_at
  before update on public.fulfillments
  for each row execute function public.set_updated_at();

-- ──────────────────────────────────────────────────────────────────────────
-- 4. Tabela plan_acceptances
-- ──────────────────────────────────────────────────────────────────────────
-- Registro legal do aceite formal. Imutável: trigger bloqueia UPDATE
-- e DELETE. Guardamos o texto exato que o paciente aceitou + hash
-- determinístico (sha256 do texto + plan_slug + prescription_url)
-- pra detectar qualquer adulteração posterior do conteúdo.

create table if not exists public.plan_acceptances (
  id                  uuid primary key default gen_random_uuid(),

  fulfillment_id      uuid not null unique
                        references public.fulfillments(id) on delete restrict,
  appointment_id      uuid not null
                        references public.appointments(id) on delete restrict,
  customer_id         uuid not null
                        references public.customers(id) on delete restrict,
  plan_id             uuid not null
                        references public.plans(id) on delete restrict,

  accepted_at         timestamptz not null default now(),
  acceptance_text     text not null,             -- snapshot exato exibido ao paciente
  acceptance_hash     text not null,             -- sha256 hex do texto canonicalizado

  -- quem e de onde
  user_id             uuid references auth.users(id) on delete set null,
  ip_address          inet,
  user_agent          text
);

comment on table public.plan_acceptances is
  'Prova legal do aceite formal do plano pelo paciente. Imutável (D-044).';

create index if not exists idx_pa_customer     on public.plan_acceptances(customer_id);
create index if not exists idx_pa_appointment  on public.plan_acceptances(appointment_id);
create index if not exists idx_pa_accepted_at  on public.plan_acceptances(accepted_at desc);

-- Imutabilidade via trigger: raise exception em UPDATE ou DELETE.
create or replace function public.prevent_plan_acceptance_changes()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'plan_acceptances é imutável — rows nunca podem ser alteradas ou removidas (D-044).';
end;
$$;

drop trigger if exists trg_plan_acceptances_immutable on public.plan_acceptances;
create trigger trg_plan_acceptances_immutable
  before update or delete on public.plan_acceptances
  for each row execute function public.prevent_plan_acceptance_changes();

comment on function public.prevent_plan_acceptance_changes is
  'Bloqueia UPDATE/DELETE em plan_acceptances. Aceite é prova legal imutável (D-044).';

-- ──────────────────────────────────────────────────────────────────────────
-- 5. RLS
-- ──────────────────────────────────────────────────────────────────────────
-- Padrão: deny-by-default + admin ALL + médica SELECT das próprias
-- linhas. Paciente segue lendo via backend service_role com filtro
-- code-level por customer_id (mesma decisão do D-043 — RLS por
-- customer exige mapear auth.uid → customer_id via join, fica pra
-- sprint futura de hardening).

alter table public.fulfillments       enable row level security;
alter table public.plan_acceptances   enable row level security;

-- ── fulfillments ──
do $$ begin
  create policy "ff_admin_all" on public.fulfillments
    for all
    using (public.jwt_role() = 'admin')
    with check (public.jwt_role() = 'admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "ff_doctor_self_select" on public.fulfillments
    for select
    using (
      doctor_id = public.current_doctor_id()
      or public.jwt_role() = 'admin'
    );
exception when duplicate_object then null; end $$;

-- ── plan_acceptances ──
do $$ begin
  create policy "pa_admin_all" on public.plan_acceptances
    for all
    using (public.jwt_role() = 'admin')
    with check (public.jwt_role() = 'admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "pa_doctor_self_select" on public.plan_acceptances
    for select
    using (
      public.jwt_role() = 'admin'
      or exists (
        select 1 from public.fulfillments f
         where f.id = plan_acceptances.fulfillment_id
           and f.doctor_id = public.current_doctor_id()
      )
    );
exception when duplicate_object then null; end $$;

-- FIM
