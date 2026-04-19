# Changelog · Instituto Nova Medida

> Registro cronológico de tudo que foi entregue. A entrada mais recente
> fica no topo. Cada entrada tem data, autor (humano ou IA) e o que
> mudou.

---

## 2026-04-19 · Sprint 4.1 (1/3) — Fundação multi-médico · IA

**Por quê:** Sprint 3 fechou o pipeline comercial (paciente paga). Agora
abre o lado clínico: cadastro de médicas, agenda, sala de teleconsulta,
e o controle financeiro pra repassar honorário mensalmente. Esta entrega
é a **fundação**: schema completo + lib de vídeo + decisões registradas.
A UI (admin/médica/paciente) e as APIs vêm nas próximas entregas.

**Decisões registradas (DECISIONS.md):**

- **D-021** — Daily.co como provider de videoconferência no MVP, atrás
  da abstração `src/lib/video.ts`. Critério de migração pra Jitsi
  self-host: 3.000 consultas/mês sustentadas (provavelmente mês 12-24).
- **D-022** — Controle financeiro **interno** (sem split Asaas).
  Earnings imutáveis, payouts mensais com workflow draft → approved →
  pix_sent → confirmed. Médica vê tudo em dashboard transparente,
  Admin aprova com 4 olhos.
- **D-023** — **Não gravar** consultas por default. Opt-in caso a caso
  com consentimento expresso. Embasamento: CFM 2.314/2022 (exige
  prontuário, não vídeo), LGPD Art. 6º III (necessidade), prática de
  mercado (Doctoralia, Conexa, Telavita não gravam por default).
- **D-024** — Médicas como **PJ** (MEI/ME), valores fixos de remuneração:
  R$ 200 consulta agendada / +R$ 40 bônus on-demand / R$ 30 plantão hora.
  Plantão **é remunerado** porque sem isso a fila on-demand não
  funciona. Valores ajustáveis por médica (regra versionada).

**Schema novo (`supabase/migrations/20260419040000_doctors_appointments_finance.sql`):**

9 tabelas + 9 enums + 5 functions + 2 cron jobs:

- `doctors` — cadastro PJ (CRM, CNPJ, status, contrato/aditivo LGPD)
- `doctor_availability` — slots semanais (agendada vs plantão)
- `doctor_payment_methods` — PIX + bancário, 1 ativo por médica
- `doctor_compensation_rules` — regras versionadas por effective_from/to
- `appointments` — consultas (scheduled / on_demand), com sala Daily,
  recording_consent, prontuário (anamnese/hipotese/conduta), Memed
- `appointment_notifications` — log de WhatsApp/email por consulta
- `doctor_earnings` — ganhos imutáveis (consultation, on_demand_bonus,
  plantao_hour, adjustment, bonus, refund_clawback) com lifecycle
  pending → available → in_payout → paid
- `doctor_payouts` — lotes mensais (1 por médica/período), workflow
  draft → approved → pix_sent → confirmed (ou cancelled/failed)
- `doctor_billing_documents` — NF-e enviadas pela médica + validação

Functions Postgres:
- `compute_earning_available_at(doctor_id, payment_id)` — calcula
  janela D+7 PIX / D+3 boleto / D+30 cartão usando regra da médica
- `recalculate_earnings_availability()` — promove pending → available
- `generate_monthly_payouts(period?)` — agrega earnings em payouts draft

Cron jobs (pg_cron — habilitado nesta sprint):
- `inm_recalc_availability` — diário 00:00 BRT
- `inm_monthly_payouts` — dia 1, 06:00 BRT

RLS:
- View `doctors_public` (read pra anon — só campos seguros, usada em
  `/agendar`)
- Médica enxerga só próprios dados (helpers `current_doctor_id()`,
  `jwt_role()`)
- Admin enxerga tudo (via custom JWT claim `role='admin'`)
- Anon nega tudo (deny-by-default)

**Lib `src/lib/video.ts`:**

- Interface `VideoProvider` (createRoom, getJoinTokens, deleteRoom,
  validateWebhook) — agnóstica de provider
- `DailyProvider` — implementação completa com:
  - Defaults D-021 (prejoin true, chat false, max 2, eject on exp)
  - Idempotência por nome de sala (auto delete+recreate em 400)
  - Tokens de owner (médica) e participant (paciente) separados
  - Validação de webhook por secret estático constant-time
- Helper `provisionConsultationRoom()` — cria sala + tokens em uma
  chamada (formato pronto pra persistir em `appointments`)
- Singleton `getVideoProvider()` controlado por env `VIDEO_PROVIDER`
  (default `daily`) pra facilitar troca futura

