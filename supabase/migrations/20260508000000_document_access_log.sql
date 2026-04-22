-- ============================================================================
-- Migration · document_access_log (PR-055 · D-066 · finding 17.4)
-- ============================================================================
--
-- Trilha imutável de emissão de signed URLs (Supabase Storage) para
-- documentos financeiros. Antes dessa tabela, cada GET em
-- /api/admin/payouts/[id]/proof, /api/medico/payouts/[id]/proof,
-- /api/admin/payouts/[id]/billing-document e /api/medico/payouts/[id]/
-- billing-document entregava uma URL assinada (60s TTL) SEM deixar
-- rastro: quem pegou, quando, de que IP — invisível pra auditoria.
-- O dado exposto inclui comprovante PIX (financeiro sensível) e
-- NF-e/RPA da médica (fiscal + identificador da pessoa física).
--
-- Finding [17.4 🟠 ALTO] classifica como vazamento silencioso: "PHI/
-- financeiro vaza sem trilha". Supabase Storage não audita download
-- por signed URL ao nível aplicativo.
--
-- Este schema NÃO resolve o problema da URL viajar fora do sistema
-- (quem tem o link pode compartilhar dentro do TTL). Resolve a meia
-- metade auditável: SEMPRE que o servidor EMITE a URL, grava aqui
-- quem pediu, qual recurso, quando expira. Se amanhã o operador
-- recebe "alguém vazou meu RPA", ele tem a shortlist de quem solicitou.
--
-- Para eliminar TAMBÉM o risco de compartilhamento do link (bullet (a)
-- da recomendação do audit), a evolução natural é expor um endpoint
-- proxy que stream do Storage sem entregar a URL ao cliente. Isso
-- fica como follow-up opcional (PR-055-B) — muda UI e flow de download.
--
-- Decisões de modelagem:
--
-- - **Append-only semântico**. Sem UPDATE/DELETE via aplicação;
--   RLS deny-all pra anon/authenticated. Mesmo padrão do
--   patient_access_log (D-051). Poderíamos adicionar trigger de
--   imutabilidade mas service-role-only já nos protege.
-- - **actor_kind** em linha com `patient_access_log.actor_kind` e
--   `admin_audit_log.actor_kind` (D-052). Valores: 'admin' | 'doctor' |
--   'system'. 'doctor' é novo aqui porque médicas também baixam
--   seus próprios documentos.
-- - **resource_id** = UUID do `doctor_payouts` (chave do contexto).
--   `resource_type` distingue 'payout_proof' de 'billing_document'.
--   O id específico do billing_document vai em metadata.
-- - **doctor_id** denormalizado — ambas as operações são sempre
--   associadas a uma médica. Facilita "me mostre todos os downloads
--   da Dra. X nos últimos 30d" sem JOIN.
-- - **signed_url_expires_at** grava o deadline da URL emitida.
--   Permite responder "a URL que vazou em 14:32 era válida até?".
-- - **action** discrimina 'signed_url_issued' (Storage) de
--   'external_url_returned' (legacy: URL externa gravada no banco,
--   não tem TTL — auditoria ainda relevante porque o cliente recebeu
--   e sabe a URL). Sem action='access' — não conseguimos observar
--   o download em si, só a emissão.
-- - **storage_path** é do bucket privado, sem PII identificadora
--   sozinha. No caso external_url_returned, grava a URL completa.
-- - **ip/user_agent/route** pra forense ANPD.
-- ============================================================================

