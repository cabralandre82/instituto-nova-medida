# Registro de Decisões · Instituto Nova Medida

> Cada decisão importante vira uma entrada permanente. Não apagamos —
> superseder a anterior se mudar de ideia, e referenciamos.

---

## D-001 · Marca: Instituto Nova Medida · 2026-04-19

**Contexto:** Precisávamos de um nome que transmitisse autoridade médica,
acolhimento e duplicidade simbólica (medida do corpo + nova abordagem).

**Decisão:** Marca = **Instituto Nova Medida**, domínio
`institutonovamedida.com.br`. Tagline: *"Não é sobre força de vontade — é
sobre o método certo."*

**Alternativas consideradas:** Mais Leve, Levea, Vivare, Lume, Plenah,
Equilibre, Curatti.

**Consequências:** "Instituto" gera percepção de seriedade científica
(positivo para um produto médico) ao custo de soar levemente menos
"consumer-friendly" — compensado com a copy emocional e tipografia humana.

---

## D-002 · Stack frontend · 2026-04-19

**Contexto:** Precisávamos de um stack moderno, com excelente DX, performance
de primeira e ecossistema rico para iterar rápido.

**Decisão:** **Next.js 14 (App Router) + TypeScript + Tailwind CSS +
Framer Motion** com Fraunces (serif display) + Inter (sans).

**Alternativas:** Next.js 15 (mais novo mas RC com React 19), Astro
(menos interatividade), Remix.

**Consequências:** Stack maduro, hospedagem ótima na Vercel, fácil de
contratar dev. Build atual: 147 kB First Load JS.

---

## D-003 · Pagamento: Asaas · 2026-04-19

**Contexto:** Precisamos de gateway com PIX, cartão recorrente, boleto e
**split automático** (para repasse à médica) — tudo no Brasil, taxas
competitivas.

**Decisão:** **Asaas** como gateway único.

**Alternativas:** Stripe (sem PIX nativo bem resolvido), Pagar.me, Mercado
Pago, Iugu.

**Consequências:** API documentada, split nativo, conformidade fiscal BR
(NF-e), suporte em português.

---

## D-004 · Receita digital: Memed · 2026-04-19

**Contexto:** Necessidade de prescrição com assinatura ICP-Brasil para
medicamentos controlados (tirzepatida).

**Decisão:** **Memed** — gratuita para o médico (monetização via farmácia),
324 integrações, líder de mercado, ICP-Brasil embutido.

**Alternativas:** Mevo (ex-Nexodata), AfyaRX, Prescrição Eletrônica do CFM.

**Consequências:** Custo zero para a plataforma, integração rápida via API,
paciente recebe receita no celular automaticamente.

---

## D-005 · Vídeo teleconsulta: Daily.co (MVP) → Jitsi self-hosted (escala) · 2026-04-19

**Contexto:** CFM 2.314/2022 exige criptografia E2E, NGS2 e
preferencialmente residência de dados no Brasil.

**Decisão:** **Daily.co** com regional residency São Paulo no MVP. Quando
ultrapassar ~50.000 minutos/mês, migrar para **Jitsi self-hosted** em
AWS São Paulo.

**Alternativas:** Twilio Video (caro), Vonage, Vidaas (white-label B2B
caro), Zoom (não compliant).

**Consequências:** Custo praticamente zero no início; transição quando
volume justificar.

---

## D-006 · Backend: Supabase · 2026-04-19

**Contexto:** Precisamos de Postgres + Auth + Storage + RLS + tempo curto
de implantação.

**Decisão:** **Supabase** com região São Paulo (LGPD-friendly).

**Alternativas:** Firebase (lock-in), AWS (mais ops), Railway+Postgres.

**Consequências:** RLS resolve isolamento de dados clínicos elegantemente;
auth e storage prontos.

---

## D-007 · WhatsApp: Cloud API oficial (Meta) · 2026-04-19

**Contexto:** WhatsApp é o canal principal de acompanhamento. Soluções
não oficiais arriscam banimento e não são compliant.

**Decisão:** **WhatsApp Cloud API oficial** com templates aprovados pela
Meta.

**Alternativas:** Z-API, Evolution API (não oficiais), Twilio WhatsApp
(intermediário caro).

**Consequências:** Zero risco de banimento, templates pré-aprovados, ótima
integração com webhooks.

---

## D-008 · Pagamento na landing: depois da consulta · 2026-04-19

**Contexto:** Estratégia de copy promete "consulta gratuita se não houver
indicação". Precisamos honrar isso no fluxo.

**Decisão:** Paciente só paga **após a consulta médica**, e somente se a
médica indicar tratamento. PIX/boleto à vista, ou cartão em até 3x sem
juros.

**Alternativas:** Pagar antes (modelo Voy/Eva).

**Consequências:** Conversão mais alta no quiz, maior confiança,
percepção de risco zero. Trade-off: maior investimento de tempo médico em
casos não convertidos — mitigado por triagem automática prévia.

---

## D-009 · Ciclo de tratamento: 90 dias · 2026-04-19

**Contexto:** Precisávamos definir granularidade do plano (mensal vs
trimestral vs anual).

**Decisão:** Pacote por **ciclo de 90 dias**. Reconsulta gratuita ao final
+ renovação. Cobrança upfront (cartão pode parcelar 3x sem juros).

**Alternativas:** Mensal (mais churn), anual (resistência inicial maior).

**Consequências:** Alinha com período clínico mínimo de avaliação;
fluxo de caixa antecipado; LTV inicial alto.

