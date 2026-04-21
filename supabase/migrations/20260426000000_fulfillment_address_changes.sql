-- ============================================================================
-- Migration · fulfillment_address_changes (D-045 · 3.E)
-- ============================================================================
-- Tabela de auditoria pra mudanças no endereço operacional de um
-- fulfillment. Cada edição (paciente via self-service ou admin pelo
-- painel) grava uma linha com snapshot before/after, quem editou,
-- quando, e canal (`patient` ou `admin`).
--
-- Motivação:
--   - LGPD / compliance: paciente pode mudar endereço; precisamos
--     saber quando e pra onde (em caso de entrega errada ou disputa).
--   - Operacional: admin ver no painel "este paciente editou endereço
--     2x essa semana — confirmar no WA antes de acionar farmácia".
--
-- Notas:
--   - `before_snapshot` é nullable porque a primeira edição pode não
--     ter snapshot prévio operacional (caso raro, mas possível se o
--     aceite não preencheu os campos `shipping_*`).
--   - `plan_acceptances.shipping_snapshot` é o snapshot IMUTÁVEL
--     firmado legalmente; esta tabela é o diário operacional
--     mutável. Nunca confundir.
-- ============================================================================

create table if not exists public.fulfillment_address_changes (
  id uuid primary key default gen_random_uuid(),
  fulfillment_id uuid not null
    references public.fulfillments(id) on delete cascade,
  changed_by_user_id uuid,
  changed_at timestamptz not null default now(),
  source text not null check (source in ('admin', 'patient')),
  before_snapshot jsonb,
  after_snapshot jsonb not null,
  note text
);

create index if not exists fulfillment_address_changes_fulfillment_idx
  on public.fulfillment_address_changes (fulfillment_id, changed_at desc);

comment on table public.fulfillment_address_changes is
  'Auditoria de edições do endereço operacional de um fulfillment. LGPD + rastreabilidade. D-045 · 3.E.';
comment on column public.fulfillment_address_changes.before_snapshot is
  'Snapshot shipping_* antes da mudança. NULL se não havia endereço prévio gravado.';
comment on column public.fulfillment_address_changes.after_snapshot is
  'Snapshot shipping_* depois da mudança. Sempre populado.';
comment on column public.fulfillment_address_changes.source is
  'Canal da edição: "patient" (self-service) ou "admin" (painel).';

do $$ begin
  raise notice 'fulfillment_address_changes criada com índice e comentários.';
end $$;
