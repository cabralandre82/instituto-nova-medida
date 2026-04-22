-- ───────────────────────────────────────────────────────────────────────
-- Migration: 20260511000000_soft_delete_clinical_tables
-- Decisão arquitetural: D-074 (PR-066 · finding 10.8)
--
-- Contexto
-- ────────
-- `DELETE FROM appointments WHERE ...` é destrutivo. CFM Res. 1.821/2007
-- Art. 8º exige retenção do prontuário por 20 anos. Um `DELETE` acidental
-- (admin solo via SQL Studio, migration com `TRUNCATE`, cron buggy, hotfix
-- mal pensado) apaga prontuário irrecuperavelmente — e dependendo de como
-- está o backup, pode ser impossível restaurar um subset sem perder outros
-- registros. Hoje não há nenhum call-site que use `.delete()` nessas
-- tabelas no app (confirmado grep em 2026-04-20), então o vetor de risco
-- é operacional e acidental.
--
-- Tabelas já protegidas (fora do escopo aqui):
--   - `plan_acceptances`            — trigger `trg_plan_acceptances_immutable` (D-049).
--   - `admin_audit_log`             — trigger imutável (D-048).
--   - `patient_access_log`          — trigger imutável (D-051).
--   - `document_access_log`         — trigger imutável (D-066).
--   - `checkout_consents`           — trigger imutável (D-064).
--   - `appointment_state_transition_log` — trigger imutável (D-070).
--
-- Escopo desta onda (A):
--   - `appointments`       — prontuário core (hipotese, conduta, anamnese).
--   - `fulfillments`       — tratamento efetivamente dispensado.
--   - `doctor_earnings`    — liga pagamento a prontuário (audit financeiro).
--   - `doctor_payouts`     — fechamento mensal (audit financeiro).
--
-- Fora do escopo (onda B futura, baixo volume/prioridade):
--   - `customers`, `leads` — já têm anonimização LGPD própria (D-051/D-052).
--   - `doctor_billing_documents`, `doctor_payment_methods`, `doctor_availability`
--     — têm `.delete()` legítimo no app (não são prontuário).
--
-- Solução
-- ────────
-- Pra cada tabela do escopo:
--
-- 1. Colunas de soft delete:
--      deleted_at        timestamptz null
--      deleted_by        uuid references auth.users(id) on delete set null
--      deleted_by_email  text                     -- snapshot D-072
--      deleted_reason    text
--
-- 2. Trigger `prevent_hard_delete_<table>()` em `BEFORE DELETE`:
--    bloqueia `DELETE` a menos que a GUC de sessão
--    `app.soft_delete.allow_hard_delete = 'true'` esteja setada. Essa GUC
--    é deliberadamente obscura e só existe pra operações excepcionais do
--    DBA (migration de descarte consciente, teste isolado, etc.). Na
--    operação normal do app, é impossível deletar.
--
-- 3. Trigger `enforce_soft_delete_fields_<table>()` em `BEFORE UPDATE`:
--    quando `deleted_at` TRANSICIONA de null → not null, exige que
--    `deleted_reason` também seja preenchido. Evita soft delete "sem
--    motivo" que deixa o log incompleto.
--
-- 4. Índice parcial `idx_<table>_active ON <table>(...) WHERE deleted_at IS NULL`
--    pra que queries que filtrem o vivo mantenham performance.
--
-- 5. NÃO criamos views `*_active`. Call-sites atuais do app não precisam
--    ser alterados porque `deleted_at IS NULL` é universal hoje (nenhum
--    registro soft-deletado existe). Quando o soft delete for usado
--    concretamente, cada call-site relevante adiciona `.is("deleted_at", null)`
--    explicitamente. Mais explícito, menos mágica, menor pegada.
--
-- Bypass documentado (uso pontual pelo operador, nunca pelo app):
--
--   begin;
--     set local app.soft_delete.allow_hard_delete = 'true';
--     delete from appointments where id = '...' and status = 'cancelled_by_admin';
--   commit;
--
-- (ou rollback; em caso de dúvida)
--
-- Invariantes garantidas
-- ──────────────────────
-- - `DELETE` normal nas 4 tabelas → `raise exception 'hard delete forbidden'`.
-- - `UPDATE` que seta `deleted_at` SEM `deleted_reason` → `raise exception`.
-- - `TRUNCATE` é operação de super-user; triggers não capturam. Mitigação:
--   role `service_role` do Supabase não tem `TRUNCATE` privilege por padrão;
--   só `postgres` (owner) consegue. É aceitável.
-- - Colunas são nullable (exceto por regra trigger) pra permitir rows
--   históricas que ainda não foram tocadas.
-- - RLS policies existentes continuam valendo; não alteramos policies
--   nesta migration.
-- - Rollback trivial: basta `DROP TRIGGER` + `ALTER TABLE DROP COLUMN`
--   (todas colunas novas são nullable e sem FK restrictive).
-- ───────────────────────────────────────────────────────────────────────

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 1) Colunas de soft delete                                          │
-- └────────────────────────────────────────────────────────────────────┘

