-- ───────────────────────────────────────────────────────────────────────
-- Migration: 20260514000000_magic_link_issued_log
-- Decisão arquitetural: D-078 (PR-070 · finding 17.8)
--
-- Contexto
-- ────────
-- Magic-links são emitidos via Supabase Auth (`signInWithOtp`) em três
-- rotas da aplicação:
--
--   1. POST /api/auth/magic-link         → admin + médica
--   2. POST /api/paciente/auth/magic-link → paciente
--   3. GET  /api/auth/callback           → verificação do token
--
-- O Supabase **não expõe log aplicativo** dessas emissões fora do painel
-- dele (que só serve pra debug operacional da própria Supabase).
-- Consequência: quando um usuário reporta "não recebi o link":
--
--   - Sem rastro próprio: temos que perguntar a Supabase ou ficar no
--     achismo ("caixa de spam?", "digitou certo?").
--   - Sem trilha forense: não conseguimos provar se o link foi emitido,
--     pra qual email, qual IP disparou, qual foi o motivo (usuário não
--     existe? role inválido? rate-limit? provider errou?).
--   - Sem correlação ataque↔vítima: em abuso (enumeração de contas,
--     brute force de e-mails), não temos dados pra diferenciar atacante
--     de usuário legítimo.
--
-- Finding [17.8 🟡 MÉDIO] da auditoria captura isso.
--
-- Solução
-- ────────
--
-- Tabela imutável `magic_link_issued_log` com trilha LGPD-safe:
--
--   id            uuid pk
--   email_hash    text not null (SHA-256 hex de email.trim().toLowerCase()
--                 — determinístico pro admin reproduzir consulta dado um
--                 email, mas sem armazenar email plaintext em disco)
--   email_domain  text (ex: 'yahoo.com.br' — útil pra métrica de
--                 provedor sem PII direta; também em linhas 'unknown')
--   role          text ('admin'|'doctor'|'patient'|null) — role resolvida
--                 na emissão; null em silenced_no_account (sequer existe
--                 auth.user) ou verify_failed (não sabemos quem)
--   action        text not null check in (
--                   'issued',                  -- link emitido com sucesso
--                   'silenced_no_account',     -- email não cadastrado
--                   'silenced_no_role',        -- existe mas sem role autorizado
--                   'silenced_wrong_scope',    -- role específica tentou rota errada
--                   'silenced_no_customer',    -- paciente: não há customer com esse email
--                   'rate_limited',            -- IP bateu rate-limit
--                   'provider_error',          -- signInWithOtp retornou erro
--                   'auto_provisioned',        -- paciente: criou auth.user antes de enviar
--                   'verified',                -- token_hash validado no callback
--                   'verify_failed'            -- verifyOtp retornou erro
--                 )
--   reason        text — detalhe livre pros states 'silenced_*'/provider_error/verify_failed
--   route         text not null — rota que originou (ex: '/api/auth/magic-link')
--   ip            inet — origem da requisição (X-Forwarded-For, X-Real-IP)
--   user_agent    text — truncado 500
--   next_path     text — path destino pós-verify (ajuda correlacionar)
--   metadata      jsonb default '{}'::jsonb — extras (ex: { provider_code: 'email_send_rate_limit' })
--   issued_at     timestamptz default now()
--
-- Imutabilidade: trigger BEFORE UPDATE/DELETE bloqueia — audit trail
-- ancestral não admite edição. Bypass idem via GUC app.magic_link_log.
-- allow_mutation (apenas suporte em DB interativo, nunca em produção).
--
-- RLS: deny-by-default. service_role lê via `getSupabaseAdmin()`.
-- Páginas administrativas consomem via server-side.
--
-- Índices forenses:
--   - (email_hash, issued_at desc): "tudo que aconteceu com este email"
--   - (action, issued_at desc): "últimos rate_limited nas 24h"
--   - (ip, issued_at desc): "tentativas do IP X"
--   - (issued_at desc): rolagem temporal global
--
-- Retenção
-- ────────
-- Sem purga automática por enquanto. Volume esperado: ~5 linhas/dia em
-- produção estabilizada; mesmo em abuso com rate_limited, clampado em
-- ~100/hora. Em ~1 ano são ~2k linhas — nada crítico. Quando o volume
-- exigir, criar cron de purga pós-365d. Mantemos eterno por ora
-- (forensics LGPD/CFM).
-- ───────────────────────────────────────────────────────────────────────

-- 1) Tabela ────────────────────────────────────────────────────────────

