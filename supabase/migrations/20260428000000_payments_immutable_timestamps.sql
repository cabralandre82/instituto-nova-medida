-- PR-013 · payments.paid_at e refunded_at são first-write-wins (audit [5.1]).
--
-- Contexto:
--   O webhook Asaas (src/app/api/asaas/webhook/route.ts) antes reescrevia
--   `paid_at` em TODO evento com status RECEIVED/CONFIRMED/RECEIVED_IN_CASH.
--   O Asaas frequentemente manda PAYMENT_CONFIRMED e, minutos depois,
--   PAYMENT_RECEIVED (cartão = confirma → compensação separada). Também
--   envia PAYMENT_UPDATED no mesmo status ao refazer fiscalizações internas.
--   Resultado: `paid_at` pulava no tempo — contabilidade inconsistente,
--   impossível gerar DRE por dia, relatório de caixa errado.
--
-- Solução (defense in depth):
--   1. Handler TS agora checa `existing.paid_at` antes do UPDATE e só
--      envia paid_at se for null.
--   2. Este trigger é a rede de segurança no Postgres: mesmo que outro
--      caller (admin via SQL direto, migration futura, script ad-hoc)
--      tente sobrescrever, o valor antigo é preservado silenciosamente.
--
-- Comportamento:
--   - Se OLD.paid_at IS NULL: aceita o novo valor sem restrição.
--   - Se OLD.paid_at IS NOT NULL e NEW.paid_at != OLD.paid_at: restaura
--     OLD (não erra, não bloqueia o UPDATE — isso manteria o webhook em
--     loop de retry do Asaas). Loga via RAISE NOTICE para aparecer no
--     log do Postgres sem ir pro cliente.
--   - Mesmo comportamento para refunded_at.
--
-- NÃO aplicamos a outras colunas de timestamp:
--   - `created_at`: imutável por convenção (default now()).
--   - `updated_at`: existe e DEVE mudar a cada update (é sua semântica).
--   - `due_date`, `estimatedCreditDate`: podem mudar legitimamente no
--     Asaas (reemissão de boleto, etc).

create or replace function public.enforce_payment_immutable_timestamps()
returns trigger
language plpgsql
as $$
begin
  if OLD.paid_at is not null
     and NEW.paid_at is distinct from OLD.paid_at then
    raise notice 'enforce_payment_immutable_timestamps: paid_at is first-write-wins; preserving old value (%) on payment %', OLD.paid_at, OLD.id;
    NEW.paid_at := OLD.paid_at;
  end if;

  if OLD.refunded_at is not null
     and NEW.refunded_at is distinct from OLD.refunded_at then
    raise notice 'enforce_payment_immutable_timestamps: refunded_at is first-write-wins; preserving old value (%) on payment %', OLD.refunded_at, OLD.id;
    NEW.refunded_at := OLD.refunded_at;
  end if;

  return NEW;
end;
$$;

comment on function public.enforce_payment_immutable_timestamps() is
  'PR-013 / audit [5.1]: garante que paid_at e refunded_at sejam first-write-wins. Eventos subsequentes do Asaas (retry, PAYMENT_UPDATED) não rebatem o timestamp contábil original.';

drop trigger if exists payments_immutable_timestamps on public.payments;
create trigger payments_immutable_timestamps
  before update on public.payments
  for each row
  execute function public.enforce_payment_immutable_timestamps();
