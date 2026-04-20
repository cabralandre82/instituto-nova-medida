-- ============================================================================
-- Migration · Endereço de entrega + snapshot imutável no aceite (D-044 · 2.C.1)
-- ============================================================================
-- A onda 2.A criou `fulfillments` e `plan_acceptances` com o esqueleto
-- operacional, mas não modelou o **endereço de entrega**. A onda 2.C
-- descobriu dois requisitos críticos:
--
--   1. O paciente do fluxo invertido pode nunca ter passado pelo
--      `/checkout` — logo, pode chegar à oferta sem endereço em
--      `customers`. A tela de aceite vai coletar o endereço com CEP
--      → ViaCEP → auto-completa (mesmo padrão já em uso em
--      `CheckoutForm.tsx`).
--
--   2. O endereço que vale para o despacho é o **do momento do
--      aceite**, não o que estiver em `customers` quando o operador
--      enviar. Se o paciente atualizar o endereço depois (ex.: mudou
--      de casa), o fulfillment em curso continua na rota original —
--      senão há risco operacional de despachar pra endereço errado
--      sem nova anuência.
--
-- Decisões de modelagem:
--
-- - **`fulfillments` ganha `shipping_*`**: snapshot do endereço de
--   despacho. Nullable enquanto `status='pending_acceptance'`, vira
--   obrigatório do `pending_payment` em diante. Essa regra é
--   aplicada pelo código (`fulfillment-acceptance.ts`) — não por
--   constraint SQL, porque um CHECK condicional em transições
--   complica sem ganho real (a transição é feita pelo backend, não
--   por operador editando direto).
--
-- - **`plan_acceptances.shipping_snapshot jsonb`**: o mesmo snapshot
--   duplicado aqui. Motivo: `plan_acceptances` é a **prova legal
--   imutável** (trigger bloqueia UPDATE/DELETE). Se o operador algum
--   dia precisar editar `fulfillments.shipping_*` por qualquer motivo
--   (improvável mas possível), o original aceito segue inviolável
--   aqui. O hash SHA-256 do aceite vai incluir esse snapshot —
--   adulteração é detectada comparando hash recomputado.
--
-- - **Clínica vs. farmácia**: o endereço é da **clínica** (operador)
--   na hora de postar o manipulado. A farmácia só recebe a receita
--   (Memed) e identificação mínima. A separação acontece na UI da
--   onda 2.E — o schema é o mesmo, a UI é quem filtra.
--
-- - **View `fulfillments_operational`**: agrega fulfillment +
--   customer + plan + doctor + appointment num único SELECT. É o
--   que a onda 2.E consome pra renderizar o painel do operador.
--   Mantemos a view aqui (em vez de na 2.E) porque ela serve também
--   pro paciente ver status do próprio tratamento na onda 2.F, e
--   centralizar o shape reduz drift entre telas.
-- ============================================================================

-- ──────────────────────────────────────────────────────────────────────────
-- 1. fulfillments: snapshot do endereço de despacho
-- ──────────────────────────────────────────────────────────────────────────

alter table public.fulfillments
  add column if not exists shipping_recipient_name text,
  add column if not exists shipping_zipcode        text,
  add column if not exists shipping_street         text,
  add column if not exists shipping_number         text,
  add column if not exists shipping_complement     text,
  add column if not exists shipping_district       text,
  add column if not exists shipping_city           text,
  add column if not exists shipping_state          char(2)
    check (shipping_state is null or shipping_state ~ '^[A-Z]{2}$');

comment on column public.fulfillments.shipping_recipient_name is
  'Nome do destinatário do despacho (default: paciente). Preenchido no aceite (D-044 · 2.C).';

comment on column public.fulfillments.shipping_zipcode is
  'CEP do endereço de despacho, só dígitos. Preenchido no aceite (D-044 · 2.C).';

create index if not exists idx_ff_shipping_city_state
  on public.fulfillments(shipping_state, shipping_city)
  where shipping_state is not null;

