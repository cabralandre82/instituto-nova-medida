-- ============================================================================
-- Migration · PIX self-service da médica (D-042)
-- ============================================================================
-- Contexto: até agora só o admin mexe em doctor_payment_methods via
-- /admin/doctors/[id]. Esta migração prepara o self-service da médica:
--
--   1. Preservar histórico — sempre que uma chave é substituída,
--      queremos manter o registro antigo (active=false, is_default=false)
--      com metadados de quem trocou e quando. A unique partial existente
--      (idx_dpm_one_active e idx_dpm_one_default) já permite múltiplos
--      inativos.
--
--   2. Auditoria — duas colunas novas:
--        replaced_at  → quando o registro deixou de ser o default
--        replaced_by  → auth.users(id) que efetuou a troca (médica ou admin)
--
--   3. Consistência — NÃO alteramos RLS: a policy `dpm_doctor_self`
--      (migration 005) já permite leitura/escrita da médica dona.
--      Backend usa service_role então também continua passando.
-- ============================================================================

alter table public.doctor_payment_methods
  add column if not exists replaced_at timestamptz,
  add column if not exists replaced_by uuid references auth.users(id) on delete set null;

-- Índice pra histórico (listar antigos mais rapidinho)
create index if not exists idx_dpm_history
  on public.doctor_payment_methods(doctor_id, created_at desc);

comment on column public.doctor_payment_methods.replaced_at is
  'Quando este registro deixou de ser o PIX default (via troca ou desativação).';
comment on column public.doctor_payment_methods.replaced_by is
  'Usuário que efetuou a troca — pode ser a própria médica (self-service) ou um admin.';

-- FIM
