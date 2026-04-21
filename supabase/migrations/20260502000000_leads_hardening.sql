-- ============================================================================
-- Migration · Hardening de `leads` contra DoS e prompt injection
-- PR-036 · D-054 · audit [9.3 + 22.2]
-- ============================================================================
--
-- Motivação:
--   1. `leads.answers` (JSONB) e `leads.utm` (JSONB) nasceram sem limite de
--      tamanho. Atacante pode enviar 50 KB de payload por lead (tipo
--      prompt-injection pre-wired) e inflar `public.leads` até virar
--      problema de storage/índice GIN.
--   2. A camada de app (`validateLead` em `src/lib/lead-validate.ts`) já
--      enforça isso em cada request, mas esta tabela será acessada por
--      service_role em cron/admin/backfill — queremos **defense-in-depth**
--      via CHECK constraint do Postgres.
--   3. `name`/`phone`/`status_notes` também ganham teto (evitar text
--      gigante que enche row e degrada toast disk).
--
-- Trade-off: limites precisam cobrir worst-case legítimo. Escolhemos
-- generosos:
--   - `answers`        ≤ 8 KB   (quiz real cabe em < 1 KB)
--   - `utm`            ≤ 2 KB   (5 pares de 120 chars = 600B, folga 3×)
--   - `name`           ≤ 120    (form limita em 80; damos margem)
--   - `phone`          ≤ 20     (E.164 máx = 15, margem pra máscara
--                                 de legado)
--   - `status_notes`   ≤ 1000   (admin digita livre; não é público)
--   - `referrer`       ≤ 500    (bate com LEAD_LIMITS.referrerMaxLen)
--   - `landing_path`   ≤ 200    (bate com LEAD_LIMITS.landingPathMaxLen)
--
-- `pg_column_size` retorna o tamanho **comprimido TOAST** do valor.
-- Pra strings pequenas é ~= length, pra JSONB é o tamanho binário do
-- jsonb + header. Seguro pra compor check.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────
-- 1. Size caps via CHECK constraint (defense-in-depth)
-- ────────────────────────────────────────────────────────────────────────

alter table public.leads
  drop constraint if exists leads_answers_size_chk;
alter table public.leads
  add constraint leads_answers_size_chk
  check (answers is null or pg_column_size(answers) < 8192);

alter table public.leads
  drop constraint if exists leads_utm_size_chk;
alter table public.leads
  add constraint leads_utm_size_chk
  check (utm is null or pg_column_size(utm) < 2048);

alter table public.leads
  drop constraint if exists leads_name_len_chk;
alter table public.leads
  add constraint leads_name_len_chk
  check (char_length(name) <= 120);

alter table public.leads
  drop constraint if exists leads_phone_len_chk;
alter table public.leads
  add constraint leads_phone_len_chk
  check (char_length(phone) <= 20);

alter table public.leads
  drop constraint if exists leads_status_notes_len_chk;
alter table public.leads
  add constraint leads_status_notes_len_chk
  check (status_notes is null or char_length(status_notes) <= 1000);

alter table public.leads
  drop constraint if exists leads_referrer_len_chk;
alter table public.leads
  add constraint leads_referrer_len_chk
  check (referrer is null or char_length(referrer) <= 500);

alter table public.leads
  drop constraint if exists leads_landing_path_len_chk;
alter table public.leads
  add constraint leads_landing_path_len_chk
  check (landing_path is null or char_length(landing_path) <= 200);

comment on constraint leads_answers_size_chk on public.leads is
  'PR-036 / D-054. Bloqueia payloads gigantes em answers (DoS + prompt injection amplifier).';
comment on constraint leads_utm_size_chk on public.leads is
  'PR-036 / D-054. Teto de UTM pra impedir abuso de tracking field.';

-- ────────────────────────────────────────────────────────────────────────
-- 2. Índice pra detecção de spike por IP (cron futuro de anti-abuso)
-- ────────────────────────────────────────────────────────────────────────
-- O findings 22.2 sugere "cron que detecta spikes de leads por IP/UA".
-- Sem um índice apropriado, o cron varre a tabela inteira. Criamos agora
-- pra que o cron — quando entrar — use direto.

create index if not exists leads_ip_created_at_idx
  on public.leads (ip, created_at desc)
  where ip is not null;

comment on index public.leads_ip_created_at_idx is
  'PR-036 / D-054. Suporta detecção de spike de leads por IP (cron futuro).';
