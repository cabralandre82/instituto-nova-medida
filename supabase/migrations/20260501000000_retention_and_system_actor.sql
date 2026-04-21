-- ============================================================================
-- Migration · Retenção automática + actor de sistema (PR-033-A · D-052 · Onda 2B)
-- ============================================================================
-- Esta migration prepara o banco para a anonimização automática por
-- política de retenção. O driver é LGPD Art. 16:
--
--   "Os dados pessoais serão eliminados após o término de seu tratamento,
--   no âmbito e nos limites técnicos das atividades, autorizada a conservação
--   para as seguintes finalidades: I - cumprimento de obrigação legal ou
--   regulatória (...)"
--
-- Dois problemas a resolver antes de ligar o cron:
--
-- 1) **Actor de sistema ausente.** Hoje `patient_access_log.admin_user_id`
--    é `NOT NULL references auth.users(id) on delete set null`. Isto é
--    contraditório: um `on delete set null` sobre uma coluna NOT NULL
--    faz o delete do usuário falhar. Mais importante, o cron de
--    retenção não é executado por nenhum humano — precisa gravar log com
--    actor = "system", não com um UUID fake. Mesma coisa pro
--    `admin_audit_log.actor_user_id` (que já é nullable — consertamos
--    só semanticamente com `actor_kind`).
--
-- 2) **Nenhuma forma tipada de diferenciar admin humano de cron.**
--    Relatórios LGPD do tipo "quais ações foram de sistema vs. humano?"
--    hoje dependem de olhar se `actor_user_id` é NULL. Frágil.
--    Adicionamos coluna explícita `actor_kind` com default compatível.
--
-- Decisões deste migration:
--
-- - `patient_access_log.admin_user_id` vira nullable. Check constraint
--   composta: se `actor_kind='admin'` então `admin_user_id` obrigatório;
--   se `actor_kind='system'` então `admin_user_id` pode ser NULL.
-- - Mesma constraint em `admin_audit_log` (já era nullable — só formaliza).
-- - Nenhuma função SQL de "find candidates" aqui — a query fica em TS
--   (`src/lib/retention.ts`), mais testável e sem precisar migration
--   quando ajustarmos thresholds. O banco não tem lógica de negócio.
-- - `retention_anonymize_at` não é coluna separada: `anonymized_at` já
--   existe (D-045 · 3.G). Distinguimos cadastros "voluntários" (LGPD
--   Art. 18 pelo titular) dos "de retenção" (LGPD Art. 16) via
--   `anonymized_ref` prefix — ver `src/lib/retention.ts`.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────
-- 1. patient_access_log: corrigir NOT NULL + adicionar actor_kind
-- ────────────────────────────────────────────────────────────────────────

alter table public.patient_access_log
  alter column admin_user_id drop not null;

alter table public.patient_access_log
  add column if not exists actor_kind text not null default 'admin';

-- Preenche admin_email quando actor_kind='system' pra padronizar relatórios.
-- Backfill leve: todas as linhas existentes ficam 'admin' (default).

alter table public.patient_access_log
  drop constraint if exists patient_access_log_actor_kind_chk;
alter table public.patient_access_log
  add constraint patient_access_log_actor_kind_chk
  check (actor_kind in ('admin', 'system'));

alter table public.patient_access_log
  drop constraint if exists patient_access_log_actor_binding_chk;
alter table public.patient_access_log
  add constraint patient_access_log_actor_binding_chk
  check (
    (actor_kind = 'admin' and admin_user_id is not null)
    or (actor_kind = 'system' and admin_user_id is null)
  );

comment on column public.patient_access_log.actor_kind is
  'Quem executou. admin = usuário humano via rota /api/admin/*; '
  'system = cron/retention/trigger sem user session. Adicionado pelo '
  'PR-033-A (D-052). Quando system, admin_user_id é NULL e admin_email '
  'carrega um marcador tipo "system:retention".';

-- ────────────────────────────────────────────────────────────────────────
-- 2. admin_audit_log: adicionar actor_kind (actor_user_id já nullable)
-- ────────────────────────────────────────────────────────────────────────

alter table public.admin_audit_log
  add column if not exists actor_kind text not null default 'admin';

alter table public.admin_audit_log
  drop constraint if exists admin_audit_log_actor_kind_chk;
alter table public.admin_audit_log
  add constraint admin_audit_log_actor_kind_chk
  check (actor_kind in ('admin', 'system'));

alter table public.admin_audit_log
  drop constraint if exists admin_audit_log_actor_binding_chk;
alter table public.admin_audit_log
  add constraint admin_audit_log_actor_binding_chk
  check (
    (actor_kind = 'admin' and actor_user_id is not null)
    or (actor_kind = 'system' and actor_user_id is null)
  );

comment on column public.admin_audit_log.actor_kind is
  'admin = usuário humano; system = cron/trigger. PR-033-A (D-052).';

-- ────────────────────────────────────────────────────────────────────────
-- 3. Índices adicionais para retenção e relatório "quem foi anonimizado por política vs. solicitação"
-- ────────────────────────────────────────────────────────────────────────

-- Último evento no customer (appointment ou fulfillment). Serve pra
-- achar "ghosts" rapidamente sem full scan das tabelas filho.
create index if not exists customers_active_candidates_idx
  on public.customers (updated_at desc)
  where anonymized_at is null;

-- Query típica do relatório: "anonymizações executadas no último mês".
create index if not exists customers_anonymized_recent_idx
  on public.customers (anonymized_at desc)
  where anonymized_at is not null;

-- ────────────────────────────────────────────────────────────────────────
-- 4. Extensão do enum CronJob (via comentário; enum não existe, é só text
--    em cron_runs.job — sem ALTER necessário).
-- ────────────────────────────────────────────────────────────────────────

do $$ begin
  raise notice 'Migration retention_and_system_actor aplicada com sucesso.';
end $$;
