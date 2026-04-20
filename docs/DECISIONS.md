# Registro de Decisões · Instituto Nova Medida

> Cada decisão importante vira uma entrada permanente. Não apagamos —
> superseder a anterior se mudar de ideia, e referenciamos.

---

## D-027 · Fluxo do paciente: reserva atomic + token HMAC + ativação no webhook · 2026-04-19

**Contexto:** o produto vende "consulta + medicação manipulada" como
plano. Até aqui tínhamos o checkout do plano funcionando, mas nenhuma
forma do paciente escolher o horário da consulta nem entrar na sala.
Faltava a coluna vertebral do produto.

**Decisão:** o paciente escolhe o slot ANTES de pagar, em
`/agendar/[plano]`. A reserva é atomic via SQL function, o appointment
fica em `pending_payment` com TTL de 15 min, e o webhook do Asaas
ativa para `scheduled` + provisiona sala Daily quando o pagamento
confirma. O link da sala é HMAC-assinado, sem login.

**Por que esse desenho:**

- **Atomic em SQL, não na app**: `book_pending_appointment_slot`
  (PL/pgSQL) faz a inserção contra um índice unique parcial
  `(doctor_id, scheduled_at) WHERE status in ('pending_payment',
  'scheduled', 'confirmed', 'in_progress')`. Duas requisições
  concorrentes para o mesmo slot — uma ganha (recebe UUID), a outra
  recebe `unique_violation` que viramos `slot_taken`. Sem race no JS.
- **TTL curto (15 min)**: tempo razoável de checkout. Se o pagamento
  não chegar nesse prazo, o slot é liberado por cron (próxima
  migration) e/ou pela própria função na próxima tentativa de reserva
  ("fast path" de auto-limpeza de pending expirado no mesmo slot).
- **`pending_payment` como estado novo no enum** (em vez de NULL ou
  flag): deixa claro no banco que aquele slot está reservado mas não
  confirmado. Aparece nos relatórios como tal, sem inflar métricas
  de consultas pagas.
- **Ativação assíncrona via webhook Asaas**: o paciente pode fechar
  a aba após pagar — o appointment é ativado pelo Asaas, e a sala
  Daily é provisionada nesse mesmo handler (best-effort, não bloqueia
  a resposta 200 do webhook). Se o Daily estiver fora do ar, há
  fallback no `/api/paciente/.../join` que provisiona sob demanda.
- **Token HMAC-SHA256 no link da consulta**: `appointment_id.exp.sig`,
  truncado a 16 bytes (128 bits). Sem login, sem cookie, sem JWT lib.
  O segredo (`PATIENT_TOKEN_SECRET`, 256 bits) só vive no servidor.
  TTL padrão 14 dias — suficiente pra cobrir reagendamento e revisita.
  Não carrega claims sensíveis (só o appointment_id), e mesmo de
  posse dele o paciente ainda precisa de um token Daily efêmero
  (gerado pelo `/api/paciente/.../join`) pra entrar na sala.
- **Janela de entrada na sala** = 30 min antes a 30 min depois do
  fim da consulta. Igual à janela da médica (D-021).

**Anti-tampering:**

- O slot enviado no `/api/agendar/reserve` é VALIDADO contra
  `listAvailableSlots()` (mesmo source-of-truth do picker). Se o
  paciente forçar um horário que não está ofertado, devolve 409.
- Token HMAC com timing-safe compare; tampering vira 401.
- O appointment_id na URL TEM que bater com o do token (anti-substituição).

**Componentes implementados:**

- Migration 008 (`20260419070000_appointment_booking.sql`):
  - `pending_payment` no enum.
  - Coluna `pending_payment_expires_at`.
  - Índice unique parcial.
  - Função `book_pending_appointment_slot()`.
  - Função `activate_appointment_after_payment()`.
- `src/lib/scheduling.ts` — `getPrimaryDoctor`, `listAvailableSlots`,
  `isSlotAvailable`, `bookPendingSlot`, `activateAppointmentAfterPayment`.
