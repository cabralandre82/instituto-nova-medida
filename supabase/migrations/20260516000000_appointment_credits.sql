-- ───────────────────────────────────────────────────────────────────────
-- Migration: 20260516000000_appointment_credits
-- Decisão arquitetural: D-081 (PR-073 · finding 2.4)
--
-- Contexto
-- ────────
-- Quando `appointments.status` vira `no_show_doctor` (médica faltou) ou
-- `cancelled_by_admin` com `cancelled_reason='expired_no_one_joined'`
-- (sala expirou vazia, risco da plataforma), o `no-show-policy.ts` já
-- executa toda a parte **defensiva**:
--
--   • clawback da earning da médica (via `createClawback`, idempotente);
--   • `refund_required=true` (aparece em `/admin/refunds` pra processar);
--   • incrementa `doctors.reliability_incidents` + evento granular
--     em `doctor_reliability_events` + possível auto-pause (D-036);
--   • envia WhatsApp `no_show_doctor` ao paciente.
--
-- O que **falta** e o audit finding [2.4 🟡 MÉDIO] cobra:
--
--   (a) O paciente fica sem caminho automático pra reagendar. Hoje ele
--       recebe só a mensagem "a médica não compareceu, entre em contato"
--       e precisa retornar ao WhatsApp de suporte. Do lado operacional,
--       o admin solo não tem registro formal de "esse paciente tem
--       direito a uma nova consulta gratuita", só a trilha de
--       `refund_required` e os eventos de reliability.
--
--   (b) Não há SLA de follow-up. Um no-show que deveria virar
--       reagendamento em 2h pode ficar semanas sem ninguém agir.
--
-- Solução
-- ────────
-- Uma tabela pequena `appointment_credits` representando o
-- **direito ao reagendamento gratuito**. Cada linha é o recibo formal
-- de "você teve uma consulta cancelada sem culpa sua e tem direito a
-- outra, dentro de N dias". Dados fluem em 3 pontos:
--
--   1) `applyNoShowPolicy` (server) chama `grantNoShowCredit()` após
--      marcar `no_show_policy_applied_at`. Idempotente via `UNIQUE
--      (source_appointment_id)` — chamada dupla vira no-op silencioso.
--
--   2) `/admin` home (inbox) conta créditos ativos com `created_at` >2h
--      como follow-up overdue. Categoria nova
--      `appointment_credit_pending_followup` · SLA 2h.
--
--   3) `/paciente` dashboard mostra banner "Você tem reagendamento
--      gratuito disponível" com CTA pré-preenchido pra WhatsApp do
--      suporte (continuamos no modelo solo-admin: admin cria a nova
--      consulta manualmente e chama `markCreditConsumed`).
--
-- Estados (`status` text + check):
--   • `active`    — válido, dentro do prazo, ainda não consumido.
--   • `consumed`  — admin marcou que a nova consulta foi agendada
--                   (ver `consumed_at` + `consumed_appointment_id`).
--   • `expired`   — passou do `expires_at` sem consumo.
--                   (Flag definitiva só é setada por cron/tarefa
--                   futura; enquanto isso a UI/lib trata "active com
--                   expires_at <= now" como `expired` computado.)
--   • `cancelled` — admin descartou manualmente com razão.
--
-- Invariantes garantidas por CHECK constraints:
--   • `expires_at > created_at` (crédito nasce com janela válida).
--   • `status='consumed'` ⇔ `consumed_at IS NOT NULL`
--     ⇔ `consumed_appointment_id IS NOT NULL`.
--   • `status='cancelled'` ⇔ `cancelled_at IS NOT NULL`.
--
-- Idempotência estrutural:
--   UNIQUE partial em `source_appointment_id` onde
--   `status <> 'cancelled'` — permite cancelar e criar de novo (caso
--   raríssimo de bug operacional) sem quebrar o retry natural.
--
-- Imutabilidade de origem:
--   Trigger `prevent_appointment_credits_source_mutation` BEFORE UPDATE
--   bloqueia mudança de `customer_id`, `source_appointment_id`,
--   `source_reason`, `created_at`, `expires_at`. Transições de status e
--   snapshots de consumed_/cancelled_ seguem livres (com coerência
--   verificada via CHECK).
--
-- RLS:
--   Deny-by-default + FORCE, sem policies. Acesso só via
--   `service_role`. Paciente **nunca** lê `appointment_credits`
--   diretamente — enxerga via `patient-quick-links.ts` que projeta
--   os campos seguros (sem metadata, sem IDs administrativos).
--
-- ───────────────────────────────────────────────────────────────────────

create table if not exists public.appointment_credits (
  id uuid primary key default gen_random_uuid(),

  customer_id uuid not null
    references public.customers(id) on delete restrict,

  -- Appointment que gerou o direito. FK restrict pra preservar o link
  -- auditável; se admin tentar deletar o appointment-fonte, trigger
  -- de imutabilidade do prontuário (D-030) já bloqueia.
  source_appointment_id uuid not null
    references public.appointments(id) on delete restrict,

  source_reason text not null
    check (source_reason in (
      'no_show_doctor',
      'cancelled_by_admin_expired'
    )),

  status text not null default 'active'
    check (status in ('active', 'consumed', 'expired', 'cancelled')),

  created_at timestamptz not null default now(),
  expires_at timestamptz not null,

  consumed_at timestamptz,
  consumed_appointment_id uuid
    references public.appointments(id) on delete set null,
  consumed_by uuid references auth.users(id) on delete set null,
  consumed_by_email text check (char_length(consumed_by_email) <= 255),

  cancelled_at timestamptz,
  cancelled_reason text check (char_length(cancelled_reason) <= 500),
  cancelled_by uuid references auth.users(id) on delete set null,
  cancelled_by_email text check (char_length(cancelled_by_email) <= 255),

  metadata jsonb not null default '{}'::jsonb,

  -- Janela válida no nascimento — CHECK simples, sem dependência de
  -- função imutável (timestamptz subtraction é estável o suficiente
  -- aqui pro propósito, e o constraint só é verificado no INSERT/
  -- UPDATE, nunca em runtime).
  constraint appointment_credits_expiry_window_chk
    check (expires_at > created_at),

  -- Consumed coerente: os 3 campos andam juntos.
  constraint appointment_credits_consumed_coherent_chk
    check (
      (status = 'consumed') = (consumed_at is not null)
      and (consumed_at is not null) = (consumed_appointment_id is not null)
    ),

  -- Cancelled coerente.
  constraint appointment_credits_cancelled_coherent_chk
    check ((status = 'cancelled') = (cancelled_at is not null)),

  -- Não pode estar consumido E cancelado ao mesmo tempo.
  constraint appointment_credits_exclusive_terminal_chk
    check (not (consumed_at is not null and cancelled_at is not null)),

  -- Reason obrigatório se cancelado.
  constraint appointment_credits_cancelled_reason_chk
    check (
      cancelled_at is null
      or (cancelled_reason is not null
          and char_length(trim(cancelled_reason)) >= 4)
    )
);

-- ─── Índices ──────────────────────────────────────────────────────────

-- 1 crédito ATIVO por appointment-fonte. Cancelled pode coexistir
-- (raro mas possível em cenário de bug/re-emissão manual).
create unique index if not exists ux_appointment_credits_source_active
  on public.appointment_credits (source_appointment_id)
  where status <> 'cancelled';

-- Query do dashboard do paciente: "quais créditos ativos eu tenho".
create index if not exists ix_appointment_credits_customer_active
  on public.appointment_credits (customer_id, expires_at desc)
  where status = 'active';

-- Watchdog do admin-inbox: "créditos ativos com >2h sem consumir".
create index if not exists ix_appointment_credits_pending_followup
  on public.appointment_credits (created_at asc)
  where status = 'active';

-- Cron futuro de expiração: "créditos ativos que já passaram do prazo".
create index if not exists ix_appointment_credits_expiry_sweep
  on public.appointment_credits (expires_at asc)
  where status = 'active';

-- Auditoria/relatórios por médica (via source appointment).
create index if not exists ix_appointment_credits_source_appt
  on public.appointment_credits (source_appointment_id);

-- ─── Imutabilidade parcial (source, timeline de criação) ──────────────

create or replace function public.prevent_appointment_credits_source_mutation()
returns trigger
language plpgsql
as $$
begin
  if new.customer_id is distinct from old.customer_id then
    raise exception 'appointment_credits.customer_id é imutável (D-081)';
  end if;
  if new.source_appointment_id is distinct from old.source_appointment_id then
    raise exception 'appointment_credits.source_appointment_id é imutável (D-081)';
  end if;
  if new.source_reason is distinct from old.source_reason then
    raise exception 'appointment_credits.source_reason é imutável (D-081)';
  end if;
  if new.created_at is distinct from old.created_at then
    raise exception 'appointment_credits.created_at é imutável (D-081)';
  end if;
  if new.expires_at is distinct from old.expires_at then
    raise exception 'appointment_credits.expires_at é imutável após criação (D-081). Cancele e emita um novo crédito se a janela precisar mudar.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_appointment_credits_immutable_source
  on public.appointment_credits;
create trigger trg_appointment_credits_immutable_source
  before update on public.appointment_credits
  for each row
  execute function public.prevent_appointment_credits_source_mutation();

-- ─── RLS deny-by-default ──────────────────────────────────────────────

alter table public.appointment_credits enable row level security;
alter table public.appointment_credits force row level security;

-- Zero policies: acesso apenas via `service_role`, que bypassa RLS.
-- Paciente nunca lê a tabela; lib projeta os campos seguros.

comment on table public.appointment_credits is
  'D-081 · PR-073. Recibo formal do direito a reagendamento gratuito quando a médica falta ou a sala expira vazia. Criado por `applyNoShowPolicy`, consumido via admin solo. Status computado em runtime quando active+expirado (até cron de expiração ser implementado). RLS deny-by-default — só service_role.';

comment on column public.appointment_credits.source_reason is
  'Razão imutável da emissão: `no_show_doctor` (médica faltou) ou `cancelled_by_admin_expired` (sala expirou com ninguém logado — risco da plataforma).';

comment on column public.appointment_credits.status is
  'Transições permitidas: active → consumed (admin marca); active → cancelled (admin cancela explicitamente); active → expired (cron futuro ou compute on-read).';

comment on column public.appointment_credits.consumed_appointment_id is
  'Novo appointment agendado para consumir este crédito. FK com ON DELETE SET NULL pra preservar a trilha do status=`consumed` mesmo se o appointment vier a ser soft-deleted.';