-- appointments
alter table public.appointments
  add column if not exists deleted_at       timestamptz,
  add column if not exists deleted_by       uuid references auth.users(id) on delete set null,
  add column if not exists deleted_by_email text,
  add column if not exists deleted_reason   text;

comment on column public.appointments.deleted_at is
  'PR-066 · D-074 · soft delete. NULL = ativo. Timestamp = quando foi soft-deletado. Ver docs/DECISIONS.md#D-074.';
comment on column public.appointments.deleted_by is
  'PR-066 · D-074 · usuário que soft-deletou (set null on user delete — pareado com deleted_by_email).';
comment on column public.appointments.deleted_by_email is
  'PR-066 · D-074 · snapshot do email do actor no soft delete (sobrevive deleção/anon do usuário, padrão D-072).';
comment on column public.appointments.deleted_reason is
  'PR-066 · D-074 · motivo obrigatório do soft delete. Trigger exige ≥ 1 char quando deleted_at passa de null → not null.';

-- fulfillments
alter table public.fulfillments
  add column if not exists deleted_at       timestamptz,
  add column if not exists deleted_by       uuid references auth.users(id) on delete set null,
  add column if not exists deleted_by_email text,
  add column if not exists deleted_reason   text;

comment on column public.fulfillments.deleted_at is
  'PR-066 · D-074 · soft delete. NULL = ativo. Timestamp = quando foi soft-deletado.';
comment on column public.fulfillments.deleted_by is
  'PR-066 · D-074 · usuário que soft-deletou (set null on user delete — pareado com deleted_by_email).';
comment on column public.fulfillments.deleted_by_email is
  'PR-066 · D-074 · snapshot do email do actor no soft delete (padrão D-072).';
comment on column public.fulfillments.deleted_reason is
  'PR-066 · D-074 · motivo obrigatório do soft delete.';

-- doctor_earnings
alter table public.doctor_earnings
  add column if not exists deleted_at       timestamptz,
  add column if not exists deleted_by       uuid references auth.users(id) on delete set null,
  add column if not exists deleted_by_email text,
  add column if not exists deleted_reason   text;

comment on column public.doctor_earnings.deleted_at is
  'PR-066 · D-074 · soft delete. NULL = ativo.';
comment on column public.doctor_earnings.deleted_by is
  'PR-066 · D-074 · usuário que soft-deletou (set null on user delete — pareado com deleted_by_email).';
comment on column public.doctor_earnings.deleted_by_email is
  'PR-066 · D-074 · snapshot do email do actor no soft delete (padrão D-072).';
comment on column public.doctor_earnings.deleted_reason is
  'PR-066 · D-074 · motivo obrigatório do soft delete.';

-- doctor_payouts
alter table public.doctor_payouts
  add column if not exists deleted_at       timestamptz,
  add column if not exists deleted_by       uuid references auth.users(id) on delete set null,
  add column if not exists deleted_by_email text,
  add column if not exists deleted_reason   text;

comment on column public.doctor_payouts.deleted_at is
  'PR-066 · D-074 · soft delete. NULL = ativo.';
comment on column public.doctor_payouts.deleted_by is
  'PR-066 · D-074 · usuário que soft-deletou (set null on user delete — pareado com deleted_by_email).';
comment on column public.doctor_payouts.deleted_by_email is
  'PR-066 · D-074 · snapshot do email do actor no soft delete (padrão D-072).';
comment on column public.doctor_payouts.deleted_reason is
  'PR-066 · D-074 · motivo obrigatório do soft delete.';

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 2) Helper: lê GUC de bypass                                        │
-- └────────────────────────────────────────────────────────────────────┘

create or replace function public.soft_delete_hard_delete_allowed()
returns boolean
language plpgsql
stable
as $$
declare
  v text;
