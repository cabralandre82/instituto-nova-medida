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

### Sprint 4.1 · Fundação multi-médico + agenda + sala + financeiro base

Foco: subir um fluxo end-to-end "paciente paga → agenda → médica
atende → recebe earning → admin paga via PIX no fim do mês". Sem fila
on-demand ainda, sem Memed ainda — esses entram na 4.2.

**Status (2026-04-20):** 95% entregue. Bloqueio D-029 (webhook Daily
falha no registro por bug HTTP/2 do superagent deles) **mitigado** em
D-035: cron `/api/internal/cron/daily-reconcile` rodando a cada 5 min
fecha o ciclo dos appointments via polling da Daily REST API. Webhook
continuará no código — quando Daily consertar ou migrarmos pra
Cloudflare, passa a rodar em paralelo como caminho primário.

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
- [ ] **pg_cron jobs (faltantes):**
  - [ ] `recalculate_earnings_availability()` — diário 00:00, passa
        `pending` → `available` conforme política D+7/D+3/D+30
  - [ ] `generate_monthly_payouts()` — dia 1 às 06:00, agrega
        earnings available em payouts `draft`
  - [ ] `notify_pending_documents()` — diário 06:00, cobra NF
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

## ⚪ Sprint 5 · Área da Médica avançada + ciclo do paciente

**Objetivo:** Médica consegue atender com fluxo enxuto (~10 min/consulta
inicial, ~5 min/reconsulta) e paciente vê seu tratamento evoluir.

### Entregáveis

- [ ] Verificação automática de CRM (CFM API ou scraping autorizado)
- [ ] Triagem automática (regras de aptidão / contraindicações absolutas
      pré-consulta com sugestão de prescrição que a médica revisa)
- [ ] Templates de mensagem WhatsApp 1-clique pra médica
- [ ] Detector de alertas (efeitos colaterais graves → escalação)
- [ ] Página `/paciente/meu-tratamento`: dose atual, próxima reconsulta,
      exames, evolução
- [ ] Upload de exames (PDF/imagem) para histórico clínico
- [ ] Renovação automática de plano com lembrete antes do fim do ciclo
- [ ] MSG 2-10 do roteiro WhatsApp original (ainda não disparadas)

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
