-- PR-030 · Imutabilidade do prontuário médico (audit [10.1] · CFM 1.821/2007).
--
-- Contexto:
--   O prontuário médico é documento legalmente imutável. A Resolução CFM
--   1.821/2007 estabelece que uma vez finalizado, ele só pode receber
--   **adendos** (append-only com identificação de autor e timestamp),
--   nunca edições. Alteração do prontuário original pode configurar
--   falsificação documental (Código Penal Art. 299).
--
--   No `public.appointments`, os campos que constituem o prontuário são:
--     - `anamnese` (jsonb, formulário estruturado)
--     - `hipotese` (text, hipótese diagnóstica)
--     - `conduta` (text, conduta clínica / observações)
--     - `memed_prescription_id` / `memed_prescription_url` (receita digital)
--
--   O marco cronológico de finalização é `finalized_at`, gravado quando
--   a médica clica "Finalizar consulta" em `/medico/consultas/[id]/finalizar`
--   (ver src/lib/appointment-finalize.ts). Depois dessa gravação, nenhum
--   campo clínico deve mudar.
--
-- Comportamento (enforcement via trigger BEFORE UPDATE):
--   1. Campos clínicos são **editáveis livremente** enquanto `finalized_at`
--      for NULL (mesa de trabalho da médica, ela pode revisar antes de
--      publicar).
--   2. Uma vez `finalized_at` gravado, qualquer UPDATE que tente mudar
--      anamnese/hipotese/conduta/memed_prescription_* erra com mensagem
--      clara (diferente do webhook que prefere ignorar silenciosamente).
--   3. `finalized_at` é first-write-wins: uma vez gravado, imutável.
--   4. `memed_prescription_id` e `memed_prescription_url` são first-write-
--      wins independente de finalized_at — uma vez emitida a receita, ela
--      tem validade legal vinculada àquele ID/URL.
--
-- Por que errar em vez de ignorar (contraste com PR-013 que ignora):
--   PR-013 (paid_at) trata de **webhooks repetidos do Asaas** — aceitar
--   silenciosamente é o comportamento correto (o webhook ficaria em
--   retry-loop se 500-asse). Prontuário não tem webhook; quem edita é
--   ser humano ou automação administrativa. Erro explícito ajuda a
--   detectar bugs e tentativas indevidas.
--
-- Casos de correção legítima (fora do escopo deste PR):
--   Se a médica precisar corrigir um erro no prontuário depois de
--   finalizado, o método legítimo é criar um **adendo** (tabela separada
--   `appointment_amendments` — a ser criada em PR futuro). Por enquanto,
--   admin pode desfazer via SQL direto com rastro em log (PR-031).
--
-- Callers que mexem em appointments (verificado em 2026-04-20):
--   - src/lib/appointment-finalize.ts (grava finalized_at + clínicos em
--     uma transação; trigger aceita porque OLD.finalized_at IS NULL).
--   - src/lib/reconcile.ts, src/lib/no-show-policy.ts, Daily webhook,
--     Asaas webhook: mexem só em started_at/ended_at/status/flags
--     operacionais, não tocam campos clínicos. Compatíveis.

create or replace function public.enforce_appointment_medical_record_immutable()
returns trigger
language plpgsql
as $$
declare
  is_finalized boolean;
begin
  is_finalized := OLD.finalized_at is not null;

  -- Campos clínicos: imutáveis após finalized_at.
  if is_finalized then
    if NEW.anamnese is distinct from OLD.anamnese then
      raise exception using
        errcode = 'check_violation',
        message = format(
          'appointment prontuário imutável: anamnese não pode ser alterada após finalização (appointment %s, finalized_at %s)',
          OLD.id, OLD.finalized_at
        ),
        hint = 'Para correção, crie um adendo em tabela própria ou consulte o admin.';
    end if;

    if NEW.hipotese is distinct from OLD.hipotese then
      raise exception using
        errcode = 'check_violation',
        message = format(
          'appointment prontuário imutável: hipótese diagnóstica não pode ser alterada após finalização (appointment %s, finalized_at %s)',
          OLD.id, OLD.finalized_at
        ),
        hint = 'Para correção, crie um adendo em tabela própria ou consulte o admin.';
    end if;

    if NEW.conduta is distinct from OLD.conduta then
      raise exception using
        errcode = 'check_violation',
        message = format(
          'appointment prontuário imutável: conduta não pode ser alterada após finalização (appointment %s, finalized_at %s)',
          OLD.id, OLD.finalized_at
        ),
        hint = 'Para correção, crie um adendo em tabela própria ou consulte o admin.';
    end if;

    -- prescribed_plan_id também é parte da decisão clínica finalizada.
    if NEW.prescribed_plan_id is distinct from OLD.prescribed_plan_id then
      raise exception using
        errcode = 'check_violation',
        message = format(
          'appointment prontuário imutável: prescribed_plan_id não pode ser alterado após finalização (appointment %s)',
          OLD.id
        );
    end if;

    -- prescription_status idem — reflete a decisão (prescrito/declinado/nenhum).
    if NEW.prescription_status is distinct from OLD.prescription_status then
      raise exception using
        errcode = 'check_violation',
        message = format(
          'appointment prontuário imutável: prescription_status não pode ser alterado após finalização (appointment %s)',
          OLD.id
        );
    end if;
  end if;

  -- Memed prescription: first-write-wins independente de finalized_at.
  -- Uma vez emitida a receita digital, o ID/URL são documentais.
  if OLD.memed_prescription_id is not null
     and NEW.memed_prescription_id is distinct from OLD.memed_prescription_id then
    raise exception using
      errcode = 'check_violation',
      message = format(
        'appointment prontuário imutável: memed_prescription_id é first-write-wins (appointment %s, prescrição %s)',
        OLD.id, OLD.memed_prescription_id
      );
  end if;

  if OLD.memed_prescription_url is not null
     and NEW.memed_prescription_url is distinct from OLD.memed_prescription_url then
    raise exception using
      errcode = 'check_violation',
      message = format(
        'appointment prontuário imutável: memed_prescription_url é first-write-wins (appointment %s)',
        OLD.id
      );
  end if;

  -- finalized_at: first-write-wins (uma consulta não pode ser "re-finalizada").
  if OLD.finalized_at is not null
     and NEW.finalized_at is distinct from OLD.finalized_at then
    raise exception using
      errcode = 'check_violation',
      message = format(
        'appointment imutável: finalized_at é first-write-wins (appointment %s, finalized_at %s)',
        OLD.id, OLD.finalized_at
      );
  end if;

  return NEW;
end;
$$;

comment on function public.enforce_appointment_medical_record_immutable() is
  'PR-030 / audit [10.1]: garante imutabilidade do prontuário médico conforme CFM 1.821/2007. Campos clínicos (anamnese/hipotese/conduta/prescribed_plan_id/prescription_status) imutáveis após finalized_at. Memed prescription e finalized_at são first-write-wins.';

drop trigger if exists appointments_medical_record_immutable on public.appointments;
create trigger appointments_medical_record_immutable
  before update on public.appointments
  for each row
  execute function public.enforce_appointment_medical_record_immutable();
