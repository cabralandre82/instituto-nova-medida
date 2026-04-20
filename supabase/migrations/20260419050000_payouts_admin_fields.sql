-- ============================================================================
-- Migration 006 · Ajustes em doctor_payouts pro fluxo admin (Sprint 4.1.2)
-- ============================================================================
-- A migração 005 colocou só `paid_at` no doctor_payouts, mas a operação
-- real precisa separar:
--   - approved_at  → admin aprovou (já existia)
--   - pix_sent_at  → admin executou PIX manual no banco (NOVO)
--   - confirmed_at → médica confirmou recebimento (NOVO)
--   - paid_at      → mantido como alias semântico de "PIX foi enviado"
--                     (mesma coisa que pix_sent_at, mantemos por
--                     compatibilidade com pg_cron / outros consumidores)
--
-- Também simplificamos doctor_payment_methods: o campo `is_default`
-- aliasa `active` (que é o que existe). Usamos uma view atualizável.
-- ============================================================================

alter table public.doctor_payouts
  add column if not exists pix_sent_at  timestamptz,
  add column if not exists confirmed_at timestamptz,
  add column if not exists pix_proof_url text,
  add column if not exists pix_transaction_id text,
  add column if not exists earnings_count int default 0;

-- Backfill semântico: se há paid_at mas não pix_sent_at → assume mesmo timestamp
update public.doctor_payouts
   set pix_sent_at = paid_at
 where paid_at is not null and pix_sent_at is null;

-- Sincroniza pix_tx_id existente
update public.doctor_payouts
   set pix_transaction_id = pix_tx_id
 where pix_tx_id is not null and pix_transaction_id is null;

-- Sincroniza receipt_url
update public.doctor_payouts
   set pix_proof_url = receipt_url
 where receipt_url is not null and pix_proof_url is null;

-- ============================================================================
-- doctor_payment_methods: adiciona campos com nomes esperados pelo painel
-- ============================================================================
alter table public.doctor_payment_methods
  add column if not exists is_default boolean,
  add column if not exists account_holder_name text,
  add column if not exists account_holder_cpf_or_cnpj text;

-- Backfill: copia active → is_default e mapeia titular
update public.doctor_payment_methods
   set is_default = active
 where is_default is null;

update public.doctor_payment_methods
   set account_holder_name = coalesce(account_holder_name, pix_key_holder, bank_account_holder)
 where account_holder_name is null;

update public.doctor_payment_methods
   set account_holder_cpf_or_cnpj = coalesce(
         account_holder_cpf_or_cnpj,
         bank_holder_doc,
         regexp_replace(coalesce(bank_holder_doc, ''), '[^0-9]', '', 'g')
       )
 where account_holder_cpf_or_cnpj is null;

-- Garante constraint: 1 default por médica
drop index if exists idx_dpm_one_default;
create unique index if not exists idx_dpm_one_default
  on public.doctor_payment_methods(doctor_id) where is_default = true;

-- ============================================================================
-- doctor_availability: aceita também valores em inglês
-- ============================================================================
-- Migration 005 usou enum em PT (agendada/plantao). Painel usa EN (scheduled/on_call).
-- Adicionamos os valores em EN ao enum pra eliminar a necessidade de
-- mapeamento na app.
do $$ begin
  alter type availability_type add value if not exists 'scheduled';
exception when duplicate_object then null; end $$;
do $$ begin
  alter type availability_type add value if not exists 'on_call';
exception when duplicate_object then null; end $$;

-- ============================================================================
-- doctor_earnings: torna description nullable (alguns earnings auto-gerados
-- pelo webhook não têm descrição humana imediata)
-- ============================================================================
alter table public.doctor_earnings
  alter column description drop not null;

-- ============================================================================
-- doctor_payouts: adiciona valor 'failed' nas transições permitidas
-- (já existe no enum, só documenta semanticamente)
-- ============================================================================

comment on column public.doctor_payouts.pix_sent_at is
  'Timestamp em que o admin executou o PIX manualmente. Próximo: confirmed_at.';
comment on column public.doctor_payouts.confirmed_at is
  'Timestamp em que a médica confirmou recebimento do PIX. Final do fluxo.';
comment on column public.doctor_payouts.pix_proof_url is
  'URL do comprovante (Storage privado). Opcional.';
comment on column public.doctor_payouts.pix_transaction_id is
  'End-to-end ID do PIX (sinônimo de pix_tx_id, usado pelo painel novo).';

-- FIM
