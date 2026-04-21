-- ============================================================================
-- Migration · Anonymization LGPD em customers (D-045 · 3.G)
-- ============================================================================
-- LGPD Art. 18, IV e VI garantem ao titular o direito à anonimização e à
-- eliminação de dados pessoais. No Instituto Nova Medida:
--
--   * Deletar linha de `customers` é INVIÁVEL: há FKs em appointments,
--     fulfillments, payments, plan_acceptances. Apagar esses dados
--     quebra obrigações de retenção (CFM: prontuário 20 anos; Receita:
--     documentos fiscais 5 anos).
--   * Em vez disso, fazemos anonymization in-place: substitui PII
--     (nome, email, phone, CPF, endereço) por valores placeholder que
--     passam as constraints da tabela, mas não identificam ninguém.
--   * Mantemos `anonymized_at` (quando) e `anonymized_ref` (hash curto
--     do id original pra referência operacional tipo "paciente #a1b2
--     foi anonymizado 2026-04-20") pra auditoria.
--
-- Após anonymization a linha fica "viva" em termos de FK (pagamentos,
-- receitas não órfãos), mas "morta" em termos de identificação.
--
-- Decisão: anonymization é IRREVERSÍVEL. Não guardamos os valores
-- originais em lugar nenhum — esse é o ponto.
-- ============================================================================

alter table public.customers
  add column if not exists anonymized_at timestamptz,
  add column if not exists anonymized_ref text;

comment on column public.customers.anonymized_at is
  'Quando o paciente foi anonimizado por solicitação LGPD. NULL = ativo. '
  'Após preenchido, a linha fica intocável pelos fluxos normais (hooks '
  'em application layer checam). D-045 · 3.G.';

comment on column public.customers.anonymized_ref is
  'Hash curto derivado do id original (primeiros 8 chars de sha256) pra '
  'admin conseguir correlacionar "paciente #a1b2c3d4 foi anonimizado em X". '
  'Não reversível, não sensível. D-045 · 3.G.';

-- Índice parcial pra admin listar rapidamente quem foi anonymizado.
create index if not exists customers_anonymized_idx
  on public.customers (anonymized_at desc)
  where anonymized_at is not null;

do $$ begin
  raise notice 'customers.anonymized_at + anonymized_ref criados.';
end $$;
