# Runbook · Prova de fogo E2E · Instituto Nova Medida

> Roteiro ponta-a-ponta pra exercitar os fluxos críticos em produção (ou
> staging quando existir). Não é teste automatizado — é checklist manual
> + smoke test sintético, cobrindo 7 cenários que juntos validam
> essencialmente toda a pilha.
>
> **Quando rodar:** antes de cada release grande (feature que mexe em
> dinheiro, pagamento, agendamento). No mínimo mensalmente mesmo sem
> release — cobertura básica de "tudo continua funcionando".
>
> **Quem roda:** admin (André). Tempo total: ~90 min com tudo andando.
>
> **Estado esperado ao final:** zero discrepâncias financeiras, zero
> médicas pausadas indevidamente, /admin/health com status geral "ok".

---

## 0 · Pré-requisitos

### Contas necessárias

| Sistema | Conta de teste | Notas |
|---|---|---|
| Asaas | Sandbox | `ASAAS_ENV=sandbox` pra rodar em produção do app sem cobrar cartão real |
| Daily.co | Conta real | Sandbox dedicado não existe; usamos salas temporárias |
| WhatsApp | Test number Meta | Phone ID `1093315577192606`, número seed `+55 21 99885-1851` |
| Supabase | Projeto único | Não temos staging separado (backlog Sprint 6) |
| Vercel | Projeto produção | crons rodam em `gru1` |

### Dados de teste

Antes de começar, confirme no `/admin`:

- [ ] Pelo menos 1 médica em status `active` e sem `reliability_paused_at`
- [ ] Médica tem `doctor_payment_methods` configurado (PIX key)
- [ ] Médica tem `doctor_availability` configurado pra hoje
- [ ] `doctor_compensation_rules` ativa pra médica

### Variáveis de ambiente

Verificar em `/admin/health?ping=1`:

- [ ] `ASAAS_API_KEY` + `ASAAS_ENV=sandbox` + `ASAAS_WEBHOOK_TOKEN`
- [ ] `DAILY_API_KEY` + `DAILY_DOMAIN` + `DAILY_WEBHOOK_SECRET`
- [ ] `WHATSAPP_PHONE_NUMBER_ID` + `WHATSAPP_ACCESS_TOKEN`
- [ ] `CRON_SECRET` (pros endpoints internos)
- [ ] `SUPABASE_SERVICE_ROLE_KEY`
- [ ] `REFUNDS_VIA_ASAAS` (opcional; deixar `false` pra ser conservador)

### Smoke test automatizado ANTES de começar

```bash
# Do seu terminal:
curl -H "x-cron-secret: $CRON_SECRET" \
  "https://institutonovamedida.com.br/api/internal/e2e/smoke?ping=1" \
  | jq '.report | {overall, checks: [.checks[] | {key, status, summary}]}'
```

**Esperado:** `overall: "ok"` e cada check com `status: "ok"` (ou
`"unknown"` em ambiente novo sem webhooks ainda).

Se `overall: "error"` — **pare aqui**. Corrija o subsistema quebrado
antes de exercitar os cenários abaixo; caso contrário, você vai gastar
tempo investigando falhas que são pré-existentes.

---

## Cenário 1 · Paciente feliz (fluxo principal)

**Objetivo:** lead chega na landing → vira customer → paga → agenda →
consulta Daily → earning criada.

### Passos

1. **Abra anônimo (aba privada)** em `https://institutonovamedida.com.br`.
2. Complete o quiz + preencha nome/WhatsApp. Use número real seu
   (vai receber WhatsApp de boas-vindas).
3. Vá em `/agendar`, escolha data/hora.
4. No checkout, escolha PIX.
5. No painel Asaas sandbox, marque o payment como `RECEIVED`
   manualmente (ou aguarde o fluxo sandbox).
6. Aguarde 10s — webhook Asaas cria earning type `consultation`.
7. Minutos antes do horário marcado, acesse a sala pelo link recebido
   via WhatsApp.
