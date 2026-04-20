# Modelo de Compensação Médica · Instituto Nova Medida

> Como pagamos as médicas, como o sistema rastreia, como o repasse
> mensal funciona. Decisão fundadora: **D-022** (controle interno
> em vez de split Asaas) e **D-024** (PJ + valores fixos).

---

## Princípios

1. **Imutabilidade** — cada `earning` é um fato isolado. Não editamos
   depois. Mudança de regra de compensação não retroage; só vale pra
   novas earnings.

2. **Transparência radical** — médica vê em tempo real cada ganho com
   origem (qual consulta, qual paciente), valor, status e quando vai
   cair na conta dela.

3. **Auditabilidade de 5 anos** — qualquer repasse passado é
   reconstituível com 1 query no Postgres. Comprovante PIX em PDF
   anexado a cada `payout`.

4. **Resiliência a chargeback** — earning só vira "disponível pra pagar"
   depois da janela de risco do meio de pagamento (D+7 PIX, D+3 Boleto,
   D+30 Cartão).

5. **Quatro olhos** — nenhum centavo sai sem aprovação humana, mesmo
   no MVP onde só uma pessoa opera.

6. **Conformidade fiscal** — médica é PJ (D-024), emite NF-e de
   serviço médico mensalmente, anexa no painel, valida no admin.

---

## Conceito central: `earnings` + `payouts`

```
earning = "fato isolado"
          (esta consulta gerou R$ 200 pra Dra. Joana em 14/Mai · status: pending)
                                                     │
                                  D+7 (PIX)           │
                                                     ▼
                                                  available
                                                     │
                                          1º dia do mês seguinte
                                                     │
                                                     ▼
payout =  "lote consolidado"
          (todos os earnings available da Dra. Joana de Maio = R$ 4.800 · status: draft)
                                                     │
                                            admin aprova
                                                     │
                                                     ▼
                                                approved
                                                     │
                                         PIX gerado (manual ou Asaas Transfer API)
                                                     │
                                                     ▼
                                                pix_sent
                                                     │
                                          confirmação + comprovante
                                                     │
                                                     ▼
                                                confirmed
                                                     │
                                             notifica médica
                                                     │
                                                     ▼
                                       médica sobe NF-e (10 dias)
```

---

## Tipos de earning

| Tipo | Sinal | Quando é gerado | Default |
|---|---|---|---|
| `consultation` | + | Consulta agendada concluída (Daily `meeting.ended`) | R$ 200 |
| `on_demand_bonus` | + | Adicional por consulta atendida via fila on-demand | R$ 40 (total R$ 240) |
| `plantao_hour` | + | Por hora em status "verde" (online + disponível pra fila) | R$ 30 |
| `after_hours_bonus` | + | Multiplicador noturno/fim de semana (não ativo no MVP) | configurável |
| `adjustment` | +/− | Ajuste manual por admin com motivo obrigatório | manual |
| `bonus` | + | Discricionário (meta, NPS, retenção) | manual |
| `refund_clawback` | − | Quando paciente é reembolsado depois | mesmo valor da consulta |

Os defaults vivem em `doctor_compensation_rules` (1 linha ativa por
médica, com `effective_from` e `effective_to` pra histórico).

### Quando uma earning é criada

| Evento | Ação |
|---|---|
| Daily `meeting.ended` (consulta agendada) | Cria `consultation` no valor regra |
| Daily `meeting.ended` (consulta on-demand) | Cria `consultation` + `on_demand_bonus` |
| pg_cron horário (médica em "verde") | Cria `plantao_hour` proporcional |
| Asaas `PAYMENT_REFUNDED` ou `_CHARGEBACK` | Cria `refund_clawback` negativo do valor da consulta |
| Admin clica "ajustar" em /admin/doctors/[id] | Cria `adjustment` com motivo |

### Quando uma earning vira `available`

Cron `recalculate_earnings_availability()` roda diário às 00:00 e:

1. Para cada earning em `pending`:
   - Identifica o `payment.billing_type` associado.
   - Se PIX: marca `available_at = paid_at + 7 dias`.
   - Se Boleto: `available_at = paid_at + 3 dias`.
   - Se Cartão: `available_at = paid_at + 30 dias`.
