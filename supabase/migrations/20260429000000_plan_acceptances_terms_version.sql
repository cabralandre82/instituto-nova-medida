-- PR-011 · `plan_acceptances.terms_version` — audit [6.1].
--
-- Contexto:
--   Até 2026-04-20 o texto do aceite (`acceptance_text`) e seu hash
--   eram calculados com uma string *enviada pelo cliente*. Um atacante
--   com DevTools podia alterar o body do POST, o servidor aceitava,
--   calculava hash sobre o texto adulterado e gravava — a "prova legal
--   imutável" ficava viciada desde a origem.
--
--   A partir deste PR:
--     1. O servidor ignora completamente o `acceptance_text` do body.
--     2. O servidor re-renderiza o texto a partir da versão declarada
--        (`terms_version`) + dados verificados (plan, customer, doctor,
--        appointment) e **só** esse texto vai pra hash.
--
--   Guardar `terms_version` na row viabiliza:
--     - auditoria histórica: saber qual versão do termo cada paciente
--       aceitou (útil em disputa).
--     - suporte a migração de termos sem quebrar aceites antigos.
--     - verificação post-hoc: re-renderizar com os dados gravados e
--       comparar com `acceptance_text` salvo → detecta adulteração.
--
-- Backfill:
--   Rows existentes ficam com `terms_version = NULL` inicialmente.
--   Como o primeiro template foi `v1-2026-04`, aplicamos backfill com
--   esse valor. Se alguma row antiga foi gravada com texto de versão
--   diferente, o hash ainda corresponde (é literal), só fica rotulada
--   genericamente. Aceitável — nada regride.

alter table public.plan_acceptances
  add column if not exists terms_version text;

update public.plan_acceptances
  set terms_version = 'v1-2026-04'
  where terms_version is null;

-- Depois do backfill, exigimos preenchimento.
alter table public.plan_acceptances
  alter column terms_version set not null;

comment on column public.plan_acceptances.terms_version is
  'PR-011 / audit [6.1]: versão do template do termo que o servidor usou para renderizar `acceptance_text` (ex.: "v1-2026-04"). O texto é server-authoritative; esta coluna é o índice de auditoria pra re-renderização de verificação.';

create index if not exists idx_pa_terms_version
  on public.plan_acceptances(terms_version);
