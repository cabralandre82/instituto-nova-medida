# Runbook · Operação solo · Instituto Nova Medida

> Checklist operacional do dia a dia pra quem administra a plataforma
> sozinho. Cada seção responde **"o que faço quando X acontece?"** em
> passos concretos, sem teoria. Pro teste ponta-a-ponta, ver
> [`RUNBOOK-E2E.md`](./RUNBOOK-E2E.md).
>
> **Filosofia:** se você abrir `/admin` e `/admin/errors` todo dia de
> manhã e seguir os indicadores daqui, o sistema opera sozinho em 95%
> dos dias. Os outros 5% têm runbook.

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

---

## 0 · Rotina diária (10 min)

Toda manhã, abra nessa ordem:

1. **`/admin`** — inbox do operador. Lista ordenada por urgência:
   `fulfillment_paid` (acionar farmácia), `fulfillment_pharmacy`
   (despachar), `offer_acceptance`/`offer_payment` (perseguir),
   `refund` (processar).
2. **`/admin/errors`** (janela 24h) — qualquer coisa que falhou desde
   ontem. Se estiver vazio, siga. Se tiver entries, seção 10.
3. **`/admin/health`** — status geral deve ser `ok` ou `warning`
   tolerável. `error` = seção 14 imediatamente.
4. **WhatsApp rollup diário** — se configurado (`ADMIN_DIGEST_PHONE`),
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

**Cálculo de repasse:** cron diário `recalc_earnings_availability`
reconcilia na próxima rodada. Se a médica já recebeu o ganho
original, o clawback será descontado do próximo payout
automaticamente.

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

| Cron | Schedule (UTC) | Impacto se falha |
| --- | --- | --- |
| `recalc_earnings_availability` | 06:00 diário | Repasses podem ficar travados na contagem |
| `generate_monthly_payouts` | 04:00 dia 1 | Pagamento do mês não é criado |
| `notify_pending_documents` | 09:00 diário | Médicas não são cobradas pela NF-e |
| `auto_deliver_fulfillments` | 10:00 diário | Fulfillments ficam em `shipped` pra sempre |
| `nudge_reconsulta` | 11:00 diário | Pacientes não recebem lembrete pra reconsultar |
| `admin_digest` | 11:30 diário | Você não recebe resumo por WA (mas pode abrir `/admin` mesmo assim) |

4. Ler `error_message` na UI. Causas comuns:
   - `timeout` → banco sob carga. Rodar novamente manualmente
     (veja próximo passo).
   - `constraint violation` → dado inconsistente. Investigar antes
     de rodar.
5. Rodar manualmente (se seguro):
   ```bash
   curl -X POST https://app.institutonovamedida.com.br/api/internal/cron/<job-slug> \
     -H "x-cron-secret: $CRON_SECRET"
   ```
   Slugs disponíveis: `recalculate-earnings`, `generate-payouts`,
   `notify-pending-documents`, `auto-deliver-fulfillments`,
   `nudge-reconsulta`, `admin-digest`.
6. Conferir novo run em `/admin/health` (coluna "Cron · ...").

Se o cron falha **3 dias seguidos** pela mesma causa, abrir issue
(trello/github) pra tratar como bug. Não espere o quarto dia.

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

Em Vercel (todas secret):

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN`, `ASAAS_ENV`
- `DAILY_API_KEY`, `DAILY_DOMAIN`, `DAILY_WEBHOOK_SECRET`
- `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
  `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
- `CRON_SECRET` (pra disparar crons manualmente)
- `ADMIN_DIGEST_PHONE` (E.164, recebe WA rollup diário)
- `MEMED_API_KEY`

Qualquer uma rotacionada → atualizar no Vercel imediatamente e
rodar `/admin/health?ping=1` pra validar.

---

*Última revisão: 2026-04-20 · D-045 · 3.G*