- `src/lib/patient-tokens.ts` — `signPatientToken`, `verifyPatientToken`,
  `buildConsultationUrl`.
- `POST /api/agendar/reserve` — fluxo completo: customer + slot +
  payment Asaas + token + URL.
- `POST /api/paciente/appointments/[id]/join` — autenticado por token,
  janela de entrada, fallback de provisioning.
- `/agendar/[plano]` — slot picker + reuso do CheckoutForm em modo
  "reserve".
- `/consulta/[id]?t=<token>` — página pública do paciente com
  contagem regressiva e botão "Entrar na sala".
- Webhook Asaas estendido: ativa appointment + provisiona sala
  (best-effort) ao receber `RECEIVED`/`CONFIRMED`.

**Não decidido aqui (futuro):**

- Cron de expiração de `pending_payment` (Supabase pg_cron — Sprint
  4.1 final).
- Webhook Daily (`meeting.started/ended` → `appointments.status`).
- Reagendamento sem repagamento (precisa fluxo "trocar horário").
- WhatsApp templates (envio do link da consulta + lembrete H-1h).
- On-demand / fila ("falar agora com a próxima médica disponível").
- Multi-doctor.

---

## D-026 · Comprovantes PIX em bucket Supabase privado, mediados por API · 2026-04-19

**Contexto:** o passo "Confirmar recebimento" do payout aceitava só uma
URL externa colada manualmente. Isso não fecha auditoria contábil: o
operador pode digitar errado, o link pode quebrar (Drive/Dropbox), e
não há controle de quem viu cada comprovante.

**Decisão:** criar bucket Supabase Storage `payouts-proofs` (private)
manipulado SEMPRE via service role do servidor, com autorização nos
handlers Next.js (não em policies SQL).

- **Bucket:** `payouts-proofs`, `public=false`, hard cap de 10 MB,
  MIMEs aceitos = `pdf, png, jpeg, webp`.
- **Path determinístico:** `payouts/{payout_id}/{ts}-{slug}.{ext}`,
  facilita listing/delete em massa por payout.
- **Coluna que aponta:** `doctor_payouts.pix_proof_url` armazena o
  storage path (string que começa com `payouts/`). URLs externas
  antigas continuam aceitas (qualquer string que não começa com
  `payouts/` é tratada como link externo no GET).
- **API admin** (`/api/admin/payouts/[id]/proof`):
  - `POST` multipart `file=` → valida MIME + 5 MB lógico, grava no
    bucket, atualiza `pix_proof_url`, remove arquivo antigo se existia.
  - `GET` → signed URL de 60s.
  - `DELETE` → remove arquivo + zera coluna.
- **API médica** (`/api/medico/payouts/[id]/proof`): só `GET`,
  bloqueia se o payout não pertence à médica autenticada.
- **Sem RLS em `storage.objects`:** o bucket é completamente fechado;
  nada o toca exceto handlers que já passaram por `requireAdmin()` ou
  `requireDoctor()` + check de ownership. Mais simples, mais seguro,
  evita policies SQL frágeis.
- **Signed URLs sempre curtas** (60s) para minimizar shoulder-surfing
  e log/clipboard hijacking.

**Consequências:**

- Operador não digita mais URL externa — anexa arquivo direto no
  passo `pix_sent → confirmed`. Comprovante fica versionado no Storage.
- Médica vê o mesmo arquivo que o operador anexou (transparência total).
- O mesmo bucket vai servir NF-e nos próximos sprints (reusar path
  `nfse/{payout_id}/...` com mesma família de helpers).
- Migration 007 documenta o bucket; é idempotente (`on conflict do update`).

**Não decidido aqui (futuro):**

- Verificação automática de PDF (PDF/A para NF-e — Sprint 5).
- Antivírus server-side (ClamAV) — quando subirem >100 arquivos/mês.
- Hash dos arquivos pra deduplicação (não é problema no volume MVP).