**Validado:**

- API key Daily testada (HTTP 200), domínio descoberto
  (`instituto-nova-medida.daily.co`), criação + delete de sala teste OK
- Migration aplicada via psql direto no Supabase São Paulo
- 9 tabelas + 9 enums + 5 functions + 2 cron jobs presentes
- RLS habilitado em 5/5 tabelas críticas
- pg_cron habilitado (extensão necessária pros jobs)

**Documentação nova/atualizada:**

- `docs/COMPENSATION.md` — modelo financeiro completo (princípios,
  workflow mensal, dashboards, política de chargeback, métricas)
- `docs/WHATSAPP_TEMPLATES.md` — 7 templates pra submeter na Meta
  (5 de agendamento + 2 financeiros), todos categoria UTILITY pt_BR
- `docs/SPRINTS.md` — Sprint 3 marcada como ✅ concluída; Sprint 4
  detalhada em 4.1 (fundação) + 4.2 (fila on-demand + Memed)
- `docs/DECISIONS.md` — D-021, D-022, D-023, D-024
- `.env.local` — `DAILY_API_KEY`, `DAILY_DOMAIN`,
  `DAILY_WEBHOOK_SECRET` adicionados

**Pendente desta entrega (próximas sub-entregas Sprint 4.1):**

- Adicionar Daily.co envs no Vercel (precisa VERCEL_TOKEN do operador)
- Auth de médica + admin (Supabase Auth com role no JWT claim)
- Páginas: `/admin/doctors`, `/admin/payouts`, `/admin/financeiro`,
  `/medico` (dashboard), `/medico/agenda`, `/medico/financeiro`,
  `/medico/configuracoes`, `/agendar` (paciente)
- API routes: `POST /api/appointments`, `POST /api/daily/webhook`,
  extensão de `POST /api/asaas/webhook` (criar earning em
  `PAYMENT_RECEIVED`, clawback em `PAYMENT_REFUNDED`),
  `POST /api/admin/payouts/[id]/(approve|pay|confirm)`
- Lib `whatsapp.ts` extendida com helpers dos 7 templates
- pg_cron: `accrue_plantao_hours()` (a cada hora) e
  `notify_pending_documents()` (diário)
- Validação E2E em produção: criar médica de teste → appointment →
  sala criada → webhook → earning → payout draft

---

## 2026-04-19 · Last-mile comercial — landing → /planos · IA

**Por quê:** a Sprint 3 deixou `/planos` e o checkout funcionando, mas
nenhuma seção da landing apontava para lá. Visitante decidido a comprar
não tinha caminho. Esta release fecha esse gap.

