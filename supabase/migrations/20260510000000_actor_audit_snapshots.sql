-- ============================================================================
-- Migration · Snapshots imutáveis do actor em campos de audit (PR-064 · D-072)
-- ============================================================================
--
-- Contexto (finding [10.6] 🟡 MÉDIO):
--   Várias colunas em tabelas de audit referenciam `auth.users(id)` com
--   `on delete set null`. Semanticamente isto é um buraco: se a médica/
--   admin for deletada (LGPD Art. 18 · direito ao esquecimento), o
--   registro imutável perde a identidade do responsável. "Quem aprovou
--   este payout?", "quem editou o endereço?", "quem aceitou o plano?"
--   passam a responder NULL.
--
--   A auditoria sugeriu `on delete restrict`. Não seguimos essa rota
--   porque quebraria LGPD Art. 18 — bloquear deleção do titular é
--   inconstitucional. Mantemos `on delete set null` e **pareamos cada
--   FK audit com uma coluna snapshot** (`*_email`, eventualmente
--   `*_kind`) preenchida no momento do INSERT/UPDATE. Assim:
--
--     • O UUID (FK) serve pra JOIN enquanto o user existir;
--     • O email serve como prova de identidade MESMO após delete.
--
--   Estratégia similar à "Ghost user" do GitHub, ajustada a LGPD.
--
-- Escopo deste PR-064:
--   Adiciona colunas snapshot nas 4 tabelas mais sensíveis do ponto de
--   vista CFM/LGPD/financeiro:
--
--     1. `plan_acceptances.user_email` — prova LEGAL do aceite do
--        paciente. Imutável por trigger. Se o paciente anonimizar a
--        conta depois, ainda conseguimos defender a clínica em
--        eventual disputa com "foi esta pessoa, neste email, nesta
--        data, que aceitou este texto".
--
--     2. `fulfillments.updated_by_email` — audit operacional das
--        transições (aceite, transporte, entrega, cancelamento) e da
--        mudança de endereço (D-045 · 3.E).
--
--     3. `appointments.refund_processed_by_email` — audit de
--        processamento de refund (D-033). Financeiro sensível: preciso
--        saber QUEM liberou cada estorno, inclusive se foi automação
--        (kind='system' com email null ou "system:asaas-webhook").
--
--     4. `doctor_payouts.approved_by_email` — audit de aprovação de
--        payout. "Quem liberou R$ X pra esta médica naquela data?"
--        tem que sobreviver à deleção do admin.
--
--   Não mexemos nas FKs. Não adicionamos NOT NULL (histórico legado
--   pode ter linhas sem email — ex. criados por cron/system sem user).
--   Os helpers do app (PR-064 camada TS) passam a sempre preencher.
--
-- Escopo NÃO incluído (seguem como PR-064-B futuro):
--
--     • `doctor_billing_documents.{uploaded_by,validated_by}` →
--       importante pra audit fiscal, mas ainda não tem volume em prod.
--     • `appointments.{created_by,cancelled_by_user_id}` → a coluna
--       `cancelled_by_user_id` **nunca é populada hoje** pelo código
--       (reconcile/webhook setam status sem user). Resolver junto com
--       uma reforma do path de cancelamento.
--     • `lgpd_requests.{fulfilled_by_user_id,rejected_by_user_id}` →
--       baixo volume, será coberto em PR-064-B.
--     • `doctors.reliability_paused_by`,
--       `doctor_reliability_events.dismissed_by`,
--       `doctor_payment_methods.replaced_by`,
--       `plans.created_by` → baixo volume, PR-064-B.
--
-- Backfill:
--   Para cada coluna nova, fazemos JOIN com `auth.users` e preenchemos
--   o email quando o user_id ainda existe. Linhas cujo user já foi
--   removido continuam com email null (não temos como reconstruir
--   retroativamente). Novos registros sempre terão email.
--
-- Idempotência: todos os `ADD COLUMN` usam `IF NOT EXISTS`.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────
-- 1. plan_acceptances — prova legal do aceite (imutável por trigger)
-- ────────────────────────────────────────────────────────────────────────
--
-- Como a tabela tem trigger `prevent_plan_acceptance_changes()` que
-- bloqueia qualquer UPDATE, o backfill aqui é delicado:
--
--   (a) `ADD COLUMN` sem default é apenas metadata — Postgres não
--       reescreve linhas existentes (fast path);
--   (b) o backfill (UPDATE com JOIN) dispara o trigger e levanta
--       exception.
--
-- Resolvo isto temporariamente desabilitando o trigger durante o
-- backfill, REINSERINDO o trigger ao final. Execução em uma única
-- transação (begin implícito na migration). Se falhar, rollback
-- preserva estado anterior.