---

## D-025 · Autenticação por magic link (Supabase Auth) + roles via app_metadata · 2026-04-19

**Contexto:** Sprint 4.1 (entrega 2/3) precisa habilitar acesso ao painel
administrativo (operador) e ao painel da médica. Decisão deliberada de
não construir login com senha:

- Senha = mais superfície de ataque (vazamento de hash, brute-force,
  reset flow), mais código a manter, e zero benefício real pra um time
  pequeno onde cada usuário tem e-mail confiável.
- Magic link delega o "fator de posse" ao provedor de e-mail —
  o que já é o fator de recuperação efetivo de qualquer senha.
- Supabase Auth já suporta nativamente; cookies HttpOnly via `@supabase/ssr`.

**Decisão:**

- **Magic link only** para operador e médicas. Sem senha, sem TOTP no MVP
  (avaliar TOTP em Sprint 6 quando houver dados clínicos sensíveis no
  painel da médica).
- Roles ficam em `auth.users.app_metadata.role` (`'admin' | 'doctor' | 'patient'`).
  **Nunca** em `user_metadata` — esse o usuário pode editar via API.
- Middleware (`src/middleware.ts`) faz hard-gate sobre `/admin/*` e
  `/medico/*` (refresh + presença de sessão). Validação fina de role
  acontece nos Server Components via `requireAdmin()` / `requireDoctor()`.
- Endpoint `/api/auth/magic-link` é **anti-enumeração**: sempre responde
  200, mesmo quando o e-mail não existe. Rate limit por IP (5 / 15 min)
  em memória — substituir por Upstash quando tiver tráfego real.
- Convite de médica via `/admin/doctors/new` cria o usuário com
  `email_confirm=true` e dispara magic link de boas-vindas — médica
  completa o perfil sozinha no `/medico` (Sprint 4.1 entrega 3).

**Alternativas descartadas:**

- **Auth0/Clerk:** custo desnecessário, lock-in adicional, e o Supabase
  Auth já está incluído.
- **Senha + TOTP:** mais segurança no papel, mas operacionalmente caro
  pra time de 1 pessoa. Reavaliar quando houver +5 médicas atendendo.
- **OAuth (Google):** funcionaria pro operador (que tem Workspace), mas
  exige cada médica ter conta Google compatível. Magic link é universal.

**Consequências:**

- Toda rota admin é dinâmica (lê cookies). Custo extra de Vercel
  Functions é desprezível neste estágio.
- Compromisso de manter o painel na mesma origem do site público
  (cookie `httpOnly` + `sameSite=lax` em `instituto-nova-medida.vercel.app`).

---

## D-024 · Modelo de remuneração de médicas (PJ + valores fixos) · 2026-04-19

**Contexto:** Sprint 4 abre o cadastro de médicas. Precisávamos definir
vínculo, política de remuneração e tipos de ganho suportados desde
o começo (decisões aqui são caras de mudar depois).

**Decisão:** Médicas trabalham como **PJ** (MEI ou ME, com CNPJ próprio),
contrato de prestação de serviço médico com cláusula explícita de
**operadora LGPD** (Instituto = controlador). Remuneração por **valores
fixos** ajustáveis por médica:

| Tipo | Valor default | Quando |
|---|---|---|
| `consultation` | R$ 200 | Por consulta agendada concluída |
| `on_demand_bonus` | +R$ 40 | Adicional por consulta atendida via fila on-demand (total R$ 240) |
| `plantao_hour` | R$ 30/h | Por hora em status "verde" (online disponível para fila) |
| `after_hours_bonus` | configurável | Multiplicador noturno/fim de semana (não ativo no MVP) |
| `adjustment` | manual | Ajuste manual com motivo obrigatório |
| `bonus` | discricionário | Meta batida, NPS, etc. |
| `refund_clawback` | negativo | Quando paciente é reembolsado depois |