-- ──────────────────────────────────────────────────────────────────────────
-- 2. plan_acceptances: snapshot imutável do endereço aceito
-- ──────────────────────────────────────────────────────────────────────────
-- jsonb (em vez de N colunas) porque:
--   - o shape aqui é DERIVADO de `fulfillments.shipping_*`, e duplicar
--     colunas duplica manutenção sem ganho de query (essa tabela é
--     só leitura pra auditoria, nunca pra listagem filtrada);
--   - jsonb permite evoluir o snapshot (ex: adicionar lat/lng futuro)
--     sem migração.

alter table public.plan_acceptances
  add column if not exists shipping_snapshot jsonb;

comment on column public.plan_acceptances.shipping_snapshot is
  'Snapshot imutável do endereço no momento do aceite. Entra no acceptance_hash (D-044 · 2.C).';

-- ──────────────────────────────────────────────────────────────────────────
-- 3. View operacional (leitura apenas)
-- ──────────────────────────────────────────────────────────────────────────
-- Consumida pela onda 2.E (painel admin) e 2.F (card no /paciente).
-- SECURITY INVOKER por default — respeita RLS das tabelas-base.

create or replace view public.fulfillments_operational as
  select
    f.id                         as fulfillment_id,
    f.status                     as fulfillment_status,
    f.created_at                 as created_at,
    f.accepted_at                as accepted_at,
    f.paid_at                    as paid_at,
    f.pharmacy_requested_at      as pharmacy_requested_at,
    f.shipped_at                 as shipped_at,
    f.delivered_at               as delivered_at,
    f.cancelled_at               as cancelled_at,
    f.cancelled_reason           as cancelled_reason,
    f.tracking_note              as tracking_note,
    -- snapshot de entrega (campos nullable até o aceite)
    f.shipping_recipient_name    as shipping_recipient_name,
    f.shipping_zipcode           as shipping_zipcode,
    f.shipping_street            as shipping_street,
    f.shipping_number            as shipping_number,
    f.shipping_complement        as shipping_complement,
    f.shipping_district          as shipping_district,
    f.shipping_city              as shipping_city,
    f.shipping_state             as shipping_state,
    -- paciente (para contato e identificação)
    c.id                         as customer_id,
    c.name                       as customer_name,
    c.cpf                        as customer_cpf,
    c.email                      as customer_email,
    c.phone                      as customer_phone,
    -- plano
    pl.id                        as plan_id,
    pl.slug                      as plan_slug,
    pl.name                      as plan_name,
    pl.medication                as plan_medication,
    pl.cycle_days                as plan_cycle_days,
    pl.price_pix_cents           as plan_price_pix_cents,
    pl.price_cents               as plan_price_cents,
    -- médica (autora da prescrição)
    d.id                         as doctor_id,
    coalesce(d.display_name, d.full_name) as doctor_name,
    d.crm_number                 as doctor_crm_number,
    d.crm_uf                     as doctor_crm_uf,
    -- consulta e prescrição
    a.id                         as appointment_id,
    a.scheduled_at               as appointment_scheduled_at,
    a.finalized_at               as appointment_finalized_at,
    a.memed_prescription_url     as prescription_url,
    a.memed_prescription_id      as prescription_memed_id,
    -- cobrança (opcional, preenchido após aceite + criação de payment)
    p.id                         as payment_id,
    p.status                     as payment_status,
    p.amount_cents               as payment_amount_cents,
    p.invoice_url                as payment_invoice_url,
    p.paid_at                    as payment_paid_at
  from public.fulfillments f
  join public.customers     c  on c.id  = f.customer_id
  join public.plans         pl on pl.id = f.plan_id
  join public.doctors       d  on d.id  = f.doctor_id
  join public.appointments  a  on a.id  = f.appointment_id
  left join public.payments p  on p.id  = f.payment_id;

comment on view public.fulfillments_operational is
  'View consolidada pra painel admin (D-044 · 2.E) e área do paciente (2.F). Respeita RLS das tabelas-base.';

-- FIM
