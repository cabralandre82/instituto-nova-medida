-- ───────────────────────────────────────────────────────────────────────
-- Migration: 20260512000000_appointment_notifications_body_snapshot
-- Decisão arquitetural: D-075 (PR-067 · finding 17.7)
--
-- Contexto
-- ────────
-- A tabela `public.appointment_notifications` (migration 004/011) hoje
-- registra `kind` e `sent_at`, mas **não persiste o body textual** nem
-- o telefone de destino exato no momento do envio. Se o paciente
-- reclama ("não recebi essa mensagem", "a mensagem estava errada",
-- "recebi a mensagem no número X mas meu cadastro é Y"), o operador
-- solo não tem evidência forense — só sabe que o `kind='confirmacao'`
-- foi sent, não o texto efetivo que foi renderizado naquele momento.
--
-- Além disso:
--   - O body é composto em `src/lib/wa-templates.ts` substituindo vars
--     do template Meta. Se um bug de formatter gerar texto errado
--     (datetime pt_BR, nome capitalizado, URL com query param quebrado),
--     a evidência forense hoje é **o log do cron** — perdido após 180
--     dias pela política de retenção (D-059).
--   - O `customers.phone` é lido live no `dispatch()` e pode mudar
--     (paciente atualiza telefone via `/paciente/meus-dados` — PR-056).
--     Se queremos provar "pra qual número foi enviado naquele dia",
--     precisamos snapshot.
--
-- CFM 2.314/2022 (telemedicina) + CDC Art. 39 VIII (prova de
-- comunicação comercial recebida/não recebida) exigem trilha forense
-- desse conteúdo.
--
-- Solução
-- ────────
-- 1. Adicionar 3 colunas em `appointment_notifications`:
--      body          text                -- corpo final renderizado (pt_BR)
--      target_phone  text                -- telefone de destino (E.164)
--      rendered_at   timestamptz         -- quando o body foi composto
--
--    Todas nullable pra histórico (linhas existentes ficam null; ok).
--    Novas linhas gravam os valores ANTES do dispatch HTTP — se a Meta
--    falhar, a evidência do que seria enviado já está no banco.
--
-- 2. Trigger `enforce_notification_body_immutable_after_send`:
--    - Se `old.sent_at IS NOT NULL` (já enviado com sucesso), bloqueia
--      qualquer UPDATE que altere `body`, `target_phone` ou `rendered_at`.
--    - Se `old.sent_at IS NULL` (ainda não enviou), permite sobrescrita
--      — o worker pode re-renderizar em retry se os dados do paciente/
--      consulta mudaram entre tentativas.
--
--    Uma vez sent_at preenchido, é evidência jurídica: imutável.
--
-- 3. Índice parcial `idx_an_target_phone` pra lookup forense
--    "me mostra todas as mensagens enviadas pro número X nos últimos
--    90 dias" (resposta a WhatsApp-queixa de paciente).
--
-- 4. RLS existente (`an_admin_only`) já cobre: só role=admin enxerga.
--    Nenhuma policy nova necessária. Paciente/médica continuam sem
--    acesso direto (via SQL); só veem seus próprios eventos via UI.
--
-- Retenção
-- ────────
-- Não aplicamos política de purge aqui. `appointment_notifications` já
-- herda o delete em cascade quando `appointments.id` é removido, e
-- `appointments` em si é CFM-core (soft delete por PR-066 · D-074).
-- Um anexo futuro pode purgar `body`/`target_phone` após 180 dias
-- (mantendo o resto da linha), mas por ora o volume é pequeno
-- (~1 mensagem por consulta por paciente) e a auditoria exige retenção.
--
-- Rollback
-- ────────
-- DROP TRIGGER + ALTER TABLE DROP COLUMN. Todas colunas são nullable
-- sem FK, rollback é trivial.
-- ───────────────────────────────────────────────────────────────────────

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 1) Colunas novas                                                   │
-- └────────────────────────────────────────────────────────────────────┘

alter table public.appointment_notifications
  add column if not exists body         text,
  add column if not exists target_phone text,
  add column if not exists rendered_at  timestamptz;

comment on column public.appointment_notifications.body is
  'PR-067 · D-075 · corpo textual final renderizado (com variáveis substituídas, idioma pt_BR). Evidência forense CFM/CDC. Imutável após sent_at.';
comment on column public.appointment_notifications.target_phone is
  'PR-067 · D-075 · telefone de destino no momento do envio (E.164 ou só dígitos). Snapshot — preserva "pra qual número foi enviado" mesmo que paciente atualize depois. Imutável após sent_at.';
comment on column public.appointment_notifications.rendered_at is
  'PR-067 · D-075 · timestamp em que body/target_phone foram compostos. Útil pra correlacionar com logs do cron. Imutável após sent_at.';

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 2) Trigger: enforce_notification_body_immutable_after_send         │
-- │    Bloqueia alteração de body/target_phone/rendered_at uma vez     │
-- │    que sent_at foi preenchido. Permite reescrita enquanto não foi  │
-- │    enviado (retry pode re-renderizar).                             │
-- └────────────────────────────────────────────────────────────────────┘

create or replace function public.enforce_notification_body_immutable_after_send()
returns trigger
language plpgsql
as $$
begin
  -- Só age quando a linha já foi enviada (sent_at preenchido no OLD).
  -- Antes do envio, permitimos que o worker re-renderize o body em
  -- retry — dados da consulta/paciente podem ter mudado entre tentativas.
  if old.sent_at is not null then
    if new.body is distinct from old.body
       or new.target_phone is distinct from old.target_phone
       or new.rendered_at is distinct from old.rendered_at then
      raise exception 'PR-067 · D-075 · appointment_notifications.{body,target_phone,rendered_at} são imutáveis após sent_at. Linha id=%', old.id;
    end if;

    -- Regra defensiva: uma vez sent_at preenchido, não pode "desfazer"
    -- zerando de volta pra null. Mantemos a linha do tempo forense.
    if new.sent_at is null then
      raise exception 'PR-067 · D-075 · appointment_notifications.sent_at não pode ser zerado após envio. Linha id=%', old.id;
    end if;
  end if;

  return new;
end;
$$;

comment on function public.enforce_notification_body_immutable_after_send() is
  'PR-067 · D-075 · trigger BEFORE UPDATE em appointment_notifications que garante imutabilidade de body/target_phone/rendered_at/sent_at uma vez que sent_at foi preenchido. Antes do envio permite reescrita pra suportar retry com re-render.';

drop trigger if exists trg_an_body_immutable_after_send
  on public.appointment_notifications;
create trigger trg_an_body_immutable_after_send
  before update on public.appointment_notifications
  for each row execute function public.enforce_notification_body_immutable_after_send();

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 3) Índice parcial pra lookup forense por telefone                  │
-- │    Admin consulta "mensagens enviadas pro 5511XXXXX"; queries      │
-- │    ficam rápidas mesmo com volume.                                  │
-- └────────────────────────────────────────────────────────────────────┘

create index if not exists idx_an_target_phone_sent
  on public.appointment_notifications (target_phone, sent_at desc)
  where target_phone is not null and sent_at is not null;

comment on index public.idx_an_target_phone_sent is
  'PR-067 · D-075 · índice forense pra consulta admin "me mostra tudo que foi enviado pro número X, ordenado por mais recente".';