Os valores ficam em `doctor_compensation_rules` (uma linha por médica,
uma versão ativa por vez). Mudança de regra **não retroage** — só vale
pra novas earnings.

**Pagamento de plantão** (R$ 30/h mesmo sem atender) é incentivo
estrutural pra fila on-demand funcionar — sem ele, médica não fica
online esperando, e a promessa de "consulta imediata" quebra.

**Alternativas consideradas:** percentual da consulta (mais alinhado com
ticket variável, mas opaco para médica); CLT (caro e inflexível);
marketplace livre (perde controle do protocolo).

**Consequências:** modelo PJ tem risco de pejotização — mitigado por:
contrato sem exclusividade, sem subordinação direta, sem horário
imposto (médica decide quando ficar online), pagamento por entrega e
não por jornada. Plantão remunerado precisa de orçamento previsível
(decisão consciente de pagar tempo ocioso pra ter disponibilidade).

---

## D-023 · Gravação de teleconsulta: opt-in, não obrigatória · 2026-04-19

**Contexto:** Sprint 4 implementa videoconsulta. Precisávamos definir
política de gravação à luz de CFM, LGPD e CDC.

**Decisão:** **Não gravar consultas por padrão.** Disponibilizar
gravação como opção opt-in caso a caso, exigindo consentimento expresso
do paciente antes do início da sala.

**Base legal:**

- **CFM Resolução 2.314/2022, Art. 4º §1º:** exige *prontuário* com
  guarda de 20 anos. **Não exige gravação de vídeo.** Substituído por
  prontuário escrito (anamnese estruturada, hipótese diagnóstica,
  conduta, prescrição via Memed).
- **LGPD Art. 11:** gravação = dado pessoal sensível (saúde) → exige
  consentimento específico, expresso e destacado. Gravar sem necessidade
  fere o **princípio da necessidade** (Art. 6º, III).
- **CDC:** prova da prestação atendida via prontuário escrito + log
  Daily.co (meeting_started_at, ended_at, participants) + termo de
  consentimento da paciente assinado no checkout.

**Mercado:** Doctoralia, Conexa Saúde, Telavita, Beep Saúde — nenhum
grava por default. Operadoras corporativas que gravam fazem por
exigência de seguro com consentimento específico.

**Implementação:** campo `recording_consent` em `appointments` (default
`false`). Quando médica liga gravação, UI do paciente mostra banner
persistente "Esta consulta está sendo gravada com seu consentimento" +
botão "Não autorizo". Storage criptografado, retenção 5 anos
(prescricional CDC), descarte automático.

**Consequências:** menor superfície de ataque LGPD, menor custo de
storage, menor fricção do paciente. Trade-off: em disputa, dependemos
do prontuário escrito (que em telemedicina já é o padrão jurídico).

---

## D-022 · Controle financeiro interno (sem split Asaas) · 2026-04-19

**Contexto:** Inicialmente previmos split automático Asaas para repassar
honorário diretamente à médica no momento da cobrança (D-019 referência).
Reavaliando a tradeoff a frio.

**Decisão:** **Não usar split Asaas.** Implementar controle financeiro
interno: Instituto recebe 100% do pagamento, calcula earnings imutáveis
por médica, gera lote mensal de payouts, paga via PIX manual (Asaas PIX
Out ou banco direto), com workflow de aprovação obrigatório.

**Por quê controle interno > split:**

| Dimensão | Split Asaas | Controle interno |
|---|---|---|
| Onboarding médica | 3-5 dias (MEI + Asaas verificada) | Instantâneo (só PIX) |
| Custo por transação | Fee Asaas por destino | Zero |
| Flexibilidade de regras | Fixa no momento da cobrança | Total (consultation, plantão, bônus, ajuste) |
| Reembolso/chargeback | Difícil reverter split | Trivial (earning negativa = clawback) |
| Pejotização | Asaas vê o vínculo recorrente | Pagamento PJ tradicional |
| Auditoria pra médica | Extrato Asaas (pouco contexto) | Dashboard rico + comprovante PIX |
| NF emitida | 1 por consulta (operacionalmente custoso) | 1 mensal consolidada |

**Modelo de earning (imutável):** cada `doctor_earning` registra um
fato isolado (consulta, plantão, bônus, etc) com `earned_at` e fica
imutável. Mudanças de regra não retroagem. Política de "available":
PIX D+7, Boleto D+3, Cartão D+30 (cobrem janelas de chargeback).

**Workflow mensal:**
1. Dia 1: `pg_cron` agrega earnings available → cria `doctor_payouts` em status `draft`
2. Admin aprova cada payout em `/admin/payouts`
3. Pagamento via PIX (manual ou Asaas Transfer API)
4. Confirmação + upload comprovante → status `confirmed`
5. Médica notificada via WhatsApp + cobrada por NF-e/RPA

**Consequências:** opera 100% no nosso código (mais responsabilidade,
mais flexibilidade). Asaas continua sendo só gateway de cobrança do
paciente (PSP), sem responsabilidade de divisão. Detalhamento completo
em `docs/COMPENSATION.md`.

**Substitui parcialmente D-019** (split Asaas previsto): mantém Asaas
como gateway, descarta split.

---

## D-021 · Daily.co como provider de videoconferência (MVP) · 2026-04-19

**Contexto:** Sprint 4 precisa de salas de teleconsulta confiáveis,
estáveis e rápidas de implementar. Avaliamos Daily.co (SaaS US),
Jitsi self-hosted (open source) e JaaS (Jitsi gerenciado pela 8x8).

**Decisão:** **Daily.co no MVP.** Implementação atrás de uma camada
de abstração `src/lib/video.ts` (interface `VideoProvider`) para
permitir migração futura sem retrabalho de negócio.

**Tabela comparativa que motivou a escolha** (cenário INM com rampa
de 50→1.000 consultas/mês no ano 1, total ~5.000 consultas):

| Critério | Daily.co | Jitsi self-hosted | JaaS |
|---|---|---|---|
| Setup MVP | ~2h | 1-3 dias + SRE | ~3h |
| Custo ano 1 (5k consultas) | ~R$ 4.500 | ~R$ 26.000 (R$ 18k infra + R$ 8k setup SRE) | ~R$ 8.000 |
| Manutenção | Zero | Alta (atualização, scaling JVB) | Zero |
| Data residency BR | Não (US/EU/SG, com DPA) | Sim (AWS gru1) | Não |
| Gravação | Trivial (flag, +R$ 0,05/min) | Precisa Jibri (mais 1 servidor) | Trivial |
| API/SDK | Excelente (REST + React/Vue/RN + iframe + webhooks) | Bom | Excelente |
| Vendor lock-in | Médio | Zero | Médio |

**Mitigação LGPD pra Daily (US-based):** DPA assinado + cláusulas
contratuais padrão (LGPD Art. 33, V) + termo de consentimento informado
do paciente sobre transferência internacional + gravação opt-in
(D-023). Em fiscalização ANPD, justificável; não é tão limpo quanto
Jitsi BR, mas é defensável.

**Critério de migração futura:** quando passar de **3.000 consultas/mês
sustentadas**, reavaliar Jitsi self-host (custo começa a ganhar).
Estimativa: mês 12-24.

**Configurações default da sala:** `enable_prejoin_ui: true`,
`enable_chat: false`, `max_participants: 2`, `eject_at_room_exp: true`,
`enable_recording: 'local'` (não grava por default — controlado por
appointment.recording_consent).

**Conta operacional:** subdomínio `instituto-nova-medida.daily.co`,
2 API keys (default 2), webhook secret rotacionável.

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

---

## D-017 · Hospedagem: Vercel + região `gru1` (São Paulo) · 2026-04-19