2. Se `available_at <= hoje`, vira `available`.
3. Earnings sem `payment_id` (plantão, bônus, ajuste): viram
   `available` imediatamente após criação.

---

## Workflow mensal de payout

### Dia 1 do mês, 06h (`generate_monthly_payouts`)

```sql
-- pseudo-código da função
for each doctor where status = 'active' loop
  total := sum(earnings.amount_cents
               where doctor_id = current.id
                 and status = 'available'
                 and available_at < first_of_current_month
                 and payout_id is null);

  if total != 0 then
    insert into doctor_payouts (
      doctor_id, reference_period, amount_cents, status, ...
    ) values (
      current.id, last_month_text, total, 'draft', ...
    ) returning id into new_payout_id;

    update doctor_earnings
      set payout_id = new_payout_id
      where ...; -- mesmo critério de cima
  end if;
end loop;

-- notifica admin via WhatsApp:
-- "5 repasses prontos pra revisão, total R$ 24.300"
```

### Dia 1-3 (manual em `/admin/payouts`)

Admin abre cada `draft` e vê:
- Cabeçalho: médica, período, valor total, número de earnings
- Detalhamento: lista de cada earning com tipo, descrição, valor
- Histórico: payouts anteriores (sanity check de variação)
- PIX da médica (do `doctor_payment_methods`)
- Documentos pendentes (NFs anteriores não enviadas)

Botões:
- ✅ **Aprovar** → status `approved`, registra `approved_by` + `approved_at`
- ✏️ **Ajustar** (cria `adjustment` earning, recalcula payout)
- ❌ **Cancelar** (motivo obrigatório, earnings voltam pra `available`)

### Dia 3-5 (manual)

Admin gera o PIX:
- **MVP:** copia chave PIX do painel → cola no banco/app → executa → pega `tx_id` → cola em `/admin/payouts/[id]/pay`
- **Futuro:** botão "Pagar via Asaas Transfer" → POST `/transfers` na API Asaas → preenche `tx_id` automaticamente

Marca status como `pix_sent` com `tx_id`.

### Confirmação

Quando confirma recebimento (banco confirma, ou médica confirma):
- Admin sobe **comprovante PDF** em `/admin/payouts/[id]/receipt`
- Status vira `confirmed`
- Trigger dispara WhatsApp pra médica (template `medica_repasse_pago`)
- Trigger marca cobrança de NF como ativa (10 dias)

### Cobrança de NF

Cron `notify_pending_documents` roda diário às 06h:
- Para cada payout `confirmed` com `paid_at < hoje - 10d` e sem
  `doctor_billing_documents`:
  - Dispara WhatsApp `medica_documento_pendente`
  - Marca payout como `aguardando_documento_fiscal` no admin (visual)

---

## Dashboard da médica (`/medico/financeiro`)

```
┌─────────────────────────────────────────────────────┐
│  Saldo disponível (a receber em 05/Jun):            │
│    R$ 4.800,00       ▲ 24 consultas                 │
├─────────────────────────────────────────────────────┤
│  Saldo pendente (em janela de risco):               │
│    R$ 1.200,00       8 consultas (libera em até 7d) │
├─────────────────────────────────────────────────────┤
│  Próximo pagamento estimado:                        │
│    05/06/2026 · ~R$ 4.800                           │
└─────────────────────────────────────────────────────┘

EARNINGS DE MAIO/2026
┌────────┬────────────────────────────┬───────┬──────┐
│ Data   │ Origem                     │ Valor │ Stat │
├────────┼────────────────────────────┼───────┼──────┤
│ 28/05  │ Consulta Maria S.          │ R$ 200│ ✅   │
│ 27/05  │ On-demand bônus            │ R$ 40 │ ✅   │
│ 27/05  │ Consulta João P.           │ R$ 200│ ✅   │
│ 25/05  │ Plantão 4h                 │ R$ 120│ ⏳   │
│ 22/05  │ Consulta Ana R.            │ R$ 200│ ⏳   │
│ ...                                                  │
└────────┴────────────────────────────┴───────┴──────┘

REPASSES ANTERIORES
- Abril/2026 · R$ 5.200 · pago 05/05 · NF-e ✅ enviada
- Março/2026 · R$ 4.100 · pago 05/04 · NF-e ✅ enviada
```

### Status visíveis pra médica

- ⏳ **Pendente** — aguardando janela de risco terminar
- ✅ **Disponível** — entrou no próximo lote de pagamento
- 💸 **No lote** — payout draft criado, aguardando aprovação
- 🏦 **Pago** — PIX enviado
- 📄 **Aguardando sua NF-e** — pago, aguardando fiscal
- ❎ **Cancelado** — earning estornada (com motivo)

---

## Painel admin (`/admin/payouts`)

### Tela inicial

Lista de payouts com filtros: período, status, médica.

```
┌──────────────┬──────────────┬──────────┬─────────┬───────────┐
│ Período      │ Médica       │ Valor    │ Status  │ Ação      │
├──────────────┼──────────────┼──────────┼─────────┼───────────┤
│ Maio/2026    │ Joana Silva  │ R$ 4.800 │ Draft   │ [Revisar] │
│ Maio/2026    │ Carla Lima   │ R$ 5.200 │ Draft   │ [Revisar] │
│ Maio/2026    │ Ana Souza    │ R$ 3.100 │ Draft   │ [Revisar] │
│ Abril/2026   │ Joana Silva  │ R$ 5.200 │ Pago    │ [Ver NF]  │
└──────────────┴──────────────┴──────────┴─────────┴───────────┘
```

### Tela de revisão de payout

Detalhamento de cada earning + dados bancários + histórico + ações.

### Conciliação automática

Tela `/admin/financeiro` mostra:

- Soma de `payments` recebidos no período
- Soma de earnings líquidas (positivas + clawbacks) no período
- Diferença = receita do Instituto
- Alerta vermelho se houver discrepância inesperada (bug silencioso)

---

## Política de chargeback (clawback)

Se vier `PAYMENT_REFUNDED` ou `PAYMENT_CHARGEBACK` do Asaas:

1. Identifica `payment_id` → `appointment_id` → earnings vinculadas.
2. Para cada earning positiva criada por esse payment:
   - Se ainda em `pending` ou `available` (não pago): cancela
     (`status='cancelled'`, `cancelled_reason`).
   - Se já em payout `confirmed` (já pago à médica): cria nova earning
     `refund_clawback` com valor negativo, vinculada à mesma médica.
3. Clawback entra no próximo payout, reduzindo o valor.

Se médica fica com saldo negativo (raro), abre `/admin/doctors/[id]/debt`
e admin combina recuperação (deduzir do mês seguinte ou cobrar).

---

## Política de no-show (D-032)

Tratamento **assimétrico** conforme qual parte falhou:

| Status final                          | Earning médica | Refund paciente | Reliability |
|---------------------------------------|----------------|-----------------|-------------|
| `no_show_patient` (paciente faltou)   | Mantém         | Não             | —           |
| `no_show_doctor` (médica faltou)      | Clawback       | Sim (flag)      | +1          |
| Sala expirou sem ninguém              | Clawback       | Sim (flag)      | +1          |

**Rationale:**

- Se o **paciente** falta, a médica disponibilizou horário, ficou
  online, e o paciente é quem quebrou o contrato. Médica recebe
  integral; paciente NÃO tem direito a refund automático, mas pode
  escalar via admin (caso de atestado, emergência comprovada).
- Se a **médica** falta, é ela que quebrou o contrato com o paciente.
  Clawback revoga a earning (reusa fluxo de D-022) e a flag
  `refund_required=true` no appointment entra na fila de refunds que o
  admin processa no Asaas (até Sprint 5 automatizar).
- Se **ninguém aparece** (sala expirou vazia), a falha é de infra /
  plataforma — não é justo o paciente pagar. Mesmo tratamento do
  `no_show_doctor`.

**Métrica de confiabilidade:** `doctors.reliability_incidents`
incrementa em 1 a cada `no_show_doctor` ou expired-empty. Dashboard
admin (Sprint 5) vai listar médicas com alta incidência — por ora é
só contador, sem regra de corte automática. Operador pode zerar o
contador manualmente depois de uma conversa (a coluna é editável).