begin
  -- current_setting com missing_ok = true devolve '' se a GUC não existe.
  v := current_setting('app.soft_delete.allow_hard_delete', true);
  return coalesce(v, '') = 'true';
end;
$$;

comment on function public.soft_delete_hard_delete_allowed() is
  'PR-066 · D-074 · devolve true se a sessão atual setou app.soft_delete.allow_hard_delete=true. Usado pelos triggers prevent_hard_delete_* para permitir bypass explícito de DBA em operações excepcionais (nunca pelo app).';

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 3) Triggers: prevent_hard_delete_<table> (BEFORE DELETE)           │
-- └────────────────────────────────────────────────────────────────────┘

create or replace function public.prevent_hard_delete_appointments()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.soft_delete_hard_delete_allowed() then
    -- Bypass explícito. Mesmo assim log: DBA está consciente.
    raise notice 'PR-066 · hard delete permitido em appointments.id=% (bypass)', old.id;
    return old;
  end if;
  raise exception 'PR-066 · D-074 · hard delete proibido em appointments. Use soft delete (update deleted_at/deleted_reason). Bypass excepcional: SET LOCAL app.soft_delete.allow_hard_delete=''true''.';
end;
$$;

drop trigger if exists trg_prevent_hard_delete_appointments on public.appointments;
create trigger trg_prevent_hard_delete_appointments
  before delete on public.appointments
  for each row execute function public.prevent_hard_delete_appointments();

create or replace function public.prevent_hard_delete_fulfillments()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.soft_delete_hard_delete_allowed() then
    raise notice 'PR-066 · hard delete permitido em fulfillments.id=% (bypass)', old.id;
    return old;
  end if;
  raise exception 'PR-066 · D-074 · hard delete proibido em fulfillments. Use soft delete (update deleted_at/deleted_reason).';
end;
$$;

drop trigger if exists trg_prevent_hard_delete_fulfillments on public.fulfillments;
create trigger trg_prevent_hard_delete_fulfillments
  before delete on public.fulfillments
  for each row execute function public.prevent_hard_delete_fulfillments();

create or replace function public.prevent_hard_delete_doctor_earnings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.soft_delete_hard_delete_allowed() then
    raise notice 'PR-066 · hard delete permitido em doctor_earnings.id=% (bypass)', old.id;
    return old;
  end if;
  raise exception 'PR-066 · D-074 · hard delete proibido em doctor_earnings. Use soft delete (update deleted_at/deleted_reason).';
end;
$$;

drop trigger if exists trg_prevent_hard_delete_doctor_earnings on public.doctor_earnings;
create trigger trg_prevent_hard_delete_doctor_earnings
  before delete on public.doctor_earnings
  for each row execute function public.prevent_hard_delete_doctor_earnings();

create or replace function public.prevent_hard_delete_doctor_payouts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.soft_delete_hard_delete_allowed() then
    raise notice 'PR-066 · hard delete permitido em doctor_payouts.id=% (bypass)', old.id;
    return old;
  end if;
  raise exception 'PR-066 · D-074 · hard delete proibido em doctor_payouts. Use soft delete (update deleted_at/deleted_reason).';
end;
$$;

drop trigger if exists trg_prevent_hard_delete_doctor_payouts on public.doctor_payouts;
create trigger trg_prevent_hard_delete_doctor_payouts
  before delete on public.doctor_payouts
  for each row execute function public.prevent_hard_delete_doctor_payouts();

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 4) Triggers: enforce_soft_delete_fields (BEFORE UPDATE)            │
-- │    Exige deleted_reason quando deleted_at passa de null → not null │
-- └────────────────────────────────────────────────────────────────────┘

create or replace function public.enforce_soft_delete_fields()
returns trigger
language plpgsql
as $$
begin
  -- Só age quando deleted_at transita de null → not null.
  if old.deleted_at is null and new.deleted_at is not null then
    if new.deleted_reason is null or length(trim(new.deleted_reason)) = 0 then
      raise exception 'PR-066 · D-074 · soft delete requer deleted_reason não vazio (tabela %)', tg_table_name;
    end if;
    -- Protege contra "undelete silencioso" em transação inconsistente:
    -- se deleted_at foi preenchido agora, não pode ser null no mesmo
    -- UPDATE. (defensive; um update normal que zera deleted_at — undelete
    -- — entra pelo outro ramo do if e é permitido.)
  end if;
  return new;