**Contexto:** Decidir onde hospedar o frontend Next.js + API routes.

**Decisão:** **Vercel** (mesmo time/empresa do Next.js). Plano free
no início (incluso para projetos pessoais). Todas as serverless
functions pinadas em **`gru1` (São Paulo)** via `vercel.json` pra
reduzir latência ao usuário BR final e ao pool do Supabase também
em São Paulo.

**Alternativas consideradas:**
- AWS Amplify / Lambda + CloudFront → mais controle, mais setup
- Render / Railway → bons mas latência BR pior
- Self-hosted (VPS BR) → assumir SRE pra deploys, TLS, scaling — sem
  retorno num MVP

**Consequências:**
- Deploy automático a cada `git push` na `main`
- Preview URL em cada PR
- HTTPS automático
- Edge global pro static (HTML/CSS/JS) + serverless funcs em São
  Paulo pras rotas dinâmicas
- Custo: $0 até atingir limites de bandwidth/invocations gratuitos
- Migração futura pra AWS = `vercel.json` + adapter, sem reescrita

---

## D-019 · Asaas em sandbox + abertura de CNPJ próprio em paralelo · 2026-04-19

**Contexto:** Operador tem conta Asaas existente, mas vinculada a CNPJ
de outra empresa (não-médica). A nova entidade jurídica
(clínica/Instituto) ainda não foi constituída.

**Opções consideradas:**

1. **Usar conta Asaas existente** (CNPJ atual)
   - ❌ NF emitida com nome errado → reclamação no PROCON
   - ❌ Receita médica em PJ não-médica → fiscalização tributária
   - ❌ Inviabiliza split correto pras médicas parceiras (cada uma
     precisa de NF correta da Instituto)

2. **Esperar abrir CNPJ pra começar Sprint 3**
   - ❌ Bloqueia desenvolvimento por 30-60 dias
   - ❌ Perde tempo de validação do fluxo de checkout

3. **Asaas sandbox agora + ativação real depois do CNPJ** ✅
   - Código fica 100% pronto e testado
   - Sandbox simula tudo: PIX, cartão, boleto, webhooks
   - Quando CNPJ chegar, troca-se apenas a `ASAAS_API_KEY` no
     Vercel — zero refactor

**Decisão:** Adotamos a opção 3.
- `ASAAS_ENV=sandbox` no início, `ASAAS_ENV=production` quando o
  CNPJ chegar
- Endpoint base muda automaticamente:
  - sandbox: `https://sandbox.asaas.com/api/v3`
  - prod: `https://api.asaas.com/v3`
- Webhook URL fica a mesma (apontando pro Vercel)

**Consequências:**
- Sprint 3 entrega o pipeline completo de pagamentos sem depender
  do CNPJ
- Operador pode demonstrar a plataforma pra sócios, médicas
  parceiras, investidores
- Migração pra produção é trocar 1 env var

---

## D-020 · Estrutura societária da entidade jurídica: SLU + RT médico contratado · 2026-04-19

**Contexto:** Operador precisa abrir a pessoa jurídica para receber
pagamentos médicos legalmente, registrar a clínica no CRM/UF e
contratar médicas parceiras.

**Decisão recomendada:**
- **Tipo:** Sociedade Limitada Unipessoal (SLU) — operador como
  único sócio
- **Responsável Técnico:** Médico(a) contratado(a) com CRM ativo
  (pode ser a Dra. principal da plataforma ou um RT terceirizado
  R$ 1.500-4.000/mês)
- **CNAE principal:** 8630-5/03 — Atividade médica ambulatorial
  restrita a consultas
- **CNAE secundário:** 8650-0 (atividades de profissionais da área
  de saúde) e opcionalmente 6201-5 (desenvolvimento de software)
- **Regime tributário:** Lucro Presumido (carga total estimada
  13-16% — favorável pra serviços médicos)
