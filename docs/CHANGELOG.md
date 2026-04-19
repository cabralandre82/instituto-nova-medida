# Changelog · Instituto Nova Medida

> Registro cronológico de tudo que foi entregue. A entrada mais recente
> fica no topo. Cada entrada tem data, autor (humano ou IA) e o que
> mudou.

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
