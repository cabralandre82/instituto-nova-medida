-- Migration 015 · Regras de confiabilidade da médica (D-036)
--
-- Contexto:
--   A migration 012 (no-show policy D-032) criou
--   `doctors.reliability_incidents` (contador) + `last_reliability_incident_at`.
--   Mas o contador é agregado e não permite:
--     - filtrar por janela temporal (ex: "últimos 30 dias")
--     - dispensar incidentes individualmente ("foi bug da plataforma,
--       não conta pra médica")
--     - auditar quais appointments geraram quais incidentes
--     - resetar sem perder histórico
--
--   D-036 introduz uma tabela de eventos granular + colunas de pause
--   automático/manual. Contador antigo fica como métrica histórica
--   agregada; a verdade operacional agora é a tabela.
--
-- Regras (configuráveis no código, defaults):
--   - Janela de análise: 30 dias.
--   - Soft warning: 2 eventos → aparece no alerta do dashboard admin.
--   - Hard block: 3 eventos → médica é auto-pausada
--     (`reliability_paused_at` preenchido). Fica de fora de
--     `/agendar` até admin reativar.
--   - Eventos dispensados (`dismissed_at IS NOT NULL`) não contam.
--
-- Idempotência:
--   - `unique(appointment_id)` (parcial, só pra linhas com appointment
--     vinculado) garante 1 evento por appointment mesmo se a política
--     rodar duas vezes.

-- 1) Tabela principal
create table if not exists public.doctor_reliability_events (
  id uuid primary key default gen_random_uuid(),
  doctor_id uuid not null references public.doctors(id) on delete cascade,
  appointment_id uuid references public.appointments(id) on delete set null,
  kind text not null
    check (kind in ('no_show_doctor', 'expired_no_one_joined', 'manual')),
  occurred_at timestamptz not null default now(),
  notes text,
  dismissed_at timestamptz,
  dismissed_by uuid references auth.users(id) on delete set null,
  dismissed_reason text,
  created_at timestamptz not null default now()
);

comment on table public.doctor_reliability_events is
  'Log granular de incidentes de confiabilidade da médica (D-036). '
  'Cada linha é um caso analisável individualmente; a contagem efetiva '
  'pra regras de pause considera apenas linhas com dismissed_at NULL '
  'na janela de interesse.';

comment on column public.doctor_reliability_events.kind is
  '"no_show_doctor" = médica não apareceu; "expired_no_one_joined" = '
  'sala expirou vazia (tratado como no-show da médica pela política); '
  '"manual" = registro criado pelo admin fora dos disparos automáticos '
  '(ex: incidente operacional reportado por paciente fora do fluxo).';

comment on column public.doctor_reliability_events.dismissed_at is
  'Quando o admin dispensou o evento. Eventos dispensados não contam '
  'pra threshold de auto-pause. Decisão registrada pra auditoria.';

-- Índice principal: lookup de "eventos ativos dos últimos N dias"
create index if not exists ix_reliability_active_recent
  on public.doctor_reliability_events (doctor_id, occurred_at desc)
  where dismissed_at is null;

-- Unique parcial: evita duplo registro quando a política rodar 2x
-- (idempotência na inserção, complementa o guard de no_show_policy_applied_at)
create unique index if not exists ux_reliability_appointment_unique
  on public.doctor_reliability_events (appointment_id)
  where appointment_id is not null;

-- 2) Colunas de pause em doctors
alter table public.doctors
  add column if not exists reliability_paused_at timestamptz,
  add column if not exists reliability_paused_by uuid references auth.users(id) on delete set null,
  add column if not exists reliability_paused_reason text,
  add column if not exists reliability_paused_auto boolean not null default false,
  add column if not exists reliability_paused_until_reviewed boolean not null default true;

comment on column public.doctors.reliability_paused_at is
  'Se NOT NULL, médica está pausada por regra de confiabilidade (D-036) '
  'e fica fora de /agendar. Appointments já agendados NÃO são cancelados '
  '— seguem seu curso, com aviso ao admin.';

comment on column public.doctors.reliability_paused_auto is
  'TRUE se o pause foi disparado automaticamente por atingir o threshold '
  '(default 3 eventos em 30 dias). FALSE se foi pause manual do admin. '
  'Auto-pauses aparecem como prioritárias no dashboard de reliability.';

comment on column public.doctors.reliability_paused_until_reviewed is
  'Flag auxiliar: quando TRUE, admin marcou que o pause só sai após '
  'revisão explícita (ex: conversa 1:1 com a médica). Default TRUE em '
  'auto-pauses; admin pode virar FALSE manualmente se quiser permitir '
  'que a própria médica solicite reativação.';

-- Índice pra query "médicas pausadas no dashboard"
create index if not exists ix_doctors_reliability_paused
  on public.doctors (reliability_paused_at desc)
  where reliability_paused_at is not null;
