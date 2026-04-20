-- ──────────────────────────────────────────────────────────────────────────
-- Migration 010 — Expiração automática de reservas abandonadas.
-- ──────────────────────────────────────────────────────────────────────────
-- A migration 008 criou `appointments.status = 'pending_payment'` com
-- `pending_payment_expires_at` (default 15 min). Se o paciente abre o
-- checkout mas não termina o pagamento, o slot FICA preso nesse estado
-- até alguém vir cancelar. A função `book_pending_appointment_slot()`
-- faz um "fast path" local (limpa expiradas no MESMO slot antes de
-- tentar inserir), mas isso não resolve o caso:
--
--   - Paciente A reserva slot às 10:00, abandona.
--   - Ninguém tenta reservar o mesmo slot de novo em 15min+.
--   - Slot fica órfão, ocupando agenda sem gerar receita.
--
-- Esta migration cria um SWEEP global que roda periodicamente e libera
-- TODAS as reservas abandonadas de uma vez, idempotente, com
-- logging e retorno estruturado pra quem chama (Vercel Cron).
--
-- Invocação esperada: `select * from public.expire_abandoned_reservations()`
-- a cada 1 minuto via Vercel Cron (docs/DECISIONS.md D-030).
-- Pode também ser chamada manualmente por admin via psql quando
-- precisa desbloquear um slot "preso" rapidamente.
-- ──────────────────────────────────────────────────────────────────────────

create or replace function public.expire_abandoned_reservations()
returns table (
  appointment_id uuid,
  doctor_id uuid,
  scheduled_at timestamptz,
  customer_id uuid,
  payment_id uuid,
  expired_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
begin
  return query
  update public.appointments a
     set status = 'cancelled_by_admin',
         cancelled_at = v_now,
         cancelled_reason = 'pending_payment_expired'
   where a.status = 'pending_payment'
     and a.pending_payment_expires_at is not null
     and a.pending_payment_expires_at < v_now
  returning
    a.id,
    a.doctor_id,
    a.scheduled_at,
    a.customer_id,
    a.payment_id,
    v_now;
end;
$$;

comment on function public.expire_abandoned_reservations is
  'Varre appointments em pending_payment cujo TTL já passou e move-os '
  'para cancelled_by_admin com reason=pending_payment_expired. '
  'Retorna uma linha por slot liberado para que o caller (cron HTTP) '
  'possa tomar ações colaterais: cancelar a cobrança no Asaas, '
  'enviar WhatsApp "sua reserva expirou" pro paciente, notificar a '
  'médica se havia algum caso especial. Função idempotente — rodar '
  'duas vezes seguidas na mesma janela retorna 0 linhas na segunda. '
  'Execução esperada: a cada 1 minuto via Vercel Cron (D-030).';

-- Index helper: em produção com muitos appointments, o sweep precisa
-- ser barato. Parcial + expressão = varre só o subconjunto "vivo".
create index if not exists ix_appointments_pending_expiry
  on public.appointments (pending_payment_expires_at)
  where status = 'pending_payment';

comment on index public.ix_appointments_pending_expiry is
  'Acelera o sweep de expire_abandoned_reservations(). '
  'Parcial pra status=pending_payment (cardinalidade baixa e útil).';

-- ──────────────────────────────────────────────────────────────────────
-- pg_cron (opcional): se a extensão estiver habilitada no projeto
-- Supabase, agendamos o sweep internamente também. Não substitui o
-- Vercel Cron (redundância barata), mas garante que se o cron HTTP
-- falhar por algum motivo (deploy down, problema Vercel), o Supabase
-- ainda limpa os slots por conta própria.
-- Deploy em Supabase sem pg_cron: o DO block silenciosamente pula
-- sem falhar (caminho NOT FOUND), deixando o Vercel Cron como único
-- mecanismo ativo.
-- ──────────────────────────────────────────────────────────────────────
do $$
declare
  v_has_pg_cron boolean;
begin
  select exists(select 1 from pg_extension where extname = 'pg_cron')
    into v_has_pg_cron;

  if not v_has_pg_cron then
    raise notice '[migration 010] pg_cron não habilitado — pulando schedule. '
                 'Vercel Cron continua responsável pelo sweep.';
    return;
  end if;

  -- Remove jobs antigos com o mesmo nome (upsert manual).
  perform cron.unschedule(jobid)
     from cron.job
    where jobname = 'inm_expire_abandoned_reservations';

  perform cron.schedule(
    'inm_expire_abandoned_reservations',
    '* * * * *',                 -- a cada 1 minuto
    $CRON$ select public.expire_abandoned_reservations(); $CRON$
  );

  raise notice '[migration 010] pg_cron job agendado: inm_expire_abandoned_reservations (*/1 min)';
end $$;
