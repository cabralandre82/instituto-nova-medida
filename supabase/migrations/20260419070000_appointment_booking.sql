-- ──────────────────────────────────────────────────────────────────────────
-- Migration 008 — Reserva de slot e estado pré-pagamento.
-- ──────────────────────────────────────────────────────────────────────────
-- Permite que o paciente RESERVE um horário ANTES de pagar, sem que
-- outro paciente roube o mesmo horário durante o checkout. O appointment
-- é criado em status `pending_payment` com TTL curto (15 min). Se o
-- pagamento confirmar dentro da janela, vai pra `scheduled` e a sala
-- Daily é provisionada pelo webhook do Asaas. Se não, expira via cron
-- (próxima migration) ou manualmente.
--
-- O que muda:
--   1. Novo valor `pending_payment` no enum `appointment_status`.
--   2. Coluna `pending_payment_expires_at` em `appointments`.
--   3. Índice unique parcial (doctor_id, scheduled_at) bloqueando 2
--      reservas no mesmo horário com a mesma médica enquanto vivo.
--   4. Função `book_pending_appointment_slot()` que insere atomicamente,
--      retornando o id do appointment OU lançando exceção amigável se
--      o slot já estiver tomado.
-- ──────────────────────────────────────────────────────────────────────────

-- 1) novo valor no enum (idempotente: ALTER TYPE ... ADD VALUE IF NOT EXISTS)
alter type appointment_status add value if not exists 'pending_payment';

-- 2) coluna de TTL para o estado pending_payment
alter table public.appointments
  add column if not exists pending_payment_expires_at timestamptz;

comment on column public.appointments.pending_payment_expires_at is
  'Apenas relevante quando status = pending_payment. Após esse instante, '
  'o slot é liberado por cron job (ver migration de cron futura).';

-- 3) índice unique parcial: 1 appointment "vivo" por (doctor_id, scheduled_at)
--    "vivo" = qualquer status que ainda ocupa a agenda da médica.
create unique index if not exists ux_app_doctor_slot_alive
  on public.appointments (doctor_id, scheduled_at)
  where status in (
    'pending_payment',
    'scheduled',
    'confirmed',
    'in_progress'
  );

-- 4) Função de reserva atomic — única forma supportada de criar pending_payment.
create or replace function public.book_pending_appointment_slot(
  p_doctor_id uuid,
  p_customer_id uuid,
  p_scheduled_at timestamptz,
  p_duration_minutes integer,
  p_kind text default 'scheduled',
  p_ttl_minutes integer default 15,
  p_recording_consent boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_appt_id uuid;
  v_now timestamptz := now();
  v_ends timestamptz := p_scheduled_at + make_interval(mins => p_duration_minutes);
  v_ttl  timestamptz := v_now + make_interval(mins => p_ttl_minutes);
begin
  if p_kind not in ('scheduled', 'on_demand') then
    raise exception 'kind inválido: %', p_kind using errcode = '22023';
  end if;
  if p_duration_minutes <= 0 or p_duration_minutes > 240 then
    raise exception 'duration_minutes fora de faixa: %', p_duration_minutes using errcode = '22023';
  end if;
  if p_scheduled_at < v_now - interval '5 minutes' then
    raise exception 'scheduled_at no passado' using errcode = '22023';
  end if;

  -- Limpa qualquer reserva expirada NO MESMO SLOT antes de tentar inserir.
  -- (cron faz isso globalmente; aqui é o "fast path" sob demanda.)
  update public.appointments
     set status = 'cancelled_by_admin',
         cancelled_at = v_now,
         cancelled_reason = 'pending_payment_expired'
   where doctor_id = p_doctor_id
     and scheduled_at = p_scheduled_at
     and status = 'pending_payment'
     and pending_payment_expires_at is not null
     and pending_payment_expires_at < v_now;

  -- Insere o novo. O índice unique parcial garante que duas chamadas
  -- concorrentes pra mesmo slot vão dar 23505 — capturamos abaixo.
  begin
    insert into public.appointments (
      doctor_id,
      customer_id,
      kind,
      scheduled_at,
      scheduled_until,
      status,
      pending_payment_expires_at,
      recording_consent
    ) values (
      p_doctor_id,
      p_customer_id,
      p_kind,
      p_scheduled_at,
      v_ends,
      'pending_payment',
      v_ttl,
      coalesce(p_recording_consent, false)
    )
    returning id into v_appt_id;
  exception when unique_violation then
    raise exception 'slot_taken' using errcode = '23505',
      hint = 'Outro paciente reservou esse horário primeiro.';
  end;

  return v_appt_id;
end;
$$;

comment on function public.book_pending_appointment_slot is
  'Reserva atomic de um slot da agenda da médica. Cria appointment em '
  'pending_payment com TTL. Use exclusivamente pelo backend autenticado '
  '(API route com requireAdmin/requireUser ou endpoint público com '
  'rate-limit + validação de payment intent).';

-- 5) Função pra ATIVAR uma reserva quando o pagamento confirma.
--    Idempotente: se já estiver ativada (scheduled), não muda nada.
create or replace function public.activate_appointment_after_payment(
  p_appointment_id uuid,
  p_payment_id uuid
)
returns table (
  id uuid,
  was_activated boolean,
  status appointment_status
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current appointment_status;
begin
  select a.status into v_current
    from public.appointments a
   where a.id = p_appointment_id
   for update;

  if v_current is null then
    raise exception 'appointment_not_found' using errcode = 'P0002';
  end if;

  if v_current = 'pending_payment' then
    update public.appointments
       set status = 'scheduled',
           payment_id = coalesce(payment_id, p_payment_id),
           pending_payment_expires_at = null
     where appointments.id = p_appointment_id;

    return query
      select p_appointment_id, true, 'scheduled'::appointment_status;
    return;
  end if;

  -- já estava em outro estado (scheduled/confirmed/in_progress/...) — só
  -- garante que payment_id está ligado.
  update public.appointments
     set payment_id = coalesce(payment_id, p_payment_id)
   where appointments.id = p_appointment_id
     and (payment_id is null);

  return query
    select p_appointment_id, false, v_current;
end;
$$;

comment on function public.activate_appointment_after_payment is
  'Promove appointment de pending_payment → scheduled quando o webhook do '
  'Asaas confirma o pagamento. Idempotente. Limpa pending_payment_expires_at.';