**Mudanças:**
- `Header.tsx` — novo item "Planos" no menu sticky (entre "Como
  funciona" e "Dúvidas"), via `next/link` para SPA navigation.
- `Hero.tsx` — segundo CTA "Ver planos de tratamento" como botão
  outline ao lado do CTA primário do quiz. A linha de microcopy embaixo
  vira inline ("Avaliação médica online · sem compromisso · você só
  segue se fizer sentido") pra não competir visualmente.
- `Cost.tsx` — link sutil "Ver planos de tratamento" ao lado do CTA
  principal "Começar minha avaliação". Hierarquia mantida: o quiz
  segue como caminho recomendado.
- `CaptureForm.tsx` — após gravar o lead, persiste em localStorage
  `inm_lead_id`, `inm_lead_name`, `inm_lead_phone`. Permite que o
  checkout vincule a compra ao lead original (atribuição).
- `CheckoutForm.tsx` — useEffect no mount lê esses 3 valores e
  pré-preenche nome+telefone, reduzindo fricção pra quem veio do quiz.
- `Success.tsx` — novo card "Quer adiantar?" entre o aviso de WhatsApp
  e o card de share, com CTA verde para `/planos`. Tom calculado:
  "Sem cobrança automática. Você só confirma depois da avaliação, se
  fizer sentido". Não pressiona, mas abre a porta.

**Jornadas suportadas após esta release:**
1. Visitante → quiz → lead → WhatsApp (caminho original)
2. Visitante → quiz → lead → /planos → checkout (vincula leadId)
3. Visitante → /planos → checkout (compra direta sem quiz)
4. Visitante → header "Planos" a qualquer momento

Build limpo. Atribuição de lead→compra preservada via localStorage
(server-side a vinculação acontece no insert da tabela `payments`
quando o `/api/checkout` recebe `leadId`).

---

## 2026-04-19 · Sprint 3 (1/2) — Pagamentos Asaas (estrutura + páginas) · IA

**Por quê:** com a Sprint 2 fechada e o site no ar, o próximo gargalo é
fechar o ciclo "lead → consulta → pagamento". Fechamos a parte de
pagamento agora; consulta + prescrição entram na Sprint 4. Operador ainda
não tem CNPJ próprio, então rodamos tudo em **Asaas sandbox** — quando o
CNPJ destravar, basta trocar `ASAAS_API_KEY` no Vercel (ver D-019).

**Decisões registradas:**
- `D-019` — Asaas sandbox enquanto o CNPJ não chega
- `D-020` — Estrutura societária recomendada (SLU + RT médico contratado)
  com checklist operacional e estimativas de prazo/custo

**Schema (migration `20260419030000_asaas_payments.sql`):**
- `plans` — catálogo dos 3 tiers (Essencial / Avançado / Avançado Plus),
  preços em centavos, features em jsonb, leitura pública via RLS
- `customers` — clientes Asaas, chave única por CPF, endereço pra entrega
- `subscriptions` — estrutura criada já (vazia até Sprint 5)
- `payments` — 1 row por checkout, status espelha enum do Asaas (15
  estados), invoice URL/boleto/QR PIX salvos
- `asaas_events` — log raw de webhooks pra idempotência + auditoria
- RLS deny-by-default em customers/subscriptions/payments/asaas_events
  (service_role escreve tudo via backend)
- Seed dos 3 planos aplicado direto no Postgres do Supabase

**Lib (`src/lib/asaas.ts`):**
- Cliente HTTP com sandbox/produção switching automático
  (`https://sandbox.asaas.com/api/v3` ↔ `https://api.asaas.com/v3`)
- `createCustomer()`, `getCustomer()`
- `createPayment()` — PIX/boleto/cartão (com 3x via installmentCount)
- `getPayment()`, `getPaymentPixQrCode()`
- `createSubscription()` — pronta pra Sprint 5
- `isWebhookTokenValid()` — comparação em tempo constante (defesa contra
  timing attack)
- Resultado tipado em union `{ ok: true, data }` ou `{ ok: false, code, message }`
  no mesmo padrão do `whatsapp.ts`

**API routes:**
- `POST /api/checkout` — valida 11 campos, busca/cria customer (idempotente
  por CPF), cria cobrança, salva tudo no Supabase, retorna `invoiceUrl`
  pra redirecionar
- `POST /api/asaas/webhook` — persiste raw em `asaas_events` (idempotente
  via `asaas_event_id`), atualiza `payments` (status, invoice_url,
  paid_at/refunded_at), valida token de auth em tempo constante (exigido
  só em produção)
- `GET /api/asaas/webhook` — healthcheck pra testar a URL no painel Asaas

**Páginas (todas com mesma estética cream/sage/terracotta+ink):**
- `/planos` — server component que lê `plans` do Supabase, 3 cards (o
  destacado tem fundo `ink-800`), seção "incluso em todos", FAQ enxuto
- `/checkout/[plano]` — server component que carrega o plano, renderiza
  `CheckoutForm` (client) com:
  - Máscara de CPF/telefone/CEP feitas à mão (sem libs, bundle leve)
  - Validação de CPF pelos dígitos verificadores
  - Auto-preenchimento via ViaCEP (e foco automático no número)
  - Resumo lateral sticky com total dinâmico por método de pagamento
  - 3 opções: PIX, cartão 3x, boleto (preço PIX/boleto = price_pix_cents,
    cartão = price_cents)
  - Aceite explícito Termos + Privacidade (LGPD)
- `/checkout/sucesso` — confirmação para cartão aprovado
- `/checkout/aguardando` — confirmação para PIX/boleto aguardando

**Métricas do build:**
- Build limpo em 36s, 14 rotas no total
- `/checkout/[plano]` → 6.44 kB (107 kB First Load) — formulário completo
- `/planos` → 2.35 kB (103 kB First Load) — server component

**Arquivos:**
- `supabase/migrations/20260419030000_asaas_payments.sql` (315 linhas)
- `src/lib/asaas.ts` (310 linhas)
- `src/app/api/checkout/route.ts` (267 linhas)
- `src/app/api/asaas/webhook/route.ts` (170 linhas)
- `src/app/planos/page.tsx` (309 linhas)
- `src/app/checkout/[plano]/page.tsx` (78 linhas)
- `src/app/checkout/sucesso/page.tsx` (102 linhas)
- `src/app/checkout/aguardando/page.tsx` (108 linhas)
- `src/components/CheckoutForm.tsx` (498 linhas — client component)

**Pendências da Sprint 3 (parte 2/2):**
- Operador cria conta sandbox em https://sandbox.asaas.com (grátis, sem
  CNPJ), gera API key e compartilha
- IA pluga `ASAAS_API_KEY` no `.env.local` e no Vercel (3 envs)
- Configura webhook no painel Asaas → URL =
  `https://instituto-nova-medida.vercel.app/api/asaas/webhook` + token
  `inm_asaas_webhook_2026_8gT4nW2cR6bV9pK`
- Testa ponta-a-ponta: `/planos` → checkout → invoice → simular pagamento
  no painel sandbox → ver `payments.status` virar `RECEIVED` no Supabase
- Adiciona link "Quero começar" do hero da home pra `/planos`

---

## 2026-04-19 · Páginas legais publicadas (Termos, Privacidade, Sobre) · IA

**Por quê:** LGPD obriga publicação de Política de Privacidade clara e
acessível. CDC exige Termos de Uso. Mais relevante para o momento: a
**Meta Business Manager checa essas páginas** durante a verificação do
site — publicar agora, antes de pedir reanálise, aumenta muito a
chance de aprovação rápida.

**Arquitetura:**
- `src/components/LegalShell.tsx` — wrapper compartilhado com header
  simples (logo + "Voltar ao site"), tipografia rica
  (H2/H3/P/UL/LI/Aside/TOC/Section), Footer reutilizado da home
- `src/components/Logo.tsx` — agora aceita prop `href` (default
  `#top`) pra apontar pra `/` quando usado em páginas internas
- `src/components/Footer.tsx` — links âncora viraram `/#secao` pra
  funcionar de páginas internas; `/lgpd` e `/cookies` consolidados em
  `/privacidade#contato` e `/privacidade#cookies`; adicionado `/sobre`

**Páginas:**

| Rota | Conteúdo | Tamanho | Seções |
|---|---|---|---|
| `/termos` | Termos de Uso | 75 kB | 14 (objeto, natureza CFM/Anvisa, elegibilidade, consulta, prescrição, pagamento c/ direito de arrependimento art. 49 CDC, WhatsApp, uso aceitável, limitação responsabilidade, propriedade intelectual, vigência, foro) |
| `/privacidade` | Política de Privacidade | 86 kB | 13 (controlador, dados coletados, finalidades, bases legais LGPD, compartilhamento, retenção, segurança, direitos do titular, cookies, menores, transferência internacional, alterações, DPO) |
| `/sobre` | Sobre o Instituto | 43 kB | 6 (missão, como atendemos, valores, conformidade regulatória, quem somos, contato) |

**Dependências legais cobertas no texto:**
- Lei nº 14.510/2022 (telessaúde)
- Resolução CFM nº 2.314/2022 (telemedicina)
- Resolução CFM nº 1.821/2007 (guarda de prontuário 20 anos)
- Código de Ética Médica
- Nota Técnica Anvisa nº 200/2025 (manipulação GLP-1)
- LGPD (Lei nº 13.709/2018)
- CDC (art. 49 — direito de arrependimento; art. 101 — foro)
- Marco Civil da Internet (art. 15 — guarda de logs 6 meses)
- Código Tributário Nacional (art. 174 — guarda de docs fiscais 5 anos)

**SEO:**
- `sitemap.ts` lista todas as 4 URLs públicas (lê
  `NEXT_PUBLIC_SITE_URL`)
- `layout.tsx` ganhou `metadata.title.template`, twitter card e
  `category: "health"`
- Cada página define `alternates.canonical` próprio e robots
  `index, follow`

**Bug de bonus encontrado e fixado:**
- `NEXT_PUBLIC_SITE_URL` no Vercel estava com `\n` literal no final
  (mesmo bug do `WHATSAPP_ACCESS_TOKEN` — `echo` adicionou newline).
  Sintoma: sitemap renderizava `<loc>https://...vercel.app\n/sobre</loc>`,
  inválido pra crawlers do Google e Meta. Fix: removido + readicionado
  com `printf` em todos os 3 ambientes.

**Validação em produção:** todas as rotas retornam 200, sitemap
limpo (4 URLs sem newline), footer atualizado.

> **Disclaimer técnico:** os textos legais foram redigidos como
> rascunho profissional consistente com a legislação vigente, mas
> precisam de revisão de advogado especializado em direito digital
> e saúde antes da entrada em operação comercial real (especialmente
> CNPJ, endereço, nome do RT médico, política específica de reembolso
> pós-manipulação).

---

## 2026-04-19 · Site no ar em produção (Vercel) · IA + operador

**URL pública oficial:** **https://instituto-nova-medida.vercel.app**

(também responde por `https://project-o43e3.vercel.app` — alias da
Vercel, equivalente)

**Operador:**
- Criou projeto no Vercel (`prj_rsFlqlcbanQe6EtPhuRBeS5icIJ0`)
- Subiu repositório no GitHub (`cabralandre82/instituto-nova-medida`)
- Gerou Vercel API token e entregou pra IA executar deploy via CLI

**IA — passos do deploy:**
1. `vercel link` → vinculou repo local ao projeto Vercel
2. Confirmou que as 10 env vars (Supabase + Meta) já estavam no
   projeto (operador subiu pela UI)
3. Trocou `WHATSAPP_ACCESS_TOKEN` (operador tinha acabado de
   regerar) — usou `printf` em vez de `echo` pra evitar trailing
   newline corruption
4. Detectou que o projeto Vercel **não tinha framework configurado**
   (`framework: null`) → primeiro deploy retornava 404 em tudo.
   Setou via API: `framework: "nextjs", nodeVersion: "20.x"`
5. Desligou `ssoProtection` (Vercel tinha ligado por padrão e
   bloqueava acesso público com 401)
6. Adicionou alias custom `instituto-nova-medida.vercel.app`
7. Adicionou `NEXT_PUBLIC_SITE_URL` apontando pra URL final
8. Deploy de produção em **35 segundos** com 8 rotas:
   - `/` (147 kB First Load) — landing renderizada estaticamente
   - `/api/lead` — serverless function (lead capture + WhatsApp)
   - `/api/wa/webhook` — serverless function (Meta webhook)
   - `/robots.txt`, `/sitemap.xml` — SEO
9. Pinou todas as funções na região **`gru1` (São Paulo)** via
   `vercel.json` pra reduzir latência pros clientes BR

**IA — fix de comportamento serverless no `/api/lead`:**

Em produção descobriu que o `void async` (fire-and-forget) que
disparava o WhatsApp depois do `return NextResponse.json(...)` era
**abortado pelo runtime serverless** assim que a resposta HTTP saía
— diferente do dev local onde o processo Node continua vivo.

Sintoma: lead persistia no Supabase mas `whatsapp_msg1_status`
ficava NULL (mensagem nunca disparada).

Fix: trocou `void (async () => {...})()` por `await` direto antes do
`return`. Cliente espera ~500ms a mais por causa do round-trip à
Meta, mas garantimos disparo + tracking no mesmo ciclo.

Commit: `bc1d145` — `fix(api/lead): await WhatsApp dispatch in
serverless runtime`

**Validação E2E em produção:**

| Endpoint | Resultado |
|---|---|
| `GET /` | HTTP 200, 43kB, landing completa renderizada |
| `POST /api/lead` | persistiu lead `0fe3e46d-eb21-474a-b2c1-ce87ee986ea0` no Supabase |
| `GET /api/wa/webhook?hub.mode=subscribe...` | retorna `hub.challenge` ✓ (handshake da Meta funcionando) |
| `GET /robots.txt` | OK |
| `GET /sitemap.xml` | OK |

**Pendência: WhatsApp em produção (erro 131005)**

POST `/messages` no runtime Vercel retorna `(#131005) Access denied`
mesmo com token byte-idêntico ao que funciona via curl residencial.

Diagnóstico (via endpoint `/api/debug/wa-env` temporário, removido
após confirmação):
- `runtime_region`: `gru1` (Brasil) — geo-IP descartado
- `outbound_ip`: `56.124.125.161` (AWS)
- Token: `length=288`, `sha256_first16=5d6eaf5bb22f8cdc` — IDÊNTICO
  ao token correto (sem whitespace, sem aspas, sem newline)
- GET `/{phone_id}?fields=...` → **200 OK**
- POST `/{phone_id}/messages` → **403 (#131005)** mesmo com
  `appsecret_proof`

**Causa raiz:** o token gerado no painel "Get Started" do WhatsApp
Cloud API é um **User Access Token** vinculado à sessão do
navegador. A Meta documenta:

> "User access tokens are only used for testing in the developer
> dashboard. For production server applications, you must use a
> System User access token."

A Meta libera `User AT` quando vem de IP residencial (assume que é
"você testando no terminal"), mas bloqueia chamadas server-to-server
de IPs cloud (AWS/Vercel/etc).

**Ação corretiva (depende da Meta destravar Business Manager):**

Quando o BM reativar (ver próximo bloco), gerar um **System User
Token permanente** em Settings → Users → System Users → Generate
Token, com escopos `whatsapp_business_management` e
`whatsapp_business_messaging`. Trocar `WHATSAPP_ACCESS_TOKEN` no
Vercel via `printf "%s" "$NEW_TOKEN" | vercel env add ...`.
Nenhuma mudança de código necessária.

**Ação para o operador AGORA — destravar Business Manager:**

1. Acesse https://business.facebook.com → seu Business Manager
2. Configurações da Empresa → Informações da Empresa
3. Em **Site da Empresa**, coloque: `https://instituto-nova-medida.vercel.app`
4. Salve e clique em **Solicitar nova análise**
5. Meta verifica em 24-48h. Quando aprovar, BM volta ao normal.
6. Aí seguimos com o System User Token (passo acima).

---

## 2026-04-19 · Sprint 2 — primeira mensagem WhatsApp entregue 🎯 · IA + operador

**Operador:**
- Cadastrou e verificou o número **+55 21 99885-1851** (chip dedicado)
  como destinatário do test number da Meta.

**IA:**
- Atualizou `WHATSAPP_PHONE_DISPLAY` no `.env.local`
- Disparou `hello_world` direto via curl → Meta retornou
  `{"message_status":"accepted","id":"wamid.HBgN...8E79A424CB3A2F85ED..."}`
  → mensagem entregue no WhatsApp do operador 🎯
- Disparou via `/api/lead` (fluxo real do site) → lead
  `50c411d1-251d-4ce0-bd8e-73526ab54310` persistido + WhatsApp
  enviado com sucesso (`status='sent'`, `message_id=wamid.HBgN...4DAA9A8A52E4A33F2A...`)
  → segunda mensagem entregue no WhatsApp do operador 🎯

**Sprint 2 (lead capture + WhatsApp pipeline) ENCERRADO.**

**Próximos passos sugeridos (operador escolhe ordem):**
1. Submeter template `boas_vindas_inicial` em pt_BR no WhatsApp Manager
   (copy pronta em `docs/COPY.md`) → quando aprovar, mensagem chega na
   identidade do Instituto, não mais o "hello_world" da Meta
2. Implementar webhook `/api/wa/webhook` pra capturar
   delivered/read/respostas e atualizar a coluna `whatsapp_msg1_status`
3. Sprint 3: Asaas (planos + cobranças PIX/cartão)
4. Sprint 4: Memed (prescrição) + Daily.co (videoconsulta)
5. Continuar lapidando landing/quiz/UX

---

## 2026-04-19 · Sprint 2 — pipeline WhatsApp ponta-a-ponta plugado · IA + operador

**Operador:**
- Compartilhou os 2 IDs do test number da Meta:
  - `WHATSAPP_PHONE_NUMBER_ID=1093315577192606`
  - `WHATSAPP_BUSINESS_ACCOUNT_ID=3610674345738807`

**IA:**
- Gravou ambos no `.env.local`
- Disparou request de teste via `curl` direto na Graph API
  (`POST /v21.0/{phone_number_id}/messages` com `hello_world`):
  - Resposta esperada: erro `131030` "Recipient phone number not in
    allowed list" → confirmou que **token, IDs e payload estão corretos**
- Criou `src/lib/whatsapp.ts` com:
  - `normalizeBrPhone()` — normalização BR para E.164 sem '+'
  - `sendTemplate()` — envia template aprovado (com variáveis)
  - `sendText()` — envia texto livre (dentro da janela de 24h)
  - `sendBoasVindas()` — wrapper específico do MSG 1; usa `hello_world`
    enquanto template customizado não é aprovado pela Meta
- Criou migration `20260419010000_leads_whatsapp_tracking.sql`:
  - Adiciona colunas `whatsapp_msg1_status`, `whatsapp_msg1_message_id`,
    `whatsapp_msg1_sent_at`, `whatsapp_msg1_error`
  - Check constraint pros valores válidos do status
  - Índice parcial pra queries de retry/observabilidade
- Aplicou a migration no Postgres do Supabase via `psql`
- Plugou o disparo automático em `src/app/api/lead/route.ts`:
  - Após insert do lead, chama `sendBoasVindas()` em paralelo (não
    bloqueia a resposta ao cliente)
  - Sucesso → grava `status='sent'` + `message_id` + `sent_at`
  - Falha → grava `status='failed'` + `error`
- Reiniciou dev server e validou ponta-a-ponta com `curl POST /api/lead`:
  - lead `e1df1674-d140-4b40-8700-89d9c39a9220` persistido ✅
  - WhatsApp falhou com 131030 (esperado) ✅
  - Falha gravada na coluna `whatsapp_msg1_error` ✅
- Documentou template `boas_vindas_inicial` em `docs/COPY.md` (a
  submeter no WhatsApp Manager quando convier)

**Único bloqueio pra mensagem chegar de fato no WhatsApp:**
- Operador precisa ir em **WhatsApp → Configuração da API → seção "Para"**
  → cadastrar +55 21 99732-2906 → confirmar com código de 6 dígitos.
- Após isso, qualquer lead criado pelo site dispara mensagem real.

---

## 2026-04-19 · Sprint 2 — token recebido + WABA restrita, pivot pra test number · IA + operador

**Operador:**
- Compartilhou `WHATSAPP_ACCESS_TOKEN` temporário (24h)
- Reportou erro `#2655121:WBxP-783273915-4224144161` ao tentar adicionar o
  número `+55 21 99732-2906` à Meta Cloud API. Causa: número estava no app
  WhatsApp Business no celular, foi apagado, Meta colocou em quarentena
  anti-fraude.

**IA:**
- Gravou o access token em `.env.local`
- Decidiu: **pivot pra Test Number da Meta** em vez de esperar a quarentena.
  Test number é gratuito, sem restrição, permite até 5 destinatários
  verificados e basta trocar `WHATSAPP_PHONE_NUMBER_ID` quando o número
  próprio destravar (ver `docs/DECISIONS.md` §6).
- Atualizou `docs/META_SETUP.md` com:
  - Passo-a-passo pra obter WABA ID + Phone Number ID do test number
  - Instruções pra verificar o +55 21 99732-2906 como destinatário de teste
  - Plano paralelo: aguardar 24-72h + abrir caso no Meta Business Support
  - Mensagem-modelo pro suporte da Meta (em pt-BR, com o código do erro)

**Pendente do operador (próxima mensagem):**
- WABA ID do test number da Meta
- Phone Number ID do test number da Meta
- Verificação do número pessoal (+55 21 99732-2906) na lista de
  destinatários do test number
- (Em paralelo, opcional) abrir caso no Meta Business Support

---

## 2026-04-19 · Sprint 2 — migration aplicada + Meta App criado · IA + operador

**Operador:**
- Criou app **Instituto Nova Medida** no developers.facebook.com
- Selecionou permissões: WhatsApp + Marketing API (CAPI para conversões)
- Cadastrou número WhatsApp Business: **+55 21 99732-2906**
- Compartilhou: App ID `945100698512733`, App Secret e Client Token

**IA:**
- Conectou diretamente no Postgres do Supabase via psql + IPv6
  (`db.rlgbxptgglqeswcyqfmd.supabase.co:5432`)
- Aplicou a migration `20260419000000_initial_leads.sql` com sucesso
- Validou estrutura: 19 colunas, 5 índices, 2 check constraints, trigger
  `updated_at`, RLS habilitado, 2 policies de deny
- Testou `/api/lead` ponta-a-ponta com `curl` → lead persistido
  (`id: 89729211-8042-4049-8f51-5cc66abe836a`) com IP, UA, UTM, answers,
  consent_at, referrer corretamente capturados
- Atualizou `.env.local` com credenciais Meta (App ID + App Secret +
  Client Token + telefone)
- Gerou `WHATSAPP_WEBHOOK_VERIFY_TOKEN` aleatório
- Criou `docs/META_SETUP.md` com passo-a-passo completo

**Pendente do operador (próxima mensagem):**
- WHATSAPP_BUSINESS_ACCOUNT_ID (WABA ID)
- WHATSAPP_PHONE_NUMBER_ID
- WHATSAPP_ACCESS_TOKEN (temporário 24h, ok pra começar)
- Rotacionar credenciais Meta+Supabase antes de produção

---

## 2026-04-19 · Sprint 2 — bootstrap Supabase + lead persistido · IA

**Decisões deste turno:**
- Projeto Supabase criado (região São Paulo, RLS automático ativado)
  - Project ref: `rlgbxptgglqeswcyqfmd`
  - URL: `https://rlgbxptgglqeswcyqfmd.supabase.co`
- Estratégia de RLS para `leads`: deny total para anon e authenticated.
  Toda escrita/leitura passa pelo backend usando service_role.

**Conexão com Supabase validada:**
- REST root → HTTP 200 ✓
- service_role autenticando ✓

**Mudanças no código:**
- `src/lib/supabase.ts` — cliente lazy com 2 modos: `getSupabaseAdmin()`
  (server-only, service_role) e `getSupabaseAnon()` (RLS).
- `src/app/api/lead/route.ts` — agora persiste no Supabase com snapshot do
  texto LGPD aceito, IP, user_agent, referrer, UTM e landing_path.

**Arquivos novos:**
- `.env.local` (gitignored) com credenciais do Supabase
- `.env.example` (commitable) — template completo de envs
- `supabase/migrations/20260419000000_initial_leads.sql` — schema
  inicial da tabela `leads` com índices, trigger `updated_at`, ENUM
  `lead_status` e RLS restritivo.

**Pendente do operador:**
- Rodar a migration no SQL Editor do Supabase
- Rotacionar credenciais antes de subir para produção
- Criar conta no Meta for Developers (próximo passo)

---

## 2026-04-19 · Sprint 1 — ajustes pós-entrega · IA

**Decisões deste turno:**
- Marca renomeada: "Mais Leve" → **Instituto Nova Medida**
- Domínio: `institutonovamedida.com.br`
- Imagens: hospedagem própria em `/public` (sem dependência externa)
- Pagamento: PIX/boleto à vista, parcelamento até 3x apenas no cartão
- Documentação versionada em `docs/`

**Mudanças no código:**
- `src/components/Logo.tsx` — novo logo (monograma circular + bilinha
  "Instituto / Nova Medida")
- `src/app/layout.tsx` — metadata com nova marca, novo `metadataBase`
- `src/app/sitemap.ts` e `src/app/robots.ts` — domínio atualizado
- `src/components/Footer.tsx` — disclaimer societário com novo nome,
  e-mail do DPO, link copy atualizado
- `src/components/Hero.tsx` — usa `/hero-paciente.jpg` (local), atualiza
  citação do floating card
- `src/components/HowItWorks.tsx` — usa `/consulta-online.jpg` (local),
  alt-text adequado
- `src/components/Faq.tsx` — pergunta sobre pagamento corrigida; pergunta
  "Quem está por trás" atualizada
- `src/components/Quiz.tsx` — header "Instituto Nova Medida"
- `src/components/Success.tsx` — share URL atualizada
- `src/app/api/lead/route.ts` — log key atualizada
- `next.config.js` — removido `remotePatterns` (não usamos mais Unsplash)
- `package.json` — name atualizado, pasta renomeada para
  `instituto-nova-medida`

**Imagens adicionadas:**
- `public/hero-paciente.jpg` (157 KB, 1200×1800)
- `public/consulta-online.jpg` (180 KB, 1200×800)

**Documentação criada:**
- `docs/README.md` (índice)
- `docs/PRODUCT.md` (visão de produto)
- `docs/DECISIONS.md` (11 ADRs registradas)
- `docs/ARCHITECTURE.md` (stack, schema preliminar, integrações)
- `docs/SPRINTS.md` (Sprint 1 fechado, Sprints 2–7 escopados)
- `docs/COMPLIANCE.md` (CFM, Anvisa, LGPD)
- `docs/PRICING.md` (tiers, splits, lógica financeira)
- `docs/BRAND.md` (paleta, tipografia, voz)
- `docs/COPY.md` (copy oficial canônica)
- `docs/SECRETS.md` (lista de credenciais — sem valores)
- `docs/CHANGELOG.md` (este arquivo)

---

## 2026-04-18 · Sprint 1 — entrega inicial · IA

**Setup do projeto:**
- Next.js 14.2.18 + React 18 + TypeScript estrito
- Tailwind CSS 3 + design tokens próprios
- Framer Motion 11 para animações
- Fontes Google: Fraunces (display) + Inter (corpo)

**Componentes criados:**
- `Logo`, `Header`, `Hero`, `Identification`, `Shift`, `Access`,
  `HowItWorks`, `Desire`, `Cost`, `Faq`, `Footer`
- `Quiz` (4 perguntas + barra de progresso animada)
- `CaptureForm` (nome + WhatsApp + máscara + opt-in LGPD)
- `Success` (share WhatsApp + copiar link)

**API:**
- `/api/lead` (POST, validação básica, log estruturado)

**SEO/PWA:**
- `metadata` completa (title, description, OG, locale pt_BR)
- `sitemap.ts` dinâmico
- `robots.ts`
- `icon.svg` favicon

**Build inicial:**
- Compilado sem erros
- 147 kB First Load JS
- 8 rotas geradas

**Pesquisas regulatórias realizadas:**
- Anvisa Nota Técnica nº 200/2025 (manipulação tirzepatida) ✓
- CFM 2.314/2022 (telemedicina) ✓
- Anvisa abril/2026 (proibição Gluconex e Tirzedral) ✓

**Decisões de stack consolidadas:**
- Pagamento: Asaas
- Receita digital: Memed
- Vídeo: Daily.co (MVP) → Jitsi self-hosted (escala)
- Backend: Supabase (São Paulo)
- WhatsApp: Cloud API oficial (Meta)
- Hospedagem: Vercel + Cloudflare
