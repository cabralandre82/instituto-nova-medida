-- ──────────────────────────────────────────────────────────────────────────
-- Migration 011 — Agendamento estruturado de notificações WhatsApp.
-- ──────────────────────────────────────────────────────────────────────────
-- A tabela `public.appointment_notifications` já existe (migration 004).
-- Esta migration adiciona:
--
--   1. Índice unique parcial que previne duplicatas do MESMO kind pro
--      MESMO appointment enquanto a notificação estiver viva (pending
--      ou já enviada). `failed` NÃO bloqueia — permite re-enfileirar
--      depois de corrigir um problema transitório.
--   2. Função `public.schedule_appointment_notifications()` que insere
--      as 4 notificações temporais padrão de uma consulta (T-24h,
--      T-1h, T-15min, T+10min). Idempotente via ON CONFLICT DO NOTHING.
--   3. Helper `public.enqueue_appointment_notification()` pra disparos
--      manuais (ex: `confirmacao` imediata após webhook Asaas, ou
--      `pos_consulta` quando médica encerra).
--
-- As notificações ficam em `status='pending'` com `scheduled_for`
-- preenchido. Um worker HTTP (`/api/internal/cron/wa-reminders`)
-- consome a fila minuto-a-minuto, dispara via Meta Graph API e
-- atualiza pra `sent`/`failed`.
--
-- Docs: D-031 em docs/DECISIONS.md.
-- ──────────────────────────────────────────────────────────────────────────

-- 1) Idempotência: no máximo 1 notificação "viva" por (appointment, kind).
--    Vivo = pending/sent/delivered/read. `failed` deixa a porta aberta
--    pra re-enqueue manual quando resolvermos o problema.
create unique index if not exists ux_an_appt_kind_alive
  on public.appointment_notifications (appointment_id, kind)
  where status in ('pending', 'sent', 'delivered', 'read');

comment on index public.ux_an_appt_kind_alive is
  'Garante que schedule_appointment_notifications() seja idempotente — '
  'rodar duas vezes pra mesmo appointment não duplica linhas.';

-- 2) Índice pro worker: varre pendentes com scheduled_for <= now().
create index if not exists idx_an_due
  on public.appointment_notifications (scheduled_for)
  where status = 'pending';

-- 3) Função pra agendar os 4 lembretes temporais de uma consulta.
create or replace function public.schedule_appointment_notifications(
  p_appointment_id uuid
)
returns table (
  kind text,
  scheduled_for timestamptz,
  created boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scheduled_at timestamptz;
  v_status appointment_status;
  v_now timestamptz := now();
  v_kind text;
  v_when timestamptz;
  v_inserted boolean;
begin
  select a.scheduled_at, a.status
    into v_scheduled_at, v_status
    from public.appointments a
   where a.id = p_appointment_id;

  if v_scheduled_at is null then
    raise exception 'appointment_not_found' using errcode = 'P0002';
  end if;

  -- Só agenda pra consultas "vivas" — não faz sentido enfileirar
  -- notificação de consulta cancelada ou expirada.
  if v_status not in ('scheduled', 'confirmed', 'in_progress', 'pending_payment') then
    raise notice '[schedule_appt_notifs] status=% — nada a agendar', v_status;
    return;
  end if;

  for v_kind, v_when in
    select * from (
      values
        ('t_minus_24h',  v_scheduled_at - interval '24 hours'),
        ('t_minus_1h',   v_scheduled_at - interval '1 hour'),
        ('t_minus_15min',v_scheduled_at - interval '15 minutes'),
        ('t_plus_10min', v_scheduled_at + interval '10 minutes')
    ) as t(kind, when_at)
  loop
    -- Pula se o disparo já passou (ex: agendou consulta pra daqui 30min —
    -- T-24h e T-1h já são passado, não faz sentido enviar agora).
    if v_when < v_now - interval '1 minute' then
      continue;
    end if;

    insert into public.appointment_notifications (
      appointment_id,
      channel,
      kind,
      status,
      scheduled_for
    ) values (
      p_appointment_id,
      'whatsapp',
      v_kind,
      'pending',
      v_when
    )
    on conflict (appointment_id, kind)
      where status in ('pending', 'sent', 'delivered', 'read')
      do nothing
    returning true into v_inserted;

    return query select v_kind, v_when, coalesce(v_inserted, false);
  end loop;
end;
$$;

comment on function public.schedule_appointment_notifications is
  'Enfileira as 4 notificações temporais padrão (T-24h, T-1h, T-15min, '
  'T+10min) em appointment_notifications como status=pending. Idempotente '
  '(ON CONFLICT DO NOTHING via ux_an_appt_kind_alive). Pula lembretes '
  'cujo horário já passou. Retorna uma linha por kind processado '
  'indicando se foi inserido (created=true) ou ignorado (já existia).';

-- 4) Helper pra disparos manuais (confirmacao, pos_consulta, reserva_expirada).
create or replace function public.enqueue_appointment_notification(
  p_appointment_id uuid,
  p_kind text,
  p_template_name text default null,
  p_scheduled_for timestamptz default null,
  p_payload jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.appointment_notifications (
    appointment_id,
    channel,
    kind,
    template_name,
    payload,
    status,
    scheduled_for
  ) values (
    p_appointment_id,
    'whatsapp',
    p_kind,
    p_template_name,
    p_payload,
    'pending',
    coalesce(p_scheduled_for, now())
  )
  on conflict (appointment_id, kind)
    where status in ('pending', 'sent', 'delivered', 'read')
    do nothing
  returning id into v_id;

  return v_id; -- null se já existia (conflito suprimido)
end;
$$;

comment on function public.enqueue_appointment_notification is
  'Insere uma notificação isolada na fila. Retorna o id se criou, ou '
  'NULL se já existia (ON CONFLICT suprimido). Use para tipos não '
  'cobertos por schedule_appointment_notifications() (confirmacao, '
  'pos_consulta, reserva_expirada).';
