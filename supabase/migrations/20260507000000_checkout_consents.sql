-- ============================================================================
-- 20260507000000_checkout_consents.sql
--
-- PR-053 · D-064 · finding [5.6 🟠 ALTO].
--
-- Contexto:
--   `/api/checkout` (fluxo legacy back-office pós-D-044) validava
--   `body.consent === true` e DESCARTAVA. Nenhum registro em banco. A
--   plataforma fica sem prova jurídica de que o paciente leu/aceitou
--   os termos — violação LGPD Art. 8º §1º (consentimento específico +
--   prova do consentimento) e Art. 9º (base legal comprovável). A
--   ANPD pode exigir a qualquer momento: "mostre-me o consentimento
--   do Fulano de Tal" — controller incapaz de responder.
--
--   Fluxo canônico pós-D-044 (`/paciente/oferta/[appointment_id]`)
--   já grava em `plan_acceptances` (D-044). Este PR estende a mesma
--   filosofia pra `/api/checkout`: toda aceitação gera row em
--   `checkout_consents`, imutável, com hash do texto exato visto e
--   ip/user_agent do cliente.
--
-- Decisão (D-064):
--   - Tabela dedicada `checkout_consents` (em vez de generalizar pra
--     `legal_consents`) — escopo limitado ao funil de checkout legacy.
--     Se emergir demanda por 3ª modalidade (newsletter, recontrato,
--     etc), generalizar em ADR próprio.
--   - Colunas espelham `plan_acceptances` (D-044): text_version,
--     text_snapshot, text_hash, ip, user_agent.
--   - Imutabilidade via trigger (UPDATE + DELETE → raise exception).
--   - FKs restrict: custom delete só pode acontecer se consent também
--     for removido (nunca é — imutável).
--
-- Por que NÃO `updatable=false policy` em vez de trigger:
--   Trigger cobre também service_role (bypass de RLS). Prova
--   legal exige proteção absoluta contra mutação, independente de
--   quem faz a query.
--
-- Reversibilidade:
--   Tabela nova + trigger novo. Reverso: drop table (destrutivo).
--   Colunas não tocam schema existente — sem impacto cross-tabela.
-- ============================================================================

create table if not exists public.checkout_consents (
  id                uuid primary key default gen_random_uuid(),

  -- Quem aceitou (obrigatório — consent sem customer não tem prova).
  customer_id       uuid not null
                      references public.customers(id) on delete restrict,

  -- Opcional: cobrança à qual esse aceite se vincula. Null quando o
  -- consent foi gravado mas a criação da cobrança Asaas falhou depois
  -- (ainda queremos preservar a prova do interesse do paciente).
  payment_id        uuid references public.payments(id) on delete set null,

  accepted_at       timestamptz not null default now(),

  -- Versão do texto legal vigente no momento do aceite. Nunca é
  -- removida do código (lib `src/lib/checkout-consent-terms.ts`) pra
  -- permitir auditoria post-hoc: "o que o Fulano viu em 2026-04-20?"
  -- → buscar linha, pegar `text_version`, reidratar template.
  text_version      text not null,

  -- Snapshot do texto EXATO exibido ao paciente. Redundante com
  -- text_version + template, mas protege contra refactor acidental
  -- do template (alterar uma vírgula sem bump de versão quebra o
  -- hash). A verdade jurídica é o snapshot.
  text_snapshot     text not null,

  -- SHA-256 do payload canonicalizado (text + version + customer_id
  -- + payment_id). Gravado pela aplicação. Auditoria re-calcula e
  -- compara — divergência indica tampering.
  text_hash         text not null,

  -- Contexto da sessão — LGPD Art. 9º §1º II-b (circunstâncias).
  ip_address        inet,
  user_agent        text,

  -- Método de pagamento escolhido no momento (só pra observabilidade,
  -- não entra no hash). pix/boleto/cartao.
  payment_method    text
                      check (payment_method is null
                             or payment_method in ('pix','boleto','cartao'))
);

comment on table public.checkout_consents is
  'Prova legal de aceite dos termos em /api/checkout (D-064). Imutável.';

comment on column public.checkout_consents.text_hash is
  'SHA-256 hex do payload canonical (text + version + customer + payment). Auditoria re-calcula pra detectar tampering.';

create index if not exists idx_cc_customer    on public.checkout_consents(customer_id);
create index if not exists idx_cc_payment     on public.checkout_consents(payment_id);
create index if not exists idx_cc_accepted_at on public.checkout_consents(accepted_at desc);

-- Imutabilidade: trigger bloqueia UPDATE + DELETE em qualquer contexto
-- (incluindo service_role). Matches D-044 / plan_acceptances.
create or replace function public.prevent_checkout_consent_changes()
returns trigger
language plpgsql
as $$
begin
  raise exception 'checkout_consents é tabela imutável — UPDATE/DELETE proibidos (D-064)';
end;
$$;

drop trigger if exists checkout_consents_immutable on public.checkout_consents;
create trigger checkout_consents_immutable
  before update or delete on public.checkout_consents
  for each row execute function public.prevent_checkout_consent_changes();

-- RLS: deny-by-default. Só service_role acessa (bypass RLS automático).
alter table public.checkout_consents enable row level security;

drop policy if exists "deny anon all" on public.checkout_consents;
create policy "deny anon all" on public.checkout_consents
  for all to anon using (false) with check (false);

drop policy if exists "deny authenticated all" on public.checkout_consents;
create policy "deny authenticated all" on public.checkout_consents
  for all to authenticated using (false) with check (false);
