-- ============================================================================
-- Migration · patient_access_log (PR-032 · D-051 · Onda 2A)
-- ============================================================================
-- Tabela de rastro imutável de acessos administrativos a PII de
-- pacientes (LGPD Art. 37 — registro de operações de tratamento de
-- dados pessoais; Art. 46 — medidas de segurança).
--
-- Diferente de `admin_audit_log` (que registra ações que MODIFICAM
-- estado — D-045 · PR-031), esta tabela foca em ACESSO A PII —
-- inclusive leitura. Um operador abrir a ficha de um paciente é, por
-- si só, um evento relevante pra auditoria ANPD (quem acessou, quando,
-- por quê).
--
-- Decisões de modelagem:
--
-- - **Append-only semântico**: sem UPDATE/DELETE via aplicação.
--   Não colocamos trigger de imutabilidade porque a tabela já é
--   service_role only e o código que escreve nela só chama INSERT
--   (`src/lib/patient-access-log.ts`). Se no futuro alguém introduzir
--   UPDATE por engano, `npm run lint` não pega — opção de colocar
--   trigger fica pra PR futuro (P3; risco baixo operacionalmente
--   dado o tamanho do time).
--
-- - **`action` como texto livre enum-like**: começamos com "view",
--   "export", "anonymize", "search", mas mantemos text não-enum pra
--   não precisar de migration sempre que um novo hotspot for
--   instrumentado. Cada call site é grep-able pela string usada.
--
-- - **`customer_id` nullable**: `action='search'` pode logar uma
--   busca que retorna N pacientes sem que o admin tenha clicado em
--   nenhum deles. O `metadata.query` captura o termo buscado.
--
-- - **Retenção**: LGPD não define prazo específico pra log de
--   acesso; a doutrina recomenda 6 meses a 2 anos. Não adicionamos
--   TTL automático nesta migration — a decisão de TTL virá junto
--   com a política geral de retenção (backlog PR-033-A).
-- ============================================================================

create table if not exists public.patient_access_log (
  id              uuid primary key default gen_random_uuid(),

  admin_user_id   uuid not null references auth.users(id) on delete set null,
  admin_email     text,
  customer_id     uuid references public.customers(id) on delete set null,

  -- view | export | anonymize | search | lgpd_fulfill | lgpd_reject | ...
  action          text not null check (length(trim(action)) > 0),

  -- Campo livre pro admin justificar (ex.: "paciente reclamou no WhatsApp").
  -- Obrigatório em UIs críticas; opcional em views passivas.
  reason          text,

  -- Contexto extra — rota, IP, user-agent, query da busca, etc.
  -- Nunca colocar PII duplicada aqui (nome, CPF, email).
  metadata        jsonb not null default '{}'::jsonb,

  accessed_at     timestamptz not null default now()
);

comment on table public.patient_access_log is
  'Rastro de acessos admin a PII de pacientes (LGPD Art. 37). Append-only. '
  'Diferente de admin_audit_log (ações que modificam estado), aqui logamos '
  'leituras e consultas. PR-032 · D-051.';

comment on column public.patient_access_log.action is
  'Nome curto da ação. Start com: view | export | anonymize | search | '
  'lgpd_fulfill | lgpd_reject. Palavra em inglês pra evitar acentuação.';

comment on column public.patient_access_log.customer_id is
  'Paciente tocado. NULL quando a ação é de listagem/busca que retorna N.';

comment on column public.patient_access_log.metadata is
  'JSON com contexto extra (rota, IP, user-agent, query, filtros). Nunca PII duplicada.';

create index if not exists patient_access_log_customer_idx
  on public.patient_access_log (customer_id, accessed_at desc)
  where customer_id is not null;

create index if not exists patient_access_log_admin_idx
  on public.patient_access_log (admin_user_id, accessed_at desc);

create index if not exists patient_access_log_accessed_idx
  on public.patient_access_log (accessed_at desc);

-- RLS: segue o padrão deny-all. Só service_role lê/escreve.
alter table public.patient_access_log enable row level security;

drop policy if exists "patient_access_log_deny_anon" on public.patient_access_log;
create policy "patient_access_log_deny_anon" on public.patient_access_log
  for all to anon using (false) with check (false);

drop policy if exists "patient_access_log_deny_authenticated"
  on public.patient_access_log;
create policy "patient_access_log_deny_authenticated" on public.patient_access_log
  for all to authenticated using (false) with check (false);

do $$ begin
  raise notice 'patient_access_log criada com índices e RLS deny-all.';
end $$;