end;
$$;

comment on function public.enforce_soft_delete_fields() is
  'PR-066 · D-074 · trigger BEFORE UPDATE que exige deleted_reason quando deleted_at transita null → not null. Aplicado nas 4 tabelas do escopo.';

drop trigger if exists trg_enforce_soft_delete_appointments on public.appointments;
create trigger trg_enforce_soft_delete_appointments
  before update of deleted_at, deleted_reason on public.appointments
  for each row execute function public.enforce_soft_delete_fields();

drop trigger if exists trg_enforce_soft_delete_fulfillments on public.fulfillments;
create trigger trg_enforce_soft_delete_fulfillments
  before update of deleted_at, deleted_reason on public.fulfillments
  for each row execute function public.enforce_soft_delete_fields();

drop trigger if exists trg_enforce_soft_delete_doctor_earnings on public.doctor_earnings;
create trigger trg_enforce_soft_delete_doctor_earnings
  before update of deleted_at, deleted_reason on public.doctor_earnings
  for each row execute function public.enforce_soft_delete_fields();

drop trigger if exists trg_enforce_soft_delete_doctor_payouts on public.doctor_payouts;
create trigger trg_enforce_soft_delete_doctor_payouts
  before update of deleted_at, deleted_reason on public.doctor_payouts
  for each row execute function public.enforce_soft_delete_fields();

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 5) Índices parciais WHERE deleted_at IS NULL                       │
-- │    Garantem que queries do vivo continuam com a mesma performance  │
-- │    mesmo após acumular soft-deletes históricos.                    │
-- └────────────────────────────────────────────────────────────────────┘

create index if not exists idx_appointments_active_scheduled
  on public.appointments (scheduled_at)
  where deleted_at is null;

create index if not exists idx_appointments_active_doctor_scheduled
  on public.appointments (doctor_id, scheduled_at)
  where deleted_at is null;

create index if not exists idx_appointments_active_customer_scheduled
  on public.appointments (customer_id, scheduled_at)
  where deleted_at is null;

create index if not exists idx_fulfillments_active_status
  on public.fulfillments (status, created_at)
  where deleted_at is null;

create index if not exists idx_fulfillments_active_doctor
  on public.fulfillments (doctor_id, created_at)
  where deleted_at is null;

create index if not exists idx_fulfillments_active_customer
  on public.fulfillments (customer_id, created_at)
  where deleted_at is null;

create index if not exists idx_doctor_earnings_active_doctor_status
  on public.doctor_earnings (doctor_id, status)
  where deleted_at is null;

create index if not exists idx_doctor_payouts_active_doctor_status
  on public.doctor_payouts (doctor_id, status)
  where deleted_at is null;

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 6) Sanity: não pode existir row com deleted_at preenchido E        │
-- │    deleted_reason vazio (o trigger de UPDATE cobre novos inserts,  │
-- │    este CHECK cobre persistência em disco).                         │
-- └────────────────────────────────────────────────────────────────────┘

alter table public.appointments
  add constraint appointments_soft_delete_reason_chk
  check (deleted_at is null or (deleted_reason is not null and length(trim(deleted_reason)) > 0))
  not valid;

alter table public.fulfillments
  add constraint fulfillments_soft_delete_reason_chk
  check (deleted_at is null or (deleted_reason is not null and length(trim(deleted_reason)) > 0))
  not valid;

alter table public.doctor_earnings
  add constraint doctor_earnings_soft_delete_reason_chk
  check (deleted_at is null or (deleted_reason is not null and length(trim(deleted_reason)) > 0))
  not valid;

alter table public.doctor_payouts
  add constraint doctor_payouts_soft_delete_reason_chk
  check (deleted_at is null or (deleted_reason is not null and length(trim(deleted_reason)) > 0))
  not valid;

-- Valida imediatamente (todas rows atuais têm deleted_at IS NULL, então
-- a constraint passa; NOT VALID é só garantia defensiva pra migration
-- segura caso alguma row já não estivesse íntegra).
alter table public.appointments    validate constraint appointments_soft_delete_reason_chk;
alter table public.fulfillments    validate constraint fulfillments_soft_delete_reason_chk;
alter table public.doctor_earnings validate constraint doctor_earnings_soft_delete_reason_chk;
alter table public.doctor_payouts  validate constraint doctor_payouts_soft_delete_reason_chk;