8. Em outra aba, conecte como médica em `/medico` (mesmo appointment).
9. Deixe a sala aberta por ~2 min (simula consulta). Encerre nos dois
   lados.
10. Aguarde 5-10 min — cron `daily-reconcile` marca appointment como
    `completed` com `reconciled_at`.

### Checklist de validação

- [ ] Lead aparece em `/admin` (painel de leads, se existir)
- [ ] Customer criado no Supabase (`select * from customers` recente)
- [ ] Payment em `status='RECEIVED'` em `/admin/financeiro` (sem
      aparecer como crítica)
- [ ] Appointment em `status='completed'` + `reconciled_at IS NOT NULL`
- [ ] Earning type `consultation` criada com `amount_cents` correto
- [ ] `doctor_earnings.status='available'` (ou pending se D+X ainda
      não passou — ok)
- [ ] WhatsApp de boas-vindas + lembrete enviados (ver
      `/admin/notifications`)

### Cleanup

Nada pra limpar — o fluxo completo é o estado desejado.

---

## Cenário 2 · No-show da médica (política D-032)

**Objetivo:** médica não entra na sala; política assimétrica aplica
clawback + refund_required; reliability event registrado.

### Passos

1. Agende um appointment pra consulta começar em 10 min (repita o
   Cenário 1 até o passo 6).
2. **NÃO entre como médica.** Deixe o paciente tentar acessar.
3. Paciente entra, espera, sai. (Ou não entra — não importa pra
   política, desde que a médica não entre.)
4. Espere 30 min após `scheduled_at` (tolerância padrão D-032).
5. Aguarde cron `daily-reconcile` rodar (até 5 min depois do
   tolerance expirar).

### Checklist de validação

- [ ] Appointment em `status='no_show_doctor'`
- [ ] `no_show_policy_applied_at IS NOT NULL`
- [ ] `refund_required=true` + `refund_processed_at IS NULL`
- [ ] Earning type `refund_clawback` criada com `amount_cents` negativo
      (= cancela a consulta)
- [ ] `/admin/reliability` lista 1 novo evento `no_show_doctor` pra
      essa médica
- [ ] Dashboard admin mostra contador de refunds pendentes
- [ ] `/admin/financeiro` NÃO lista esse appointment como
      `no_show_doctor_without_clawback` (o clawback existe)

### Cleanup

- Processar o refund (Cenário 4) OU marcar como dispensado no admin.

---

## Cenário 3 · Sala expira sem ninguém (política D-032)

**Objetivo:** nem médica nem paciente entram. Política marca
`cancelled_by_admin_expired` e registra reliability event
`expired_no_one_joined`.

### Passos

1. Repita Cenário 1 até o passo 6.
2. Não entre como ninguém.
3. Aguarde 30 min após `scheduled_at`.
4. Aguarde cron `daily-reconcile`.

### Checklist de validação

- [ ] Appointment em `status='cancelled_by_admin'` +
      `cancelled_reason='expired_no_one_joined'`
- [ ] `refund_required=true`
- [ ] Earning `refund_clawback` criada (negativa)
- [ ] `/admin/reliability` mostra evento `expired_no_one_joined`
- [ ] Dashboard admin mostra refund pendente

### Cleanup

Processar o refund no Cenário 4.

---

## Cenário 4 · Refund processado (D-033 manual + D-034 Asaas API)

**Objetivo:** refund marcado como processado; flag some dos alertas.

### Passos (fluxo manual, default)

1. Em `/admin/refunds`, selecione um dos appointments com
   `refund_required=true` gerados nos Cenários 2 ou 3.
2. Clique em "Registrar estorno manual".
3. Preencha `external_ref` (pode ser qualquer string — simulando ID
   do estorno feito no painel Asaas).
4. Submeta.

### Passos (fluxo automático, se `REFUNDS_VIA_ASAAS=true`)

