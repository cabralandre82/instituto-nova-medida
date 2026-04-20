-- ============================================================================
-- Migration · Índices de busca rápida em customers (D-045 · 3.B)
-- ============================================================================
-- O painel admin ganha uma busca global (nome/email/telefone/CPF). Fazer
-- `ilike '%termo%'` direto na coluna é table-scan e fica lento conforme
-- o volume cresce. Pra operação solo com centenas → milhares de pacientes,
-- a solução adequada é trigram (pg_trgm): permite match parcial rápido.
--
-- Estratégia:
--   - `pg_trgm` é uma extensão builtin do Postgres; habilitar é seguro.
--   - Três índices GIN com `gin_trgm_ops`: name, email, phone. CPF fica
--     no índice b-tree existente `customers_pkey` apenas pra UNIQUE;
--     busca de CPF é sempre exata (11 dígitos), então não precisa
--     trigram.
--   - Caso um ambiente não permita extensão (raro no Supabase), os
--     CREATE INDEX ainda assim são opcionais — caem no fallback linear
--     do code path.
--
-- Observação: a lib `patient-search.ts` continua funcional mesmo sem
-- esses índices (Postgres faz seq scan). Essa migration é otimização,
-- não correção de feature.
-- ============================================================================

-- 1. Habilita pg_trgm (idempotente)
create extension if not exists pg_trgm;

-- 2. Índices GIN trigram pra busca `ilike '%q%'`
create index if not exists customers_name_trgm_idx
  on public.customers using gin (name gin_trgm_ops);

create index if not exists customers_email_trgm_idx
  on public.customers using gin (email gin_trgm_ops);

create index if not exists customers_phone_trgm_idx
  on public.customers using gin (phone gin_trgm_ops);

-- 3. Confirmação visual
do $$ begin
  raise notice 'Trigram indexes criados em customers(name, email, phone).';
end $$;
