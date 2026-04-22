# Runbook · Operação solo · Instituto Nova Medida

> Checklist operacional do dia a dia pra quem administra a plataforma
> sozinho. Cada seção responde **"o que faço quando X acontece?"** em
> passos concretos, sem teoria.
>
> Documentos vizinhos:
>
> - [`RUNBOOK-E2E.md`](./RUNBOOK-E2E.md) — prova de fogo ponta-a-ponta
>   antes de release grande.
> - [`RUNBOOK-PRODUCTION-CHECKLIST.md`](./RUNBOOK-PRODUCTION-CHECKLIST.md)
>   — checklist de go-live: envs, crons, feature flags, bloqueantes
>   legais. Rodar antes de cada mudança de escopo (publicar, ligar
>   tráfego pago, rotacionar secrets).
> - [`SECRETS.md`](./SECRETS.md) — catálogo das envs.
>
> **Filosofia:** se você abrir `/admin` + `/admin/crons` + `/admin/errors`
> todo dia de manhã e seguir os indicadores daqui, o sistema opera
> sozinho em 95% dos dias. Os outros 5% têm runbook.

---

## Sumário

- [0 · Rotina diária (10 min)](#0--rotina-diária-10-min)
- [1 · Acionar farmácia (status `paid` → `pharmacy_requested`)](#1--acionar-farmácia-status-paid--pharmacy_requested)
- [2 · Despachar medicamento (status `pharmacy_requested` → `shipped`)](#2--despachar-medicamento-status-pharmacy_requested--shipped)
- [3 · Cancelar uma oferta (`pending_acceptance` ou `pending_payment`)](#3--cancelar-uma-oferta-pending_acceptance-ou-pending_payment)
- [4 · Processar estorno (refund)](#4--processar-estorno-refund)
- [5 · Pagar repasse de médica (payout)](#5--pagar-repasse-de-médica-payout)
- [6 · Paciente reclamou que não recebeu WhatsApp](#6--paciente-reclamou-que-não-recebeu-whatsapp)
- [7 · Paciente perdeu link de consulta](#7--paciente-perdeu-link-de-consulta)
- [8 · LGPD · paciente pediu os dados dele (portabilidade)](#8--lgpd--paciente-pediu-os-dados-dele-portabilidade)
- [9 · LGPD · paciente pediu exclusão (anonimização)](#9--lgpd--paciente-pediu-exclusão-anonimização)
- [10 · Cron falhou (alerta em `/admin/errors`)](#10--cron-falhou-alerta-em-adminerrors)
- [11 · Webhook Asaas com erro de processamento](#11--webhook-asaas-com-erro-de-processamento)
- [12 · Conciliação financeira com divergência](#12--conciliação-financeira-com-divergência)
- [13 · Médica pausada inesperadamente](#13--médica-pausada-inesperadamente)
- [14 · Incidente geral — `/admin/health` em error](#14--incidente-geral--adminhealth-em-error)
- [15 · Crédito de reagendamento do paciente (PR-073)](#15--crédito-de-reagendamento-do-paciente-pr-073)
- [16 · Paciente diz que não recebeu magic link (PR-070)](#16--paciente-diz-que-não-recebeu-magic-link-pr-070)
- [17 · Conferir texto exato de WA enviado (PR-067)](#17--conferir-texto-exato-de-wa-enviado-pr-067)
- [18 · Circuit breaker aberto (PR-050)](#18--circuit-breaker-aberto-pr-050)
- [19 · Soft delete de registro CFM (PR-066)](#19--soft-delete-de-registro-cfm-pr-066)
- [20 · Appointment `pending_payment` "fantasma" (PR-071)](#20--appointment-pending_payment-fantasma-pr-071)

---

## 0 · Rotina diária (10 min)

Toda manhã, abra nessa ordem:

1. **`/admin`** — inbox do operador. Lista ordenada por urgência:
   `reschedule_credit_pending` (2h SLA, paciente desassistido),
   `fulfillment_paid` (acionar farmácia, 24h), `fulfillment_pharmacy`
   (despachar, 5d), `offer_acceptance`/`offer_payment` (perseguir),
   `refund` (processar, 48h), `appointment_pending_payment_stale`
   (ghost D-044, 24h).
2. **`/admin/crons`** — sparklines dos 11 crons nos últimos 7 dias.
   Qualquer cron com `success_rate < 95%` ou `stuck_count > 0` vira
   investigação (seção 10). Note os chips `skipped` — são cron que
   pulou de propósito por circuit breaker aberto (seção 18), não
   falha.
3. **`/admin/errors`** (janela 24h) — qualquer coisa que falhou desde
   ontem. Se estiver vazio, siga. Se tiver entries em `source=cron`,
   cruze com `/admin/crons` via correlação temporal (D-077): o bloco
   "Último erro" de cada job mostra `± 15min: N Asaas · M envio WA`
   → clica em **ver correlação →** e chega em `/admin/errors?ts=…&w=15`.
4. **`/admin/health`** — status geral deve ser `ok` ou `warning`
   tolerável. `error` = seção 14 imediatamente.
5. **WhatsApp rollup diário** — se configurado (`ADMIN_DIGEST_PHONE`),
   já te avisou por WA às 08:30 BRT o que está pendente. Use como
   referência cruzada com o `/admin`.

Tempo médio: 10 min sem pendências, 30-60 min com.

---

## 1 · Acionar farmácia (status `paid` → `pharmacy_requested`)

**Quando:** card `fulfillment_paid` aparece em `/admin`. SLA: 24h.

**Passos:**

1. Abrir `/admin/fulfillments` → filtrar por status `paid`.
2. Clicar no fulfillment. Anotar:
   - Nome completo do paciente (campo `shipping_recipient_name`)
   - Endereço completo (`shipping_street`, `number`, etc)
   - Receita Memed (`memed_prescription_url`) — abre em nova aba,
     baixa o PDF.
   - Plano + medicação prescrita.
3. Na plataforma da farmácia de manipulação:
   - Fazer pedido usando **endereço da clínica como entrega**
     (a farmácia NÃO recebe o endereço do paciente — ela manda
     pra gente, a gente manda pro paciente).
   - Anexar o PDF da receita.
   - Anotar código do pedido na farmácia.
4. Voltar ao `/admin/fulfillments/[id]`, clicar **"Pedido feito à
   farmácia"**. No campo `tracking_note` colocar o código da farmácia.
5. Sistema transiciona pra `pharmacy_requested` e manda WA automático
   pro paciente: "seu medicamento foi solicitado".

**SLA próximo:** `pharmacy_requested` → `shipped` em 5 dias.

---

## 2 · Despachar medicamento (status `pharmacy_requested` → `shipped`)

**Quando:** farmácia entregou o kit na clínica. SLA: 5 dias desde o
pedido à farmácia.

**Passos:**

1. Receber o kit fisicamente. Conferir: receita bate, medicação bate,
   dosagem bate.
2. Gerar etiqueta do Correios / transportadora usando o endereço do
   paciente (pega direto na ficha `/admin/pacientes/[id]` ou
   `/admin/fulfillments/[id]`).
3. Despachar.
4. Em `/admin/fulfillments/[id]`, clicar **"Despachado"**. No campo
   `tracking_note` colocar o código de rastreio do Correios.
5. Sistema transiciona pra `shipped`. WA automático: "seu kit foi
   despachado, código Xx".

**SLA próximo:** cron `auto-deliver-fulfillments` (diário às 10:00
UTC / 07:00 BRT) transiciona automaticamente pra `delivered` após
14 dias do `shipped`. Se o paciente reclamar que não recebeu antes
disso, ver seção 6.

---

## 3 · Cancelar uma oferta (`pending_acceptance` ou `pending_payment`)

**Quando:**

- Paciente pediu cancelamento por WA antes de pagar;
- Oferta muito antiga (> 30 dias sem aceite), você decidiu abandonar;
- Médica errou a prescrição e precisa refazer.

**Passos:**

1. `/admin/fulfillments/[id]` → botão **"Cancelar oferta"**.
2. Preencher motivo curto (obrigatório p/ auditoria).
3. Confirmar. Sistema transiciona pra `cancelled`.
4. **Não há cobrança.** WA automático pro paciente: "indicação
   encerrada sem custo".

**Alternativa:** o próprio paciente pode cancelar em `/paciente`
enquanto a oferta estiver `pending_acceptance` / `pending_payment`.
Se ele cancelou, você não precisa fazer nada — só vai receber o WA
de confirmação na manhã seguinte (rollup).

**Após pagamento confirmado** (`paid`) cancelamento vira estorno —
seção 4.

---

## 4 · Processar estorno (refund)

**Quando:**

- Paciente pagou mas desistiu antes de você acionar a farmácia;
- Erro médico / duplicidade / fraude detectada.

**Atenção política:** após `pharmacy_requested`, NÃO há estorno. O
medicamento é manipulado personalizado — custo é do paciente. Isso
está no `acceptance_text` assinado.

**Passos:**

1. `/admin/refunds` → localizar o payment.
2. No painel Asaas:
   - Abrir o payment.
   - Reembolsar (total ou parcial).
3. Voltar ao `/admin/refunds/[id]` → clicar **"Marcar processado"**
   com nota do reembolso Asaas.
4. Sistema:
   - Marca `payments.refunded_at`.
   - Se houver fulfillment linkado, transiciona pra `cancelled` com
     `cancelled_reason = 'refund_processed'`.
   - Gera `doctor_earnings` de `refund_clawback` (estorna o ganho da
     médica).
   - WA pro paciente: "estorno processado".

**Cálculo de repasse:** cron diário `recalculate-earnings` (03:15 UTC)
reconcilia na próxima rodada. Se a médica já recebeu o ganho
original, o clawback será descontado do próximo payout
automaticamente. Pós-PR-051 · D-062, `generateMonthlyPayouts` faz
reconciliação bounded (até 3 iterações) captando clawbacks que cheguem
**durante** a janela de geração — se um clawback dominar e zerar o
payout, ele vira `cancelled` e as earnings negativas voltam pra
disponível aguardando o próximo ciclo.

**Estorno via Asaas API:** se a env `REFUNDS_VIA_ASAAS=true`
estiver ligada, `/admin/refunds` mostra botão "Estornar no Asaas"
que chama `POST /payments/{id}/refund` diretamente — não precisa
abrir o painel. Idempotente (webhook `PAYMENT_REFUNDED` chega depois
e não duplica clawback). Default é `false` (conservador); só
ligar após Cenário 4 do RUNBOOK-E2E passar em sandbox.

---

## 5 · Pagar repasse de médica (payout)

**Quando:** dia 5 do mês seguinte (cron `generate_monthly_payouts`
gera em `draft` no dia 1). Card `doctor_pending` em `/admin`.

**Passos:**

1. `/admin/payouts` → filtrar `draft` + `approved`.
2. Pra cada payout:
   - Revisar valor bruto + ajustes + clawbacks → valor líquido.
   - Conferir chave PIX da médica (não mudou?).
   - Se ok, clicar **"Aprovar"**. Status vira `approved`.
3. Fazer o PIX pelo banco.
4. Clicar **"Registrar PIX enviado"** no payout, anexar comprovante.
   Status vira `pix_sent`.
5. Confirmar com a médica que recebeu. Clicar **"Confirmar
   recebimento"**. Status vira `confirmed`.
6. A médica emite NF-e contra o CNPJ do Instituto e envia via
   `/medica/faturamento`. Cron `notify_pending_documents` cobra
   diariamente se ela atrasar.

Ordem estrita: `draft` → `approved` → `pix_sent` → `confirmed`. Nenhum
atalho.

**Warnings inesperados em `/admin/payouts/[id]` (pós-PR-051):**

- `clawback_reconciled` — veio um clawback durante a geração do
  payout. Valor reajustado; seguir normalmente.
- `clawback_dominant_cancelled` — clawback maior que earnings positivas.
  Payout foi marcado `cancelled`; nada pra pagar neste ciclo. Próximo
  cron vai regenerar quando houver earnings positivas.
- `reconcile_incomplete` — a reconciliação não convergiu em 3
  iterações (sistema sob carga alta). Aguardar próximo ciclo; se
  repetir, investigar.

---

## 6 · Paciente reclamou que não recebeu WhatsApp

**Passos:**

1. `/admin/pacientes/[id]` → timeline. Ver se aparece evento
   `notification_sent` próximo do horário esperado.
2. Se aparece mas paciente diz que não chegou:
   - Confirmar o número do telefone cadastrado. Mesmo com "+55"?
     Mesmo com DDD + 9?
   - Checar `/admin/errors?source=whatsapp_delivery` pra ver se a
     Meta marcou `failed` (janela 24h, bloqueio, número errado).
3. Se não aparece evento `notification_sent`:
   - Checar `/admin/errors?source=notification` pra ver se o envio
     falhou.
   - Causa comum: janela 24h fechada (Meta bloqueia texto livre
     após 24h sem resposta do paciente). Solução: enviar template
     HSM manualmente ou pedir pro paciente mandar "oi" pra abrir
     janela.

**Nunca dê confirmação por SMS.** WhatsApp é o canal. Se ele não
tem WA, registrar em nota da ficha e combinar telefonema.

---

## 7 · Paciente perdeu link de consulta

**Passos:**

1. `/admin/pacientes/[id]` → aba Consultas.
2. Localizar a consulta (deve estar `scheduled` ou `confirmed`).
3. Link do Daily: campo `daily_room_url` na consulta. Copiar.
4. Mandar por WA manualmente (ou abrir a consulta em
   `/admin/appointments/[id]` se existir a tela — senão SQL direto).

Se a consulta está `expired` (passou do horário), agendar nova no
fluxo normal (cron já marca expired após 30min).

---

## 8 · LGPD · paciente pediu os dados dele (portabilidade)

Direito previsto no Art. 18, V da LGPD.

**Passos:**

1. `/admin/pacientes/[id]` → rolar até o bloco **"LGPD · Art. 18"**.
2. Clicar **"Exportar dados (JSON)"**.
3. Navegador baixa `lgpd-export-[id]-YYYY-MM-DD.json`.
4. Enviar ao paciente por e-mail ou WA (verificar identidade antes:
   confirmar CPF + data de nascimento por WA).

O arquivo inclui `legal_notice` explicando que dados clínicos e
fiscais retidos por obrigação legal (CFM 20 anos para prontuário,
Receita 5 anos para fiscal) não podem ser excluídos ainda que
solicitada a eliminação completa. Isso cobre o Art. 16 da LGPD.

Prazo legal de resposta: 15 dias. Anotar em planilha externa a data
da solicitação pra garantir que cumpre.

---

## 9 · LGPD · paciente pediu exclusão (anonimização)

Direito previsto no Art. 18, VI da LGPD. **Irreversível.**

**Pré-condição:** paciente NÃO pode ter fulfillment em curso
(`paid` / `pharmacy_requested` / `shipped`). Se tem, conclua ou
cancele primeiro (seção 1, 2 ou 4). Se o paciente insistir, pode
forçar mas é caso excepcional — peça por escrito que ele aceita
perder o tratamento.

**Passos:**

1. Verificar identidade do solicitante (CPF + nascimento por WA).
2. `/admin/pacientes/[id]` → bloco **"LGPD · Art. 18"** → clicar
   **"Anonimizar…"**.
3. Ler o aviso: nome, e-mail, telefone, CPF e endereço serão
   substituídos por placeholders. Fiscal e clínico permanecem.
4. Digitar literalmente **"anonimizar"** no campo de confirmação.
5. Se houver tratamento em curso, marcar "Forçar…" só se o paciente
   concordou.
6. Clicar **"Confirmar anonimização"**.
7. Após sucesso:
   - Ficha mostra badge "anonimizado".
   - Nome vira "Paciente anonimizado #abc12345".
   - CPF, e-mail, telefone = placeholders.
   - Endereço = null.
8. **Revogar sessão do Supabase Auth (se paciente tinha login):**
   - Ir no Supabase Studio → Authentication → Users.
   - Buscar pelo `user_id` que está na ficha antes da anonimização
     (copie antes).
   - "Delete user" ou "Ban user" (banir preserva FKs).

Prazo legal de conclusão: 15 dias. O timestamp `anonymized_at` fica
registrado pra auditoria.

---

## 10 · Cron falhou (alerta em `/admin/errors`)

**Passos:**

1. `/admin/errors?source=cron` → localizar a entrada.
2. Copiar o `reference` (formato `cron_runs:abc-def-123`).
3. Checar qual cron é pela coluna `job`:

| Cron (slug) | Schedule (UTC) | BRT aprox. | Impacto se falha |
| --- | --- | --- | --- |
| `expire-reservations` | `* * * * *` | a cada min | Reserva de horário fica lockada além dos 15min; paciente não consegue retomar |
| `wa-reminders` | `* * * * *` | a cada min | `appointment_notifications` `pending` não vira `sent`; paciente não recebe WA |
| `daily-reconcile` | `*/5 * * * *` | a cada 5min | Sala encerrada sem marcar appointment `completed`; no-show D-032 não aplica → sem clawback/refund |
| `recalculate-earnings` | `15 3 * * *` | 00:15 | Earnings ficam `pending` além do hold; `/medico/ganhos` não reflete saldo disponível |
| `generate-payouts` | `15 9 1 * *` | 06:15 dia 1 | Payout mensal da médica não é criado — ela não recebe até você rodar manualmente |
| `notify-pending-documents` | `0 9 * * *` | 06:00 | Médicas não são cobradas pela NF-e atrasada |
| `auto-deliver-fulfillments` | `0 10 * * *` | 07:00 | Fulfillments ficam em `shipped` pra sempre |
| `nudge-reconsulta` | `0 11 * * *` | 08:00 | Pacientes não recebem lembrete pra reconsultar (20d antes do fim do plano) |
| `admin-digest` | `30 11 * * *` | 08:30 | Você não recebe resumo por WA (mas pode abrir `/admin` mesmo assim) |
| `retention-anonymize` | `0 4 * * 0` | 01:00 dom | Backlog LGPD (Art. 16) cresce — customers "ghost" não anonimizados |
| `asaas-events-purge` | `0 5 * * 0` | 02:00 dom | `asaas_events.payload` com PII não é purgado pós-180d |
| `expire-appointment-credits` | `0 12 * * *` | 09:00 | `appointment_credits.status='active'` com `expires_at` no passado não vira `expired` fisicamente — UI segue honesta (compute-on-read), mas relatórios SQL raw ficam menos limpos |

4. Ler `error_message` na UI. Causas comuns:
   - `timeout` → banco sob carga. Rodar novamente manualmente
     (veja próximo passo).
   - `constraint violation` → dado inconsistente. Investigar antes
     de rodar.
   - `status='skipped'` (não é falha) → cron pulou por circuit
     breaker aberto (seção 18). Provedor externo indisponível; ação:
     investigar provedor, não o cron.
5. Rodar manualmente (se seguro — Vercel aceita tanto GET quanto POST
   nos endpoints internos):
   ```bash
   curl -H "x-cron-secret: $CRON_SECRET" \
     https://app.institutonovamedida.com.br/api/internal/cron/<slug>
   ```
   Slugs disponíveis (bate 1:1 com a coluna da tabela acima):
   `expire-reservations`, `wa-reminders`, `daily-reconcile`,
   `recalculate-earnings`, `generate-payouts`,
   `notify-pending-documents`, `auto-deliver-fulfillments`,
   `nudge-reconsulta`, `admin-digest`, `retention-anonymize`,
   `asaas-events-purge`, `expire-appointment-credits`.

   Crons de retenção e de sweep aceitam flags:
   ```bash
   # Dry-run (não muta, só reporta):
   curl -H "x-cron-secret: $CRON_SECRET" \
     "https://.../api/internal/cron/retention-anonymize?dryRun=1"

   # Threshold custom em dias:
   curl -H "x-cron-secret: $CRON_SECRET" \
     "https://.../api/internal/cron/asaas-events-purge?thresholdDays=365"

   # Sweep de créditos com batch menor:
   curl -H "x-cron-secret: $CRON_SECRET" \
     "https://.../api/internal/cron/expire-appointment-credits?limit=100"
   ```
6. Conferir novo run em `/admin/crons` (bloco do job específico →
   sparkline + últimos 20 runs).

Se o cron falha **3 dias seguidos** pela mesma causa, abrir issue
(trello/github) pra tratar como bug. Não espere o quarto dia.

**Logs adicionais (JSON estruturado pós-D-057):**

- No Vercel Logs (Functions → Filter → `/api/internal/cron/<slug>`),
  cada execução emite uma linha JSON com `{ts, level, msg, context}`.
- Campos úteis: `context.route`, `context.run_id` (correlaciona com a
  linha em `cron_runs`), `context.duration_ms`, contadores por ação.
- Erros vêm em `level: "error"` com `err.name`/`err.message` já
  redigidos de PII (CPF/CEP/email/phone → `[REDACTED]`).
- Para correlacionar com o banco: copie `run_id` do log e rode
  `SELECT * FROM cron_runs WHERE id = '<run_id>';` no SQL Editor.

---

## 11 · Webhook Asaas com erro de processamento

**Sintoma:** entrada em `/admin/errors?source=asaas_webhook`.

**Passos:**

1. Copiar `asaas_payment_id` da entry.
2. No painel Asaas, abrir o payment e conferir status real.
3. Se status é `RECEIVED` / `CONFIRMED`:
   - Checar se o payment_id existe na nossa base (SQL direto em
     `payments` por `asaas_payment_id`).
   - Se existe mas ficou em `pending`, atualize manualmente ou
     acione conciliação (`/admin/financeiro/conciliacao`).
4. Se status é `REFUNDED`:
   - Ver seção 4, refaça o fluxo de marcar estorno.
5. Se for webhook desconhecido (`event_type` estranho):
   - Provavelmente Asaas mudou API. Checar docs deles, abrir issue.

Webhook é replayable — se o Asaas reenviar, o processamento será
tentado de novo. O campo `processing_error` fica preenchido até
próximo reenvio bem-sucedido.

**Logs estruturados do webhook (pós-D-057):** cada request emite
linhas JSON no Vercel Logs com `context.route = "/api/asaas/webhook"`
e chaves por entity: `asaas_payment_id`, `event`, `fulfillment_id`,
`appointment_id`, `payment_id`. Use a filter bar do Vercel pra
correlacionar: filtrar por `asaas_payment_id` mostra tudo que rolou
pra aquele payment (update, earning, fulfillment promovido, WA).

---

## 12 · Conciliação financeira com divergência

**Sintoma:** card `finance_critical` ou `finance_warning` em
`/admin` ou em `/admin/financeiro/conciliacao`.

**Passos:**

1. Abrir `/admin/financeiro/conciliacao`.
2. Cada linha mostra: `payment_id`, valor esperado, valor
   encontrado, tipo da divergência (missing, amount_mismatch,
   status_mismatch, orphan).
3. Casos:
   - **missing:** `payments` diz pago, `doctor_earnings` não tem
     linha. Rodar cron `recalculate-earnings` manualmente (seção 10).
   - **amount_mismatch:** earnings somam diferente do payment.
     Geralmente é clawback mal-registrado. Investigar `doctor_earnings`
     por `parent_earning_id` null/errado.
   - **orphan:** existe earning sem payment correspondente. Pode ser
     legítimo (ajuste manual) ou bug. Checar `earnings.kind`.

Se a divergência **crítica** persistir > 48h, pausar pagamentos
(`/admin/payouts` → não aprovar) até resolver.

---

## 13 · Médica pausada inesperadamente

**Sintoma:** card `reliability_paused` em `/admin`.

**Passos:**

1. `/admin/reliability` → ver detalhe da médica.
2. Causa: geralmente 3+ no-shows consecutivos (hard block) ou
   métrica de confiabilidade < 60%.
3. Ligar pra médica, entender o que aconteceu:
   - Problema pessoal/saúde → despausar manualmente com nota em
     `/admin/reliability/[doctorId]`.
   - Problema crônico → conversa difícil, decidir se mantém no
     catálogo.
4. Após despausar, métrica de confiabilidade volta a contar; se ela
   tiver outro no-show logo em seguida, pausa de novo.

---

## 14 · Incidente geral — `/admin/health` em error

**Quando:** status geral vermelho em `/admin/health`.

**Passos:**

1. Identificar qual check está em error.
2. Ações por check:

| Check | Ação |
| --- | --- |
| `database` | Checar status Supabase ([status.supabase.com](https://status.supabase.com)). Se Supabase ok, restart da função Vercel. |
| `asaas_env` | Checar `ASAAS_API_KEY` no Vercel env. Se foi rotacionada, atualizar. |
| `asaas_webhook` | Asaas parou de enviar? Checar painel Asaas → Webhooks → status. |
| `daily_env` | Idem Asaas, chave `DAILY_API_KEY`. |
| `whatsapp_env` | Token Meta expirou? São long-lived mas Meta pode revogar. Rotar em developers.facebook.com. |
| `reconciliation` | Seção 12. |
| `reliability` | Alguma médica em estado inesperado. Seção 13. |
| `cron_*` | Seção 10. |

3. Se múltiplos checks estão em error ao mesmo tempo, provavelmente
   é DB ou deploy quebrado. Reverter deploy no Vercel se necessário.
4. **Comunicar pacientes** se o incidente bloqueia agendamento /
   consulta por > 30min. Mandar WA genérico por template HSM (se
   ainda consegue) ou e-mail em lote.

Registrar o incidente em planilha com: início, causa, fim, impacto
(#consultas afetadas, R$ em risco).

---

## 15 · Crédito de reagendamento do paciente (PR-073)

**Contexto:** quando a médica dá no-show (`no_show_doctor`) ou a sala
expira vazia (`cancelled_by_admin_expired`), `applyNoShowPolicy`
emite automaticamente um `appointment_credits` pro paciente. É o
direito do paciente à reconsulta gratuita — aparece como banner
grande no `/paciente`.

**Quando:** card `reschedule_credit_pending` em `/admin`. **SLA: 2h.**
É o SLA mais curto da plataforma porque cada hora parado é paciente
desassistido + risco de reclamação regulatória.

**Passos:**

1. Abrir `/admin/credits` (o card `reschedule_credit_pending` linka pra
   cá direto desde D-083). A seção "Ativos" mostra o paciente, telefone,
   consulta de origem, dias restantes e UUID do crédito.
2. **Escolher uma data/hora** com a médica — seja com a mesma ou
   outra — e criar um novo `appointment` (`scheduled`, sem cobrança).
3. Avisar o paciente por WA (ele já viu o banner "Sua próxima
   consulta é por nossa conta" e clicou no CTA pré-preenchido).
4. Marcar o crédito como consumido via UI: clicar **"Marcar como
   consumido"** no card do crédito, colar o UUID do novo appointment
   e confirmar. O `/admin/credits` faz `POST /api/admin/credits/[id]/consume`,
   que chama `markCreditConsumed()` em `src/lib/appointment-credits.ts`
   (idempotente via guard `status='active'`, audita em `admin_audit_log`
   como `appointment_credit.consumed`).

   **Fallback via SQL editor** (se a UI estiver indisponível):

   ```sql
   update public.appointment_credits
   set status = 'consumed',
       consumed_at = now(),
       consumed_appointment_id = '<uuid-do-novo-appointment>',
       consumed_by = '<uuid-do-admin-user>',
       consumed_by_email = 'cabralandre@yahoo.com.br'
   where id = '<uuid-do-credit>'
     and status = 'active';
   ```

   O CHECK `appointment_credits_consumed_coherent_chk` exige os 3
   campos `consumed_*` juntos. Para obter o UUID do admin:
   `select id from auth.users where email = 'cabralandre@yahoo.com.br'`.

5. Conferir: o crédito sai da seção "Ativos" e aparece em "Histórico"
   como `consumed`; card `reschedule_credit_pending` some do `/admin`.

**Invariantes (D-081):**

- Créditos são **imutáveis** em `customer_id/source_appointment_id/source_reason/created_at/expires_at`
  (trigger `prevent_appointment_credits_source_mutation`).
- Consumo de crédito **não** devolve refund — são ortogonais. Se o
  paciente pagou e médica faltou, ele recebe refund **e** ganha o
  crédito.
- Expiração: 90 dias após emissão (`CREDIT_EXPIRY_DAYS`). `computeCurrentStatus`
  devolve `expired` on-read; o cron `expire_appointment_credits`
  (D-083, 12:00 UTC) materializa isso no DB diariamente. Créditos
  `active+expirado` aparecem com badge terracotta "sweep pendente"
  em `/admin/credits` até o próximo run.
- Idempotência estrutural: tentar emitir crédito pro mesmo `source_appointment_id`
  duas vezes faz o segundo virar `alreadyExisted=true` (UNIQUE partial
  `ux_appointment_credits_source_active`).

**Casos excepcionais:**

- **Paciente não quer reagendar** (quer desistir): em `/admin/credits`,
  clicar **"Cancelar crédito"** no card, escrever a razão (4..500 chars,
  ex: "Paciente optou por não reagendar (WA YYYY-MM-DD)") e confirmar.
  Via API: `POST /api/admin/credits/[id]/cancel` com body `{ reason }`
  usando `cancelCredit()` da lib. Terminal — não pode voltar a ativar.

  **Fallback via SQL editor** (se a UI estiver indisponível):
  ```sql
  update appointment_credits
  set status = 'cancelled',
      cancelled_at = now(),
      cancelled_reason = 'Paciente optou por não reagendar (WA YYYY-MM-DD)',
      cancelled_by = auth.uid(),
      cancelled_by_email = 'cabralandre@yahoo.com.br'
  where id = '<uuid>' and status = 'active';
  ```
  `cancelled_reason` é obrigatório ≥4 chars (CHECK constraint).

---

## 16 · Paciente diz que não recebeu magic link (PR-070 / PR-070-B)

**Contexto:** D-078 instalou trilha forense em `magic_link_issued_log`.
Toda emissão + verificação de magic-link é logada com email **hasheado**
(SHA-256 LGPD-safe), IP, UA, route e `action` taxonômica.

**Caminho primário — UI `/admin/magic-links` (D-084):**

1. Pedir o email exato do paciente por WA.
2. Abrir `/admin/magic-links`.
3. No filtro **Email**, colar o endereço plaintext. O servidor calcula
   o SHA-256 antes da query — email plaintext **nunca** é armazenado
   nem logado como query literal.
4. Opcional: restringir com **Action**, **Role**, **IP** ou data.
5. Ler a coluna **Action** na linha mais recente + o campo `reason`
   (quando há erro), cruzando com a tabela abaixo.

O topo da página já mostra 4 cards com contagens das **últimas 24h**
(total, emitidos, verificados, incidentes) — independentes dos filtros.
Se "incidentes" passa de 0 sem motivo óbvio, investigar spike
(enumeração em curso, SMTP quebrado, etc).

**Fallback — SQL Editor no Supabase Studio:**

Se a UI estiver indisponível ou se precisar de query mais complexa:

```sql
-- cria o hash exato como a lib faz (normaliza: trim + lower)
with probe as (
  select encode(
    digest(lower(trim('alice@yahoo.com.br')), 'sha256'),
    'hex'
  ) as h
)
select
  action,
  reason,
  role,
  route,
  issued_at,
  ip,
  metadata
from magic_link_issued_log, probe
where email_hash = probe.h
order by issued_at desc
limit 20;
```

**Interpretação do `action`:**

| `action` | Significado | Ação |
|---|---|---|
| `issued` | Supabase confirmou envio pro SMTP | Checar caixa de spam; se não está lá, Supabase SMTP entregou mas destinatário filtrou. |
| `silenced_no_account` | Email não tem conta em `auth.users` | Paciente nunca se cadastrou / digitou errado. Se é patient real, criar conta (seção 5.1 do RUNBOOK-PRODUCTION-CHECKLIST). |
| `silenced_no_customer` | `auth.users` existe mas `customers.user_id` não bate | Bug ou estado antigo. Consertar manualmente `customers.user_id`. |
| `silenced_no_role` | Tentou logar admin/médica num endpoint do paciente, ou vice-versa | Use a URL certa (`/admin/login`, `/medico/login`, `/paciente/login`). |
| `silenced_wrong_scope` | Admin/doctor tentou logar como paciente | Mesma coisa. |
| `rate_limited` | Muitas tentativas do mesmo IP | Aguardar; ou se é o admin, SSH pra `PATIENT_TOKEN_SECRET` bypass (não existe — esperar cooldown). |
| `provider_error` | Falhou `signInWithOtp` ou `listUsers` | Supabase Auth fora do ar ou sandbox limit. Ver `reason`. |
| `auto_provisioned` | Novo auth.user criado on-the-fly pra paciente com customer mas sem user_id | Sucesso normal do fluxo magic-link. |
| `verified` | Paciente clicou no link e trocou por sessão | Bem-sucedido — se reclamou mesmo assim, é problema no device dele, não na plataforma. |
| `verify_failed` | Paciente clicou em link expirado / inválido | Link tem validade curta; pedir novo. |

**Se `action=issued` mas paciente reclama:**

- Checar `/admin/errors?source=whatsapp_delivery` — às vezes
  confundem "email" com "WhatsApp".
- Checar caixa de spam do provedor dele (Yahoo/Gmail agressivo
  com SMTP novo).
- Reenviar (paciente mesmo pede em `/paciente/login`; admin **não** deve
  reemitir pelo Studio — viola o modelo mental de magic-link).

**Bypass último recurso (admin só):** você pode criar sessão
pelo Supabase Studio → Authentication → Users → ação "Send magic
link" (usa SMTP Supabase direto, fora do fluxo da plataforma).

---

## 17 · Conferir texto exato de WA enviado (PR-067)

**Contexto:** D-075 instalou snapshot do body + telefone em
`appointment_notifications.body/target_phone/rendered_at`. Coluna é
**imutável** após `sent_at` preenchido (trigger `trg_an_body_immutable_after_send`)
— serve como evidência jurídica CFM 2.314/2022 + CDC Art. 39 VIII.

**Quando:**

- Paciente diz "recebi mensagem diferente do que estou vendo no painel".
- Médica diz "o aviso de consulta saiu errado pro meu paciente".
- Auditoria externa pedir "prove que o paciente foi avisado".

**Via UI:** `/admin/notifications` tem coluna **Conteúdo** com
telefone mascarado + `<details>` colapsável do body (não expõe PII em
massa na listagem; expande caso-a-caso).

**Via SQL (pra filtros complexos):**

```sql
-- tudo que foi enviado pro número X, mais recente primeiro
select
  id,
  appointment_id,
  kind,
  target_phone,       -- gravado no momento do render
  sent_at,
  body                -- exato, imutável pós-sent_at
from appointment_notifications
where target_phone = '5511999998888'
  and sent_at is not null
order by sent_at desc
limit 20;

-- tudo que foi enviado pra um appointment específico
select kind, target_phone, rendered_at, sent_at, status, body
from appointment_notifications
where appointment_id = '<uuid>'
order by coalesce(sent_at, rendered_at, created_at) desc;
```

**Interpretação de `target_phone`:**

- Vem **sempre** preenchido em rows pós-PR-067.
- Rows legadas (pré-migration `20260512000000`) têm `target_phone=null` —
  normal, não é bug.
- Máscara de display do admin: `maskPhoneForAdmin(phone, { visible: 4 })`
  em `src/lib/appointment-notifications.ts` mostra DDI+DDD +
  últimos 4. Pra ver completo no SQL é só selecionar a coluna.

---

## 18 · Circuit breaker aberto (PR-050)

**Contexto:** D-061 instalou circuit breaker in-memory (3 estados
clássicos) em `asaas.ts::request`, `whatsapp.ts::postToGraph`,
`video.ts::dailyRequest`, `cep.ts::fetchViaCep`. Rolling window 60s,
threshold 50%, minThroughput 5, cooldown 30s. Provider em falha vira
`OPEN` → requisições respondem rápido com erro; depois do cooldown
entra em `HALF_OPEN` e a próxima tenta validar; sucesso fecha, falha
reabre.

**Sintomas de breaker aberto:**

- `/admin/health` mostra check `circuit_breaker_<provider>` em
  warning/error.
- `/admin/crons` mostra chip **`skipped`** em jobs WA-dependentes
  (`admin-digest`, `nudge-reconsulta`, `notify-pending-documents`).
  Skip é **intencional** (fail-fast), não falha.
- Checkout/agendar retornam erro mais rápido do que o normal.

**Passos:**

1. **Identificar o provider:** olhar qual check em `/admin/health`
   disparou. Valores: `circuit_breaker_asaas`, `_whatsapp`,
   `_daily`, `_cep`.
2. **Confirmar que é o provider, não nós:**
   - Asaas: abrir `https://status.asaas.com`.
   - Meta/WhatsApp: `https://metastatus.com` → Messaging & WhatsApp Business.
   - Daily.co: `https://status.daily.co`.
   - ViaCEP: `curl https://viacep.com.br/ws/01310100/json/`.
3. **Se provider está fora:** aguardar. Breaker vai abrir e permitir
   1 probe a cada 30s. Quando provider voltar, o primeiro probe
   bem-sucedido fecha o breaker automaticamente.
4. **Se provider está OK mas breaker ainda aberto:** indica que nosso
   request é que está errado (4xx). 4xx não abre breaker, mas 5xx
   sim — provavelmente estamos mandando payload inválido. Ver
   `/admin/errors?source=<provider>` e investigar.

**Forçar reset manual** (só em emergência real; o fluxo normal
é deixar o HALF_OPEN probe resolver):

- Breaker é **in-memory por instance da função Vercel**. Redeploy
  (Vercel → Deployments → Redeploy) reseta todos os estados.
- Se múltiplas instâncias de Function estão rodando, o redeploy é
  o único reset global.

**Logs:** transições de estado são logadas como `circuit.opened`,
`circuit.half_open`, `circuit.closed` no logger canônico com `provider`
no contexto. Filtrar no Vercel Logs:

```
level:"info" mod:"circuit-breaker" msg:"circuit.opened"
```

---

## 19 · Soft delete de registro CFM (PR-066)

**Contexto:** D-074 instalou soft delete nas 4 tabelas CFM-core:
`appointments`, `fulfillments`, `doctor_earnings`, `doctor_payouts`.
Trigger `prevent_hard_delete_<table>` BEFORE DELETE bloqueia qualquer
`DELETE` bruto nelas — proteção contra SQL manual descuidado,
`TRUNCATE` em migration, cron buggy. Retenção CFM 1.821/2007 exige
prontuário por 20 anos.

**Quando fazer soft delete:**

- Registro claramente errado que não dá pra corrigir por `UPDATE`
  (ex.: appointment criado com `doctor_id` da médica errada).
- Duplicata detectada pós-fato.
- Decisão administrativa explícita e documentada.

**Nunca fazer:**

- "Limpar" dados de teste em produção — isso é sinal de dados de
  teste em produção, que é o bug. Use staging/sandbox.
- Apagar registro real de paciente real só pra "deixar a tela
  limpa". Isso é prontuário, é violação CFM direta.

**Via código (preferido):**

```typescript
import { softDelete } from "@/lib/soft-delete";

await softDelete(supabase, {
  table: "appointments",
  id: "<uuid>",
  reason: "Duplicata de <outro-uuid> criada por bug X em YYYY-MM-DD",
  actor: { kind: "admin", userId: user.id, email: user.email },
});
```

- `reason` é obrigatório, mínimo 4 chars úteis após trim (CHECK
  constraint + validação TS). Seja descritivo; isso fica em
  `deleted_reason` pra sempre.
- Idempotente: se já estava deletado, devolve `alreadyDeleted: true`
  sem lançar.

**Via SQL (emergência):**

```sql
update appointments
set deleted_at = now(),
    deleted_by = auth.uid(),
    deleted_by_email = 'cabralandre@yahoo.com.br',
    deleted_reason = 'Duplicata de <uuid> (bug X em YYYY-MM-DD)'
where id = '<uuid>' and deleted_at is null;
```

**Hard delete (último recurso):**

```sql
begin;
set local app.soft_delete.allow_hard_delete = 'true';
delete from <table> where id = '<uuid>';
commit;
```

Use só quando soft delete não serve (ex.: LGPD Art. 18 VI de
paciente **sem** vínculo assistencial). Pra paciente com vínculo, a
retenção CFM 20 anos prevalece sobre o direito de eliminação LGPD
(Art. 16 I) e isso está documentado no `legal_notice` do export LGPD.

**Índices parciais:** listagens normais já filtram `deleted_at IS NULL`
automaticamente quando o call-site usa helpers da lib; se for query
direta no SQL editor, lembrar de adicionar `where deleted_at is null`
explicitamente.

---

## 20 · Appointment `pending_payment` "fantasma" (PR-071)

**Contexto:** D-079 marcou `appointments.status='pending_payment'`
como **legado** (D-044 tornou primeira consulta gratuita). Watchdog
`appointment_pending_payment_stale` no admin-inbox alerta após 24h.

**Quando:** card `appointment_pending_payment_stale` em `/admin`.

**Leitura defensiva:** com `LEGACY_PURCHASE_ENABLED=false` em
produção, **nenhum novo** appointment `pending_payment` deveria
estar sendo criado. Se o watchdog dispara:

1. É resíduo histórico (appointment criado antes da virada D-044) —
   contexto normal, seguir passo 3.
2. OU é bug grave (algum código-path criando `pending_payment` novo)
   — seguir passo 2.

**Passos:**

1. Identificar quais appointments estão em `pending_payment`:

   ```sql
   select
     id, customer_id, doctor_id, created_at,
     age(now(), created_at) as age,
     pending_payment_expires_at,
     scheduled_at
   from appointments
   where status = 'pending_payment'
     and deleted_at is null
   order by created_at asc;
   ```

2. **Se a row é recente (< 1h) e `LEGACY_PURCHASE_ENABLED=false` em
   produção:** bug sério. Abrir `/admin/errors` e ver o que logou.
   Investigar antes de fechar manualmente.

3. **Se a row é antiga (resíduo D-044):** contactar o paciente.
   Decidir:
   - Paciente quer consultar → reagendar (cria novo appointment
     `scheduled`, grátis per D-044). Soft-delete o antigo com
     `deleted_reason='Ghost D-044 (pending_payment) — reagendado como <new-uuid>'`
     (seção 19).
   - Paciente não quer mais → cancelar via UI ou:
     ```sql
     update appointments
     set status = 'cancelled_by_admin',
         cancelled_reason = 'D-044 legacy pending_payment — paciente não deu retorno',
         cancelled_at = now(),
         cancelled_by = auth.uid()
     where id = '<uuid>' and status = 'pending_payment';
     ```

4. **Nunca auto-cancelar em massa via cron** — foi decisão explícita
   (D-079): segurança > conveniência. Cada appointment é triado
   manualmente pra evitar duplo-estorno.

**Paciente vê UI ruim?** Pós-PR-071, card `/paciente` desses
appointments mostra "Fale com a equipe pelo WhatsApp" com mensagem
pré-preenchida (`whatsappSupportUrl` da lib `contact.ts`). Responder
o WA dele rapidamente destrava o fluxo humano.

---

## Apêndice · Onde está cada coisa

| Dado | Onde |
| --- | --- |
| Receita Memed | `appointments.memed_prescription_url` |
| Endereço entrega atual | `fulfillments.shipping_*` (não `customers.address_*` — essa é cadastro) |
| Snapshot legal aceite | `plan_acceptances.acceptance_text` + `acceptance_hash` |
| Comprovante PIX repasse | `doctor_payouts.pix_proof_url` (Storage) |
| NF-e da médica | `doctor_billing_documents.file_url` (Storage) |
| Histórico de aceite | timeline em `/admin/pacientes/[id]` |
| Histórico de endereço | tabela `fulfillment_address_changes` |

---

## Apêndice · Variáveis de ambiente críticas

Ver `docs/RUNBOOK-PRODUCTION-CHECKLIST.md` §2 pra a lista
**completa** classificada por criticidade (🔴 bloqueante, 🟠
degradação, 🟡 observabilidade) e `docs/SECRETS.md` pro template
completo do `.env.local`.

Atalho operacional:

- **Cobrança / pagamento:** `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN`,
  `ASAAS_ENV`, `REFUNDS_VIA_ASAAS` (flag).
- **Vídeo:** `DAILY_API_KEY`, `DAILY_DOMAIN`, `DAILY_WEBHOOK_SECRET`
  (base64 válido).
- **WhatsApp:** `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
  `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_TEMPLATES_APPROVED` (flag),
  `WHATSAPP_TEMPLATE_VERSION`.
- **Supabase:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`.
- **Crons + tokens:** `CRON_SECRET`, `PATIENT_TOKEN_SECRET`,
  `ADMIN_DIGEST_PHONE` (E.164 do operador).
- **Fluxos + contato público:** `LEGACY_PURCHASE_ENABLED` (default
  `false` em prod — **nunca ligar**), `NEXT_PUBLIC_WA_SUPPORT_NUMBER`,
  `NEXT_PUBLIC_DPO_EMAIL`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_BASE_URL`.
- **Memed (prescrição):** `MEMED_API_KEY`, `MEMED_API_SECRET`,
  `MEMED_ENV`.

Qualquer uma rotacionada → atualizar em Vercel (production **+**
preview **+** development, atento ao gotcha da CLI descrito em
`SECRETS.md`) e rodar `/admin/health?ping=1` pra validar.
Para rotina de rotação (cadência, ordem, envs que causam downtime),
ver `RUNBOOK-PRODUCTION-CHECKLIST.md` §8.

---

## State machine de `appointments.status` (D-070 · PR-059)

A trigger `validate_appointment_transition` está instalada em modo
`'warn'` (default) — registra transições não-listadas em
`appointment_state_transition_log` mas **deixa passar**. Quando o log
ficar limpo por ≥ 7 dias seguidos, promova para `'enforce'`.

### Diagnóstico semanal

```sql
-- O que apareceu de não-esperado nos últimos 7 dias?
select
  action,
  count(*) as n,
  array_agg(distinct from_status || '→' || to_status order by from_status || '→' || to_status) as transitions
from public.appointment_state_transition_log
where created_at >= now() - interval '7 days'
group by action;
```

Espera-se `n = 0` para `warning`, `blocked` e `bypassed`. Se aparecer:

- **warning** legítimo (ex.: nova rota faz uma transição que faz sentido):
  adicione INSERT na tabela `appointment_state_transitions` E na lib
  `src/lib/appointment-transitions.ts` (mantém paridade), pelo
  procedimento padrão de migration.
- **warning** ilegítimo (ex.: bug em cron ou rota): corrige o caller
  e marca o caso como tratado em ADR de follow-up.

### Promoção para `enforce`

1. Confirmar 7 dias seguidos com `n=0` em `warning`.
2. No Supabase SQL Editor, rodar como `postgres`:

   ```sql
   alter database postgres
     set app.appointment_state_machine.mode = 'enforce';
   ```

3. Disparar `select pg_reload_conf();` (não estritamente necessário, mas
   garante propagação imediata para conexões novas).
4. Rodar smoke manual: tentar `update appointments set status='completed'
   where status='cancelled_by_admin' limit 1` — deve falhar com
   `invalid_appointment_transition`.
5. Atualizar `D-070` em `docs/DECISIONS.md` com data/hora da promoção.

### Rollback emergencial

Se o `enforce` quebrar produção (transição legítima esquecida no seed):

```sql
alter database postgres set app.appointment_state_machine.mode = 'warn';
```

Em emergência absoluta:

```sql
alter database postgres set app.appointment_state_machine.mode = 'off';
```

### Bypass por transação (admin manual com motivo)

```sql
begin;
set local app.appointment_state_machine.bypass = 'true';
set local app.appointment_state_machine.bypass_reason = 'CFM hotfix #123 - reclassificação após petição';
update public.appointments set status = 'completed' where id = '...';
commit;
```

Sempre loga em `appointment_state_transition_log` com `action='bypassed'`.

---

*Última revisão: 2026-04-20 · D-085 · PR-041-B (bump Next 14.2.35 →
15.5.15 + React 18 → 19 — fecha família 11.x 100%; nenhum procedimento
operacional mudou, mas `supabase-server.ts::getSupabaseServer()` e
`::getSupabaseRouteHandler()` agora são `async Promise<SupabaseClient>`
pra quem escrever novo call-site). Revisão anterior: D-084 · PR-070-B
(§16 reescrito pra usar `/admin/magic-links` como caminho primário,
mantendo SQL fallback).*