1. Em `/admin/refunds`, clique "Estornar no Asaas" no mesmo
   appointment.
2. Aguarde 5s — app chama `POST /payments/{id}/refund` no Asaas
   sandbox.

### Checklist de validação

- [ ] Appointment tem `refund_processed_at IS NOT NULL` +
      `refund_processed_method IN ('manual','asaas_api')`
- [ ] Dashboard admin não mostra mais esse refund como pendente
- [ ] `/admin/financeiro` não lista como `refund_required_stale`
- [ ] Se asaas_api: webhook `PAYMENT_REFUNDED` chega segundos depois;
      `handleRefund` dedupe via `refund_processed_at` existente
      (idempotente) e NÃO duplica clawback (ver logs)

### Cleanup

Nada — o estorno é o estado desejado.

---

## Cenário 5 · Payout mensal (D-022)

**Objetivo:** admin agrega earnings disponíveis da médica em payout;
marca como `approved` → `pix_sent` → `confirmed`; earnings viram `paid`.

### Pré-requisito

Cenário 1 completo (pelo menos 1 earning `available` sem `payout_id`).

### Passos

1. Em `/admin/payouts`, clique "Gerar payout para {médica}".
   - Filtro: earnings com `status='available'` + `payout_id IS NULL`.
   - Payout criado em `status='draft'`.
2. Revise o payout: confira valor + contagem de earnings + competência.
3. Clique "Aprovar" → status vira `approved`.
4. **Faça o PIX real** pro pix key da médica (ou simule com valor
   simbólico no sandbox, se tiver conta separada).
5. Volte em `/admin/payouts/{id}` e clique "Marcar como enviado".
   Preencha `pix_tx_id` (txID do banco). Status vira `pix_sent`.
6. Upload do comprovante (PDF do banco ou print).
7. Clique "Confirmar recebimento" → status vira `confirmed`.
8. Handler do confirm propaga: todas as earnings do payout passam pra
   `status='paid'` + `paid_at = payout.paid_at`.

### Checklist de validação

- [ ] `doctor_payouts.status='confirmed'`
- [ ] `doctor_payouts.paid_at IS NOT NULL`
- [ ] `doctor_payouts.pix_tx_id IS NOT NULL`
- [ ] `doctor_payouts.receipt_url IS NOT NULL`
- [ ] Todas as earnings do payout: `status='paid'` + `paid_at` preenchido
- [ ] `/admin/financeiro` NÃO lista esse payout como
      `payout_paid_earnings_not_paid` nem `payout_amount_drift`
- [ ] `/medico/repasses` mostra o payout como "Pago em {data}"
- [ ] `/medico/ganhos` zera o saldo disponível (se era o único pendente)

### Cleanup

Nada.

---

## Cenário 6 · Conciliação financeira limpa (D-037)

**Objetivo:** após os cenários 1-5, `/admin/financeiro` mostra zero
discrepâncias (exceto as warnings aceitáveis).

### Passos

1. Acesse `/admin/financeiro`.
2. Aguarde os 6 checks rodarem (~1-3s).

### Checklist de validação

- [ ] **Críticas: 0** (se aparecer > 0, ler o hint de ação e corrigir)
- [ ] **Warnings: 0 ou com justificativa** (earning_available_stale
      só é normal se cron `generate_monthly_payouts` não tá rodando —
      ver Sprint 5)
- [ ] Tela "Nada pra reconciliar" aparece

### Troubleshooting

Se aparecer `consultation_without_earning`: rodar no Supabase SQL
editor:

```sql
select a.id, a.status, a.scheduled_at, a.ended_at,
  exists(select 1 from doctor_earnings e
         where e.appointment_id = a.id and e.type='consultation') as has_earning
from appointments a
where a.id = '<appointment_id_da_discrepancia>';
```

Investigar logs de `handleEarningsLifecycle` no webhook Asaas.