create table if not exists public.document_access_log (
  id                        uuid primary key default gen_random_uuid(),

  -- Quem pediu
  actor_user_id             uuid references auth.users(id) on delete set null,
  actor_email               text,
  actor_kind                text not null
                              check (actor_kind in ('admin','doctor','system')),

  -- O quê
  resource_type             text not null
                              check (resource_type in
                                ('payout_proof','billing_document')),
  resource_id               uuid not null,
  doctor_id                 uuid references public.doctors(id) on delete set null,

  -- URL / path
  storage_path              text not null,
  signed_url_expires_at     timestamptz,

  -- Discriminador
  action                    text not null default 'signed_url_issued'
                              check (action in
                                ('signed_url_issued','external_url_returned')),

  -- Contexto forense
  ip                        inet,
  user_agent                text,
  route                     text,

  metadata                  jsonb not null default '{}'::jsonb,
  created_at                timestamptz not null default now(),

  -- Bindings entre actor_kind e actor_user_id pra ecoar o padrão do
  -- patient_access_log (D-052). 'system' pode ter user_id NULL
  -- (cron emitindo URL por conta própria — hoje não existe, mas
  -- reservado); 'admin' e 'doctor' exigem user_id (prova de quem).
  constraint document_access_log_actor_binding_chk
    check (
      (actor_kind in ('admin','doctor') and actor_user_id is not null)
      or (actor_kind = 'system' and actor_user_id is null)
    )
);

comment on table public.document_access_log is
  'Trilha imutável de emissão de signed URLs de Supabase Storage pra '
  'comprovantes de PIX e NF-e/RPA das médicas (D-066 · finding 17.4). '
  'Emissão apenas — o download em si permanece invisível (limitação do '
  'Storage). Combinado com TTL=60s, dá à auditoria a lista curta de '
  'quem solicitou o link caso haja vazamento.';

comment on column public.document_access_log.actor_kind is
  'admin = operador via /api/admin/*; doctor = médica via /api/medico/*; '
  'system = reservado pra cron/trigger.';

comment on column public.document_access_log.resource_type is
  'payout_proof = comprovante PIX do admin pra médica. '
  'billing_document = NF-e/RPA emitida pela médica pro admin.';

comment on column public.document_access_log.resource_id is
  'UUID do doctor_payouts. Chave do contexto. Para billing_documents '
  'específicos, id do documento vai em metadata.document_id.';

comment on column public.document_access_log.signed_url_expires_at is
  'Deadline da URL emitida (now() + TTL, tipicamente 60s). NULL quando '
  'action=external_url_returned (URL legada sem TTL controlado).';

comment on column public.document_access_log.action is
  'signed_url_issued = URL assinada nova de Storage. '
  'external_url_returned = URL externa legada devolvida ao cliente '
  '(ainda auditamos porque o cliente passa a ter o link).';

-- Índices voltados pras queries forenses:

-- "Downloads nos últimos N dias" (dashboard admin futuro)
create index if not exists document_access_log_created_idx
  on public.document_access_log (created_at desc);

-- "Quem pegou os documentos da Dra. X" (investigação por médica)
create index if not exists document_access_log_doctor_idx
  on public.document_access_log (doctor_id, created_at desc)
  where doctor_id is not null;

-- "Quantas vezes o actor Y baixou coisa" (investigação por actor)
create index if not exists document_access_log_actor_idx
  on public.document_access_log (actor_user_id, created_at desc)
  where actor_user_id is not null;

-- "Últimos acessos ao payout X" (investigação por recurso)
create index if not exists document_access_log_resource_idx
  on public.document_access_log (resource_type, resource_id, created_at desc);

-- RLS deny-all: só service_role (no nosso caso o código com
-- SUPABASE_SERVICE_ROLE_KEY) escreve/lê.
alter table public.document_access_log enable row level security;

drop policy if exists "document_access_log_deny_anon"
  on public.document_access_log;
create policy "document_access_log_deny_anon" on public.document_access_log
  for all to anon using (false) with check (false);

drop policy if exists "document_access_log_deny_authenticated"
  on public.document_access_log;
create policy "document_access_log_deny_authenticated"
  on public.document_access_log
  for all to authenticated using (false) with check (false);

do $$ begin
  raise notice 'document_access_log criada com índices + RLS deny-all (D-066 · 17.4).';
end $$;
