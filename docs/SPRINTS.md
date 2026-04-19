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

## 🟡 Sprint 2 · Backend + Persistência + WhatsApp · próxima

**Objetivo:** Lead da landing vai parar no Supabase e dispara automação
WhatsApp (MSG 1–10 do documento de estratégia).

### Entregáveis

- [ ] Conta Supabase (região São Paulo) — *credencial pendente*
- [ ] Schema completo do banco (leads, pacientes, médicas, consultas,
      prescricoes, ciclos, mensagens_wa, eventos_lgpd)
- [ ] Row Level Security (RLS) policies
- [ ] `/api/lead` persistindo no Supabase
- [ ] Conta Meta for Developers + WhatsApp Business — *credencial pendente*
- [ ] Templates aprovados pela Meta (MSG 1–10)
- [ ] Worker de disparo automático (cron ou inngest/qstash)
- [ ] Webhook `/api/wa/incoming` recebendo respostas
- [ ] Detecção de "SIM" / "NÃO" / dúvida → fluxo apropriado
- [ ] Painel mínimo de leads (admin) para acompanhar conversões

### Definição de pronto

Um lead novo no quiz dispara MSG 1 em até 60 segundos. Resposta do
paciente é registrada e dispara MSG seguinte do fluxo.

---

## ⚪ Sprint 3 · Área do Paciente

**Objetivo:** Paciente consegue agendar consulta, assinar TCLE, fazer
videoconsulta e ver seu histórico.

### Entregáveis

- [ ] Auth do paciente (Supabase Auth, magic link via WhatsApp/email)
- [ ] Onboarding 3 minutos: TCLE eletrônico + anamnese curta + dados básicos
- [ ] Escolha: agendar horário OU entrar em fila ("próxima médica disponível")
- [ ] Página de teleconsulta (Daily.co embed + chat)
- [ ] Pagamento Asaas (PIX, boleto à vista, cartão 3x sem juros)
- [ ] Página "Meu tratamento": dose atual, próxima reconsulta, exames
- [ ] Upload de exames (PDF/imagem) para histórico

---

## ⚪ Sprint 4 · Área da Médica

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

## ⚪ Sprint 5 · Admin + Indicação + Analytics

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

## ⚪ Sprint 6 · Conteúdo, SEO e crescimento orgânico

- [ ] Blog (rota `/blog` com MDX)
- [ ] Páginas de cidade ("emagrecimento online em São Paulo")
- [ ] Página de imprensa
- [ ] Página "Para médicas" (recrutamento)
- [ ] Schema.org MedicalBusiness + FAQ + Article

---

## ⚪ Sprint 7 · Hardening e LGPD operacional

- [ ] Termos de uso e Política de Privacidade redigidos por advogado de saúde
- [ ] Encarregado de Dados (DPO) contratado/nomeado
- [ ] Painel de exercício de direitos LGPD (paciente solicita acesso/correção/exclusão)
- [ ] Auditoria de logs e backup
- [ ] Sentry + alertas
- [ ] Pen-test inicial
