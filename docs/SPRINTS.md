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

## 🟡 Sprint 3 · Pagamentos (Asaas) · em andamento

**Objetivo:** Paciente clica num plano, preenche dados de identificação
+ entrega, paga via PIX/cartão/boleto, e o status da cobrança é
rastreado no Supabase via webhook do Asaas.

**Modo:** sandbox (`https://sandbox.asaas.com/api/v3`) até o operador
abrir o CNPJ próprio. Migração pra produção = trocar `ASAAS_API_KEY`
no Vercel. Ver decisão `D-019`.

### Entregáveis

- [ ] Conta Asaas sandbox + API key — *credencial pendente do operador*
- [ ] Schema Supabase: `plans`, `customers`, `payments`,
      `subscriptions`, `asaas_events` (migrations versionadas)
- [ ] Seed dos 3 planos atuais (Essencial, Avançado, Avançado Plus)
      conforme `docs/PRICING.md`
- [ ] `src/lib/asaas.ts` — cliente da API com:
  - `createCustomer()` — vinculado ao `lead.id`
  - `createPayment()` — cobrança avulsa (PIX/cartão/boleto)
  - `createSubscription()` — recorrência mensal
  - `getPayment()`
  - tratamento de erros tipado
  - sandbox/prod switching automático
- [ ] Página `/planos` — 3 cards bonitos com tiers, comparação clara,
      CTA "Quero esse plano"
- [ ] Página `/checkout/[plano]` — formulário com:
  - Dados pessoais (nome, CPF, email, telefone)
  - Endereço de entrega (auto-preenchido por CEP via ViaCEP)
  - Escolha de forma de pagamento (PIX / cartão 3x / boleto)
  - Aceite explícito dos termos + privacidade
- [ ] `POST /api/checkout` — cria customer + cobrança no Asaas, salva
      em `payments`, redireciona pra invoice URL hospedada
- [ ] `POST /api/asaas/webhook` — recebe `PAYMENT_*` events
      (CREATED, RECEIVED, OVERDUE, REFUNDED, CHARGEBACK), valida HMAC,
      registra raw em `asaas_events`, atualiza `payments.status`
- [ ] Páginas pós-checkout:
  - `/checkout/sucesso` — pagamento confirmado
  - `/checkout/aguardando` — PIX/boleto gerado, aguardando confirmação
- [ ] `docs/SECRETS.md` atualizado com Asaas
- [ ] `README.md` + `CHANGELOG.md` atualizados

### Fora do escopo (próximas sprints)

- Split automático com farmácia/médica → Sprint 5 (depende de
  parceiros cadastrados como subcontas Asaas)
- Renovação automática + lembrete antes do fim do ciclo → Sprint 5
- Painel do paciente "minha assinatura" → Sprint 4
- Reembolso self-service → Sprint 7

### Definição de pronto

Operador entra na `/planos` na URL pública, clica num plano,
preenche checkout, escolhe PIX, é redirecionado pra invoice do Asaas
sandbox, simula o pagamento, recebe webhook, vê o `payments.status`
mudar pra `RECEIVED` no Supabase. Tudo isso em ambiente sandbox, sem
movimentar dinheiro real.

---

## ⚪ Sprint 4 · Avaliação clínica + videoconsulta + prescrição

**Objetivo:** Paciente que pagou agenda a consulta, é atendido por
videoconferência segura, recebe prescrição digital ICP-Brasil quando
indicada.

### Entregáveis

- [ ] Auth do paciente (Supabase Auth, magic link via WhatsApp/email)
- [ ] Onboarding pós-pagamento: TCLE eletrônico + anamnese curta +
      dados clínicos
- [ ] Escolha: agendar horário OU entrar em fila ("próxima médica
      disponível")
- [ ] Sala de teleconsulta (Daily.co embed + chat)
- [ ] Memed integrado (assinatura ICP-Brasil)
- [ ] Página "Meu tratamento": dose atual, próxima reconsulta, exames
- [ ] Upload de exames (PDF/imagem) para histórico
- [ ] Webhook Memed → atualiza `prescriptions` no banco

---

## ⚪ Sprint 5 · Área da Médica

**Objetivo:** Médica consegue atender com fluxo enxuto (~10 min/consulta
inicial, ~5 min/reconsulta).

### Entregáveis

- [ ] Auth da médica + verificação de CRM
- [ ] Dashboard: pacientes ativos, fila de espera, próximos agendamentos
- [ ] Sala de teleconsulta (vídeo Daily + prontuário lado-a-lado)
- [ ] Anamnese pré-preenchida pelo paciente (médica revisa)
- [ ] Triagem automática (regras de aptidão / contraindicações absolutas)
- [ ] Sugestão de prescrição (médica revisa e assina)
- [ ] Memed integrado (assinatura ICP-Brasil)
- [ ] Templates de mensagem WhatsApp (1-clique)
- [ ] Detector de alertas (efeitos colaterais graves → escalação)

---

## ⚪ Sprint 6 · Admin + Indicação + Analytics + Split de comissão

**Objetivo:** Você (operador) tem visibilidade total + máquina de
indicação rodando.

### Entregáveis

- [ ] Dashboard admin com todas as métricas (CAC, MRR, funil, churn, NPS)
- [ ] Cohort de retenção mensal
- [ ] Programa "indique e ganhe" (link rastreável + crédito automático)
- [ ] Eventos de conversão Meta Pixel + GTM + GA4
- [ ] Splits de comissão configuráveis no admin
- [ ] Onboarding de farmácia parceira (upload de licença, IFA, laudos)

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
