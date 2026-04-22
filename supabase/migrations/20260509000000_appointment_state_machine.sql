-- ───────────────────────────────────────────────────────────────────────
-- Migration: 20260509000000_appointment_state_machine
-- Decisão arquitetural: D-070 (PR-059 · finding 10.5)
--
-- Contexto
-- ────────
-- A coluna `appointments.status` (enum `appointment_status`) tem CHECK
-- de valores válidos, mas QUALQUER transição entre eles é aceita pelo
-- DB. A camada de aplicação (`reconcile.ts`, `appointment-finalize.ts`,
-- daily webhook, RPC `book_pending_appointment_slot` etc.) respeita
-- transições legítimas, mas:
--
--   1. `getSupabaseAdmin()` usa service_role → bypassa RLS. Um admin
--      via SQL Studio (ou hotfix CLI) pode levar `cancelled_by_admin`
--      → `completed` sem rastro.
--   2. Bug futuro pode regredir: alguma rota nova esquece de checar
--      `status atual` antes de updatar.
--   3. Forense CFM exige rastreabilidade do prontuário (Res. 1.821/2007
--      Art. 8º). "Quem mudou status quando" precisa ser auditável.
--
-- Solução
-- ────────
-- 1. Tabela declarativa `appointment_state_transitions(from_status, to_status)`
--    seedada com TODAS as transições que o código real faz hoje
--    (mapeadas via grep em 2026-04-20). É a fonte de verdade.
--
-- 2. Trigger `BEFORE UPDATE OF status` em `appointments` valida cada
--    mudança contra a tabela. Comportamento configurável via setting
--    `app.appointment_state_machine.mode`:
--
--       'warn'    (default) → registra log, NÃO bloqueia
--       'enforce'           → registra log + RAISE EXCEPTION pra bloquear
--       'off'               → trigger é no-op (escape hatch emergencial)
--
--    Bypass por sessão: setar `app.appointment_state_machine.bypass = 'true'`
--    desabilita validação só naquela transação. Usado pra hotfix manual
--    do admin (que mesmo assim grava o log com `bypass=true`).
--
-- 3. Tabela imutável `appointment_state_transition_log` registra TODAS
--    as transições (válidas, warning, blocked, bypass) com:
--    - from_status, to_status, action ('allowed' | 'warning' | 'blocked' | 'bypassed' | 'noop')
--    - by_user (extraído de `request.jwt.claims`, fallback 'service_role_system')
--    - mode_at_time (qual modo o setting estava no momento)
--    - created_at
--    Imutável por trigger (sem UPDATE/DELETE).
--
-- Plano de rollout (D-070)
-- ────────────────────────
-- - Deploy desta migration em modo 'warn' (default).
-- - Observar `appointment_state_transition_log` por 1-2 semanas. Se
--   aparecer warning genuíno, decidir caso a caso (adicionar transição
--   à seed ou corrigir o caller).
-- - Quando warning_count = 0 por 7 dias seguidos, mudar `db.config` pra
--   'enforce' (Vercel env var → init-script roda
--   `ALTER DATABASE … SET app.appointment_state_machine.mode = 'enforce'`).
--   Documentado em RUNBOOK.md.
--
-- Não-objetivos
-- ─────────────
-- - Não cobre INSERT (state inicial) — a RPC `book_pending_appointment_slot`
--   já força `pending_payment`; INSERT direto é raro e fica fora do escopo.
-- - Não cobre `prescription_status` (já tem trigger imutabilidade pós-finalização
--   via migration 20260428010000).
-- - Não cobre coluna `refund_processed_at` (idempotência por unique partial).
-- ───────────────────────────────────────────────────────────────────────

-- ════════════════════════════════════════════════════════════════════
-- 1) Tabela declarativa de transições válidas
-- ════════════════════════════════════════════════════════════════════

create table if not exists public.appointment_state_transitions (
  from_status   public.appointment_status not null,
  to_status     public.appointment_status not null,
  description   text,
  added_at      timestamptz not null default now(),
  primary key (from_status, to_status)
);

