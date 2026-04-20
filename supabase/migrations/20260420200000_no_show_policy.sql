-- ──────────────────────────────────────────────────────────────────────────
-- Migration 012 — Política de no-show no financeiro.
-- ──────────────────────────────────────────────────────────────────────────
-- Contexto: o webhook do Daily (D-028) já detecta no-show e atualiza
-- `appointments.status` para `no_show_patient`, `no_show_doctor` ou
-- `cancelled_by_admin` (com `cancelled_reason='expired_no_one_joined'`
-- quando a sala expira vazia). Falta fechar o ciclo financeiro:
--
--   - no_show_patient: médica recebe earning integral (disponibilizou
--     horário, ficou online). Paciente é notificado mas sem refund
--     automático. Flag `no_show_policy_applied_at` marca idempotência.
--
--   - no_show_doctor: clawback da earning + `refund_required=true`
--     (admin processa refund via Asaas, Sprint 5 automatiza).
--     Incrementa `doctors.reliability_incidents` pra acompanhar
--     confiabilidade operacional da médica.
--
--   - cancelled_by_admin + expired_no_one_joined: idem no_show_doctor
--     (risco técnico/plataforma, não do paciente).
--
-- Esta migration só adiciona as colunas/índices — a lógica em si
-- roda em `src/lib/no-show-policy.ts` (chamada pelo webhook Daily).
-- Fazer em TS em vez de SQL permite reusar `createClawback()` que já
-- existe e iterar mais rápido na notificação WhatsApp.
--
-- Docs: D-032 em docs/DECISIONS.md.
-- ──────────────────────────────────────────────────────────────────────────

-- 1) Colunas novas em appointments
alter table public.appointments
  add column if not exists no_show_policy_applied_at timestamptz,
  add column if not exists refund_required boolean not null default false,
  add column if not exists refund_processed_at timestamptz,
  add column if not exists no_show_notes text;

comment on column public.appointments.no_show_policy_applied_at is
  'Timestamp em que applyNoShowPolicy() processou este appointment. '
  'Guard de idempotência — chamadas subsequentes retornam noop.';

comment on column public.appointments.refund_required is
  'TRUE quando a política de no-show gerou direito a refund pro '
  'paciente (no_show_doctor ou expired). Admin processa via painel '
  'até Sprint 5 automatizar via Asaas API.';

comment on column public.appointments.refund_processed_at is
  'Timestamp em que o admin (ou cron futuro) processou o refund no '
  'Asaas. Preenchido pelo handler de estorno.';

comment on column public.appointments.no_show_notes is
  'Notas humanas do admin sobre o caso (ex: paciente enviou atestado, '
  'médica teve problema técnico comprovado, etc). Usado na tela de '
  'reconciliação manual.';

-- 2) Métricas de reliability por médica
alter table public.doctors
  add column if not exists reliability_incidents int not null default 0,
  add column if not exists last_reliability_incident_at timestamptz;

comment on column public.doctors.reliability_incidents is
  'Contador de no_show_doctor + cancelamentos forçados pela médica. '
  'Usado em dashboards de acompanhamento e em regras futuras de '
  'ajuste de compensação.';

comment on column public.doctors.last_reliability_incident_at is
  'Timestamp do último incidente registrado. Reset manual via admin '
  'quando a médica resolver a causa-raiz.';

-- 3) Índice pra triage de refunds pendentes no painel admin
create index if not exists ix_appt_refund_required
  on public.appointments (refund_required, scheduled_at desc)
  where refund_required = true and refund_processed_at is null;

comment on index public.ix_appt_refund_required is
  'Acelera o "WHERE refund_required AND NOT processed" que a UI admin '
  'usa pra listar casos pendentes de estorno.';

-- 4) Índice pra métrica "appointments em no_show nos últimos N dias"
create index if not exists ix_appt_no_show_applied
  on public.appointments (no_show_policy_applied_at desc)
  where no_show_policy_applied_at is not null;
