-- ============================================================================
-- Migration · Área logada do paciente (D-043)
-- ============================================================================
-- Até agora, `customers` não tinha vínculo com `auth.users` — o paciente
-- só acessava /consulta via token HMAC no link do WhatsApp/e-mail. Pra
-- liberar a área logada /paciente, precisamos:
--
--   1. Vincular customer ↔ auth.user por email (fonte da verdade: email
--      do customer, que é validado no checkout e bate com o que o
--      paciente usa pra pedir o magic-link).
--
--   2. Backfill automático: pra cada customer cujo email já tem
--      auth.users existente (raro hoje, mas preparado pro futuro), faz
--      o match imediato.
--
--   3. Trigger on insert auth.users: se um auth.user é criado com email
--      que bate um customer sem user_id, vincula automaticamente.
--      Complementa o caminho inverso: API do magic-link cria auth.user
--      quando o paciente pede pela primeira vez e já vincula.
--
-- Observação sobre RLS: appointments / payments / customers continuam
-- sendo acessados via service_role no backend. O fencing de "paciente
-- só vê o que é dele" é feito no código (requirePatient → customerId
-- filtra as queries). Abrir RLS por paciente exige policies por tabela
-- e é escopo D-04x futuro.
-- ============================================================================

-- 1. Coluna de vínculo
alter table public.customers
  add column if not exists user_id uuid references auth.users(id) on delete set null;

-- Um customer tem no máximo 1 user_id; dois customers não podem
-- reivindicar o mesmo auth.user (evita bug de enumeração).
create unique index if not exists customers_user_id_unique_idx
  on public.customers(user_id)
  where user_id is not null;

create index if not exists customers_user_id_idx
  on public.customers(user_id);

comment on column public.customers.user_id is
  'Vínculo com auth.users (área logada /paciente). Preenchido no primeiro magic-link do paciente.';

-- 2. Backfill: pra cada customer cujo email já tem auth.user, vincula.
--    Idempotente (só atualiza quando user_id IS NULL e há match).
update public.customers c
   set user_id = u.id,
       updated_at = now()
  from auth.users u
 where c.user_id is null
   and u.email is not null
   and lower(u.email) = lower(c.email);

-- 3. Trigger: quando um auth.user novo é criado, tenta vincular a um
--    customer existente com o mesmo email (SECURITY DEFINER porque a
--    trigger roda no contexto do schema auth).
create or replace function public.link_customer_to_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if new.email is null then
    return new;
  end if;

  update public.customers
     set user_id = new.id,
         updated_at = now()
   where user_id is null
     and lower(email) = lower(new.email);

  return new;
end;
$$;

drop trigger if exists trg_link_customer_to_new_auth_user on auth.users;
create trigger trg_link_customer_to_new_auth_user
  after insert on auth.users
  for each row execute function public.link_customer_to_new_auth_user();

comment on function public.link_customer_to_new_auth_user is
  'Vincula customers.user_id quando auth.users é criado (D-043).';

-- FIM