**Gatilho técnico:** `src/lib/no-show-policy.ts#applyNoShowPolicy()`
é chamado pelos webhooks Daily (`/api/daily/webhook` e
`/api/daily-webhook`) imediatamente após o update de status final no
appointment. Idempotente via `appointments.no_show_policy_applied_at`.

**Notificação ao paciente:** kinds `no_show_patient` e `no_show_doctor`
na fila `appointment_notifications` (D-031). Templates Meta reais
(`no_show_patient_aviso`, `no_show_doctor_desculpas`) aguardando
revisão jurídica — enquanto isso, stubs retornam
`templates_not_approved` e o worker mantém as notificações em
`pending` até os templates entrarem no ar.

---

## Cron jobs (pg_cron)

| Frequência | Job | Função |
|---|---|---|
| Diário 00:00 | `recalculate_earnings_availability()` | Passa pending → available conforme política |
| Diário 02:00 | `apply_pending_clawbacks()` | Processa refunds da janela |
| Diário 06:00 | `notify_pending_documents()` | Cobra NF |
| Mensal 1 às 06:00 | `generate_monthly_payouts()` | Cria drafts pra revisão |
| Horário (a cada 1h) | `accrue_plantao_hours()` | Cria `plantao_hour` por hora em verde |

---

## Onboarding de médica nova

1. Operador cria conta em `/admin/doctors/new`:
   - Nome, CRM/UF, email, telefone, CNPJ (MEI), foto, bio
   - PIX (chave + tipo)
   - Regra de compensação (default ou customizada)
2. Sistema envia email com magic link (Supabase Auth)
3. Médica entra em `/medico`, completa perfil, configura agenda
4. Status passa pra `active` quando: PIX validado + agenda configurada
   + ao menos 1 slot disponível
5. Aparece em `/agendar` para pacientes

**Operacional fora do código:**

- Contrato de prestação de serviço médico assinado (modelo no Drive)
- Contrato de operadora LGPD assinado (anexo do contrato principal)
- Médica registra a contratação na NF-e da prefeitura (CNAE 8630-5/03)

---

## Comparação com modelos alternativos

### Por que não split Asaas?

Já consolidado em **D-022**. Síntese: split Asaas exige cada médica
ter conta Asaas verificada (3-5 dias de onboarding), cobra fee por
transação, é difícil reverter em chargeback, e amarra a relação como
"recorrente automatizada" o que aumenta risco trabalhista.

### Por que não pagar por percentual?

Considerado, descartado. Razões:
- Ticket é fixo no MVP (mesmo plano = mesma consulta) → percentual
  e fixo são equivalentes operacionalmente
- Fixo é mais transparente pra médica (sabe exatamente quanto ganha
  por consulta)
- Quando ticket variar (planos diferentes, upsell), o sistema já
  suporta valor configurável por regra (mudar de R$ 200 fixo pra R$ X
  variável é trivial)

### Por que não pagar por dia/mês fixo (CLT)?

Custo. CLT pra médico ~R$ 12-20k/mês com encargos. PJ + por consulta
+ plantão remunerado modesto = margem operacional saudável + atrai
médicas que querem flexibilidade.

---

## Métricas operacionais

Acompanhar em `/admin/financeiro`:

- **CRMC (Custo de Receita Médica por Consulta)** = honorário médico ÷
  ticket da consulta
- **Take rate do Instituto** = (receita − honorário − farmácia) ÷ receita
- **Inadimplência sobre earnings** = clawbacks ÷ earnings positivas
- **Tempo médio entre consulta concluída e payout confirmado**
- **% de NFs em dia** (validadas dentro de 10 dias do pagamento)
- **Variação de payout MoM** (alerta se cair >30% pra mesma médica)

---

## Roadmap futuro (pós-MVP)

- **Pagamento adiantado** (médica solicita antecipação de earnings
  available) → cobrar fee pelo serviço
- **Asaas Transfer API** pra automatizar PIX (eliminar etapa manual)
- **Geração automática de RPA/NF-e** pelo Instituto em nome da
  médica (operação de retenção de imposto na fonte) — depende de
  modelagem fiscal específica
- **Dashboard pro contador** com export CSV/XML pra integrar com
  contabilidade
- **Alerta de pejotização** — se médica tiver >X% da renda dela vindo
  do Instituto por >Y meses, aciona revisão de contrato