Se aparecer `no_show_doctor_without_clawback`: chamar manualmente
`createClawback` via SQL/migration helper OU reprocessar o appointment
via `applyNoShowPolicy`.

---

## Cenário 7 · Auto-pause por reliability (D-036)

**Objetivo:** ao acumular 3 eventos `no_show_doctor` em 30 dias,
médica é pausada automaticamente e sai de `/agendar`.

### Passos

1. Gere 3 no-shows pra MESMA médica (repetir Cenário 2 três vezes).
2. No 3º no-show, após cron `daily-reconcile` rodar, a médica deve
   estar `reliability_paused_at IS NOT NULL` +
   `reliability_paused_auto=true`.
3. Como paciente em aba anônima, vá em `/agendar`. A médica NÃO
   deve aparecer na lista de médicas disponíveis.

### Checklist de validação

- [ ] `doctors.reliability_paused_at IS NOT NULL`
- [ ] `doctors.reliability_paused_auto=true`
- [ ] `doctors.reliability_paused_reason` contém "Auto-pause:"
- [ ] `/admin/reliability` lista a médica na seção "Pausadas"
- [ ] Dashboard admin mostra alerta crítico "1 médica pausada"
- [ ] `/agendar` não oferece horários dela
- [ ] API `POST /api/agendar/reserve` com doctorId dela retorna
      `409 doctor_reliability_paused`

### Cleanup

1. Em `/admin/reliability`, clicar "Reativar" na linha da médica.
   Opcional: dispensar alguns eventos de confiabilidade (ex: "foi bug
   de plataforma").
2. Confirmar médica volta a aparecer em `/agendar`.

---

## Checklist final de encerramento

Após rodar os 7 cenários:

- [ ] `/admin/health` com `overall: "ok"`
- [ ] `/admin/financeiro` com 0 críticas e warnings justificadas
- [ ] `/admin/reliability` sem médicas pausadas (a menos que você
      queira manter o auto-pause pra observar)
- [ ] `/admin/refunds` sem pendentes
- [ ] Smoke HTTP:
      ```bash
      curl -sH "x-cron-secret: $CRON_SECRET" \
        "https://institutonovamedida.com.br/api/internal/e2e/smoke?ping=1" \
        | jq '.report.overall'
      ```
      → `"ok"`
- [ ] Sem logs de erro em `/var/log` do Vercel nas últimas 2h
      (vercel dashboard → functions → logs)

## Limpeza de dados de teste

Se usou números reais seus pra simular paciente, pode deixar os
registros — eles ajudam a ter dados vivos nas views. Se preferir
limpar:

```sql
-- Cuidado: deleção em cascata.
-- Rodar só se tiver certeza que são registros de teste.

-- Identificar customer de teste pelo phone
select id, name, phone from customers where phone like '%99885-1851%';

-- Cascade: appointments → payments → earnings → leads → customer
-- A FK tem ON DELETE SET NULL em vários lugares; seguro se fizer
-- na ordem:
delete from doctor_reliability_events where appointment_id in
  (select id from appointments where customer_id = '<id>');
delete from appointment_notifications where appointment_id in
  (select id from appointments where customer_id = '<id>');
delete from doctor_earnings where appointment_id in
  (select id from appointments where customer_id = '<id>');
delete from appointments where customer_id = '<id>';
delete from payments where customer_id = '<id>';
delete from customers where id = '<id>';
```

## Em caso de incidente

Se algum cenário deu errado e deixou dado em estado ruim:

1. Abrir `/admin/financeiro` — a discrepância provavelmente está
   listada com hint de ação específico.
2. Se não estiver, rodar o smoke HTTP com `?ping=1` e ler o JSON —
   cada check tem `details` estruturados pra debug.
3. Logs do Vercel (functions) + logs do Asaas sandbox (painel web)
   + `daily_events` / `asaas_events` / `whatsapp_events` no Supabase
   são os 3 lugares onde a história completa está.
