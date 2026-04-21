-- PR-031 · admin_audit_log — trilha de auditoria para ações administrativas.
--
-- Contexto (audit [17.1], CRÍTICO):
--   `getSupabaseAdmin()` usa o service role key que BYPASSA RLS. Qualquer
--   UPDATE/DELETE feito pelo admin em produção é atualmente invisível:
--   não há rastro de "quem aprovou esse refund", "quem anonimizou esse
--   paciente", "quem pausou essa médica". Isso inviabiliza forense em
--   incidente, compliance LGPD Art. 37 (logs de acesso/tratamento) e
--   auditoria financeira externa.
--
-- Design:
--   Tabela append-only de eventos emitidos **voluntariamente** pelo
--   código Node/TS através do helper `logAdminAction` (lib/admin-audit-log.ts).
--   Não é trigger DB genérico porque:
--     1. Triggers DB não têm acesso ao `user_id` do operador (service
--        role não carrega claims). Ficaria "anonymous" em todas as rows.
--     2. Grande parte dos UPDATEs são operacionais (scheduler, webhook)
--        e logá-los polui o histórico sem valor de auditoria.
--     3. Queremos capturar **intenção** (ex.: "admin aprovou payout"),
--        não apenas efeito (update em `doctor_payouts`). Intenção exige
--        contexto do handler.
--
-- Consequências:
--   - Se um handler esquece de chamar logAdminAction, perde-se o rastro
--     daquela operação específica. Mitigação: checklist no PR review +
--     teste por handler que assert. logAdminAction mock é chamado.
--   - Gap fica preenchido por mais defesas (PR-030 prontuário imutável,
--     triggers de immutable timestamps em payments, etc).
--
-- Retenção:
--   Guardar por tempo indeterminado (LGPD não obriga retenção máxima
--   de logs de auditoria — ao contrário, a RFB/CFM preferem 5-10 anos).
--   Se a tabela ficar gigante (1M+ rows), particionar por created_at.
--
-- Dados sensíveis no before/after:
--   `before` e `after` são jsonb livres. Podem conter PII (nome, CPF,
--   endereço). Campos sensíveis devem ser redactados pelo caller quando
--   possível. Acesso a esta tabela é admin-only via RLS.

create table if not exists public.admin_audit_log (
  id              uuid primary key default gen_random_uuid(),

  -- Quem executou a ação.
  -- `actor_user_id` referencia auth.users; `actor_email` é snapshot
  -- imutável caso o user seja posteriormente deletado/anonimizado.
  actor_user_id   uuid references auth.users(id) on delete set null,
  actor_email     text,

  -- Ação executada, em formato 'entity.verb':
  --   'fulfillment.transition', 'payout.approve', 'payout.pay',
  --   'refund.mark_processed', 'customer.anonymize',
  --   'doctor.reliability_pause', etc.
  action          text not null,

  -- Entidade afetada. Pode ser null quando ação global (ex.: 'system.maintenance').
  entity_type     text,
  entity_id       uuid,

  -- Snapshots antes/depois. Pode ser subset dos campos relevantes
  -- (caller decide — não serializar row inteira se tiver PII pesada).
  before_json     jsonb,
  after_json      jsonb,

  -- Contexto opcional: ip, user_agent, rota, motivo/nota livre, etc.
  metadata        jsonb,

  created_at      timestamptz not null default now()
);

create index if not exists idx_admin_audit_actor_time
  on public.admin_audit_log(actor_user_id, created_at desc);

create index if not exists idx_admin_audit_entity_time
  on public.admin_audit_log(entity_type, entity_id, created_at desc);

create index if not exists idx_admin_audit_action_time
  on public.admin_audit_log(action, created_at desc);

comment on table public.admin_audit_log is
  'PR-031 / audit [17.1]: trilha append-only de ações administrativas significativas. Emitido pelo helper logAdminAction em handlers /api/admin/* e em libs que executam mutações sensíveis sob service_role.';

comment on column public.admin_audit_log.before_json is
  'Snapshot dos campos relevantes antes da mutação. Pode ser subset.';
comment on column public.admin_audit_log.after_json is
  'Snapshot dos campos relevantes após a mutação. Pode ser subset.';
comment on column public.admin_audit_log.metadata is
  'Contexto opcional: ip, user_agent, rota, motivo/nota livre.';

-- RLS: admin-only read. Service role bypassa.
alter table public.admin_audit_log enable row level security;

revoke all on public.admin_audit_log from anon, authenticated;

-- Política de leitura pra admins autenticados.
-- A verificação de role fica em src/lib/auth.ts (`requireAdmin()`);
-- no banco basta bloquear anon e exigir service role (via API admin).
-- Se no futuro quisermos deixar role=admin autenticado ler direto,
-- adicionar policy que cheque app_metadata->>'role' = 'admin'.

drop policy if exists admin_audit_log_admin_read on public.admin_audit_log;
create policy admin_audit_log_admin_read
  on public.admin_audit_log
  for select
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );
