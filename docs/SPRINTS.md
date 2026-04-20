# Sprints · Instituto Nova Medida

> Cada sprint tem escopo claro, entregáveis e definição de pronto.
> Marcamos `[x]` quando concluído, com data.

---

## ✅ Sprint 1 · Landing Page MVP · 2026-04-18 a 2026-04-19

**Objetivo:** Site público no ar, capaz de converter visitante em lead com
nome+WhatsApp, baseado 1:1 na estratégia do `estrategia tirzepatida.odt`.

### Entregáveis

- [x] Setup Next.js 14 + TS + Tailwind + Framer Motion
- [x] Design tokens (paleta cream/sage/terracotta/ink, fontes Fraunces+Inter)
- [x] Hero com copy do documento + CTA + microcopy de escassez
- [x] Seções: Identification, Shift, Access, HowItWorks, Desire, Cost
- [x] FAQ com 6 perguntas (incl. compliance CFM/Anvisa/LGPD)
- [x] Footer com identificação societária + LGPD + DPO + termos
- [x] Quiz funcional (4 perguntas + barra de progresso animada)
- [x] CaptureForm (nome + WhatsApp com máscara + opt-in LGPD)
- [x] Tela Success com share WhatsApp + copiar link
- [x] API `/api/lead` validando e logando lead
- [x] SEO: metadata, sitemap, robots, ícone, OG
- [x] Build limpo (147 kB First Load JS)

### Ajustes pós-entrega (mesma sprint)

- [x] Substituir imagens hotlink por arquivos em `/public`
- [x] Corrigir FAQ: PIX/boleto à vista, parcelamento só no cartão
- [x] Rebrand completo: "Mais Leve" → "Instituto Nova Medida"
- [x] Atualizar domínio para `institutonovamedida.com.br`
- [x] Estrutura de documentação em `docs/`

---

## ✅ Sprint 2 · Backend + Persistência + WhatsApp · 2026-04-19

**Objetivo:** Lead da landing vai parar no Supabase e dispara automação
WhatsApp (MSG 1–10 do documento de estratégia).

### Entregáveis

- [x] Conta Supabase (região São Paulo) ✅
- [x] Schema da fase 1 (`leads` + `whatsapp_events`, RLS deny-by-default) ✅
- [x] Migrations versionadas em `supabase/migrations/` ✅
- [x] `/api/lead` persistindo no Supabase ✅
- [x] App Meta + WhatsApp Cloud API ativados ✅
- [x] Test number da Meta funcionando como remetente (Phone ID
      `1093315577192606`) ✅
- [x] Lib WhatsApp (`src/lib/whatsapp.ts`) com `sendTemplate`,
      `sendText`, `sendBoasVindas` ✅
- [x] Webhook `/api/wa/webhook` recebendo `delivered`, `read`,
      `failed` e respostas inbound ✅
- [x] Tracking no banco (`whatsapp_msg1_status`, `_message_id`,
      `_sent_at`, `_error`) ✅
- [x] Pipeline ponta-a-ponta validado: lead novo → Supabase →
      `hello_world` enviado pra `+55 21 99885-1851` (entregue) ✅

### Adendos pós-sprint

- [x] **Deploy em produção (Vercel)** — site no ar em
      https://instituto-nova-medida.vercel.app, função pinada em
      `gru1`, framework Next.js detectado, ssoProtection desligada
- [x] Fix do `void async` fire-and-forget no runtime serverless
      (trocado por `await` direto)
- [x] Páginas legais: `/termos`, `/privacidade`, `/sobre`
- [x] Sitemap + metadata atualizados

### Pendências carregadas pra próximas sprints

- [ ] Submeter template `boas_vindas_inicial` em pt_BR no WhatsApp
      Manager (copy em `docs/COPY.md`) — bloqueado por reativação BM
- [ ] **System User Token permanente** — bloqueado por reativação do
      Business Manager da Meta (operador precisa atualizar site no BM
      e pedir reanálise)
- [ ] Fluxo MSG 2-10 com agendamento via cron / qstash — Sprint 5
- [ ] Painel admin de leads — Sprint 5

---

## ✅ Sprint 3 · Pagamentos (Asaas) · 2026-04-19

**Objetivo:** Paciente clica num plano, preenche dados, paga via
PIX/cartão/boleto, status rastreado em tempo real via webhook.

**Modo:** sandbox até CNPJ próprio sair (D-019). Concluída e validada
ponta-a-ponta em produção. Detalhamento no CHANGELOG.

### Entregáveis (todos ✅)

- [x] Schema Supabase: `plans`, `customers`, `payments`, `subscriptions`,
      `asaas_events` com RLS deny-by-default e seed dos 3 planos
- [x] `src/lib/asaas.ts` (cliente sandbox/prod, customers, payments,
      subscriptions, webhook validation)
- [x] `POST /api/checkout` com idempotência por CPF, suporte
      PIX/boleto/cartão e split opcional
- [x] `POST /api/asaas/webhook` autenticado, persiste eventos em raw +
      atualiza status do payment
- [x] Páginas `/planos`, `/checkout/[plano]`, `/checkout/sucesso`,
      `/checkout/aguardando`
- [x] Landing conectada (Header/Hero/Cost/Success → /planos) com
      atribuição lead→compra via localStorage
- [x] Validado E2E na URL de produção: customer + payment criados na
      Asaas sandbox, webhook RECEIVED disparado, status atualizado no
      Supabase com `signature_valid=true`

### Pendente operacional (não bloqueia)

- [ ] CNPJ próprio (D-020) → trocar para `ASAAS_API_KEY` de produção
- [ ] Sub-contas das farmácias parceiras → split de 3 vias (Sprint 6)

---

## 🟡 Sprint 4 · Multi-médico + agenda + videoconsulta · em andamento

**Objetivo:** Construir o lado **clínico** do produto: cadastro de
médicas como PJ (D-024), agenda própria de cada uma, videoconsulta
real via Daily.co (D-021), notificações WhatsApp completas, fila
on-demand pra "consulta agora", prontuário escrito, prescrição via
Memed, e controle financeiro interno (D-022) que paga as médicas
mensalmente com workflow auditável.

**Dividida em 2 entregas** porque o escopo é grande e interdependente:

### ✅ Sprint 4.1 · Fundação multi-médico + agenda + sala + financeiro base

Foco: subir um fluxo end-to-end "paciente paga → agenda → médica
atende → recebe earning → admin paga via PIX no fim do mês". Sem fila
on-demand ainda, sem Memed ainda — esses entram na 4.2.

**Status (2026-04-20):** ✅ **100% entregue.** Bloqueio D-029 (webhook
Daily falha no registro por bug HTTP/2 do superagent deles)
**mitigado** em D-035: cron `/api/internal/cron/daily-reconcile` rodando
a cada 5 min fecha o ciclo dos appointments via polling da Daily REST
API. Webhook continuará no código — quando Daily consertar ou migrarmos
pra Cloudflare, passa a rodar em paralelo como caminho primário.
D-036 (governança da médica) entregue: eventos de confiabilidade
granulares + auto-pause em 3 eventos/30d + painel admin completo.
D-037 (conciliação financeira) entregue: 6 checks on-demand em
/admin/financeiro detectando divergências entre payments, earnings
e payouts, com severidade e hint de ação.
D-038 (testes unitários) entregue: Vitest + 29 testes cobrindo
reliability, refunds e reconciliation. Helper `src/test/mocks/supabase.ts`
para mockar DB via fila de respostas por tabela. Runtime ~500ms.
D-039 (prova de fogo E2E) entregue: `src/lib/system-health.ts` com 9
checks paralelos, `/admin/health` dashboard server-rendered,
`GET /api/internal/e2e/smoke` endpoint protegido (200/503 pra
UptimeRobot) e `docs/RUNBOOK-E2E.md` com 7 cenários de prova de fogo.
D-040 (crons financeiros em Node) entregue: `earnings-availability.ts`
+ `monthly-payouts.ts` + `cron-runs.ts` + 2 Vercel crons observáveis,
tabela `cron_runs` pra auditoria, badge "auto" em `/admin/payouts`
nos drafts gerados pelo cron, e 2 checks novos em system-health
(`cron_earnings_availability`, `cron_monthly_payouts`). Ciclo
financeiro end-to-end finalmente automatizado e visível. Total: 28
testes novos (85 no total).

**Entregáveis:**

- [ ] **Schema multi-médico:**
  - [ ] `doctors` (id, crm, uf, name, email, phone, photo_url, bio,
        cnpj, status enum)
  - [ ] `doctor_availability` (doctor_id, weekday, start_time,
        end_time, type enum: agendada/plantao)
  - [ ] `doctor_payment_methods` (doctor_id, pix_key + tipo, dados
        bancários opcionais)
  - [ ] `doctor_compensation_rules` (doctor_id, valores fixos por
        tipo de earning, ativa por vez)
- [ ] **Schema appointments:**
  - [ ] `appointments` (id, doctor_id, customer_id, payment_id,
        scheduled_at, status enum, video_room_url, video_room_token,
        recording_consent, anamnese jsonb, hipotese, conduta,
        memed_prescription_id, started_at, ended_at, cancelled_*)
  - [ ] `appointment_notifications` (appointment_id, channel, kind,
        template_name, payload, sent_at, message_id, status, error)
- [ ] **Schema financeiro:**
  - [ ] `doctor_earnings` (id, doctor_id, appointment_id, payment_id,
        type enum, amount_cents (signed), description, earned_at,
        status enum, available_at, payout_id, metadata)
  - [ ] `doctor_payouts` (id, doctor_id, reference_period, amount_cents,
        earnings_count, status enum, pix_key snapshot, pix_tx_id,
        paid_at, approved_by, approved_at, receipt_url, notes)
  - [ ] `doctor_billing_documents` (payout_id, type, document_url,
        document_number, issued_at, validated_*)
- [x] **Cron de expiração de reservas (D-030)** — pg_cron
      `*/1 min` + Vercel Cron `*/1 min` → libera slots em
      `pending_payment` expirados (TTL 15 min). Migration 010.
- [x] **Crons financeiros (D-040)** — Node + Vercel Cron, observável:
  - [x] `GET /api/internal/cron/recalculate-earnings` (diário 03:15 UTC)
        promove `pending` → `available` (D+7 PIX / D+3 BOLETO /
        D+30 CARTÃO + UNDEFINED). RPC SQL mantida como backup.
  - [x] `GET /api/internal/cron/generate-payouts` (mensal dia 1, 09:15
        UTC) agrega earnings available em payouts `draft` com
        `auto_generated=true`. Idempotente via UNIQUE constraint +
        handler 23505. Warnings pra médica sem PIX ativo.
  - [x] Tabela `cron_runs` + system-health checks freshness.
  - [x] `notify_pending_documents` — diário 06:00 BRT, cobra NF
        (entregue em D-041, Sprint 5).
- [ ] **Lib `src/lib/video.ts`:**
  - [ ] Interface `VideoProvider` (createRoom, getJoinUrl, deleteRoom,
        validateWebhook)
  - [ ] `DailyProvider` implementação completa
  - [ ] Defaults da sala: `enable_prejoin_ui: true`, `enable_chat: false`,
        `max_participants: 2`, `eject_at_room_exp: true`,
        `enable_recording: 'local'` (off por default, ligada por
        appointment quando `recording_consent=true`)
- [x] **Lib `src/lib/whatsapp.ts` extendida + fila persistente (D-031):**
  - [x] Helpers tipados para os 5 templates de agendamento (`wa-templates.ts`)
  - [x] Helpers para os 2 templates financeiros (`medica_repasse_pago`,
        `medica_documento_pendente`)
  - [x] Worker HTTP `/api/internal/cron/wa-reminders` (Vercel Cron
        `*/1 min`) drena `appointment_notifications`
  - [x] Integrado ao webhook Asaas (confirmação + 4 lembretes
        agendados no `RECEIVED`) e ao cron de expiração (reserva
        expirada)
  - [ ] Submeter os 7 templates na Meta WhatsApp Manager
        (aprovação 1-24h). Ativar setando
        `WHATSAPP_TEMPLATES_APPROVED=true` no Vercel.
- [x] **Política financeira de no-show (D-032)** — fecha o ciclo
      clínico-financeiro dos desfechos `no_show_patient`,
      `no_show_doctor` e `cancelled_by_admin+expired_no_one_joined`.
      Migration 012 + `src/lib/no-show-policy.ts` + integração em
      ambos handlers Daily. Reusa `createClawback()` (idempotente).
      Flag `refund_required` guia admin pra processar refund Asaas
      (automação vem na Sprint 5). Contador
      `doctors.reliability_incidents` alimentado.
  - [ ] Templates Meta dedicados (`no_show_patient_aviso`,
        `no_show_doctor_desculpas`) — aguardando revisão jurídica do
        copy antes de submeter. Enquanto isso, stubs retornam
        `templates_not_approved` e worker mantém notificações em
        `pending` pra re-tentar.
  - [ ] Ativação real do fluxo depende de D-029 destravar (webhook
        Daily registrado em produção). A política funciona hoje via
        update manual de status por admin.
- [x] **UI admin de observabilidade (D-033)** — destrava operação dos
      sistemas entregues em D-031 e D-032. Migration 013 adiciona
      metadata de refund (`refund_external_ref`, `refund_processed_by`,
      `refund_processed_method`, `refund_processed_notes`) + índice
      parcial. `src/lib/refunds.ts` centraliza o registro de refund
      processado com idempotência e gancho pra automação futura. 2
      páginas (`/admin/notifications`, `/admin/refunds`) + 2 API
      routes + 2 alertas novos no dashboard. UI só oferece modo
      manual hoje; Sprint 5 liga o modo `asaas_api` sem refactor.
- [x] **Estorno automático via Asaas API (D-034)** — antecipa o que
      seria Sprint 5. `refundPayment()` em `src/lib/asaas.ts` chama
      `POST /payments/{id}/refund` com full refund; `processRefundViaAsaas()`
      em `src/lib/refunds.ts` orquestra + valida + marca com
      `method='asaas_api'`. API `/api/admin/appointments/[id]/refund`
      aceita `method` no body com default inteligente pelo flag
      `REFUNDS_VIA_ASAAS`. UI `/admin/refunds` ganha botão primário
      "Estornar no Asaas" + fallback manual inline auto-expandido em
      erro. Webhook Asaas `PAYMENT_REFUNDED` fecha o loop pra refunds
      iniciados fora da nossa UI (painel Asaas direto, chargeback).
      **Flag OFF em produção por default** — valida em sandbox antes de
      flipar. Full-refund-only por ora.
- [x] **Cron de reconciliação Daily (D-035)** — destrava produção
      enquanto D-029 (webhook Daily) permanece bloqueado. Migration 014
      adiciona `appointments.reconciled_at` + `reconciled_by_source`.
      Novo `src/lib/reconcile.ts` centraliza `reconcileAppointmentFromMeetings()`,
      consumido por webhook (refatorado) E pelo novo cron
      `/api/internal/cron/daily-reconcile` (agendado `*/5 * * * *`). Cron
      faz polling da Daily REST API `/meetings`, aplica mesma lógica de
      classificação (completed / no_show_patient / no_show_doctor /
      cancelled_expired) e dispara `applyNoShowPolicy()`. Dashboard
      admin ganha card de observabilidade com breakdown por source e
      alerta quando há appointments > 2h sem fechamento.
      Defesa em profundidade: quando D-029 voltar, webhook e cron
      continuam rodando em paralelo.
- [x] **Regras de confiabilidade da médica (D-036)** — fecha o arco
      "governança da equipe clínica". Migration 015 cria
      `doctor_reliability_events` (eventos granulares auditáveis com
      dismiss individual) + colunas `reliability_paused_*` em
      `doctors`. Novo `src/lib/reliability.ts` com constantes de
      política (30 dias / 2 soft warn / 3 hard block), funções
      `recordReliabilityEvent`, `evaluateAndMaybeAutoPause`,
      `pauseDoctor`, `unpauseDoctor`, `dismissEvent`, overview/listing.
      `applyNoShowPolicy` (D-032) passa a registrar evento granular +
      rodar avaliação → auto-pausa a médica ao atingir 3 eventos.
      `getPrimaryDoctor()` (D-027) e `/api/agendar/reserve` filtram
      médicas pausadas — appointments já agendados seguem. 3 API
      routes (`pause`, `unpause`, `dismiss`) + página
      `/admin/reliability` com tabelas de pausadas, alertas e feed de
      eventos recentes. AdminNav ganha item "Confiabilidade".
      Dashboard admin ganha dois alertas novos (N pausadas, N em
      alerta) em "Próximos passos".
- [x] **Conciliação financeira (D-037)** — fecha o arco de auditoria
      de payments/earnings/payouts. Novo `src/lib/reconciliation.ts`
      com 6 checks read-only (4 críticos: consultation_without_earning,
      no_show_doctor_without_clawback, payout_paid_earnings_not_paid,
      payout_amount_drift; 2 warnings: earning_available_stale,
      refund_required_stale). Cada discrepância vem tipada com
      severidade, IDs relacionados, valores, idade e hint de ação.
      Hard limit de 100 itens/check sinaliza truncamento na UI.
      Nova página `/admin/financeiro` com cards de resumo e seções
      agrupadas por severidade/kind. Dashboard admin ganha dois
      alertas novos (N críticas, N warnings) em "Próximos passos".
      Zero mutations — admin corrige manual via SQL (hint sugere).
      Recomendação operacional: rodar toda sexta antes de fechar mês.
- [x] **Testes automatizados unitários (D-038)** — primeira suíte
      automatizada do projeto. Vitest 4.x + mock helper
      `src/test/mocks/supabase.ts` (fila de respostas por tabela, sem
      simulação de DB). 29 testes em 3 arquivos, ~500ms runtime:
      `reliability.test.ts` (12 testes, auto-pause + idempotência
      pause/unpause + dedupe 23505), `refunds.test.ts` (10 testes,
      feature flag literal-"true"-only + mark idempotente),
      `reconciliation.test.ts` (7 testes, KIND_LABELS exaustivo +
      report vazio coerente + resiliência a erro). Scripts
      `npm test` / `npm run test:watch`. Fora do escopo desta leva
      (mantido pra D-039): no-show-policy, appointment-lifecycle,
      slot-reservation, HMAC tokens, E2E com Playwright.
- [x] **Prova de fogo E2E (D-039)** — cobertura ativa de
      "tudo está funcionando agora?". `src/lib/system-health.ts` com
      9 checks paralelos + timeout individual + tolerância a falha
      (database, asaas_env, asaas_webhook, daily_env, daily_signal,
      whatsapp_env, whatsapp_webhook, reconciliation, reliability).
      `/admin/health` dashboard server-rendered com status agregado
      no topo + 9 cards por subsistema + toggle ping externo.
      `GET /api/internal/e2e/smoke` endpoint JSON protegido por
      `CRON_SECRET`, retorna 503 em erro pra UptimeRobot ler só o
      status code (seguro pra bater a cada minuto; zero side effect).
      `docs/RUNBOOK-E2E.md` com 7 cenários passo-a-passo (paciente
      feliz, no-show médica, sala expirada, refund manual, refund via
      Asaas API, payout mensal, conciliação limpa, auto-pause) + SQL
      de troubleshooting + cleanup template. AdminNav ganha link
      "Saúde". Decisão deliberada: não automatizar E2E via Playwright
      agora (falta staging); humano roda o runbook antes de releases
      grandes ou mensalmente.
- [ ] **Auth:** roles `doctor` e `admin` no Supabase, middleware
      protegendo `/medico/*` e `/admin/*`
- [ ] **API routes:**
  - [ ] `POST /api/appointments` (paciente cria agendamento)
  - [ ] `POST /api/daily/webhook` (meeting.started, meeting.ended)
  - [ ] Extender `POST /api/asaas/webhook` para criar earning quando
        `PAYMENT_RECEIVED` e clawback quando `PAYMENT_REFUNDED`
  - [ ] `POST /api/admin/payouts/[id]/approve|pay|confirm`
  - [ ] `POST /api/admin/payouts/[id]/receipt` (upload PDF)
- [ ] **Páginas:**
  - [ ] `/agendar` (paciente escolhe médica + horário)
  - [ ] `/medico` (dashboard: próximas consultas, status verde/amarelo/
        vermelho/cinza, botão "entrar na sala")
  - [ ] `/medico/agenda` (gerenciar slots e bloqueios)
  - [ ] `/medico/financeiro` (saldo, próximo pagamento, histórico, NFs)
  - [ ] `/medico/configuracoes` (PIX, foto, bio)
  - [ ] `/admin/doctors` (CRUD + regras de compensação)
  - [ ] `/admin/payouts` (workflow mensal completo)
  - [ ] `/admin/financeiro` (consolidado + alertas de conciliação)
- [ ] **Notificações WhatsApp** agendadas (T-24h, T-1h, T-15min, T+0,
      T+10min) via pg_cron + templates
- [ ] **Documentação:**
  - [ ] `docs/COMPENSATION.md` — modelo financeiro completo
  - [ ] `docs/WHATSAPP_TEMPLATES.md` — 7 templates pra submeter na Meta