create table if not exists public.magic_link_issued_log (
  id uuid primary key default gen_random_uuid(),
  email_hash text not null,
  email_domain text,
  role text,
  action text not null
    check (action in (
      'issued',
      'silenced_no_account',
      'silenced_no_role',
      'silenced_wrong_scope',
      'silenced_no_customer',
      'rate_limited',
      'provider_error',
      'auto_provisioned',
      'verified',
      'verify_failed'
    )),
  reason text,
  route text not null,
  ip inet,
  user_agent text,
  next_path text,
  metadata jsonb not null default '{}'::jsonb,
  issued_at timestamptz not null default now(),

  -- email_hash precisa ser SHA-256 hex (64 chars lowercase). Guard
  -- defensivo contra insert errado (app-side sempre passa hex correto
  -- via magic-link-log.ts::hashEmail).
  constraint magic_link_email_hash_format
    check (email_hash ~ '^[0-9a-f]{64}$'),

  -- user_agent razoavelmente truncado. App-side já limita em 500;
  -- aqui é rede de segurança contra caller que passe raw header.
  constraint magic_link_user_agent_len
    check (user_agent is null or char_length(user_agent) <= 500),

  -- email_domain limita em 253 (max FQDN). Proteção contra SQL inchado.
  constraint magic_link_email_domain_len
    check (email_domain is null or char_length(email_domain) <= 253),

  -- reason e route tamanhos defensivos.
  constraint magic_link_reason_len
    check (reason is null or char_length(reason) <= 500),
  constraint magic_link_route_len
    check (char_length(route) between 1 and 200)
);

-- 2) Índices forenses ────────────────────────────────────────────────

create index if not exists ix_magic_link_email_hash_issued
  on public.magic_link_issued_log (email_hash, issued_at desc);

create index if not exists ix_magic_link_action_issued
  on public.magic_link_issued_log (action, issued_at desc);

create index if not exists ix_magic_link_ip_issued
  on public.magic_link_issued_log (ip, issued_at desc)
  where ip is not null;

create index if not exists ix_magic_link_issued_at_desc
  on public.magic_link_issued_log (issued_at desc);

-- 3) Imutabilidade ───────────────────────────────────────────────────
--
-- Por padrão UPDATE/DELETE são bloqueados. DBA pode autorizar numa
-- transação via:
--
--   begin;
--     set local app.magic_link_log.allow_mutation = 'true';
--     update public.magic_link_issued_log set metadata = '{}'::jsonb
--       where id = '…';
--   commit;
--
-- Helper `app.magic_link_log_mutation_allowed()` lê a GUC `missing_ok`
-- pra não falhar quando a variável não tá setada (cenário default).

create or replace function public.magic_link_log_mutation_allowed()
returns boolean
language plpgsql
stable
as $$
declare
  raw text;
begin
  begin
    raw := current_setting('app.magic_link_log.allow_mutation', true);
  exception when others then
    return false;
  end;
  return coalesce(lower(raw), '') in ('true', 't', '1', 'yes', 'on');
end;
$$;

create or replace function public.prevent_magic_link_mutation()
returns trigger
language plpgsql
as $$
begin
  if public.magic_link_log_mutation_allowed() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'magic_link_issued_log é append-only (PR-070 · D-078). Bypass via SET LOCAL app.magic_link_log.allow_mutation = ''true''.';
end;
$$;

drop trigger if exists trg_prevent_magic_link_update on public.magic_link_issued_log;
create trigger trg_prevent_magic_link_update
  before update on public.magic_link_issued_log
  for each row execute function public.prevent_magic_link_mutation();

drop trigger if exists trg_prevent_magic_link_delete on public.magic_link_issued_log;
create trigger trg_prevent_magic_link_delete
  before delete on public.magic_link_issued_log
  for each row execute function public.prevent_magic_link_mutation();

-- 4) RLS deny-by-default ─────────────────────────────────────────────

alter table public.magic_link_issued_log enable row level security;
alter table public.magic_link_issued_log force row level security;

-- Nenhuma policy — nenhum acesso via RLS. service_role continua
-- acessando via bypass (padrão Supabase). Páginas admin leem via
-- `getSupabaseAdmin()` server-side.

-- 5) Comentários ───────────────────────────────────────────────────────

comment on table public.magic_link_issued_log is
  'PR-070 · D-078. Trilha forense de emissões e verificações de magic-link, imutável. Email guardado como SHA-256 hex (sem plaintext).';

comment on column public.magic_link_issued_log.email_hash is
  'SHA-256 hex (64 chars) de email.trim().toLowerCase(). Determinístico pra busca, LGPD-safe em disco.';

comment on column public.magic_link_issued_log.email_domain is
  'Domínio do email (ex: yahoo.com.br). Serve pra métricas de provedor. Não revela usuário específico.';

comment on column public.magic_link_issued_log.action is
  'issued, silenced_no_account, silenced_no_role, silenced_wrong_scope, silenced_no_customer, rate_limited, provider_error, auto_provisioned, verified, verify_failed.';