alter table public.plan_acceptances
  add column if not exists user_email text;

comment on column public.plan_acceptances.user_email is
  'Snapshot imutável do email do paciente no momento do aceite. '
  'Pareado com user_id (FK): se o user for deletado depois '
  '(LGPD Art. 18), o email preservado aqui é a prova que quem aceitou '
  'o plano era esta identidade. Preenchido pelo app em acceptFulfillment.';

-- Backfill: precisa desabilitar temporariamente o trigger de
-- imutabilidade. Reativa ao final. Se falhar no meio, o rollback da
-- migration desfaz tudo. Nova trigger pós-migration continua protegendo.
alter table public.plan_acceptances disable trigger trg_plan_acceptances_immutable;

update public.plan_acceptances pa
  set user_email = u.email
  from auth.users u
  where pa.user_id = u.id
    and pa.user_email is null
    and pa.user_id is not null;

alter table public.plan_acceptances enable trigger trg_plan_acceptances_immutable;

-- ────────────────────────────────────────────────────────────────────────
-- 2. fulfillments — audit operacional
-- ────────────────────────────────────────────────────────────────────────

alter table public.fulfillments
  add column if not exists updated_by_email text;

comment on column public.fulfillments.updated_by_email is
  'Snapshot do email do último actor (paciente/admin/médica) que fez '
  'transição ou mudança de endereço. Pareado com updated_by_user_id. '
  'Preservado mesmo após delete/anonymize do user (PR-064 · D-072).';

update public.fulfillments f
  set updated_by_email = u.email
  from auth.users u
  where f.updated_by_user_id = u.id
    and f.updated_by_email is null
    and f.updated_by_user_id is not null;

-- ────────────────────────────────────────────────────────────────────────
-- 3. appointments — audit de refund
-- ────────────────────────────────────────────────────────────────────────

alter table public.appointments
  add column if not exists refund_processed_by_email text;

comment on column public.appointments.refund_processed_by_email is
  'Snapshot do email do admin que processou o refund. Pareado com '
  'refund_processed_by (FK pra auth.users). Null quando acionado por '
  'automação (cron/webhook Asaas) — nesse caso refund_processed_method '
  'distingue a fonte. PR-064 · D-072.';

update public.appointments a
  set refund_processed_by_email = u.email
  from auth.users u
  where a.refund_processed_by = u.id
    and a.refund_processed_by_email is null
    and a.refund_processed_by is not null;

-- ────────────────────────────────────────────────────────────────────────
-- 4. doctor_payouts — audit de aprovação financeira
-- ────────────────────────────────────────────────────────────────────────

alter table public.doctor_payouts
  add column if not exists approved_by_email text;

comment on column public.doctor_payouts.approved_by_email is
  'Snapshot do email do admin que aprovou o payout. Pareado com '
  'approved_by (FK pra auth.users). Preservado após delete/anonymize '
  'do admin. PR-064 · D-072.';

update public.doctor_payouts dp
  set approved_by_email = u.email
  from auth.users u
  where dp.approved_by = u.id
    and dp.approved_by_email is null
    and dp.approved_by is not null;
