-- ────────────────────────────────────────────────────────────────────────
-- Migration: 20260520000000_book_free_appointment_slot
-- Decisão arquitetural: D-086 (PR-075-A · finding 1.1 + D-044)
--
-- Contexto
-- ────────
-- Em D-044 mudamos o produto pra "consulta inicial é GRATUITA". O
-- enforcement disso é o `LEGACY_PURCHASE_ENABLED=false` em produção
-- (ver `src/lib/legacy-purchase-gate.ts`), que bloqueia
-- `/agendar/[plano]` e `/checkout/[plano]`.
--
-- O efeito colateral, descoberto na auditoria operacional pós-Sprint
-- 2: NÃO EXISTE rota pública de agendamento alinhada com D-044. O
-- paciente termina o quiz, vira lead, vê "te chamamos no WhatsApp",
-- e fica preso esperando contato manual do operador. Isso quebra a
-- promessa do produto e o operador solo não escala.
--
-- Esta migration introduz a peça SQL que faltava: uma RPC dedicada
-- pra criar appointment FREE (`status='scheduled'` direto, sem
-- payment_id, sem TTL de pending_payment). A diferença em relação
-- a `book_pending_appointment_slot()` (migration 008):
--
--   `book_pending_appointment_slot`     `book_free_appointment_slot`
--   ────────────────────────────────    ────────────────────────────
--   status = 'pending_payment'           status = 'scheduled'
--   pending_payment_expires_at = +TTL    pending_payment_expires_at = NULL
--   exige payment downstream             nenhum payment é criado
--   fluxo /agendar/[plano] (LEGACY)      fluxo /agendar (canônico D-044)
--
-- Reuso e invariantes
-- ───────────────────
-- - O índice unique parcial `ux_app_doctor_slot_alive` (migration
--   008) JÁ cobre 'scheduled' como status "vivo". A nova função
--   herda a mesma garantia anti-double-book sem alteração de
--   schema.
-- - A função tem `security definer` igual `book_pending` — só
--   chamável por backend autenticado (route handler usando service
--   role).
-- - Limpeza de pending_payment_expired do mesmo slot é mantida
--   ("fast path" do cron de expiração — mesmo padrão da função
--   pending) pra cobrir o caso bizarro de coexistência: paciente
--   tinha uma reserva pending_payment expirada, e agora quer
--   agendar gratuita no mesmo horário.
-- - Validações: kind ∈ ('scheduled','on_demand'),
--   duration_minutes ∈ [1,240], scheduled_at > now() - 5min.
-- - Erro `slot_taken` (errcode 23505) é capturado e re-emitido
--   com mensagem amigável — mesmo contrato da pending.
--
-- Não-objetivos
-- ─────────────
-- - NÃO removemos `book_pending_appointment_slot`. Continua sendo
--   chamada por `/api/agendar/reserve` quando o operador
--   excepcionalmente liga `LEGACY_PURCHASE_ENABLED=true`.
-- - NÃO mudamos o fluxo de fulfillment (pago, pós-prescrição). A
--   cobrança em D-044 acontece em `/api/paciente/fulfillments/.../accept`
--   após a consulta — nada disso muda.
-- - NÃO mexemos no enum `appointment_status` nem no
--   state-machine D-070. `scheduled` já é o estado inicial padrão.
-- ────────────────────────────────────────────────────────────────────────

create or replace function public.book_free_appointment_slot(
  p_doctor_id uuid,
  p_customer_id uuid,
  p_scheduled_at timestamptz,
  p_duration_minutes integer,
  p_kind text default 'scheduled',
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

  -- Limpa qualquer pending_payment legado expirado no MESMO slot antes de tentar.
  -- (fast path do cron 20260420000000_expire_pending_payment.)
  update public.appointments
     set status = 'cancelled_by_admin',
         cancelled_at = v_now,
         cancelled_reason = 'pending_payment_expired'
   where doctor_id = p_doctor_id
     and scheduled_at = p_scheduled_at
     and status = 'pending_payment'
     and pending_payment_expires_at is not null
     and pending_payment_expires_at < v_now;

  -- Insere direto em 'scheduled'. O índice unique parcial
  -- `ux_app_doctor_slot_alive` previne corrida com qualquer outra
  -- reserva (pending_payment, scheduled, confirmed, in_progress).
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
      'scheduled',
      null,
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

comment on function public.book_free_appointment_slot is
  'PR-075-A · D-086. Cria appointment GRATUITO (status=scheduled, sem '
  'payment_id, sem TTL) atomicamente. Usado pela rota canônica '
  '/api/agendar/free a partir de um lead validado. Diferença vs '
  'book_pending_appointment_slot: status inicial scheduled e nenhum '
  'payment associado — alinhado com D-044 (consulta inicial gratuita).';

-- ──────────────────────────────────────────────────────────────────────
-- Coluna `leads.appointment_id` (analytics + observabilidade)
-- ──────────────────────────────────────────────────────────────────────
-- Conveniência pra:
--   (a) Conversão lead → consulta (admin dashboard, audit, KPIs).
--   (b) Detectar leads "fantasmas" (status='agendado' mas sem
--       appointment_id) — sintoma de bug ou abuso.
--   (c) Trilha LGPD: quando o paciente pede esquecimento, sabemos
--       qual consulta amarrou ao lead.
-- on delete set null pra não derrubar o lead se a consulta for
-- removida (cancelamento / clean-up). lead permanece histórico.

alter table public.leads
  add column if not exists appointment_id uuid
    references public.appointments(id) on delete set null;

comment on column public.leads.appointment_id is
  'PR-075-A · D-086. Apontador pro appointment criado quando o '
  'paciente fechou a consulta gratuita pela rota /api/agendar/free. '
  'Permanece NULL pra leads que nunca agendaram.';

create index if not exists leads_appointment_idx
  on public.leads (appointment_id) where appointment_id is not null;