- **Endereço:** sede em endereço fiscal compartilhado/coworking
  (R$ 80-200/mês) — não vincula endereço pessoal nos órgãos públicos
- **Capital social:** a partir de R$ 1.000 (livre)

**Etapas operacionais (estimativa de tempo e custo):**

| Etapa | Tempo | Custo |
|---|---|---|
| Abertura na Junta Comercial (via contador) | 5-10 dias | R$ 800-1.500 |
| Liberação CNPJ na Receita Federal | 1-3 dias | grátis |
| Alvará municipal de funcionamento | 15-30 dias | R$ 100-400 |
| **Registro da clínica no CRM/UF** (obrigatório) | 30-60 dias | R$ 600-1.500 |
| Conta bancária PJ | 5-15 dias | grátis |
| Conta Asaas com novo CNPJ | 1-3 dias | grátis |
| **Total operacional** | **30-60 dias** | **R$ 1.500-3.500** |

**Bloqueio crítico:** sem **registro da clínica no CRM/UF**, a
operação médica é tecnicamente irregular mesmo com CNPJ. Esta etapa
deve ser iniciada em paralelo com a abertura do CNPJ.

**Contador:** procurar especialização em saúde. Opções: Contabilizei
ou Conube (online, R$ 79-99/mês), ou contador local com experiência
em clínicas médicas (perguntar diretamente: "já abriu clínica? sabe
registrar no CRM/UF?").

**Consequências:**
- Operador faz isso em paralelo enquanto desenvolvemos
- Quando ativo, basta criar conta Asaas com CNPJ novo e trocar
  `ASAAS_API_KEY` no Vercel
- O Footer e os documentos legais já têm placeholders `[a preencher]`
  esperando os dados (CNPJ, endereço, RT médico, CRM/UF)

---

## D-018 · WhatsApp em produção exige System User Token (não User AT) · 2026-04-19

**Contexto:** Após deploy bem-sucedido em https://instituto-nova-medida.vercel.app,
o `POST /messages` da Meta começou a retornar `(#131005) Access denied`
em 100% das chamadas, mesmo com token byte-idêntico ao que funciona
via curl residencial brasileiro.

Diagnóstico provou (via endpoint debug `/api/debug/wa-env`,
removido após):
- Token no Vercel: `length=288`, `sha256_first16=5d6eaf5bb22f8cdc`
  — IDÊNTICO ao token correto
- Função roda em `gru1` (Brasil) — geo-IP descartado
- IP de saída: `56.124.125.161` (AWS)
- GET `/{phone_id}` → 200 OK
- POST `/{phone_id}/messages` → 403 com/sem `appsecret_proof`

A Meta documenta:
> "User access tokens are only used for testing in the developer
> dashboard. For production server applications, you must use a
> System User access token."

A Meta libera o User AT quando vem de IP residencial (assume
"você testando no terminal") mas bloqueia chamadas server-to-server
de IPs cloud (AWS/Vercel/etc), retornando 131005.

**Decisão:** Usar **System User Token permanente** em produção,
gerado em Business Manager → Settings → Users → System Users →
Generate Token, com escopos:
- `whatsapp_business_management`
- `whatsapp_business_messaging`

System User Tokens não expiram (ou duram 60 dias) e funcionam de
qualquer IP, justamente para servidores.

**Bloqueio temporário:** O Business Manager do operador está
desativado pela Meta porque o site cadastrado não pôde ser
verificado. Agora que temos a URL pública
`https://instituto-nova-medida.vercel.app`, basta atualizar o site
no BM e pedir reanálise (24-48h).

**Consequências:**
- Pipeline `/api/lead → Supabase → WhatsApp` está plugado e testado,
  só aguarda o token correto pra disparar em produção
- Zero mudança de código quando o System User Token chegar — só
  trocar `WHATSAPP_ACCESS_TOKEN` no Vercel
- User AT atual (`hello_world` via curl) continua funcionando pra
  testes locais