---

## D-010 · Imagens: hospedagem própria + IA · 2026-04-19

**Contexto:** Cliente prefere fazer imagens junto, sem ações externas.

**Decisão:** Imagens curadas baixadas para `/public` (eliminando
dependência de terceiros). Próxima fase: gerar variações com IA dentro do
projeto e/ou shoot próprio.

**Consequências:** Site não depende de Unsplash/CDN externa; mais
controle de licenciamento.

---

## D-011 · Documentação: pasta `docs/` versionada · 2026-04-19

**Contexto:** Cliente pediu para documentarmos todo o desenvolvimento.

**Decisão:** Tudo em Markdown na pasta `docs/`, versionado junto com o
código, atualizado a cada sessão.

**Consequências:** Memória do projeto preservada; onboarding de qualquer
nova pessoa em horas, não dias.

---

## D-012 · RLS deny-by-default em `leads` · 2026-04-19

**Contexto:** A tabela `leads` armazena dados sensíveis (nome, telefone,
respostas do quiz). Pelo design da Supabase, RLS protege contra acesso
direto via PostgREST mesmo se a anon key vazar.

**Decisão:** RLS habilitado, com policies explícitas de **deny total**
para roles `anon` e `authenticated`. Toda operação (insert, select,
update) acontece exclusivamente via backend Next.js usando a
`service_role` key (que faz bypass de RLS automaticamente).

**Alternativas consideradas:** Permitir insert via anon (mais simples,
mas expõe a tabela a abuso de captcha-bypass).

**Consequências:**
- Segurança máxima: a anon key vazada não dá acesso a nada da tabela
- Backend é o único caminho de escrita → permite rate limit, validação,
  enriquecimento (IP, UA, UTM)
- Quando criarmos painel admin (Sprint 5), adicionaremos policies para
  `role = 'admin'` claim no JWT.

---

## D-014 · Conexão direta ao Postgres para aplicar migrations · 2026-04-19

**Contexto:** Operador prefere que IA aplique tudo no Supabase em vez de
copiar/colar SQL no painel.

**Decisão:** IA conecta via `psql` diretamente em
`db.PROJECTREF.supabase.co:5432` (porta 5432, modo session, SSL
obrigatório, IPv6) usando a senha do banco. Aplica migrations
automaticamente.

**Alternativas consideradas:**
- Supabase Management API (precisa Personal Access Token, mais setup)
- Supabase CLI local (precisa instalação e link de projeto)

**Consequências:**
- Aplicação de schema fica trivial dentro do agente
- Senha do banco precisa estar disponível em `.env.local`
- Em produção, todas as migrations rodarão via CI/CD ou Supabase CLI

---

## D-016 · Pivot pra Test Number da Meta no início · 2026-04-19

**Contexto:** Operador tentou cadastrar o número próprio
`+55 21 99732-2906` na Meta Cloud API e recebeu erro
`#2655121:WBxP-783273915-4224144161` ("WhatsApp Business Account
restrita"). Causa: número estava registrado no app WhatsApp Business no
celular, foi apagado, Meta acionou quarentena anti-fraude. Liberar via
Meta Support pode levar 3-15 dias úteis.

**Decisão:** Usar o **Test Number gratuito** que a Meta provisiona
automaticamente em todo app WhatsApp como `phone_number_id` corrente
durante todo o desenvolvimento e MVP fechado. Em paralelo:
1. Aguardar 24-72h pra reusar o número próprio sem ação
2. Abrir caso no Meta Business Support
3. Considerar **chip dedicado** (número novo) pra produção real, isolando
   da agenda pessoal do operador

**Alternativas consideradas:**
- Esperar destrava do número (bloqueia desenvolvimento por dias)
- Comprar chip novo agora (R$ 30 + tempo de cadastro, prematuro)
- Usar número de outro sócio (gera mistura de identidades)

**Consequências:**
- Desenvolvimento segue hoje sem bloqueio
- Limite de 5 destinatários verificados — ok pra dev/demo
- Migração pra número definitivo = trocar `WHATSAPP_PHONE_NUMBER_ID`
  no `.env`. Zero refactor de código
- Custo zero até produção

---

## D-015 · Meta App: WhatsApp + Marketing API ativados · 2026-04-19

**Contexto:** App da Meta precisa de produtos certos pra cobrir nossas
necessidades atuais e médias-prazo.

**Decisão:** Ativar **WhatsApp** (acompanhamento de pacientes) +
**API de Marketing** (Conversions API server-side). Não ativar Anúncios
de Apps (não temos app nativo) nem Threads (sem plano de uso).

**Consequências:**
- WhatsApp: permite Cloud API completa
- Marketing API: permite enviar eventos de conversão server-side via
  CAPI, fundamental para escalar ads pós-iOS 14.5 e third-party cookies
- Sem dependências adicionais no início

---

## D-013 · Migrations versionadas em `supabase/migrations/` · 2026-04-19

**Contexto:** Precisamos de histórico de schema reproduzível, não
"clica e arrasta" no painel.

**Decisão:** Toda mudança de schema vira um arquivo SQL em
`supabase/migrations/YYYYMMDDHHMMSS_descricao.sql`, executado no SQL
Editor. Quando passar de ~5 migrations, migrar para Supabase CLI
(`supabase db push`).

**Consequências:**
- Schema versionado junto com o código no git
- Replicar ambientes (staging/prod) é trivial
- Rollback é manual mas explícito