comment on table public.appointment_state_transitions is
  'Lista declarativa de transições válidas em appointments.status. '
  'Seedada em 2026-04-20 com base em grep do código real. Adicionar '
  'linha aqui é a forma oficial de permitir uma nova transição — '
  'NÃO disable a trigger, NÃO altera enum sem revisar.';

-- Seed: transições documentadas em código (2026-04-20).
-- Cada bloco está acompanhado da origem real da mudança.

insert into public.appointment_state_transitions (from_status, to_status, description) values
  -- pending_payment: criado pela RPC book_pending_appointment_slot.
  --   - vira scheduled após pagamento confirmado (RPC activate_appointment_after_payment).
  --   - vira cancelled_by_admin se TTL expirar (RPC expire_abandoned_reservations).
  ('pending_payment', 'scheduled',           'Pagamento confirmado (activate_appointment_after_payment)'),
  ('pending_payment', 'cancelled_by_admin',  'TTL expirou ou cleanup pré-insert (expire_abandoned_reservations / book_pending_appointment_slot)'),
  ('pending_payment', 'cancelled_by_patient','Paciente cancela antes de pagar (futuro: UI de cancelamento)'),
  ('pending_payment', 'cancelled_by_doctor', 'Médica cancela slot antes do paciente pagar'),
  -- Defensivo: reconcile pode pegar appt em pending_payment se webhook ouvir meeting.ended sem ter visto meeting.started.
  ('pending_payment', 'completed',           'Defensivo: reconcile fecha appt sem started_at (caso raro)'),
  ('pending_payment', 'no_show_patient',     'Defensivo: reconcile classifica no-show direto sem ter passado por scheduled'),
  ('pending_payment', 'no_show_doctor',      'Defensivo: idem para no-show da médica'),

  -- scheduled: pago e agendado. Pode confirmar (notificação), iniciar, cancelar ou virar terminal pelo reconcile.
  ('scheduled', 'confirmed',           'Notificação de confirmação enviada / paciente confirmou'),
  ('scheduled', 'in_progress',         'Daily meeting.started detectado (webhook)'),
  ('scheduled', 'completed',           'reconcile: ambos entraram OU appointment-finalize sem passar por in_progress'),
  ('scheduled', 'no_show_patient',     'reconcile: só médica entrou'),
  ('scheduled', 'no_show_doctor',      'reconcile: só paciente entrou'),
  ('scheduled', 'cancelled_by_patient','Paciente cancelou'),
  ('scheduled', 'cancelled_by_doctor', 'Médica cancelou'),
  ('scheduled', 'cancelled_by_admin',  'Admin cancelou OU reconcile expired_no_one_joined'),

  -- confirmed: notificação confirmada. Mesmas saídas que scheduled.
  ('confirmed', 'in_progress',         'Daily meeting.started'),
  ('confirmed', 'completed',           'reconcile / appointment-finalize'),
  ('confirmed', 'no_show_patient',     'reconcile: só médica entrou'),
  ('confirmed', 'no_show_doctor',      'reconcile: só paciente entrou'),
  ('confirmed', 'cancelled_by_patient','Paciente cancelou'),
  ('confirmed', 'cancelled_by_doctor', 'Médica cancelou'),
  ('confirmed', 'cancelled_by_admin',  'Admin cancelou OU reconcile expired_no_one_joined'),

  -- in_progress: meeting rolando. Só pode virar terminal.
  ('in_progress', 'completed',           'reconcile (ambos entraram E duração ≥ 3min) OU appointment-finalize'),
  ('in_progress', 'no_show_patient',     'reconcile: paciente nunca entrou apesar de meeting.started'),
  ('in_progress', 'no_show_doctor',      'reconcile: médica nunca entrou'),
  ('in_progress', 'cancelled_by_admin',  'Admin força encerramento (cron de timeout, expired_no_one_joined defensivo)'),
  ('in_progress', 'cancelled_by_doctor', 'Médica encerra meeting cedo'),
  ('in_progress', 'cancelled_by_patient','Paciente sai e cancela')
