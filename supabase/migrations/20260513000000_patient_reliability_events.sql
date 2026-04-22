-- ───────────────────────────────────────────────────────────────────────
-- Migration: 20260513000000_patient_reliability_events
-- Decisão arquitetural: D-076 (PR-068 · finding 17.6)
--
-- Contexto
-- ────────
-- A plataforma já mantém `public.doctor_reliability_events` (migration
-- 015, D-036) com log granular de incidentes de confiabilidade da
-- médica (no-show, sala expirada vazia, manual), com thresholds em
-- janela temporal disparando auto-pause. O simétrico pro paciente
-- ainda não existia — `appointments.status` vira `no_show_patient`
-- em `reconcile.ts`, `cancelled_by_admin + reason='pending_payment_
-- expired'` em `expire_abandoned_reservations()`, e (futuramente)
-- `cancelled_by_patient` via UI de cancelamento — mas nenhum evento é
-- registrado pra análise de padrão de abuso.
--
-- Riscos sem log:
--   - Paciente reserva slot, não paga ou abandona: bloqueia agenda da
--     médica por até o TTL (30 min) sem custo; se reincidir, custo
--     oportunidade cumulativo.
--   - Paciente confirma reserva, paga, não comparece: slot queimado +
--     médica precisou estar logada. Clawback não se aplica ao paciente
--     (ele já pagou), mas o padrão importa pra diferenciar "acidente
--     isolado" de "abuso crônico" (ex: síndrome de "só marquei pra
--     desafogar a fila").
--   - Paciente cancela muito em cima (< 2h): slot irrecuperável pra
--     outro paciente. Hoje nem há endpoint pra isso, mas infra deve
--     estar pronta pra capturar quando a UI existir.
--
-- Solução
-- ────────
--
-- 1) Tabela `patient_reliability_events` com mesmo desenho de
--    `doctor_reliability_events`:
--      id                uuid pk
--      customer_id       uuid not null → customers
--      appointment_id    uuid → appointments (nullable pra eventos
--                        manuais não-vinculados)
--      kind              text check in ('no_show_patient',
--                        'reservation_abandoned', 'late_cancel_patient',
--                        'refund_requested', 'manual')
--      occurred_at       timestamptz default now()
--      notes             text
--      dismissed_at      timestamptz (admin pode dispensar)
--      dismissed_by      uuid → auth.users
--      dismissed_reason  text
--      created_at        timestamptz default now()
--
--    Sem pausamento automático de customer no MVP — apenas log +
--    thresholds expostos no admin pra decisão manual. Auto-block (ex:
--    impedir checkout de paciente com 3+ eventos ativos em 90 dias)
--    fica pra PR-068-B quando houver sinal operacional suficiente pra
--    calibrar o threshold.
--
-- 2) Trigger AFTER UPDATE OF status ON appointments:
--    Detecta transições de status que caracterizam incidente e INSERE
--    linha (ON CONFLICT DO NOTHING) em `patient_reliability_events`.
--    Tipos detectados automaticamente:
--      - old→'no_show_patient'           → kind 'no_show_patient'
--      - old→'cancelled_by_admin' com
--        cancelled_reason='pending_payment_expired'
--                                        → kind 'reservation_abandoned'
--      - old→'cancelled_by_patient' com
--        scheduled_at - now() < 2 horas  → kind 'late_cancel_patient'
--
--    Desacoplado do `applyNoShowPolicy` (não precisa alterar código
--    TS): qualquer caller que mova o status via SQL/cron/webhook/app
--    dispara o registro. Fail-safe: se INSERT falhar (ex: customer
--    deletado), trigger captura `exception when others` e registra
--    `raise notice` sem bloquear o UPDATE original do appointment.
--
-- 3) Índices e unique parcial `(appointment_id, kind)` garantem
--    idempotência — re-rodada do mesmo evento (ex: reconcile rodando
--    duas vezes, hot-reload) não duplica.
--
-- 4) RLS deny-by-default com política `an_admin_only` espelhando
--    `doctor_reliability_events`. Paciente não enxerga (é info
--    adversarial; paciente não deve saber a nota dele).
-- ───────────────────────────────────────────────────────────────────────

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 1) Tabela principal                                                │
-- └────────────────────────────────────────────────────────────────────┘

create table if not exists public.patient_reliability_events (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  appointment_id uuid references public.appointments(id) on delete set null,
  kind text not null
    check (kind in (
      'no_show_patient',
      'reservation_abandoned',
      'late_cancel_patient',
      'refund_requested',
      'manual'
    )),
  occurred_at timestamptz not null default now(),
  notes text,
  dismissed_at timestamptz,
  dismissed_by uuid references auth.users(id) on delete set null,
  dismissed_reason text,
  created_at timestamptz not null default now()
);

comment on table public.patient_reliability_events is
  'PR-068 · D-076 · Log granular de incidentes de confiabilidade do paciente (simétrico ao doctor_reliability_events / D-036). Cada linha é um caso analisável individualmente; a contagem efetiva pra regras de alerta considera apenas linhas com dismissed_at NULL na janela de interesse (default 90 dias).';