- [ ] **Validação E2E** em produção: criar médica de teste, criar
      appointment de teste, sala criada, webhook Daily processado,
      earning criada com status correto, payout draft gerado

### Sprint 4.2 · Fila on-demand + prontuário + Memed

Foco: completar a UX clínica e financeira, implementar o diferencial
da "consulta agora".

**Entregáveis:**

- [ ] `consultation_queue` table + RPC `process_queue()`
- [ ] Página `/consulta-agora` (paciente entra na fila, vê posição em
      tempo real via Supabase Realtime channel)
- [ ] Painel da médica recebe alerta "próximo paciente" (Realtime)
- [ ] Anamnese estruturada (formulário no painel da médica → grava em
      `appointments.anamnese` jsonb)
- [ ] Hipótese + conduta livres (texto)
- [ ] Integração **Memed** (OAuth por médica, criação de prescrição,
      arquivamento PDF)
- [ ] Mensagem WhatsApp pós-consulta com link Memed
- [ ] Templates Meta submetidos e aprovados (cobre todos os disparos
      proativos da 4.1 + 4.2)
- [ ] Página `/medico/historico` (consultas anteriores + busca)
- [ ] Página `/paciente/historico` (paciente vê suas consultas + receitas)

### Fora do escopo da Sprint 4 (vai pra 5+)

- Renovação automática de plano com lembrete (Sprint 5)
- Painel do paciente "meu tratamento" (Sprint 5)
- Triagem automática por regras (Sprint 5)
- Templates de mensagem 1-clique pra médica (Sprint 5)
- Detector de alertas de efeitos colaterais (Sprint 5)
- Reembolso self-service (Sprint 7)
- Refund parcial (quando surgir caso real — hoje tudo full refund)

### Definição de pronto da Sprint 4.1

1. Operador cadastra uma médica em `/admin/doctors` com CRM, PIX,
   regra de compensação default.
2. Médica recebe magic link, faz login em `/medico`, configura agenda
   semanal em `/medico/agenda`.
3. Paciente que pagou (Sprint 3) entra em `/agendar`, escolhe médica
   + horário, é confirmado por WhatsApp.
4. 15min antes da consulta, paciente recebe link da sala via WhatsApp.
5. Ambos entram, conversam, médica encerra → webhook Daily dispara
   (⚠️ bloqueado enquanto D-029 estiver aberto — só vai passar após
   migração Cloudflare ou Daily atualizar superagent).
6. Earning aparece em `/medico/financeiro` com status `pending`.
7. Após D+7 (PIX), earning vira `available`.
8. No dia 1 do mês seguinte, payout draft aparece em `/admin/payouts`.
9. Admin aprova, paga via PIX, sobe comprovante, status `confirmed`,
   médica é notificada.
10. Médica sobe NF-e em `/medico/financeiro`, status `validated`.

---

## 🟡 Sprint 5 · Área da Médica + ciclo do paciente · aberta 2026-04-20

**Objetivo:** agora que o ciclo financeiro está completo e automatizado
(D-040), fechar a área da médica (auto-serviço de PIX, NF, saldo) e
começar o ciclo do paciente (renovação, histórico). Financeiro mais
automatizado (estorno já foi em D-034; NF-e upload flow fica aqui).

### Entregáveis priorizados

**Frente 1 — Completar área da médica:**

- [x] **D-041 · Painel financeiro da médica + upload NF-e + cron de
      cobrança** — `/medico/repasses` ganhou saldo em tempo real
      (disponível, aguardando, próximo repasse, total recebido),
      banner de NF pendente, e upload de NF-e por payout. Admin valida
      em `/admin/payouts/[id]`. Cron `notify_pending_documents` roda
      diariamente 09:00 UTC (06:00 BRT) cobrando NF pendente há > 7d
      via template WhatsApp `medica_documento_pendente`. Bucket
      privado `billing-documents` + `src/lib/doctor-finance.ts` como
      fonte da verdade. 91 testes passando (27 novos).