on conflict (from_status, to_status) do nothing;

-- Estados terminais (completed, no_show_*, cancelled_*) NÃO têm linha
-- na tabela — qualquer transição a partir deles é "warning" (warn mode)
-- ou "blocked" (enforce mode). Reconcile com forceTouch é exceção
-- documentada (ver bypass abaixo).

-- ════════════════════════════════════════════════════════════════════
-- 2) Tabela de log de transições (audit imutável)
-- ════════════════════════════════════════════════════════════════════

create table if not exists public.appointment_state_transition_log (
  id              uuid primary key default gen_random_uuid(),
  appointment_id  uuid not null references public.appointments(id) on delete cascade,
  from_status     public.appointment_status not null,
  to_status       public.appointment_status not null,
  action          text not null
    check (action in ('allowed','warning','blocked','bypassed','noop')),
  mode_at_time    text not null
    check (mode_at_time in ('warn','enforce','off')),
  by_user_id      uuid references auth.users(id) on delete set null,
  by_user_email   text,
  by_role         text,
  bypass_reason   text,
  created_at      timestamptz not null default now()
);

comment on table public.appointment_state_transition_log is
  'Audit trail imutável de cada transição de appointments.status. '
  'Inclui mudanças bloqueadas (enforce mode), permitidas em warn '
  '(quando seriam bloqueadas em enforce) e bypasses explícitos.';

create index if not exists idx_apptlog_appt_created
  on public.appointment_state_transition_log (appointment_id, created_at desc);
create index if not exists idx_apptlog_action_created
  on public.appointment_state_transition_log (action, created_at desc)
  where action in ('warning','blocked','bypassed');

-- Imutabilidade por trigger.
create or replace function public.appointment_state_transition_log_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'appointment_state_transition_log é imutável (operação %)', tg_op
    using errcode = '0L000', hint = 'Trilha de transições não pode ser editada nem deletada.';
end;
$$;

drop trigger if exists trg_apptlog_no_update on public.appointment_state_transition_log;
create trigger trg_apptlog_no_update
  before update on public.appointment_state_transition_log
  for each row execute function public.appointment_state_transition_log_immutable();

drop trigger if exists trg_apptlog_no_delete on public.appointment_state_transition_log;
create trigger trg_apptlog_no_delete
  before delete on public.appointment_state_transition_log
  for each row execute function public.appointment_state_transition_log_immutable();

-- RLS deny-all (consultas via service_role).
alter table public.appointment_state_transition_log enable row level security;

drop policy if exists apptlog_deny_anon on public.appointment_state_transition_log;
create policy apptlog_deny_anon
  on public.appointment_state_transition_log for all to anon
  using (false) with check (false);

drop policy if exists apptlog_deny_authenticated on public.appointment_state_transition_log;
create policy apptlog_deny_authenticated
  on public.appointment_state_transition_log for all to authenticated
  using (false) with check (false);

-- ════════════════════════════════════════════════════════════════════
-- 3) Helper: lê modo atual do setting (com fallback 'warn')
-- ════════════════════════════════════════════════════════════════════

create or replace function public.appointment_state_machine_mode()
returns text
language plpgsql
stable
as $$
declare
  v_mode text;
begin
  v_mode := nullif(current_setting('app.appointment_state_machine.mode', true), '');
  if v_mode is null then
    return 'warn';
  end if;
  if v_mode not in ('warn','enforce','off') then
    raise warning 'appointment_state_machine: modo desconhecido %, usando warn', v_mode;
    return 'warn';
  end if;
  return v_mode;
end;
$$;

comment on function public.appointment_state_machine_mode is
  'Lê app.appointment_state_machine.mode. Default warn. Use ALTER '
  'DATABASE/ROLE/SESSION SET pra mudar (ver RUNBOOK.md).';

-- ════════════════════════════════════════════════════════════════════
-- 4) Trigger principal: valida transição BEFORE UPDATE
-- ════════════════════════════════════════════════════════════════════