comment on column public.patient_reliability_events.kind is
  'no_show_patient = paciente faltou (reconcile detectou); reservation_abandoned = pending_payment expirou sem pagamento (expire_abandoned_reservations); late_cancel_patient = cancelou < 2h antes (quando UI de cancel existir); refund_requested = pediu refund pós-consulta (manual); manual = registro ad-hoc pelo admin (abuso, fraude, etc.).';

comment on column public.patient_reliability_events.dismissed_at is
  'Quando o admin dispensou o evento. Eventos dispensados não contam pra threshold de alerta. Decisão registrada pra auditoria.';

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 2) Índices                                                         │
-- └────────────────────────────────────────────────────────────────────┘

-- Lookup principal: "eventos ativos do paciente X nos últimos N dias"
create index if not exists ix_patient_reliability_active_recent
  on public.patient_reliability_events (customer_id, occurred_at desc)
  where dismissed_at is null;

-- Unique parcial: evita duplo registro pro mesmo appointment+kind
-- (trigger pode disparar em retries / reconcile idempotente; manual
-- tb não duplica se alguém clicar 2x). Permite múltiplos kinds
-- distintos pro mesmo appointment (edge case: paciente abandona pagamento,
-- reserva nova na mesma agenda, perde de novo — kinds distintos).
create unique index if not exists ux_patient_reliability_appt_kind
  on public.patient_reliability_events (appointment_id, kind)
  where appointment_id is not null;

-- Auxiliar pra dashboard: não-dispensados por kind (cards agregados)
create index if not exists ix_patient_reliability_kind_active
  on public.patient_reliability_events (kind, occurred_at desc)
  where dismissed_at is null;

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 3) RLS deny-by-default + admin-only                                │
-- │    Mesma política de doctor_reliability_events (ver migration 013) │
-- └────────────────────────────────────────────────────────────────────┘

alter table public.patient_reliability_events enable row level security;

do $$ begin
  create policy "pre_admin_only" on public.patient_reliability_events
    for all using (public.jwt_role() = 'admin')
    with check (public.jwt_role() = 'admin');
exception when duplicate_object then null; end $$;

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 4) Trigger auto-registro: AFTER UPDATE OF status ON appointments   │
-- │    Detecta transições que caracterizam incidente e INSERE evento.  │
-- │    Fail-safe: erros internos viram RAISE NOTICE (não derruba o     │
-- │    UPDATE original — uma trigger de observabilidade não pode       │
-- │    jamais quebrar fluxo de negócio).                                │
-- └────────────────────────────────────────────────────────────────────┘

create or replace function public.record_patient_reliability_from_appt()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text;
  v_hours_to_scheduled numeric;
begin
  -- Ignora se status não mudou (UPDATE de colunas não-status).
  if old.status is not distinct from new.status then
    return new;
  end if;

  v_kind := null;

  -- Paciente faltou (reconcile detectou só médica presente)
  if new.status = 'no_show_patient' then
    v_kind := 'no_show_patient';

  -- Reserva expirou sem pagamento (expire_abandoned_reservations)
  elsif new.status = 'cancelled_by_admin'
    and new.cancelled_reason = 'pending_payment_expired' then
    v_kind := 'reservation_abandoned';

  -- Cancelamento pelo paciente com < 2h pra hora marcada
  -- (pending_payment → cancelled_by_patient NÃO conta — ainda não
  -- comprometeu a médica)
  elsif new.status = 'cancelled_by_patient'
    and old.status in ('scheduled', 'confirmed', 'in_progress')
    and new.scheduled_at is not null then
    v_hours_to_scheduled := extract(epoch from (new.scheduled_at - now())) / 3600.0;
    if v_hours_to_scheduled < 2.0 then
      v_kind := 'late_cancel_patient';
    end if;
  end if;

  if v_kind is null then
    return new;
  end if;

  -- INSERT idempotente via unique(appointment_id, kind). customer_id
  -- é NOT NULL em appointments (vide migration 004).
  begin
    insert into public.patient_reliability_events (
      customer_id, appointment_id, kind, occurred_at, notes
    )
    values (
      new.customer_id,
      new.id,
      v_kind,
      now(),
      case
        when v_kind = 'late_cancel_patient'
          then 'Auto: cancelamento em ' || round(v_hours_to_scheduled::numeric, 2) || 'h antes.'
        when v_kind = 'reservation_abandoned'
          then 'Auto: TTL de pending_payment expirou sem confirmação.'
        when v_kind = 'no_show_patient'
          then 'Auto: reconcile identificou paciente ausente.'
        else null
      end
    )
    on conflict (appointment_id, kind) where appointment_id is not null
    do nothing;
  exception when others then
    -- Fail-safe: não travamos o UPDATE principal por causa do log.
    raise notice 'PR-068 · D-076 · record_patient_reliability_from_appt falhou (appt=%, kind=%): %',
      new.id, v_kind, sqlerrm;
  end;

  return new;
end;
$$;

comment on function public.record_patient_reliability_from_appt() is
  'PR-068 · D-076 · trigger AFTER UPDATE OF status ON appointments que registra automaticamente eventos de confiabilidade do paciente (no_show_patient, reservation_abandoned, late_cancel_patient). Idempotente via unique(appointment_id, kind). Fail-safe: erros não derrubam o UPDATE original.';

drop trigger if exists trg_record_patient_reliability on public.appointments;
create trigger trg_record_patient_reliability
  after update of status on public.appointments
  for each row execute function public.record_patient_reliability_from_appt();