- [x] **D-042 · PIX self-service da médica** — `/medico/perfil/pix`
      com card vigente (tipo + chave mascarada + titular), form de
      troca com `window.confirm` e lista de histórico com botão
      "Remover". API `POST /api/medico/payment-methods` faz **troca
      não-destrutiva**: marca default antigo como
      `active=false, is_default=false, replaced_at=now,
      replaced_by=userId` e insere o novo. Migration
      `20260422000000_doctor_payment_methods_history.sql` adiciona
      auditoria. Admin refatorado pra usar a mesma lib
      (`src/lib/doctor-payment-methods.ts`). Banner no `/medico`
      quando sem PIX. Cron D-040 continua funcionando sem mudança.
      Validação Asaas adiada (PIX hoje é manual; retomar quando
      execução via Asaas). 120 testes passando (29 novos).
- [ ] Página `/medico/agenda` (CRUD de `doctor_availability`)
- [ ] Auto-serviço de desmarque pela médica com janela mínima de
      aviso (liga na política de reliability D-036)

**Frente 2 — Ciclo do paciente:**

- [x] **D-043 · Área logada do paciente "meu tratamento"** —
      `/paciente/*` com magic-link dedicado (`/api/paciente/auth/
      magic-link`) que auto-provisiona `auth.user` com role=patient
      no primeiro acesso se e-mail bate um `customer` existente.
      Migration `20260423000000_customers_user_id.sql` adiciona
      `customers.user_id` + trigger `link_customer_to_new_auth_user`.
      `requirePatient()` no `src/lib/auth.ts`.
      `src/lib/patient-treatment.ts` como fonte única
      (`getActiveTreatment`, `getRenewalInfo`,
      `getUpcomingAppointment`, `listPastAppointments`).
      UI: `/paciente` dashboard (próxima consulta com entrada HMAC,
      status do ciclo com % progresso, banners condicionais para
      `expired`/`expiring_soon`, últimas 3 consultas),
      `/paciente/consultas` (agenda + histórico),
      `/paciente/consultas/[id]` (detalhe reutilizando
      `JoinRoomButton` via token HMAC server-side — sem duplicar
      lógica de janela), `/paciente/renovar` (status do ciclo + lista
      de planos com CTA destacado pro plano atual). Middleware e
      callback auth atualizados pra `/paciente/*`. Card de acesso em
      `/checkout/sucesso`. 141 testes passando (21 novos).
- [ ] Pré-consulta (sintomas/efeitos) em `/paciente/consultas/[id]`
      que a médica lê antes
- [ ] Upload de exames (PDF/imagem) para histórico clínico
- [ ] Prescrições visíveis ao paciente após a consulta
- [ ] MSG 2-10 do roteiro WhatsApp original (ainda não disparadas)

**Frente 3 — Clínica:**

- [ ] Verificação automática de CRM (CFM API ou scraping autorizado)
- [ ] Triagem automática (regras de aptidão / contraindicações absolutas
      pré-consulta com sugestão de prescrição que a médica revisa)
- [ ] Templates de mensagem WhatsApp 1-clique pra médica
- [ ] Detector de alertas (efeitos colaterais graves → escalação)

**Frente 4 — Teste + robustez:**

- [ ] Cobertura de testes pra `no-show-policy`, `slot-reservation`,
      tokens HMAC (pontos críticos não cobertos em D-038)
- [ ] E2E Playwright contra staging (se criarmos staging)
- [ ] Relatório financeiro consolidado por médica (export CSV mês)

**Frente 5 — Inversão do fluxo comercial (D-044) — consulta grátis, aceite formal, fulfillment:**

- [x] **Retirada de `/planos` da home pública** (2026-04-20): links
      públicos removidos de Header/Hero/Cost/Success,
      `robots: noindex,nofollow`, fora do sitemap. URL continua
      acessível pro operacional enviar via WhatsApp.
- [x] **D-044 onda 2.A · Schema + domínio de fulfillment e aceite formal**
      (2026-04-20): enum `fulfillment_status` (7 estados),
      tabelas `fulfillments` (1:1 com appointment) e
      `plan_acceptances` (imutável via trigger),
      3 colunas novas em `appointments`
      (`prescribed_plan_id`, `prescription_status`, `finalized_at`),
      RLS admin-ALL + médica-self, `src/lib/fulfillments.ts`
      com máquina de estados pura + hash SHA-256 canonicalizado
      do aceite. 24 testes novos (165 totais). Migração aplicada.