create or replace function public.validate_appointment_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mode      text;
  v_bypass    text;
  v_allowed   boolean;
  v_jwt       jsonb;
  v_user_id   uuid;
  v_email     text;
  v_role      text;
  v_action    text;
  v_reason    text;
begin
  -- Só intervem se status REALMENTE mudou.
  if new.status is not distinct from old.status then
    return new;
  end if;

  v_mode := public.appointment_state_machine_mode();

  -- Modo OFF: trigger não opera (nem loga). Escape hatch emergencial.
  if v_mode = 'off' then
    return new;
  end if;

  -- Lê quem está na sessão (para audit). JWT pode estar vazio (service_role).
  v_jwt := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_user_id := (v_jwt ->> 'sub')::uuid;
  v_email := v_jwt ->> 'email';
  v_role := coalesce(v_jwt ->> 'role', current_user);

  -- Bypass explícito por transação. Sempre loga.
  v_bypass := nullif(current_setting('app.appointment_state_machine.bypass', true), '');
  if v_bypass = 'true' then
    insert into public.appointment_state_transition_log
      (appointment_id, from_status, to_status, action, mode_at_time,
       by_user_id, by_user_email, by_role, bypass_reason)
    values
      (new.id, old.status, new.status, 'bypassed', v_mode,
       v_user_id, v_email, v_role,
       nullif(current_setting('app.appointment_state_machine.bypass_reason', true), ''));
    return new;
  end if;

  -- Verifica allowlist.
  select true into v_allowed
    from public.appointment_state_transitions t
   where t.from_status = old.status
     and t.to_status = new.status;

  if v_allowed is true then
    -- Caminho feliz. Não loga (volume seria gigantesco — só transições
    -- problemáticas viram registro).
    return new;
  end if;

  -- Transição NÃO listada. Modo determina o que fazer.
  if v_mode = 'enforce' then
    v_action := 'blocked';
    v_reason := format(
      'Transição %s → %s não está em appointment_state_transitions. '
      'Adicione lá ou use bypass explícito (ver D-070).',
      old.status, new.status
    );
    insert into public.appointment_state_transition_log
      (appointment_id, from_status, to_status, action, mode_at_time,
       by_user_id, by_user_email, by_role, bypass_reason)
    values
      (new.id, old.status, new.status, v_action, v_mode,
       v_user_id, v_email, v_role, v_reason);
    raise exception 'invalid_appointment_transition: %', v_reason
      using errcode = 'P0001';
  end if;

  -- v_mode = 'warn' → registra warning e DEIXA passar.
  v_action := 'warning';
  insert into public.appointment_state_transition_log
    (appointment_id, from_status, to_status, action, mode_at_time,
     by_user_id, by_user_email, by_role, bypass_reason)
  values
    (new.id, old.status, new.status, v_action, v_mode,
     v_user_id, v_email, v_role, null);

  raise warning 'appointment_state_machine[warn]: transição não listada %s → %s no appointment %',
    old.status, new.status, new.id;

  return new;
end;
$$;

comment on function public.validate_appointment_transition is
  'Trigger BEFORE UPDATE OF status em appointments. Modo (warn/enforce/off) '
  'controlado por setting app.appointment_state_machine.mode. Bypass por '
  'transação via app.appointment_state_machine.bypass=true.';

drop trigger if exists trg_validate_appointment_transition on public.appointments;
create trigger trg_validate_appointment_transition
  before update of status on public.appointments
  for each row execute function public.validate_appointment_transition();

-- ════════════════════════════════════════════════════════════════════
-- 5) Comentário operacional (lembrete do modo default)
-- ════════════════════════════════════════════════════════════════════

do $$
begin
  raise notice
    'appointment_state_machine instalada em modo warn. '
    'Mude pra enforce só após observar appointment_state_transition_log '
    'por 1-2 semanas. Ver RUNBOOK.md (Onda 3B · D-070).';
end;
$$;
