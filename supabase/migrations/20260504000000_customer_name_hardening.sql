-- ============================================================================
-- Migration · Hardening de `customers.name`
-- PR-037 · D-056 · audit [9.2] (fulfillment-messages amplifier)
-- ============================================================================
--
-- Motivação:
--   `customers.name` é interpolado em:
--     - templates WhatsApp (`fulfillment-messages.ts`)
--     - e-mails transacionais (pós-aceite, pós-pagamento)
--     - comprovantes fiscais (Asaas `customerName`)
--     - eventual LLM de atendimento (próxima fase)
--   Historicamente a API só rodava `.trim()`. Um name com `\n`,
--   zero-width, bidi override ou templating `${...}` podia chegar ao
--   canal externo sem sanitização. A Onda PR-037 fechou os dois write
--   paths (`/api/checkout`, `/api/agendar/reserve`) com
--   `sanitizeShortText(personName)`; esta migration é a rede embaixo:
--   mesmo que alguém escreva via service_role / import SQL, o banco
--   rejeita payloads absurdos.
--
-- Decisões intencionais:
--   - Limite de 120 chars (char_length), alinhado com o limite da app.
--     Nome brasileiro raramente passa de 70 chars; 120 é folga pro
--     caso "Maria das Graças de Jesus Cristo dos Santos Ferreira".
--   - Bloqueio dos controles 0x00-0x1F e 0x7F (sem exceção — nenhum
--     nome legítimo tem `\n` ou NUL).
--   - NÃO rejeita acentos, apóstrofos, hífens ou parênteses. Pattern
--     ajustado pelo app (`personName`) faz a validação estrita
--     (`\p{L} .,'()-`); no banco usamos filtro só contra lixo obvio pra
--     não brigar com nomes em outros scripts (cirílico, árabe etc — a
--     clínica pode atender paciente estrangeiro).
--   - NOT VALID na criação do CHECK pra que linhas pré-existentes
--     eventuais não impeçam deploy; depois um `VALIDATE CONSTRAINT` em
--     migration futura após backfill.

-- ────────────────────────────────────────────────────────────────────────
-- Limpeza eventual de linhas pré-existentes com controles (paranoia).
-- Se houver, substituímos controles por espaço e colapsamos.
-- ────────────────────────────────────────────────────────────────────────

-- Obs.: `[[:cntrl:]]` é a POSIX character class que casa 0x00-0x1F + 0x7F
-- (exatamente nosso alvo). Funciona em todas as versões de Postgres que
-- suportamos, diferente de escapes `\u0000` que dependem de flags.
update public.customers
set name = regexp_replace(name, '[[:cntrl:]]+', ' ', 'g')
where name ~ '[[:cntrl:]]';

-- Colapsa espaços consecutivos e trima.
update public.customers
set name = btrim(regexp_replace(name, '\s+', ' ', 'g'))
where name ~ '\s{2,}' or name ~ '^\s' or name ~ '\s$';

-- Corta entries absurdas (se acontecer, vamos reinvestigar no log).
update public.customers
set name = substr(name, 1, 120)
where char_length(name) > 120;

-- ────────────────────────────────────────────────────────────────────────
-- Constraints defensivas.
-- ────────────────────────────────────────────────────────────────────────

alter table public.customers
  add constraint customers_name_len_chk
  check (char_length(name) between 1 and 120);

alter table public.customers
  add constraint customers_name_no_ctrl_chk
  check (name !~ '[[:cntrl:]]');

-- ────────────────────────────────────────────────────────────────────────
-- Nota de documentação
-- ────────────────────────────────────────────────────────────────────────

comment on constraint customers_name_len_chk on public.customers is
  'PR-037 · D-056 · teto defensivo (120 chars). Limite fino está no app (sanitizeShortText).';

comment on constraint customers_name_no_ctrl_chk on public.customers is
  'PR-037 · D-056 · rejeita controles ASCII. Nenhum nome legítimo os contém; são vetor de injection em WhatsApp/LLM.';