- [x] **D-044 onda 2.B · Painel da médica — finalizar consulta.**
      (2026-04-20) `/medico/consultas/[id]/finalizar` com radio
      declined/prescribed, textareas de anamnese/hipótese/conduta,
      seletor de plano ativo e URL Memed (validada http/https).
      Finalização é **idempotente** (409 em re-tentativa) e
      cria `fulfillment(pending_acceptance)` quando há prescrição.
      Tela read-only automática pós-finalização. Botão
      "Finalizar" no histórico de `/medico/agenda`. Lib pura
      `src/lib/appointment-finalize.ts` + endpoint
      `POST /api/medico/appointments/[id]/finalize`. 21 testes
      novos (186 totais). `next build` verde.
- [x] **D-044 onda 2.C.1 · Backend do aceite (endereço + termo jurídico).**
      (2026-04-20) Migração adiciona `shipping_*` em `fulfillments` e
      `shipping_snapshot jsonb` em `plan_acceptances` + view
      `fulfillments_operational`. `src/lib/fulfillments.ts` estende
      hash com endereço canonicalizado. Novas libs puras
      `src/lib/patient-address.ts` (validação + normalização) e
      `src/lib/acceptance-terms.ts` (template jurídico v1-2026-04
      com LGPD, CFM 2.314/2022, CDC art. 49, Lei 5.991/1973) e
      `src/lib/fulfillment-acceptance.ts` (orquestração idempotente
      do aceite: update customer cache + insert acceptance imutável
      + update fulfillment → pending_payment + snapshot shipping).
      Trata `23505` como idempotência. 50 testes novos (241
      totais). Migração aplicada.
- [ ] **D-044 onda 2.C.2 · UI do aceite + integração Asaas.**
      Endpoint `POST /api/paciente/fulfillments/[id]/accept` +
      página `/paciente/oferta/[appointment_id]` com resumo da
      prescrição, plano, termo completo, form de endereço com
      ViaCEP, checkbox legal e submit. Após aceite: chama
      `ensurePaymentForFulfillment` (idempotente) pra criar cobrança
      Asaas e redirecionar pro checkout hospedado. Card "oferta
      pendente" em `/paciente`.
- [ ] **D-044 onda 2.D · Webhook Asaas promove `paid`.** Extensão
      do handler existente pra mover fulfillment
      `pending_payment` → `paid`; WhatsApp "pagamento ok".
- [ ] **D-044 onda 2.E · Painel admin de fulfillment.** Lista de
      pendentes com botões das transições (pharmacy_requested →
      shipped → delivered) + notificações WhatsApp em cada etapa.
- [ ] **D-044 onda 2.F · /paciente: card "meu tratamento".** Mostra
      status do fulfillment + CTA "confirmar recebimento".
- [ ] **D-044 onda 2.G · Desligar fluxo antigo "paga antes".**
      Remover qualquer CTA público que leve a `/checkout` sem
      consulta prévia; manter endpoints como back-office.

---

## ⚪ Sprint 6 · Admin + Indicação + Analytics + Split de comissão

**Objetivo:** Você (operador) tem visibilidade total + máquina de
indicação rodando + farmácia integrada com split.

### Entregáveis

- [ ] Dashboard admin com todas as métricas (CAC, MRR, funil, churn, NPS)
- [ ] Cohort de retenção mensal
- [ ] Programa "indique e ganhe" (link rastreável + crédito automático)
- [ ] Eventos de conversão Meta Pixel + GTM + GA4
- [ ] Onboarding de farmácia parceira (upload de licença, IFA, laudos)
- [ ] Split Asaas de 3 vias (Instituto + Farmácia) — supersede D-022
      parcialmente: split entra apenas pra farmácia, médica continua
      com controle interno (D-022)

---

## ⚪ Sprint 7 · Conteúdo, SEO e crescimento orgânico

- [ ] Blog (rota `/blog` com MDX)
- [ ] Páginas de cidade ("emagrecimento online em São Paulo")
- [ ] Página de imprensa
- [ ] Página "Para médicas" (recrutamento)
- [ ] Schema.org MedicalBusiness + FAQ + Article

---

## ⚪ Sprint 8 · Hardening e LGPD operacional

- [ ] Termos de uso e Política de Privacidade redigidos por advogado de saúde
- [ ] Encarregado de Dados (DPO) contratado/nomeado
- [ ] Painel de exercício de direitos LGPD (paciente solicita acesso/correção/exclusão)
- [ ] Auditoria de logs e backup
- [ ] Sentry + alertas
- [ ] Pen-test inicial
