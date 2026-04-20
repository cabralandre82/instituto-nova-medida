# Registro de Decisões · Instituto Nova Medida

> Cada decisão importante vira uma entrada permanente. Não apagamos —
> superseder a anterior se mudar de ideia, e referenciamos.

---

## D-044 · Painel da médica "finalizar consulta" (onda 2.B) · 2026-04-20

**Contexto:** a onda 2.A (schema D-044) criou `fulfillments`,
`plan_acceptances`, e os 3 campos novos em `appointments`
(`prescribed_plan_id`, `prescription_status`, `finalized_at`). Tudo
dormindo — ninguém escrevia essas colunas nem gerava fulfillment.
A onda 2.B é a **primeira** entrada real de dados nesse pipeline: é
onde a médica declara o desfecho clínico e, se houver prescrição,
nasce o fulfillment que alimenta todas as ondas seguintes.

**Decisões-chave desta onda:**

- **Só 2 decisões possíveis**: `declined` (avaliou sem indicar) ou
  `prescribed` (indicou plano). Não existe "pendente" — médica
  finaliza = decisão tomada. Isso simplifica a UI e elimina estado
  intermediário ambíguo. `prescription_status='none'` continua
  existindo só pra consultas **ainda não finalizadas**.

- **Idempotência por `finalized_at`**: uma vez preenchido, qualquer
  nova tentativa de finalizar retorna 409 `already_finalized`. A
  UI nesse caso mostra a consulta em modo read-only. Correção
  explícita só via admin (deliberado: fechamento clínico é evento
  legal, não deve ser reversível pela própria médica).

- **Fulfillment nasce aqui, não no pagamento**. Decisão contra-
  intuitiva defensável: `pending_acceptance` representa "médica
  já prescreveu, aguardando aceite do paciente". Isso dá
  visibilidade operacional imediata (admin vê que há prescrição
  pendente no paciente), permite follow-up de WhatsApp sem
  depender do pagamento e mantém 1:1 com `appointment`.

- **Upsert idempotente em `fulfillments`** na lib, não só via
  constraint. Checa existência antes do INSERT pra devolver o `id`
  correto mesmo em caso de re-execução (ex: UPDATE de appointment
  falhou depois do INSERT — próxima tentativa encontra o
  fulfillment e segue pro UPDATE).

- **URL Memed obrigatória no prescribed**. Validação `isHttpUrl()`
  rejeita `javascript:`, `data:`, etc. A URL é o que a operadora
  vai abrir pra encaminhar à farmácia e é o que entra no hash do
  aceite (onda 2.C) — precisa ser estável e acessível.

- **Hipótese e conduta opcionais**. Médica que só avalia e declina
  pode marcar "declined" sem precisar justificar por escrito. A
  responsabilidade clínica existe, mas o sistema não obriga
  preencher texto — isso seria paternalista e criaria fricção.

- **Validação estrita dupla**: `validateFinalizeInput` (pura) +
  `finalizeAppointment` (com I/O). A pura cobre tudo que pode ser
  decidido sem banco (UUID válido, URL válida, tamanhos); a outra
  cobre ownership, estado do appointment, existência do plano.

- **Transição de `appointments.status`**: quando o atual é
  `scheduled`/`confirmed`/`in_progress`, o update força
  `status='completed'`. Pra `no_show_patient`/`no_show_doctor`
  preservamos o status original — é possível e legítimo finalizar
  com "paciente faltou" + declined.

- **Lib pura, rota fina**. Toda a lógica em
  `src/lib/appointment-finalize.ts` (com `FinalizeInput`,
  `FinalizeResult` tagged union, `FinalizeFailure.code` mapeado
  pra HTTP status no endpoint). A rota `POST
  /api/medico/appointments/[id]/finalize` é 90 linhas, quase só
  transport. Facilita testar e reusar.

**Fora do escopo da onda 2.B:**

- Envio de WhatsApp pro paciente avisando "sua oferta está
  pronta" — entra na onda 2.C/2.E junto com a tela de aceite e o
  painel admin de fulfillment, quando o destino do link existir.
- Tela `/paciente/oferta/[id]` onde o paciente aceita — onda 2.C.
- Painel admin de gestão de fulfillment — onda 2.E.

**Arquivos tocados:**

- `src/lib/appointment-finalize.ts` (novo · 250 linhas)
- `src/lib/appointment-finalize.test.ts` (novo · 21 casos)
- `src/app/api/medico/appointments/[id]/finalize/route.ts` (novo)
- `src/app/medico/(shell)/consultas/[id]/finalizar/page.tsx` (novo)
- `src/app/medico/(shell)/consultas/[id]/finalizar/FinalizeForm.tsx` (novo)
- `src/app/medico/(shell)/agenda/page.tsx` (editado — botão
  "Finalizar" no histórico, labels de status com finalized_at)
- Docs (DECISIONS · CHANGELOG · SPRINTS)

**Estado:** 186 testes passando (21 novos). TypeScript, ESLint e
Next build verdes. Migração da onda 2.A já aplicada em produção —
esta onda pode ir pro ar sem banco extra. Próxima: onda 2.C
(tela de aceite formal do paciente).

---

## D-044 · Inversão do fluxo financeiro — consulta grátis, aceite formal e fulfillment (onda 2.A) · 2026-04-20

**Contexto:** até D-043, o pipeline comercial assumia que o paciente
**pagava antes** da consulta: `/planos` → `/checkout/[slug]` →
pagamento confirmado → appointment gerado → médica atendia. Esse
desenho tem 3 problemas estruturais:

1. **Desalinhado com a realidade clínica.** A médica não tem como
   prescrever sem avaliar o paciente. Forçar pagamento antes cria
   fricção desnecessária ("tô pagando por quê? ainda nem sei se
   sirvo pra isso") e induz à promessa implícita de "você vai ser
   tratado" antes de qualquer avaliação.
2. **Exposição de preços na porta de entrada.** Home e modal de
   captura exibiam valores altos sem contexto médico. Usuário foi
   categórico: "isso vai assustar os pacientes, é horrível".
3. **Fulfillment invisível.** Mesmo no fluxo antigo, depois do
   pagamento o sistema simplesmente "dava o plano como entregue" —
   ignorava todo o ciclo real (manipulação em farmácia externa,
   envio, rastreio, confirmação de recebimento). A equipe fazia
   tudo em planilha paralela.

**Fluxo correto (combinado com o usuário nesta sessão):**

```
Landing/Quiz → Lead
  → Consulta gratuita (médica avalia sem cobrar)
    → Desfecho A: sem indicação clínica (prescription_status='declined', sem cobrança)
    → Desfecho B: médica prescreve plano (Memed) + seleciona plan_id
         → /paciente/oferta/[appointment_id]: prescrição + plano + aceite formal
           → Paciente aceita (plan_acceptance imutável) → checkout Asaas
             → PAYMENT_RECEIVED → fulfillment: paid
               → operador: "enviei à farmácia" → pharmacy_requested
                 → operador: "despachei ao paciente" → shipped (+ tracking_note)
                   → paciente/operador: "recebi" → delivered
```

**Respostas do negócio que ancoram o design:**

- Consulta inicial é **gratuita**. Médica só recebe comissão se o
  plano for prescrito, aceito e pago. Sem isso, nenhum earning
  é gerado — a regra financeira existente já suporta (earning
  vem de payment confirmado; sem payment, sem earning).
- Plano é **pacote fechado** de 1 ciclo (default 90 dias). Não
  é assinatura recorrente. 1 fulfillment por ciclo. Renovação =
  nova consulta → novo fulfillment.
- Aceite é **formal e explícito**: texto completo mostrado ao
  paciente + checkbox + submit. Distinto de "aceite implícito por
  pagar". Decisão pró-conformidade (LGPD/CFM).

**Alternativas consideradas e rejeitadas:**

1. **Manter pagamento antes da consulta, com reembolso integral
   se não houver prescrição.** Simpler codebase, mas fricção
   enorme no funil (paciente dá CPF/cartão sem saber se vai ser
   atendido), e refund é operacionalmente caro via Asaas.
2. **Pagamento no ato da consulta (médica cobra dentro da chamada).**
   Viola LGPD (médica não deve processar pagamento na frente do
   paciente) e quebra a separação entre ato clínico e comercial.
3. **Aceite implícito via próprio pagamento.** Funciona legalmente,
   mas enfraquece a prova em caso de contestação ("paguei sem saber
   que era isso"). Aceite formal explícito é barato de implementar
   e forte como evidência.

**Decisões arquiteturais desta onda (2.A · só schema):**

- **Novo enum `fulfillment_status`** com 7 estados:
  `pending_acceptance` → `pending_payment` → `paid` →
  `pharmacy_requested` → `shipped` → `delivered`. `cancelled` é
  atingível de qualquer estado pré-`delivered`. Terminais:
  `delivered` e `cancelled`.

- **Tabela `fulfillments`** 1:1 com appointment via
  `unique(appointment_id)`. Se o paciente não aceitar ou não pagar,
  o fulfillment fica preso na primeira etapa e não é "reciclável" —
  para iniciar um novo ciclo, nova consulta. Reflete a realidade
  clínica: prescrição tem validade, não pode viver "congelada" por
  meses.

- **Tabela `plan_acceptances`** separada de `fulfillments` e
  **imutável**. Trigger `prevent_plan_acceptance_changes` bloqueia
  UPDATE e DELETE — o registro de aceite é prova legal, não pode
  ser editado nem pelo admin. Guarda snapshot do texto exato +
  hash determinístico do conjunto (texto + plan_slug +
  prescription_url + appointment_id), pra detectar adulteração.

- **`appointments` ganhou 3 colunas:** `prescribed_plan_id`,
  `prescription_status` (`none`|`prescribed`|`declined`) e
  `finalized_at`. O default de `prescription_status` é `none` e
  as linhas antigas ficam todas nesse estado — compatível com o
  histórico. Consulta só passa a gerar fulfillment quando a médica
  seta `prescription_status='prescribed'` e escolhe um plano.

- **Máquina de estados encapsulada em `src/lib/fulfillments.ts`**
  (puro TS, zero I/O). Funções `canTransition`,
  `nextAllowedStatuses`, `timestampsForTransition` e
  `computeAcceptanceHash`. Testes cobrem cada transição válida,
  cada pulo bloqueado, retrocesso, auto-transição, estados
  terminais e normalização do hash (NFC Unicode, whitespace,
  case do slug). Cobertura: 24 casos.

- **Hash de aceite** é SHA-256 do JSON canonicalizado com chaves
  ordenadas alfabeticamente, texto normalizado NFC + colapso de
  espaços, slug em lowercase. Determinístico e resistente a
  variações superficiais. Auditor re-calcula e compara com o
  `acceptance_hash` gravado — diferença = alguém editou algo.

- **RLS** segue o padrão do resto do projeto: admin ALL + médica
  SELECT só do que é dela via `current_doctor_id()`. Paciente
  lê via backend `service_role` com filtro code-level por
  `customer_id` (mesma decisão consciente do D-043).

- **`uuid_generate_v4()` → `gen_random_uuid()`** pra novas tabelas
  (pgcrypto, built-in em Postgres moderno). Alinha com migrations
  recentes que já usavam.

**Escopo expressamente fora desta onda:**

- Nenhuma UI nova. A onda 2.A é **puramente schema + domínio**.
- Nenhuma mudança em `/checkout` ou `/agendar` — eles continuam
  funcionando no fluxo antigo até a onda 2.G desligar.
- Nenhuma notificação WhatsApp nova — chegam nas ondas 2.B/2.D/2.E
  junto com as UIs de cada etapa.

**Próximas ondas (mapeadas mas não implementadas):**

- **2.B · Painel da médica — finalizar consulta.** Tela
  `/medico/consultas/[id]/finalizar` com anamnese + hipótese +
  conduta + Memed + seletor de plano. Ao finalizar: atualiza
  appointment e cria `fulfillment(pending_acceptance)`.
- **2.C · Paciente — oferta + aceite.** Tela `/paciente/oferta/[id]`
  com prescrição + plano + checkbox + submit. Cria
  `plan_acceptance` e redireciona pro checkout autenticado.
- **2.D · Webhook Asaas promove pra `paid`.** Extensão do handler
  já existente.
- **2.E · Painel admin — gestão de fulfillment.** Lista de
  pendentes + botões de transição + auditoria.
- **2.F · Paciente — status do tratamento.** Card em `/paciente`
  mostrando onde está o fulfillment + CTA "recebi".
- **2.G · Desligar CTAs do fluxo antigo.** Remover pontos públicos
  que ainda levam a `/checkout` sem consulta prévia.

**Arquivos tocados nesta onda:**

- `supabase/migrations/20260424000000_fulfillments_and_plan_acceptance.sql`
- `src/lib/fulfillments.ts` (novo)
- `src/lib/fulfillments.test.ts` (novo · 24 testes)
- `docs/DECISIONS.md` (este bloco)
- `docs/CHANGELOG.md` (entrada D-044)
- `docs/SPRINTS.md` (Sprint 5, Frente 5 — nova)

**Estado:** migração aplicada em produção; 165 testes passando
(24 novos). Nenhuma UI exposta ainda — próxima onda é 2.B.

---

## D-043 · Área logada do paciente ("meu tratamento") · 2026-04-20

**Contexto:** até aqui, o paciente existia como **linha em
`customers`** e recebia links pontuais por WhatsApp/e-mail:
`/checkout/[plano]` pra pagar, `/consulta/[id]?t=...` pra entrar
na sala (D-028), lembrete pelo bot. Não havia `/paciente` — uma
vez que a compra confirmava, o paciente **sumia do app**. Toda
interação operacional (qual foi minha próxima consulta? preciso
renovar? quando termina meu ciclo?) virava tíquete de WhatsApp
pra equipe, que lia, respondia e registrava manualmente.

Problemas concretos:

- **Retenção cega:** sem visibilidade do ciclo, paciente descobre
  que acabou a medicação tarde demais → evasão silenciosa.
- **WhatsApp inflado:** ~40% das mensagens entrantes da equipe
  eram perguntas que a própria área logada resolveria em 10s.
- **Sem canal de renovação:** na renovação, operador tinha que
  re-disparar checkout; qualquer lapso, evasão.
- **Zero bookmark:** link `/consulta/[id]?t=...` expira em 7 dias;
  paciente que arquivou o e-mail fica sem porta de entrada.

**Alternativas consideradas:**

1. **Status quo (só token por link):** zero infraestrutura nova,
   mas perpetua dependência de WhatsApp e impede qualquer
   produto self-service futuro (prescrições, NF-e, receitas).
2. **Auth por SMS / senha própria:** funcionalmente equivalente
   ao magic-link (que já usamos pra admin/médica em D-025), mas
   exige 2+ integrações novas (SMS gateway, hashing de senha,
   fluxo de reset). Preço > valor.
3. **Magic-link reaproveitando D-025 + vínculo automático por
   e-mail:** mesma stack, zero UI nova de senha, self-onboarding
   implícito (se o paciente já é `customer`, o primeiro clique
   cria o `auth.user` com role=patient).

**Decisão:** Alternativa (3).

- Nova tabela-vínculo não; ampliamos `customers` com
  `user_id uuid references auth.users(id) on delete set null`
  (unique partial). Fonte da verdade do match é o **e-mail do
  customer** (já validado no checkout, já único em 99% dos
  cenários — o CPF é que é estrictamente único, mas e-mails
  de compras distintas tipicamente também são).
- Trigger SQL `link_customer_to_new_auth_user` sincroniza o
  vínculo quando o auth.user é criado **em qualquer caminho**
  (admin, migration, import). A API do magic-link do paciente
  é quem geralmente cria esse auth.user e já vincula no mesmo
  fluxo, mas a trigger é a defesa em profundidade.
- Role `patient` já estava reservada em `src/lib/auth.ts`
  (D-025 comentava "Sprint 5: futuro /paciente"); agora virou
  real via `requirePatient()` — hard-gate que redireciona pra
  `/paciente/login` se falta sessão ou customer.
- API dedicada `/api/paciente/auth/magic-link` isola o fluxo
  de auto-provisionamento do paciente do fluxo clássico
  (`/api/auth/magic-link` que só aceita admin/médica
  pré-existentes). Evita regressão no login do operador.

**Arquitetura da UI:**

- `/paciente/login` — form magic-link idêntico ao `/medico/login`.
- `/paciente/(shell)/layout.tsx` — `requirePatient()` + header
  com saudação + nav (Visão geral / Minhas consultas / Renovar).
- `/paciente` — dashboard (próxima consulta + status do ciclo
  + últimas 3 consultas + CTAs condicionais de renovação).
- `/paciente/consultas` — agenda + histórico completo.
- `/paciente/consultas/[id]` — detalhe + botão "Entrar na sala".
  **Truque crítico**: em vez de duplicar a lógica de janela de
  entrada/Daily, geramos um token HMAC via `signPatientToken()`
  no server component e reutilizamos `JoinRoomButton` +
  `/api/paciente/appointments/[id]/join`. O endurecimento de
  janela, provisionamento, expiração de token Daily — tudo
  continua **num só lugar**.
- `/paciente/renovar` — status do ciclo, lista de planos, CTA
  destaque pro plano atual (recomendado), redireciona pra
  `/checkout/[slug]` existente. Renovação é **manual** (1 clique),
  não recorrente — decisão já tomada em D-011 e mantida aqui.

**Lib `src/lib/patient-treatment.ts`** é fonte única:
`getActiveTreatment`, `getRenewalInfo`, `getUpcomingAppointment`,
`listPastAppointments`, `getPatientProfile` + helpers de label.
Todas aceitam `SupabaseClient` injetável (testável sem
singleton) e recebem `now: Date` opcional pra testes
determinísticos.

**Impacto:**

- Destrava **retenção auto-servida**: paciente acessa
  `/paciente`, vê "faltam 7 dias", clica "Renovar" → checkout.
  Sem passar por operador.
- Reduz fricção do reingresso na sala: token do WhatsApp
  expirou? Paciente loga e gera um novo de `/paciente/consultas/
  [id]`.
- Abre caminho pros próximos D-: pré-consulta (formulário de
  sintomas antes da conversa), prescrições (download da receita
  após a consulta), NF-e do paciente, tracking de entrega
  da medicação. Tudo cabe em `/paciente/*` agora.

**Sobre RLS:** seguimos o padrão do projeto — backend usa
service_role, fencing é feito em código via `requirePatient()`
que filtra queries por `customer_id`. Abrir RLS por paciente
(policy em `appointments`, `payments`, `customers` filtrando
por `auth.uid() = customers.user_id`) exige reescrever 6+
policies e é escopo pra quando houver cliente direto no front
(mobile nativo, app externo, etc). Hoje todas as queries
passam pelo server, então não há ganho material.

**Relacionado:** D-025 (auth + magic-link base), D-028 (token
HMAC + `/consulta/[id]`), D-011 (cycle-based, não
subscription-based), D-042 (self-service da médica — espelho).

**Métricas pra acompanhar:**

- % de pacientes que loga em /paciente ao menos uma vez (meta:
  >60% em 60 dias).
- Volume de WhatsApp operacional ("quando é minha próxima?",
  "quando acaba?") — deve cair mensuravelmente após 30 dias.
- Conversão de renovação: % de pacientes em `expiring_soon`
  que clica "Renovar" direto do dashboard.

---

## D-042 · PIX self-service da médica · 2026-04-20

**Contexto:** com o ciclo fiscal fechado (D-041) e o cron de payouts
operando (D-040), sobrou um único gargalo humano no onboarding da
médica: **a chave PIX**. Até agora, só o admin podia cadastrar ou
trocar o PIX em `/admin/doctors/[id]`. Resultado prático:

- Médica nova entra → precisa abrir ticket WhatsApp pro operador
- Troca de chave (conta nova, banco novo) → outro ticket
- Operador digita os dados a partir de print/foto → risco de typo
  em `pix_key_type` + `pix_key` vs `CPF/CNPJ do titular`
- Zero histórico auditável: a única chave existente era sempre a
  atual; não sabíamos se tinha sido trocada nem quando

Sem resolver isso, o cadastro "Convidada → Ativa" sempre depende
do admin. E sem histórico, não temos como responder um "essa NF
foi paga pro PIX certo naquele mês?".

**Alternativas consideradas:**

1. **Manter admin-only** — barato, zero código, mas cada onboarding
   e cada troca exige intervenção humana. Mostrou-se insuficiente
   mesmo com volume baixo (3-5 médicas). Descartado.
2. **Self-service com UPDATE destrutivo** — médica edita o registro
   `is_default=true` existente. Mais simples mas **apaga o
   histórico**. Perde auditoria do "quem trocou, quando, para
   quê". Descartado.
3. **Self-service com troca não-destrutiva + histórico**
   (o que escolhemos) — nova chave é INSERT; o registro antigo vira
   `is_default=false, active=false, replaced_at=now(),
   replaced_by=user.id`. Preserva TUDO.
4. **Validar com API Asaas (`/accounts/validatePixKey`)** —
   tecnicamente interessante mas adiado: hoje o PIX é executado
   manualmente pelo admin no app do banco, não via Asaas. Validação
   viraria falsa segurança (retorna "chave válida" mas não garante
   nada sobre a execução manual). Retomar quando a execução for
   também via Asaas (D-04X futuro).

**Decisão:** Opção 3.

**Arquitetura:**

1. **Migration 017 (`20260422000000_doctor_payment_methods_history.sql`):**
   - `doctor_payment_methods.replaced_at timestamptz` — quando
     deixou de ser default
   - `doctor_payment_methods.replaced_by uuid references auth.users` —
     quem trocou (médica via self-service OU admin)
   - Índice `idx_dpm_history(doctor_id, created_at desc)` pra listar
     histórico rápido na UI
   - RLS **não muda**: a policy `dpm_doctor_self` (migration 005) já
     permite leitura/escrita da médica dona.

2. **Core: `src/lib/doctor-payment-methods.ts` (fonte única):**
   - `PIX_KEY_TYPES`, `isValidPixKey`, `normalizePixKey`,
     `validatePixInput`, `isHolderConsistent` — validação/normalização
     por tipo (cpf, cnpj, email, phone, random)
   - `listPaymentMethods(supabase, doctorId)` — default + histórico
     ordenados (default primeiro, depois created_at desc)
   - `getActivePaymentMethod(supabase, doctorId)` — só o default
   - `createOrReplacePaymentMethod(supabase, doctorId, input,
     {replacedByUserId})` — **troca não-destrutiva**:
       1. Busca default vigente
       2. `UPDATE doctor_payment_methods SET is_default=false,
          active=false, replaced_at=now(), replaced_by=userId
          WHERE doctor_id=... AND (active OR is_default)`
       3. `INSERT` novo registro com `is_default=true, active=true`
     Resultado: invariante de `idx_dpm_one_active` (só 1 active=true
     por médica) e `idx_dpm_one_default` (só 1 is_default=true)
     mantidas; cron D-040 continua funcionando sem mudança.
   - `deleteHistoricalPaymentMethod(supabase, doctorId, id)` —
     remove registro do histórico **apenas se não-default**. Não é
     possível se deixar sem PIX.
   - `maskPixKey`, `labelForPixType` — helpers de apresentação.

3. **APIs HTTP (espelham padrão de /api/medico/*):**
   - `GET /api/medico/payment-methods` → lista (default + histórico)
   - `POST /api/medico/payment-methods` → cria/substitui
   - `DELETE /api/medico/payment-methods/[id]` → remove histórico
   - `POST /api/admin/doctors/[id]/payment-method` — **refatorado**
     pra delegar pra `createOrReplacePaymentMethod` (mesma lógica).
     Admin também gera entradas de `replaced_at`/`replaced_by`.

4. **UI `/medico/perfil/pix`:**
   - Card vigente (tipo + chave mascarada + titular + verified_at)
   - Form de troca (com `window.confirm` porque é ação sensível)
   - Lista de histórico com botão "Remover" por item
   - Sidebar educativa ("como os repasses funcionam", "dicas")
   - Card no `/medico/perfil` mostra PIX atual + CTA "Gerenciar"
   - **Banner terracotta no `/medico` dashboard** quando não há PIX:
     sem chave, o payout não consegue gerar automaticamente.

5. **Preservação do cron D-040:** o cron
   `/api/internal/cron/generate-payouts` lê PIX com `active=true`.
   A troca não-destrutiva garante **sempre no máximo 1** registro
   `active=true` por médica. Não há snapshot "histórico" no payout
   (já que o payout registra `pix_key_snapshot` no próprio
   `doctor_payouts` no momento da criação — imutável por design).

**Impacto:**
- Onboarding da médica agora é 100% self-service:
  convite → login → completa perfil → cadastra PIX → recebe.
- Troca de chave sem intervenção humana (e com auditoria).
- Admin mantém o poder via `/admin/doctors/[id]` (mesma lib), para
  casos de suporte (médica sem acesso ao email, etc).

**Métricas alvo:**
- Tempo médio "convidada → ativa": < 24h (antes: 2-5 dias
  limitado por disponibilidade do admin)
- % de médicas ativas com PIX cadastrado: ≥ 95%
- Nº de tickets "quero trocar meu PIX": → 0

**Testes (29 casos novos):**
- `doctor-payment-methods.test.ts`: validação por tipo,
  normalização, createOrReplace (insere, substitui, propaga erro),
  deleteHistorical (bloqueia default, rejeita outra médica).

**ADRs relacionados:** D-022 (estrutura `doctor_payment_methods`),
D-026 (campos `is_default` / `account_holder_*`), D-040 (cron que
consome o PIX), D-041 (ciclo fiscal que complementa este fluxo).

---

## D-041 · Painel financeiro da médica + upload de NF-e + cron de cobrança · 2026-04-20

**Contexto:** depois do D-040, a geração de payouts virou automática
e idempotente — mas o **fecho do ciclo fiscal** continuava fora do
sistema. A médica não tinha como:

1. Ver em tempo real o **saldo** (pending + available + próximo payout
   estimado) — só conseguia abrir `/medico/ganhos` e filtrar por mês.
2. **Anexar NF-e** pra cada payout confirmado. O fluxo atual era:
   admin cobra por WhatsApp → médica emite NF-e no prefeitura → envia
   por e-mail → admin arquiva manualmente. Frágil e não auditável.
3. Ter um admin que **validasse** formalmente a NF recebida (CNPJ
   correto, valor bate com o repasse, número válido).

Sem isso, o instituto ficava com um passivo invisível: payouts pagos
mas sem documento fiscal correspondente, criando risco tributário e
sobrecarga de follow-up manual.

**Alternativas consideradas:**

1. **Continuar manual fora do sistema** — operador cobra no WhatsApp,
   arquiva NF em pasta. Barato de construir (zero código), mas cada
   ciclo mensal consome ~30 min do admin e a auditoria depende de
   pastas de Drive. Não escala além de ~10 médicas.
2. **Integrar com API municipal (NFS-e) pra emitir NF automaticamente
   em nome da médica** — tecnicamente inviável sem certificado digital
   dela, juridicamente inviável (a NF é emitida pelo CNPJ da médica,
   não do instituto). Descartado.
3. **Upload de NF pela médica + validação humana pelo admin** (o que
   escolhemos). Mantém a emissão como responsabilidade da médica
   (correta juridicamente), mas traz o documento pra dentro do sistema
   pra auditoria. Médio esforço de engenharia (~1 dia).

**Decisão:** Opção 3 — fluxo self-service da médica + validação admin.

**Arquitetura:**

1. **Storage dedicado (migration 015):**
   - Novo bucket privado `billing-documents` (separado do
     `payouts-proofs` do D-022/D-026). Aceita PDF/XML/PNG/JPG/WEBP
     até 5 MB. Service role only — zero exposição cliente.
   - Path convenção: `billing/{payout_id}/{timestamp}-{slug}.{ext}`.
   - `doctor_billing_documents(payout_id)` virou UNIQUE — 1 NF por
     payout. Substituição é DELETE + POST explícito (operação rara,
     melhor que versionamento invisível).
   - Coluna nova `doctor_payouts.last_nf_reminder_at` pra idempotência
     do cron de cobrança (índice parcial pra query rápida).

2. **Core: `src/lib/doctor-finance.ts` (fonte única da verdade):**
   - `getDoctorBalance(supabase, doctorId)` — agrega por status
     (pending / available / in_payout / paid).
   - `estimateNextPayout(supabase, doctorId, now)` — separa
     "eligible" (available_at < mês atual) de "deferred" (cairá no
     ciclo seguinte). Retorna `scheduledAt` = próximo dia 1 às 09:15
     UTC (alinhado com Vercel Cron do D-040).
   - `listPayoutsWithDocuments(supabase, doctorId, limit)` — join
     `doctor_payouts` + `doctor_billing_documents` (camelCase pro
     consumo em React).
   - `countPendingBillingDocuments(supabase, doctorId?)` — distingue
     `pendingUpload` (sem doc) de `awaitingValidation` (doc sem
     `validated_at`). Alimenta o banner no dashboard.

3. **Storage helpers: `src/lib/billing-documents.ts`:**
   - Espelho deliberado de `payout-proofs.ts`. Bucket separado permite
     policies de retenção independentes no futuro (NF-e tem exigência
     fiscal de 5 anos para a médica; comprovante PIX é responsabilidade
     do instituto).
   - `buildStoragePath`, `slugifyFilename`, `createSignedUrl`,
     `removeFromStorage` — API idêntica, paths diferentes.

4. **APIs HTTP (reutilizam padrão do D-026):**

   - `POST /api/medico/payouts/[id]/billing-document` (multipart):
     valida MIME/tamanho, confere ownership, insere/atualiza linha
     em `doctor_billing_documents`, tira o arquivo antigo. Substituição
     zera `validated_at` (admin precisa re-validar).
   - `GET` — signed URL 60s.
   - `DELETE` — só ENQUANTO não validado (após validação, só admin remove).

   - `GET /api/admin/payouts/[id]/billing-document` — signed URL 60s.
   - `DELETE` — admin pode remover mesmo após validação (casos de
     correção).
   - `POST /api/admin/payouts/[id]/billing-document/validate[?unvalidate=1]`
     — mutação explícita (POST com body opcional pra `validation_notes`).
     Idempotente: revalidar preserva o `validated_at` original
     (auditoria).

5. **UI self-service:**
   - `/medico/repasses` reescrito: mostra saldo em tempo real (4 cards
     — disponível, aguardando, próximo repasse, total recebido),
     banner quando há NF pendente, card por payout com status + botão
     "Enviar NF" integrado (`BillingDocumentBlock`). Form com número
     da NF, data de emissão e valor (opcionais, ajudam na conferência).
   - `/medico` (dashboard): banner de aviso quando há payouts confirmados
     sem NF enviada, com link pra `/medico/repasses`.
   - `/admin/payouts/[id]`: novo painel `BillingDocumentAdminPanel` no
     sidebar. Mostra número/valor/diferença; destaca se
     `document_amount_cents !== amount_cents` (vermelho). Textarea pra
     `validation_notes`. Botões: Validar / Desvalidar / Remover.

6. **Cron de cobrança (`src/lib/notify-pending-documents.ts`):**
   - Roda diariamente às 09:00 UTC ≈ 06:00 BRT via Vercel Cron.
   - Query: payouts `status='confirmed'` com `paid_at ≤ now - 7d`.
   - Para cada payout sem NF validada:
     - Interval guard: `last_nf_reminder_at` mais recente que
       `REMINDER_INTERVAL_HOURS` (24h) → pula (evita spam).
     - Médica sem phone/nome → pula MAS marca `last_nf_reminder_at`
       (impede loop).
     - Template stub (`templates_not_approved`) → pula MAS marca
       `last_nf_reminder_at` (impede loop daily em dev).
     - Send real → incrementa `notified`, marca timestamp.
   - Guard de `MAX_NOTIFICATIONS_PER_RUN` (100) pra proteger quota Meta.
   - Retorno estruturado: `{ evaluated, notified, skippedInterval,
     skippedTemplate, skippedMissingPhone, errors, details }` — vai
     pro `cron_runs.payload`.

7. **Observabilidade (`src/lib/system-health.ts`):**
   - Novo check `cron_notify_pending_documents` (36h warning, 7d erro).
   - `payloadSummary` estendido pra mostrar `evaluated`, `notified`,
     `skippedInterval`, `skippedTemplate`, `skippedMissingPhone` na
     tela `/admin/health`.

**Idempotência e segurança:**

- UNIQUE(`payout_id`) protege corrida na criação do doc.
- Ownership check em TODA rota `/api/medico/*` (compara
  `payout.doctor_id` com `requireDoctor()`).
- `validated_at` só pode ser mexido pela rota admin dedicada.
- Bucket 100% privado, signed URLs de 60s. Service role never exposed.
- `last_nf_reminder_at` garante que o cron não spama (mesmo se rodar
  10x no dia).

**Consequências:**

- Ciclo fiscal fecha dentro do sistema: cron gera draft → admin
  aprova/paga → médica sobe NF → admin valida. Zero trabalho humano
  recorrente além da validação (que é obrigatória por natureza).
- Auditoria completa: `/admin/payouts/[id]` mostra o documento junto
  do comprovante de PIX. Uma página, uma fonte da verdade.
- Quando o template Meta `medica_documento_pendente` for aprovado, o
  cron passa a cobrar automaticamente — o stub atual já registra
  `last_nf_reminder_at` pra não entrar em loop em dev.
- 91 testes passando (27 novos em `doctor-finance.test.ts`,
  `billing-documents.test.ts`, `notify-pending-documents.test.ts`).

---

## D-040 · Crons financeiros reimplementados em Node, com observabilidade · 2026-04-20

**Contexto:** a migration 005 (D-022) já tinha criado as RPCs Postgres
`recalculate_earnings_availability()` e `generate_monthly_payouts()`
agendadas via `pg_cron`. Em teoria, o ciclo financeiro estava
"pronto". Na prática:

1. `pg_cron` pode não estar habilitado em um ambiente (o próprio
   bloco `CREATE EXTENSION` faz apenas `raise notice` e segue). Se
   alguém esqueceu, earnings ficam presas em `pending` indefinidamente
   e nenhum payout é gerado — sem alerta.
2. As RPCs retornam só um `int`. **Zero observabilidade**: ninguém sabe
   se rodou, quantas earnings foram promovidas, se houve erro, quais
   médicas foram puladas por falta de PIX.
3. Médicas com saldo `available` mas sem `doctor_payment_methods.active=true`
   são silenciosamente ignoradas pelo `JOIN` do SQL. Admin só descobre
   a lacuna quando a médica pergunta "cadê meu repasse?".
4. A lógica era difícil de testar em unit test (exigiria fixture SQL
   de banco de teste isolado).

**Decisão:** reimplementar os dois crons em **Node puro** (com Supabase
service role), chamados via **Vercel Crons**, mantendo as RPCs no banco
como **backup idempotente** rodando sob `pg_cron` (quando habilitado).

**Arquitetura:**

- `src/lib/earnings-availability.ts`
  - Função: `recalculateEarningsAvailability(supabase)`
  - Regra (paridade com COMPENSATION.md):
    - Earning sem `payment_id` → `available_at = earned_at`, promove já.
    - Earning com `payment_id` → `available_at = payment.paid_at + janela`
      onde janela = 7 dias (PIX), 3 dias (BOLETO), 30 dias (CREDIT_CARD
      e UNDEFINED — pior caso conservador).
    - `available_at <= now()` → `status='available'` via UPDATE com
      `.eq("status","pending")` (guard contra corrida).
  - Retorno estruturado: `{ inspected, scheduledFuture, promoted,
    skippedMissingPaidAt, errors, errorDetails }`.

- `src/lib/monthly-payouts.ts`
  - Função: `generateMonthlyPayouts(supabase, { referencePeriod? })`
  - `defaultReferencePeriod(now)` → mês anterior no fuso UTC, 'YYYY-MM'.
  - Pipeline:
    1. SELECT earnings `available` + `payout_id IS NULL` + `available_at
       < currentMonthStartIso()`.
    2. Agrega por `doctor_id`, descarta quem tem `sum=0`.
    3. SELECT `doctors` e `doctor_payment_methods (active=true)` em
       batch (2 queries pro N de médicas).
    4. Por médica: se inativa OU sem PIX → `warning` no payload, pula.
       Se ok → INSERT com `auto_generated=true`. Em `23505` (unique)
       → trata como idempotente, warning `existing_payout`.
    5. UPDATE `doctor_earnings` linked com guard `.eq("status","available")
       .is("payout_id",null)` + `.in("id", earningIds)`.
  - Retorno: `{ referencePeriod, doctorsEvaluated, payoutsCreated,
    payoutsSkippedExisting, payoutsSkippedMissingPix, earningsLinked,
    totalCentsDrafted, warnings[], errors, errorDetails }`.

- `src/lib/cron-runs.ts`
  - Wrapper `startCronRun` / `finishCronRun` que persiste cada execução
    na nova tabela `public.cron_runs` (migration 014): job, status,
    duration_ms, payload (counters + warnings), error_message.

- `GET /api/internal/cron/recalculate-earnings` (daily, 03:15 UTC)
- `GET /api/internal/cron/generate-payouts` (monthly, dia 1 09:15 UTC)
  - Autenticados por `CRON_SECRET` (mesmo padrão das outras crons).
  - Param opcional `?period=YYYY-MM` pra backfill manual.

**Schema complementar (migration 014):**

- `doctor_payouts.auto_generated boolean default false` — destaca na
  UI `/admin/payouts` drafts gerados pelo cron (badge "auto") vs.
  ajustes manuais futuros.
- `cron_runs (id, job, started_at, finished_at, status, duration_ms,
   payload jsonb, error_message)` + índices em `(job, started_at)`
  e `(status)`. Service role only.

**Observabilidade (D-039 + D-040):**

- `system-health.ts` ganhou dois checks:
  - `cron_earnings_availability` — warning > 36h sem run, error > 7d.
  - `cron_monthly_payouts` — warning > 40d, error > 70d (cron mensal,
    folga grande).
  - Se a última execução foi `error`, eleva o status em 1 nível mesmo
    que fresca.
  - `payload_summary` no details expõe contagens chave (`promoted`,
    `payoutsCreated`, `errors`) direto no dashboard.

**Coexistência com pg_cron:**

As RPCs SQL continuam no banco e rodam junto com os crons Vercel.
Ambas são idempotentes (UPDATE com guard de status; INSERT com
UNIQUE). Se uma rodar primeiro, a segunda vira noop. Em prod, se o
Vercel cair num minuto específico, o `pg_cron` cobre (e vice-versa).
No dev/teste sem `pg_cron`, o Vercel é o único motor — e agora é
observável.

**Alternativas consideradas:**

- **Manter só o pg_cron.** Rejeitada: 3 problemas acima intocados.
- **Trigger SQL em INSERT/UPDATE de earnings.** Rejeitada: viola
  imutabilidade (D-022), não resolve `generate_monthly_payouts` que é
  intrinsicamente batch.
- **Webhook vindo do Asaas disparando re-calc.** Rejeitada: só cobre
  consultas; não resolve ajustes/plantão; cria acoplamento a um
  provider externo pra coisa interna.

**Testes:**

- `earnings-availability.test.ts` — 16 testes cobrindo cada billing_type,
  payment sem paid_at, earnings sem payment_id, idempotência, erro de
  select, agregado com múltiplas earnings mistas.
- `monthly-payouts.test.ts` — 12 testes cobrindo happy path,
  `defaultReferencePeriod` (janeiro→dezembro, meses 1-12), PIX missing,
  PIX vazia, médica inativa, sum-zero por clawback, unique violation
  (idempotência), erro parcial isolado de uma médica, 2 médicas
  simultâneas.

**Consequências:**

- Médicas recebem PIX no primeiro dia útil do mês sem intervenção
  manual — earnings avançam diariamente e viram draft no dia 1º.
- Admin tem feedback imediato no `/admin/health` sobre o ciclo
  financeiro — quebra não fica silenciosa por 30 dias até alguém
  reclamar.
- Admin sabe exatamente quais médicas têm saldo mas faltam PIX
  cadastrado (warning `missing_pix_active` no payload da cron_run).
- Badge "auto" em `/admin/payouts` deixa evidente quais drafts
  nasceram do cron (base futura pra permitir edição/aprovação diferente).
- Duplicação controlada de lógica (Node + SQL). Mitigada pela paridade
  documentada aqui e pelos testes.
- **Abre Sprint 5:** financeiro agora flui. Próximos blocos
  naturais são NF-e upload flow, relatório financeiro por médica,
  automação PIX via Asaas, e o Painel da Médica propriamente dito.

---

## D-039 · Prova de fogo E2E (runbook + health endpoint + dashboard) · 2026-04-20

**Contexto:** antes desta entrega, validar que "tudo está funcionando
em produção" era um exercício tácito: o admin abria `/admin/*`,
conferia se nada explodia, e seguia. Com a pilha atual (Asaas + Daily
+ WhatsApp + 3 crons + 3 webhook sinks + política de no-show + auto-pause
de médicas + conciliação financeira), essa verificação informal deixou
de ser confiável — tem coisa demais acontecendo em background pra
saber olhando.

Três gatilhos concretos pra formalizar agora:

1. **D-029 (bug Daily webhook)** ensinou que integração externa pode
   falhar silenciosamente por semanas até alguém notar que appointments
   deixaram de fechar. A mitigação foi cron fallback (D-035), mas a
   lição é: preciso saber **no momento** se o sinal de finalização tá
   fluindo, independente de qual caminho.

2. **D-032 (política de no-show assimétrica)** + **D-036 (auto-pause)**
   criam efeitos colaterais em cascata. Um bug em qualquer etapa pode
   deixar dinheiro mal distribuído (médica sem clawback) ou médica
   pausada sem motivo. Conciliação (D-037) pega a metade financeira,
   mas precisa ser rodada; e reliability precisa ser monitorada em
   conjunto.

3. **Sprint 5 em diante vai mexer em fluxos ainda mais sensíveis**
   (pagamento recorrente, prescrição Memed, fila on-demand). Sem uma
   cobertura base de "como eu sei que tudo tá ok agora?", cada feature
   nova vai ser deploy-and-pray.

**Alternativas consideradas:**

- **Playwright E2E rodando em CI contra staging.** Rejeitado pra essa
  volta: não temos staging separado (custo Supabase/Vercel duplicado
  + replicação de Asaas sandbox + dados seed) e Playwright contra
  produção é perigoso (cria dados reais em cada run, polui métricas).
  Adiado pra Sprint 6 quando/se fizer staging separado. Custo maior
  que benefício imediato.

- **Testes de integração com Supabase local (docker + seed).**
  Rejeitado: sobe em ~30s por ciclo, adiciona complexidade de setup
  em CI, e cobre só a camada DB — integrações externas (Asaas, Daily,
  WhatsApp) precisariam de mocks de qualquer jeito. Com 9 checks
  paralelos em ~500ms via `runHealthCheck`, o sinal equivalente tá
  presente sem a infra.

- **Monitoria via observabilidade profissional (Datadog, Sentry APM,
  Better Stack).** Rejeitado pra essa versão: custo mensal + setup
  + instrumentação. Pra operação atual (1 médica, 0 consultas/dia
  ainda), overkill. UptimeRobot grátis batendo no smoke endpoint
  resolve 80% com esforço mínimo. Se o volume justificar, migração
  fácil (o próprio endpoint já retorna JSON estruturado).

- **Tabela de log de cron runs (`cron_runs`) + histórico de health
  checks.** Rejeitado pra MVP: gera volume de dados em rampa + UI
  extra. Os 3 event tables existentes (`asaas_events`, `daily_events`,
  `whatsapp_events`) + `reconciled_at` em appointments já fornecem
  rastreio histórico pros checks atuais.

- **Smoke test que CRIA dados sintéticos (customer teste, payment,
  appointment) a cada execução.** Rejeitado: efeitos colaterais
  (polui DB, dispara webhook real) + complexidade de cleanup.
  Runbook manual (`docs/RUNBOOK-E2E.md`) cobre o caso "tenho que
  exercitar o fluxo completo" sem código que muta em produção.

**Decisão:** três componentes read-only:

1. **`src/lib/system-health.ts`** — 9 checks paralelos com timeout
   individual e tolerância a falha por check:
   - `database` · count em `doctors` (DB reachable)
   - `asaas_env` · validação de env vars + ping opcional (GET
     `/customers?limit=1`)
   - `asaas_webhook` · freshness do último `asaas_events.received_at`
   - `daily_env` · validação de env vars + ping opcional (GET
     `/rooms?limit=1`)
   - `daily_signal` · max(`daily_events.received_at`,
     `appointments.reconciled_at`) — aceita webhook OU cron como sinal
   - `whatsapp_env` · validação de env vars (sem ping por default
     pra não gastar rate limit do Meta Graph)
   - `whatsapp_webhook` · freshness do último `whatsapp_events`
   - `reconciliation` · reutiliza `getReconciliationCounts()` (D-037)
   - `reliability` · reutiliza `listDoctorReliabilityOverview()` (D-036)

2. **`/admin/health`** · página server-rendered que chama
   `runHealthCheck()` no request. Mostra status agregado no topo +
   9 cards por subsistema com status (ok/warning/error/unknown),
   summary humano, detalhes estruturados e tempo de execução por
   check. `?ping=1` força ping externo (HTTP real em Asaas/Daily).

3. **`GET /api/internal/e2e/smoke`** · endpoint JSON protegido por
   `CRON_SECRET` (mesmo padrão dos crons). Retorna `HealthReport`
   completo; HTTP 503 quando `overall: "error"` pra facilitar
   UptimeRobot / Better Uptime lerem só o status code. Zero side
   effect — seguro pra rodar a cada minuto.

4. **`docs/RUNBOOK-E2E.md`** · roteiro passo-a-passo dos 7 cenários
   críticos (paciente feliz, no-show médica, sala expirada, refund
   manual/asaas, payout mensal, conciliação limpa, auto-pause). Cada
   cenário tem pré-requisitos, passos numerados, checklist de
   validação (com queries SQL quando aplicável) e limpeza. Inclui
   instruções de troubleshooting e query de cleanup de dados de teste.

**Consequências:**

- **Detecção de regressão passa de "o admin reclamou" pra "o
  endpoint respondeu 503"** — UptimeRobot grátis batendo a cada 5 min
  no smoke é suficiente pra alertar antes do usuário final perceber.
- **Runbook serve como documentação viva** — um novo desenvolvedor
  (ou Claude futuro) lê o RUNBOOK e entende o fluxo completo sem ter
  que reconstituir da leitura de código.
- **Decisão deliberada de NÃO automatizar os 7 cenários** — a
  economia de reusar infra humana (André tem os números de
  WhatsApp, a conta Asaas sandbox, acesso ao painel Daily) supera o
  ganho de CI automatizado enquanto o volume for baixo. Reavaliar na
  Sprint 6/7 quando tiver 2-3 médicas e 10+ consultas/dia.
- **Sprint 4.1 fecha em 100%** — todos os pedaços de "fundação
  multi-médico + agenda + sala + financeiro base" têm cobertura de
  validação agora.
- **Próximo passo natural (Sprint 5+):** Playwright E2E contra
  staging, mas só depois de ter staging. Staging vira prioridade
  quando o primeiro bug em produção causar dano real; até lá, o
  runbook + smoke cobrem o risco.

**Status:** ✅ Implementado.

---

## D-038 · Testes automatizados unitários com Vitest (mínimo viável) · 2026-04-20

**Contexto:** até aqui o projeto não tinha nenhum teste automatizado. A
cobertura era `npm run build` + `tsc --noEmit` + testes manuais E2E
antes de cada merge pra `main`. Isso funcionou enquanto o código era
pequeno e cada feature era conhecida na cabeça, mas agora temos:

- Política assimétrica de no-show (D-032) com ramos de cobrança/refund
  que envolvem dinheiro real.
- Regras de confiabilidade da médica (D-036) com auto-pause baseado em
  threshold — precisa ser idempotente e não disparar em médica já
  pausada manualmente.
- Conciliação financeira (D-037) com 6 checks independentes sobre 3
  tabelas.
- Refund via Asaas API atrás de feature flag (D-034) — flag default-off
  é salva-vidas em caso de bug, então não pode vazar pra on sem
  intenção.
- Dedupe idempotente em múltiplos webhooks (Asaas, Daily, WhatsApp
  template status).

Com essa quantidade de lógica crítica, a ausência de testes começa a
pesar. Risco concreto: alguém fazer refactor em `no-show-policy.ts` pra
adicionar um caso novo e quebrar silenciosamente o caso de
`expired_no_one_joined` (cuja ramificação é fácil de esquecer).

**Alternativas consideradas:**

- **Jest.** Rejeitado por inércia de configuração com Next 14 + ESM +
  `moduleResolution: "bundler"` + alias `@/*`. Jest funciona mas exige
  `ts-jest` + `moduleNameMapper` + transform setup. Vitest roda
  nativamente em ESM e respeita `tsconfig.paths` via seu próprio
  resolver.
- **Playwright E2E desde já.** Adiado pra D-039. Testes E2E precisam de
  ambiente de staging com DB limpo + Asaas sandbox + dados seed. Sprint
  5 planejada separada. ROI menor agora porque quebras atuais são de
  lógica interna, não de fluxo ponta-a-ponta.
- **Testes de integração com Supabase local (via `supabase start`).**
  Rejeitado por ora: o setup sobe Postgres + PostgREST + Studio no
  Docker e leva ~30s por teste de DB. Acelera iteração só quando o
  projeto tem 100+ testes. Hoje com <30, mocks em memória são mais
  rápidos e menos frágeis.
- **Pular testes e investir o tempo em features.** Rejeitado: o custo
  de não ter testes já tá alto o suficiente. Um bug silencioso na
  política de no-show ou no auto-pause é jornada toda pra reconstituir
  depois.

**Decisão:** Vitest + mock de Supabase em memória, focando em 3 suites
cobrindo os pontos mais críticos:

1. `src/lib/reliability.test.ts` — auto-pause no threshold hard,
   idempotência em pause/unpause (não sobrescrever pause manual com
   metadados de auto-pause), dedupe 23505 em `recordReliabilityEvent`.
2. `src/lib/refunds.test.ts` — feature flag `REFUNDS_VIA_ASAAS` é
   literal-`"true"` only (case-sensitive, `"1"`/`"TRUE"` não contam), e
   `markRefundProcessed` é idempotente por `refund_processed_at`.
3. `src/lib/reconciliation.test.ts` — `KIND_LABELS` cobre exaustivamente
   `DiscrepancyKind` (teste quebra se alguém adicionar kind novo sem
   label), 4 críticos + 2 warnings por design, `runReconciliation` não
   quebra com DB vazio nem com erros de query em checks individuais.

**Helper `src/test/mocks/supabase.ts`:** em vez de simular um query
builder completo (propenso a bugs no próprio mock), cada teste enfileira
explicitamente as respostas que cada `.from('tabela')` deve devolver, em
ordem. O builder aceita toda a chain fluente (`.select().eq().is()...`)
e resolve via `thenable` ou terminais (`.single()` / `.maybeSingle()`).
Pequeno, transparente, fácil de auditar.

**Consequências:**

- Regressão em lógica crítica vira erro de CI em vez de bug em produção.
- 29 testes passando em ~500ms — contrato de velocidade preservado
  (rodar `npm test` precisa caber no muscle memory; nunca vai ter
  incentivo pra pular).
- Nova convenção: mudou `src/lib/*.ts` crítico → adiciona/atualiza teste
  correspondente. Sem cerimônia extra.
- Próximos passos (D-039+): E2E com Playwright; cobertura pra
  `no-show-policy.ts`, `appointment-lifecycle.ts`, `slot-reservation.ts`
  (os três mais complexos que ficaram de fora dessa primeira leva por
  envolverem mais mocks).
- `REFUNDS_VIA_ASAAS` agora tem trava de teste: se alguém mudar o
  parser pra aceitar `"1"` ou `"TRUE"` sem intenção, o teste quebra.

**Status:** ✅ Implementado.

---

## D-037 · Conciliação financeira read-only (on-demand) · 2026-04-20

**Contexto:** D-022 (controle financeiro interno) instituiu três
tabelas que movimentam dinheiro — `payments`, `doctor_earnings`,
`doctor_payouts` — com ciclos de vida separados: payment tem status
controlado pelo Asaas (via webhook), earning tem ciclo
pending→available→in_payout→paid, payout tem draft→approved→pix_sent→
confirmed. Cada transição é controlada por um handler diferente
(webhook Asaas, cron de availability, admin aprovando payout, etc).

Mesmo com idempotência em cada handler, existem modos de falha onde
os três podem sair de sincronia:

1. Webhook Asaas `PAYMENT_RECEIVED` registra no payments mas o
   handler falha ao criar earning (erro silencioso no
   `handleEarningsLifecycle`).
2. `applyNoShowPolicy` chama `createClawback` que retorna erro —
   policy segue (por design, pra não travar o fluxo) mas o clawback
   nunca é criado.
3. Admin aprova payout, PIX é enviado, admin esquece de clicar
   `confirm` — earnings ficam `in_payout` indefinidamente mesmo com
   dinheiro já na conta da médica.
4. Earning é adicionada manualmente via SQL depois do payout gerado,
   e `amount_cents` do payout não é atualizado — drift.
5. Refund processado no painel Asaas direto (D-034 webhook dedupe
   cobre, mas se webhook falhar, fica dessincronizado).

Sem ferramenta pra detectar isso, o admin só descobre quando a médica
reclama ("não recebi X consulta") ou quando o saldo disponível no
`/admin/payouts` parece alto demais. Ambos já são sintomas tardios.

**Alternativas consideradas:**

- **Triggers SQL que bloqueiam inserções inconsistentes.** Rejeitado:
  o custo de rigidez é maior que o benefício. Cada operação válida
  teria que passar por checks custosos; e quando algo falhasse, o
  erro ficaria em log do Postgres em vez de UI pro admin.

- **Cron periódico que aplica correções automáticas.** Rejeitado pra
  primeira versão: conciliação financeira é exatamente o tipo de
  coisa em que correção automática pode piorar o problema (pagar duas
  vezes, deletar earning legítima). Decidimos: **detectar
  automaticamente, corrigir manualmente**.

- **Integração com conciliação bancária (extrato PIX).** Rejeitado
  pra essa versão: exige conexão com Open Finance ou parser de OFX;
  escopo muito maior. A conciliação interna já resolve 90% dos casos
  (dinheiro que saiu do sistema mas não foi registrado corretamente);
  bancária cobriria "PIX não chegou ao destinatário" — cobrir depois.

- **Persistir o relatório em tabela pra histórico.** Rejeitado por
  ora: admin roda on-demand, foto fica no navegador. Se precisar
  auditar "isso já existia semana passada?", dá pra re-rodar com
  query de data. Adicionar persistência quando surgir caso de uso
  real (ex: relatório mensal exportável).

**Decisão:**

1. **Lib `src/lib/reconciliation.ts` com 6 checks read-only.**
   Cada check retorna array de `Discrepancy` tipada com severidade,
   ids, valores, idade e hint de ação.

   Críticos (ação imediata):
   - `consultation_without_earning`: appointment completed há >1h
     sem earning `type='consultation'`.
   - `no_show_doctor_without_clawback`: policy aplicada + payment_id
     + status de no-show, sem earning `type='refund_clawback'`.
   - `payout_paid_earnings_not_paid`: payout `paid`/`confirmed` com
     earnings ainda em status != 'paid'.
   - `payout_amount_drift`: soma de earnings.amount_cents !=
     payout.amount_cents OR contagem != earnings_count.

   Warnings (suspeitos mas podem ser legítimos):
   - `earning_available_stale`: earning `available` há >45d sem
     payout (cron mensal pode estar off).
   - `refund_required_stale`: `refund_required=true` há >7d sem
     processar (paciente esperando).

2. **Hard limit de 100 itens por check.** Se estourar, marca como
   truncado na UI — sinaliza que operação está fora de controle, pede
   atenção, mas não trava o render. 100 é generoso o bastante pra
   cobrir cenários reais de meses ruins.

3. **Página `/admin/financeiro` chama `runReconciliation()` no
   request.** Server Component, sem cache. Cada visita é foto nova.
   Custo: ~6 queries rápidas no Supabase (todas com índices
   existentes). Aceitável pra UI de admin.

4. **Dashboard global (`/admin`) chama `getReconciliationCounts()`**
   no load pra mostrar alertas em "Próximos passos". Mesma lib, só
   descarta os detalhes. Evita duplicação de lógica e garante que
   números batem entre as duas páginas.

5. **Zero mutations.** Toda correção é manual via SQL. O hint na
   UI dá o comando sugerido; admin decide caso-a-caso. Razão: auto-fix
   de finanças é risco assimétrico — errado, paga duas vezes; certo,
   só economiza 30s de SQL.

6. **UI agrupa por severidade → por kind.** Críticas primeiro
   (vermelho), warnings depois (neutro). Cada card de grupo tem
   descrição da categoria + lista de casos com detalhes
   estruturados + hint de ação.

**Implementação:** 1 lib nova (`reconciliation.ts`), 1 página nova
(`/admin/financeiro/page.tsx` — item do AdminNav que estava apontando
pra pasta vazia), 1 modificação no dashboard global.

**Consequências imediatas:**

- Admin pode auditar sanidade financeira on-demand. Recomendação
  operacional: toda sexta antes de fechar o mês + sempre que o
  dashboard principal mostrar "N críticas".
- Bugs silenciosos em handlers de earning/payout passam a aparecer
  com contexto e sugestão de ação — tempo de detecção vai de "quando
  médica reclama" pra "no próximo visit do admin".
- Zero risco de corromper dados — ferramenta puramente
  diagnóstica.

**Pendente (Sprint 5+):**

- Cron diário que envia alerta (email/WhatsApp admin) quando
  `totalCritical > 0`. Hoje depende de admin abrir a UI.
- Ações "corrigir com 1 clique" pros casos triviais (ex: payout com
  earnings ainda `in_payout` → marcar como paid com paid_at do
  payout). Só fazer depois que a operação tiver confiança no report.
- Conciliação bancária (extrato PIX vs `doctor_payouts.paid_at`) —
  exige Open Finance ou parser OFX. Escopo de Sprint futura.
- Export do relatório em CSV pra contador — trivial quando
  precisar.

---

## D-036 · Regras de confiabilidade da médica (auto-pause) · 2026-04-20

**Contexto:** D-032 instituiu o contador `doctors.reliability_incidents`
pra acompanhar no-shows + cancelamentos forçados pela médica. Mas o
contador é agregado, monotônico, sem janela temporal e sem ação. Na
prática ele servia só como "termômetro informativo no admin", e:

1. Incidentes de 1 ano atrás contavam igual aos de 1 semana.
2. Sem forma de dispensar um caso comprovadamente não-culpa da médica
   (ex: paciente reportou que tinha caído luz na região dela).
3. Sem ação automática — admin tinha que vigiar um número crescente
   manualmente.
4. Risco de reputação: paciente agenda com uma médica que fez 4
   no-shows nos últimos 30 dias porque a plataforma não bloqueou.

**Objetivo:** instituir regra automática de confiabilidade com três
camadas (observável, justa, configurável via código) + painel de
gestão pro admin.

**Alternativas consideradas:**

- **Regra no banco via trigger/pg_cron.** Rejeitado: regra de negócio
  no DB fica mais difícil de auditar e versionar do que em TS. Além
  disso a avaliação roda de forma oportunística (após cada novo evento)
  — não precisa de cron.

- **Thresholds configuráveis dinamicamente (via UI/DB).** Rejeitado
  por hora: adicionar UI de configuração é custo adicional sem ROI
  claro, e mudança de threshold é rara. Se precisar, muda via commit
  (e fica no histórico como decisão).

- **Auto-reativação após N dias sem incidentes.** Rejeitado: no domínio
  clínico, reativação precisa ser decisão humana consciente. Admin
  precisa conversar com a médica, entender a raiz, etc. Auto-timer
  apaga essa conversa.

- **Não distinguir auto-pause de manual-pause.** Rejeitado: perde
  contexto operacional importante. Auto-pause indica "regra disparou,
  talvez injustiça, conversar com médica"; manual-pause indica
  "admin tomou decisão, já tem contexto".

**Decisão:**

1. **Tabela granular de eventos** (`doctor_reliability_events`,
   migration 015):
   - Cada incidente vira uma linha com `kind`, `occurred_at`,
     `appointment_id`, `dismissed_at/by/reason`.
   - Unique parcial em `appointment_id` garante idempotência com
     retries do webhook + cron (D-035).
   - Contador antigo `doctors.reliability_incidents` fica — é métrica
     histórica agregada; a verdade operacional agora é a tabela.

2. **Regras fixas no código** (em `src/lib/reliability.ts`):
   - `RELIABILITY_WINDOW_DAYS = 30`
   - `RELIABILITY_SOFT_WARN = 2` → admin vê no dashboard e na página
     `/admin/reliability`, médica segue atendendo.
   - `RELIABILITY_HARD_BLOCK = 3` → médica é auto-pausada; sai de
     `/agendar` até admin reativar.

3. **Colunas de pause em `doctors`** (migration 015):
   - `reliability_paused_at` (timestamptz) — se NOT NULL, médica não
     aparece em `getPrimaryDoctor()` nem aceita novas reservas via
     `/api/agendar/reserve`.
   - `reliability_paused_auto` (bool) — distingue auto-pause de manual.
   - `reliability_paused_by` (uuid, fk auth.users) — quem pausou
     (null em auto-pause).
   - `reliability_paused_reason` (text) — motivo pra auditoria.
   - `reliability_paused_until_reviewed` (bool, default true) — admin
     sinaliza se o pause só sai após revisão (pra auto-pauses) ou se
     pode sair automaticamente (reservado; hoje unpause é sempre
     manual).

4. **Ações de pause/unpause/dismiss idempotentes:**
   - `pauseDoctor` respeita estado — se já pausada, não sobrescreve os
     metadados (preserva "admin está no volante").
   - `unpauseDoctor` é idempotente (noop em médica não pausada).
   - `dismissEvent` marca `dismissed_at/by/reason`, não deleta (audit
     trail preservado).
   - `evaluateAndMaybeAutoPause` roda após cada `recordReliabilityEvent`
     e só pausa se: `active events >= HARD_BLOCK` AND `!isPaused`.

5. **Integração com `applyNoShowPolicy` (D-032):**
   - Depois do bump atômico do contador antigo, a policy agora chama
     `recordReliabilityEvent` + `evaluateAndMaybeAutoPause`.
   - O `kind` é derivado do `finalStatus`:
     `no_show_doctor` → kind `"no_show_doctor"`,
     `cancelled_by_admin_expired` → kind `"expired_no_one_joined"`.
   - `no_show_patient` não gera evento (paciente faltou, não médica).
   - Resultado volta em `NoShowResult.doctorAutoPaused` +
     `.activeReliabilityEvents` pra logs.

6. **Barreira no agendamento (D-027):**
   - `getPrimaryDoctor()` filtra `reliability_paused_at IS NULL`.
   - `/api/agendar/reserve` com `doctorId` explícito valida e retorna
     `doctor_reliability_paused` 409 se a médica estiver pausada.
   - Appointments já agendados ANTES do pause seguem o curso — o pause
     afeta só novas reservas. Decisão deliberada: cancelar em massa
     prejudicaria pacientes que já se planejaram.

7. **UI `/admin/reliability`:**
   - 4 cards de resumo: pausadas, em alerta, OK, total de eventos
     ativos.
   - Tabela "Pausadas" com botão "Reativar" por linha (prompt pede
     notas opcionais).
   - Tabela "Em alerta" com botão "Pausar" manual por linha (prompt
     pede motivo obrigatório).
   - Tabela "Eventos recentes" (últimos 50) com botão "Dispensar" pra
     eventos ativos (prompt pede motivo obrigatório).

8. **Dashboard `/admin`:**
   - Dois novos alertas no "Próximos passos": `N médicas pausadas por
     confiabilidade` (vermelho forte, link pra página) e `N em alerta`
     (vermelho claro).
   - Condição "Tudo em dia" incorpora os dois novos contadores.

9. **AdminNav:**
   - Item "Confiabilidade" entre "Médicas" e "Repasses" — coerente com
     o mental model de gestão de equipe.

**Implementação:** 1 migration (015), 1 lib nova (`reliability.ts`), 3
API routes (pause/unpause/dismiss), 1 página admin nova
(`/admin/reliability` + client `_Actions`), 1 modificação em
`no-show-policy.ts` (integra com eventos), 1 em `scheduling.ts`
(filtra pausadas), 1 em `agendar/reserve/route.ts` (barra reserva com
médica pausada), 1 em dashboard e AdminNav.

**Consequências imediatas:**

- No próximo no-show da médica, um evento será inserido na nova
  tabela (além de incrementar o contador antigo).
- Se a médica acumular 3 eventos ativos em 30 dias, ela é pausada
  automaticamente. Se já tinha reservas em curso, elas continuam —
  apenas novas ficam bloqueadas.
- Admin tem painel pra ver, dispensar eventos injustos, reativar
  médicas. Nada automático na direção contrária (unpause é sempre
  decisão humana).
- D-029 (webhook bloqueado) + D-035 (cron fallback) + D-036 (auto-pause):
  cadeia completa — mesmo se o webhook não registrar no-show em tempo
  real, o cron em 5min dispara a policy, que dispara o evento, que
  dispara auto-pause se atingir threshold.

**Pendente (Sprint 5+):**

- Métrica "taxa de dispensa por admin" — útil pra calibrar se o
  threshold está justo. Hoje dá pra extrair por SQL, não tem UI.
- Notificação pra médica quando for pausada (hoje só admin fica
  sabendo). Precisa de template WhatsApp novo (+ aprovação Meta) ou
  email institucional. Por ora, admin comunica por fora.
- Thresholds por médica (senior vs iniciante). Rejeitado pra MVP mas
  fácil de estender — coluna `reliability_threshold_override` em
  `doctors` + lógica em `evaluateAndMaybeAutoPause`.

---

## D-035 · Cron de reconciliação Daily como fallback do webhook · 2026-04-20

**Contexto:** D-029 bloqueou o registro do webhook Daily em produção
por um bug conhecido no cliente `superagent` usado pelos servidores do
Daily — ele falha o SSL handshake quando o host de destino é do Vercel
(problema recorrente reportado no support Daily desde meados de 2025).
Consequência cascata em produção:

1. `meeting.ended` nunca chega → appointments ficam travados em
   `scheduled`/`in_progress` depois de terminar.
2. Política de no-show (D-032) nunca dispara → `reliability_incidents`
   = 0 em produção, UI D-033 "Estornos" sempre vazia, D-034 (estorno
   automático) nunca é gatilhado.
3. Earnings de consulta nunca são criadas via webhook
   (`PAYMENT_RECEIVED` sozinho não basta — o webhook Daily é o que
   efetivamente marca `completed`).
4. Validação E2E ficou inviável.

As opções "tradicionais" dependem de terceiros: esperar Daily consertar
o cliente, ou migrar DNS pra Cloudflare (que tem um request path
diferente e tende a não reproduzir o bug). Ambas fora da minha
janela de controle direto.

**Alternativas consideradas:**

1. **Esperar Daily consertar.** ❌ Sem SLA; já se arrasta.
2. **Migrar DNS pra Cloudflare.** ⚠️ Resolve mas é operação arriscada
   pra todo o domínio, afeta cache de assets, certificados, e ainda
   deixaria o sistema como **SPOF do webhook** — qualquer segundo
   incidente nesse caminho trava tudo de novo.
3. **Polling da REST API do Daily com cron.** ✅ **Escolhido.** O Daily
   expõe `GET /meetings?room=…` que retorna todas as sessões da sala
   com presença individual por participante. Um Vercel Cron a cada
   5 min varre appointments cujo fim previsto está atrás no passado
   recente e chama a mesma lógica de fechamento que o webhook chamaria.
4. **Polling + remover o webhook.** ❌ Ingênuo. Webhook é tempo-real
   (bom pra UX "paciente mal saiu e já apareceu 'completada'"), cron
   tem ~5 min de latência. Manter os dois é defesa em profundidade.
5. **Reescrever a lógica no cron.** ❌ Duas fontes de verdade
   divergindo ao longo do tempo é certeza. Extrair pra função única.

**Decisão:** Implementar cron de reconciliação, refatorar o webhook
pra delegar à mesma função de reconciliação, manter os dois
coexistindo. Schema ganha trilha de auditoria pra sabermos quem
fechou cada appointment (webhook vs cron).

**Implementação:**

- **Migration 014** (`appointments.reconciled_at` +
  `reconciled_by_source`) pra audit trail. Idempotente: só preenche
  na primeira reconciliação; subsequentes são noop na coluna. Índice
  parcial pra queries de observabilidade ("últimos N reconciliados
  por source").

- **`src/lib/video.ts` · `listMeetingsForRoom()`**  
  Novo método no `VideoProvider` batendo em Daily
  `GET /meetings?room=…&timeframe_*=…&limit=20`. Normaliza resposta em
  `MeetingSummary[]` com participantes e duração individual. 404 da
  sala (sala já deletada) vira `[]` — reconciler trata como "sala
  expirou vazia".

- **`src/lib/reconcile.ts` · `reconcileAppointmentFromMeetings()`**  
  Função central, consumida por webhook E cron. Dada uma lista de
  `MeetingSummary[]`, decide o status final:
  - `cancelled_by_admin` + `expired_no_one_joined` se ninguém entrou.
  - `no_show_patient` se só a médica.
  - `no_show_doctor` se só o paciente.
  - `completed` se ambos (curta ou longa).
  
  Atualiza `appointments` com status, ended_at, duration_seconds,
  started_at (se ainda nulo — extrai do earliest `join_time`),
  reconciled_at e reconciled_by_source. Chama `applyNoShowPolicy()`
  para `no_show_*` e `cancelled_by_admin_expired`. Idempotente nos
  dois níveis: colunas de audit + guard interno do `applyNoShowPolicy`.
  
  Helper `buildMeetingSummaryFromWebhookEvents()` reconstrói
  `MeetingSummary` a partir de `daily_events.participant.joined`
  acumulados — mantém a API do reconciler única (sempre recebe
  `MeetingSummary[]`), independente da origem.

- **Identificação de médica vs paciente**  
  Via REST `/meetings`, Daily não expõe `is_owner` por participante.
  O reconciler cruza o `user_name` retornado com o
  `display_name`/`full_name` do doctor do appointment (match
  case-insensitive, sem acentos). Já o webhook continua lendo
  `payload.is_owner` diretamente de `participant.joined` (gravado
  desde a criação dos eventos D-029 originais), então não depende
  do matching por nome. Quando os dois caminhos rodam, o webhook
  costuma ganhar pela latência menor.

- **Webhook refatorado**  
  `meeting.ended` em `src/app/api/daily/webhook/route.ts` agora chama
  `buildMeetingSummaryFromWebhookEvents()` + `reconcileAppointmentFromMeetings({source: 'daily_webhook'})`.
  A lógica de decisão sai do webhook; vira um adapter que apenas
  traduz o shape do evento. Reduz ~80 linhas duplicadas e garante
  que webhook e cron permaneçam sincronizados sobre o que é
  "no_show".

- **Novo cron `/api/internal/cron/daily-reconcile`**  
  Agendado `*/5 * * * *` no Vercel. Carrega appointments cujo
  `scheduled_at + consultation_minutes` está entre `now() - 2h` e
  `now() - 5min`, não-terminais, com `video_room_name`, e com
  `reconciled_at IS NULL`. Pra cada um, chama
  `provider.listMeetingsForRoom()` + `reconcileAppointmentFromMeetings({source: 'daily_cron'})`.
  Autenticado por `CRON_SECRET` igual aos outros crons. Log
  estruturado por execução com quebra por action
  (`completed`/`no_show_patient`/`no_show_doctor`/`cancelled_expired`).

- **Janela**  
  - `MIN_AGE_MINUTES = 5` → margem pra paciente/médica ainda estar na
    sala passando do horário.
  - `MAX_AGE_HOURS = 2` → lookback defensivo pra cobrir webhook
    atrasado (se D-029 voltar) + retries de execuções falhadas do
    próprio cron.
  - `DEFAULT_LIMIT = 25`, `MAX_LIMIT = 200` — cabe em 60s de Vercel
    function, com folga pro fetch no Daily.

- **Dashboard admin (D-033 extendido)**  
  Novo card "Reconciliação Daily · últimas 24h" com breakdown por
  source (`webhook` / `cron` / `admin`). Alerta `reconcileStuck` na
  seção "Próximos passos" quando aparecerem appointments > 2h sem
  fechamento — sinal de que o cron está falhando ou o provider está
  fora do ar.

**Princípios reafirmados:**

1. **Defesa em profundidade > single source of truth em integrações
   externas.** Webhook é ótimo em regime normal, mas depende de um
   sistema que não controlamos. Polling em cima dá resiliência
   pagando 5 min de latência — trade aceitável pro domínio (política
   de no-show não é tempo-real crítico).
2. **Uma função, dois gatilhos.** Webhook e cron compartilham
   `reconcileAppointmentFromMeetings` — drift de lógica zero.
3. **Audit trail antes de precisar debugar.** `reconciled_by_source`
   é barato no schema e caro se não existir no dia que alguém
   perguntar "por que esse appointment fechou como no_show?".
4. **Idempotência em todos os níveis.** Coluna de audit + guard na
   política de no-show. Webhook voltando em produção amanhã + cron
   rodando em paralelo = zero conflito.

**Consequências imediatas:**

- Produção volta a fechar appointments automaticamente (via cron)
  mesmo com D-029 bloqueado.
- `reliability_incidents` volta a ser populado — destrava regras
  futuras (#3 da lista de TODOs).
- Políticas D-032/D-034 passam a efetivamente gatilhar em produção.
- E2E validation fica viável: paciente + médica entram na sala, saem;
  em até 5 min o status terminal aparece; se for no-show, estorno
  pipeline completo roda (flag D-034 ligada em sandbox primeiro).

**Pendências explícitas:**

- **Sprint futura / D-029 resolvido**: quando o webhook voltar a
  registrar em produção, nada muda — os dois continuam rodando. Ganho
  é observabilidade via dashboard: "% de reconcile via webhook"
  sobe naturalmente e o cron vira contingência silenciosa.
- **Limite de consulta muito longa**: hoje assume máximo 60 min pra
  calcular janela do cron. Se médica configurar 90 min no futuro, a
  janela precisa aumentar ou o cron pode pular appointments. Trivial
  de estender (ler o consultation_minutes máximo do sistema), mas
  deixei hardcoded até surgir o caso.
- **Retry automático em falha de Daily API**: hoje o cron só loga o
  erro e avança. Como o próximo tick em 5 min vai tentar de novo, é
  naturalmente auto-resiliente. Se precisarmos de retry mais rápido
  (dentro da mesma execução), trivial.

---

## D-034 · Estorno automático via Asaas API (`REFUNDS_VIA_ASAAS`) · 2026-04-20

**Contexto:** D-033 entregou a superfície admin pra marcar refunds como
processados, mas o estorno em si ficou 100% manual: admin abre o painel
Asaas, emite o refund no botão deles, cola o id de volta no nosso form.
Funcional, mas caro em atenção humana e com janela de erro (operador
esquece de marcar no nosso lado após estornar → flag `refund_required=true`
fica pra sempre e o caso reaparece como pendente amanhã).

A ideia original era deixar essa automação pra "Sprint 5". Mas o
ganho é grande e o risco é cirúrgico:

- **Ganho**: 2 cliques ("Estornar no Asaas" → toast de sucesso) em vez
  de 5-6 passos cross-tab com copy/paste de ids frágeis.
- **Risco técnico**: a Asaas API pode falhar (saldo insuficiente no
  wallet do Asaas, payment antigo, adquirente recusando, cartão
  invalidado). Se a gente marcar como processado confiando cegamente na
  resposta 200, pode ter flag dessincronizada.

**Alternativas consideradas:**

1. **Esperar Sprint 5** (status quo D-033, full-manual). ❌ Adiciona
   atrito recorrente em ação de alta frequência no crescimento.
2. **Automatizar sem feature flag** (commit direto, tudo via API). ❌
   Sem válvula de escape em produção se a integração der problema.
3. **Automatizar com feature flag OFF em produção + fallback manual
   inline em caso de erro Asaas.** ✅ **Escolhido.** O flag
   `REFUNDS_VIA_ASAAS=false` começa desligado em produção, permitindo
   validar em dev/sandbox antes do flip. Quando a Asaas API retornar
   erro, a UI mostra o erro e **auto-abre o form manual pré-preenchido**
   com o contexto da falha — zero atrito pro admin pivotar.
4. **Automatizar + remover o manual.** ❌ Ingênuo. Há sempre casos
   patológicos onde o manual é necessário (Asaas sobrecarregado,
   chargeback em andamento, pagamento em boleto).
5. **Refund parcial** (passar `value` no payload). ❌ Por ora. A
   política D-032 assume devolução integral em no-show. Casos de
   refund parcial (médica atendeu meia consulta) viram pedido manual
   conversado por fora — raros o bastante pra não complicar a UI.

**Decisão:** Implementar estorno automático **full-refund-only** via
Asaas API, gated por `REFUNDS_VIA_ASAAS=true`, com fallback manual
inline em erro. Webhook Asaas `PAYMENT_REFUNDED` fecha o loop
idempotentemente quando o admin estorna direto no painel Asaas ou
quando há chargeback.

**Implementação:**

- **`src/lib/asaas.ts` · `refundPayment(input)`**  
  Novo helper que chama `POST /payments/{id}/refund`. Payload: `{ value?,
  description? }` — omitimos `value` pra garantir full refund. Resposta
  tipada como `AsaasRefundResponse` (Payment atualizado com
  `status=REFUNDED` ou `REFUND_IN_PROGRESS`).

- **`src/lib/refunds.ts` · `isAsaasRefundsEnabled()` + `processRefundViaAsaas()`**  
  `isAsaasRefundsEnabled()` é um one-liner que lê
  `process.env.REFUNDS_VIA_ASAAS === "true"`. Por default OFF —
  conservador. `processRefundViaAsaas({ appointmentId, processedBy })`
  orquestra: carrega appointment + payment, valida pré-condições
  (`refund_required=true`, não já processado, tem `asaas_payment_id`),
  chama `refundPayment()`, e **só** marca `refund_processed_at` após a
  Asaas confirmar. Se a Asaas falhar, retorna `RefundResult` com
  `code='asaas_api_error'` + `asaasStatus`/`asaasCode` — sem tocar o
  banco. `external_ref` usado é o `asaas_payment_id` mesmo (suficiente
  pra rastreio no painel Asaas + dedupe com webhook).

- **`POST /api/admin/appointments/[id]/refund`**  
  Agora aceita `method?: 'manual' | 'asaas_api'` no body. Resolução:
  - Sem `method` → usa `asaas_api` se flag ligada, senão `manual`
    (preserva comportamento D-033).
  - `asaas_api` explícito com flag desligada → 400.
  - Erros do Asaas viram HTTP 502 com `{ code, error, asaas_status,
    asaas_code }` estruturados pra UI pivotar.

- **`src/app/admin/(shell)/refunds/_RefundForm.tsx` (reescrito)**  
  Quando `asaasEnabled=true`: botão primário grande verde "Estornar no
  Asaas" + link sutil "ou registrar manualmente (fallback)" que
  expande o form antigo. Quando `asaasEnabled=false`: comportamento
  D-033 inalterado. Em erro do Asaas, fallback manual é
  auto-expandido e o textarea de notas vem **pré-preenchido** com o
  motivo da falha (`"Tentativa automática falhou: {msg}.
  Processado manualmente."`) — admin só precisa colar a referência e
  clicar.

- **Dedupe no webhook Asaas**  
  `src/app/api/asaas/webhook/route.ts` ganhou bloco que, em
  `PAYMENT_REFUNDED` (ou `status=REFUNDED`), se o appointment tiver
  `refund_required=true` e `refund_processed_at IS NULL`, chama
  `markRefundProcessed({method:'asaas_api', externalRef:asaasPaymentId,
  processedBy:null})`. Isso cobre três casos limpamente:
  1. **Nossa UI estornou**: o status já foi marcado antes do webhook
     chegar; `markRefundProcessed` retorna `alreadyProcessed=true` e vira
     noop.
  2. **Admin estornou direto no painel Asaas**: webhook é o único sinal;
     marca com `processedBy=null` sinalizando que não houve admin humano
     na nossa trilha.
  3. **Chargeback da bandeira**: tratamento idêntico — estorno é estorno.

**Princípios reafirmados:**

1. **Feature flags são válvulas, não botões.** Começamos OFF em
   produção, validamos em sandbox, flipamos. Fácil desligar se algo
   correr mal.
2. **Fallback inline é mais honesto que retry automático.** Se a Asaas
   recusou o refund, há motivo — admin precisa ler e decidir. Não é
   problema só de "tentar de novo".
3. **Webhook fecha o loop mesmo quando a ação veio de fora.** O sistema
   é consistente independente de quem disparou o estorno.
4. **Full-refund-only até haver caso real de parcial.** Evita UI
   confusa pra cobrir 0,5% dos casos.

**Consequências imediatas:**

- Admin em sandbox vê os 2 botões e pode testar o fluxo automático
  contra pagamentos de teste Asaas.
- Admin em produção continua vendo só o manual (flag OFF) —
  comportamento D-033 preservado.
- Quando aprovado + CNPJ regularizado, basta setar
  `REFUNDS_VIA_ASAAS=true` no Vercel e flipar. Zero deploy adicional.
- Webhook `PAYMENT_REFUNDED` agora reconcilia automático casos
  "admin estornou direto no Asaas" que antes ficavam eternamente
  pendentes na UI D-033.

**Pendências explícitas pra uma evolução futura:**

- **Refund parcial**: schema não suporta hoje. Quando necessário, adicionar
  `amount_cents` opcional no input de `processRefundViaAsaas()` +
  repassar pro `refundPayment()` (que já aceita o argumento), e expor
  campo na UI.
- **Retry automático em erro transiente do Asaas**: hoje a UI só exibe
  o erro e pivota pro manual. Se `asaas_code` indicar erro transiente
  (timeout, 500), poderíamos auto-retry 1 vez com backoff — decisão
  pra quando tivermos estatística de erro real.
- **Métrica "% estornos via Asaas vs manual"**: a coluna
  `refund_processed_method` permite, basta uma query no dashboard admin
  quando houver volume suficiente pra ser interessante.

---

## D-033 · Observabilidade operacional do admin (`/admin/notifications` + `/admin/refunds`) · 2026-04-20

**Contexto:** D-031 (fila persistente de WhatsApp) e D-032 (política de
no-show com `refund_required`) shippados na mesma manhã introduziram dois
sistemas vivos em produção que **setavam flags sem nenhuma superfície
humana pra agir**:

1. `appointment_notifications` — worker roda a cada 1 min processando a
   fila; se uma notif falhar (Meta recusa, telefone inválido, template
   rejeitado), a única forma de descobrir hoje é SQL manual no Supabase.
   Linhas `pending` travadas em loop infinito de `templates_not_approved`
   são indistinguíveis no log de linhas legítimas aguardando seu
   `scheduled_for`.
2. `appointments.refund_required=true` — setado quando a política de
   no-show da médica dispara, mas refund real (devolver dinheiro pro
   paciente) fica parado até alguém manualmente lembrar de abrir o painel
   Asaas. Sem lista, cai no esquecimento.

**Alternativas consideradas:**

1. **Nada agora, esperar Sprint 5** (quando o refund automático entraria).
   ❌ Enquanto isso os flags se acumulam silenciosamente. No dia em que a
   Meta aprovar os 7 templates e virarmos `WHATSAPP_TEMPLATES_APPROVED=true`,
   o operador precisa de um HUD pra entender o que está rodando.
2. **Endpoint administrativo isolado** (só API, sem UI, usa REST
   externo/Postman). ❌ Força o operador (não-dev) a saber HTTP +
   autenticação. Quebra no primeiro incidente fora do horário.
3. **UI admin mínima + gancho de schema pra Sprint 5 automatizar.** ✅
   Fecha o loop operacional de hoje E pavimenta a automação futura sem
   re-modelagem.

**Decisão:** Opção 3. Entregas:

- **Migration 013** (`20260420210000_admin_refund_metadata.sql`) — adiciona
  4 colunas de auditoria em `appointments`:
  - `refund_external_ref text` — id do refund no Asaas (`rf_xxx`) ou
    end-to-end do PIX. Quando a Sprint 5 automatizar, recebe o
    `refund.id` retornado pela Asaas API sem mudança de shape.
  - `refund_processed_by uuid references auth.users(id)` — quem acionou.
  - `refund_processed_notes text` — observações humanas (ex: "paciente
    aceitou crédito pra reagendar").
  - `refund_processed_method text check in ('manual','asaas_api')` —
    distingue fluxos humanos vs automação futura, habilita métrica
    "quanto ainda é manual?".
  - Índice parcial `ix_appt_refund_processed` acelera histórico sem
    scanear a tabela inteira.

- **`src/lib/refunds.ts`** — ponto único de entrada pra marcar refund
  processado:
  - `markRefundProcessed({appointmentId, method, externalRef, notes,
    processedBy})` — idempotente via guard em `refund_processed_at` (e
    segunda trava via `.is('refund_processed_at', null)` no UPDATE pra
    proteger race). Valida `refund_required=true` antes de aceitar —
    impede admin registrar estorno pra um appointment que nunca teve
    direito a ele.
  - `processRefundViaAsaas()` — placeholder explícito retornando
    `not_implemented`. Sprint 5 troca o corpo, o resto (chamadores,
    UI, schema) não precisa mexer.

- **API routes:**
  - `POST /api/admin/notifications/[id]/retry` — reseta notif
    `failed`/`pending` pra `pending + scheduled_for=now()`, deixa o
    próximo tick do cron dispatching. Não dispara síncrono (evita
    duplicar lógica de dispatch e respeita rate-limit global).
    Idempotente (2ª chamada é noop).
  - `POST /api/admin/appointments/[id]/refund` — método `manual` hoje,
    gancho pra `asaas_api` quando Sprint 5 chegar. Grava tudo via
    `markRefundProcessed()`.

- **Páginas `/admin/notifications` e `/admin/refunds`:**
  - Notificações: contadores por status (failed/pending/sent/delivered/
    read), filtros via query string (server-rendered), tabela com
    botão Retry, paginação 50/página. Ordenação favorece `failed` no
    topo (alfabética feliz: `failed < pending < sent`).
  - Refunds: 2 seções — "Pendentes" (card por appointment com formulário
    inline: external_ref + notes + botão) e "Histórico" (últimos 50
    processados, inclui badge manual/asaas_api).
  - Dashboard ganhou 2 alertas novos: "X estornos pendentes" (terracotta)
    e "Y notificações com falha".
  - Link no `AdminNav` (6 entradas agora).

**Princípios aplicados:**

- **Observabilidade antes de automação.** Primeiro mostrar o que está
  vivo; depois automatizar. Inverter cria caixa preta.
- **Schema pronto pra futuro.** As 4 colunas da migration 013 servem
  idêntico pra admin manual (hoje) e pra automação (Sprint 5). Evita
  migração retroativa.
- **Idempotência em todo escritor.** `markRefundProcessed` e `retry`
  ambos safe pra duplo-clique e retry de rede.
- **UI honesta.** Enquanto Sprint 5 não liga, a UI só oferece "manual"
  e explica o fluxo passo-a-passo. Não cria falso senso de automação.

**Consequências imediatas:**

- Operador abre `/admin` e vê imediatamente quantos refunds pendentes e
  notifs falhadas existem — sem precisar de SQL.
- No dia que `WHATSAPP_TEMPLATES_APPROVED=true` virar, a gente consegue
  observar em tempo real a taxa de sucesso/falha nos primeiros minutos.
- D-032 deixa de ser "log-only" em produção — `no_show_doctor` vira
  ação operacional concreta (processar estorno no Asaas + registrar).

**Pendências explícitas (Sprint 5):**

- Trocar o corpo de `processRefundViaAsaas()` por chamada real à
  `POST /payments/{asaas_payment_id}/refund`.
- Ligar o botão "Estornar no Asaas" na UI do `/admin/refunds`.
- Dedupe com o webhook Asaas `PAYMENT_REFUNDED`: quando admin processar
  manualmente antes do webhook chegar, webhook precisa ser idempotente
  via `refund_external_ref` pra não marcar de novo.
- Extender o webhook Asaas pra preencher `refund_processed_at` quando
  receber `PAYMENT_REFUNDED` (cobre casos em que paciente abre chargeback
  ou admin processa direto no Asaas sem passar pela nossa UI).

**Arquivos:**
- `supabase/migrations/20260420210000_admin_refund_metadata.sql`
- `src/lib/refunds.ts`
- `src/app/api/admin/notifications/[id]/retry/route.ts`
- `src/app/api/admin/appointments/[id]/refund/route.ts`
- `src/app/admin/(shell)/notifications/` (page + filters + retry button)
- `src/app/admin/(shell)/refunds/` (page + form)
- `src/app/admin/(shell)/_components/AdminNav.tsx` (+2 entradas)
- `src/app/admin/(shell)/page.tsx` (+2 alertas no dashboard)

---

## D-032 · Política financeira de no-show (clawback assimétrico paciente × médica) · 2026-04-20

**Contexto:** O webhook do Daily (D-028) já resolve *identificar*
qual parte falhou numa consulta agendada — `no_show_patient` quando
só a médica entrou, `no_show_doctor` quando só o paciente, e
`cancelled_by_admin` com reason `expired_no_one_joined` quando a sala
expirou vazia. Faltava fechar o ciclo clínico-financeiro: o que
acontece com o payment (Asaas), com o earning da médica
(`doctor_earnings`) e com a comunicação pro paciente em cada caso.

Opções consideradas:

1. **Tratamento simétrico**: refund total em qualquer no-show. É o
   mais "limpo" pro paciente, mas pune a médica por um comportamento
   do paciente que ela não controla — ela abriu mão do horário dela,
   ficou online, e não recebe nada. Quebra a relação com as médicas
   rapidamente.
2. **Tratamento assimétrico (escolhido)**: clawback só quando o
   problema é do lado da plataforma (médica faltou ou houve falha
   técnica); paciente perde o valor se ele mesmo faltou.
3. **Sempre manter earning, nunca refund**: protege a receita mas
   ignora que o paciente pagou por um serviço que não recebeu quando
   a médica falha. Quebra a relação com o paciente.

**Decisão:** Política assimétrica com 3 ramos:

| Status final                          | Earning médica | Refund paciente | Notifica paciente | Reliability |
|---------------------------------------|----------------|-----------------|-------------------|-------------|
| `no_show_patient`                     | Mantém         | **Não**         | Sim (aviso)       | —           |
| `no_show_doctor`                      | **Clawback**   | **Sim** (flag)  | Sim (desculpas)   | +1          |
| `cancelled_by_admin` + `expired_…`    | **Clawback**   | **Sim** (flag)  | Sim (desculpas)   | +1 (médica) |

- **Clawback** reutiliza `createClawback()` de `src/lib/earnings.ts`
  (D-022): insere earning negativa `refund_clawback` apontando pro
  parent via `parent_earning_id`, cancela a original se ainda não
  virou `paid`. Já era idempotente por design.
- **Refund** NÃO é feito automaticamente no Asaas nessa sprint — a
  política só marca `appointments.refund_required = true` e o admin
  processa via painel Asaas. Motivo: refund automático exige idempotência
  cross-system (Asaas ↔ Supabase ↔ dedupe de evento) que merece
  sprint dedicada (Sprint 5). Até lá, a flag + índice
  `ix_appt_refund_required` garantem que nenhum caso se perca.
- **Reliability** é um contador simples em `doctors.reliability_incidents`
  + timestamp `last_reliability_incident_at`. Na prática vai ser usado
  só pra dashboard admin por enquanto; regras de corte (ex: "bloquear
  agenda se > 3 incidentes no mês") ficam pra quando houver histórico.
- **Notificação** vai pela fila persistente de D-031 via novos kinds
  `no_show_patient` e `no_show_doctor`. Os templates Meta reais ainda
  não foram submetidos (copy depende de revisão jurídica — redação do
  aviso de "você perdeu sua consulta" precisa ser cuidadosa pra não
  gerar reclamação ANS/Procon). Enquanto isso, `wa-templates.ts`
  retorna `templates_not_approved` e o worker mantém em `pending` pra
  re-tentar quando o flag `WHATSAPP_TEMPLATES_APPROVED` virar true com
  os templates aprovados.

**Idempotência:** guard via nova coluna
`appointments.no_show_policy_applied_at`. Chamadas subsequentes
(retry do webhook Daily, re-processamento manual) retornam
`already_applied` sem efeito colateral. A lib também faz logging
estruturado pra auditoria.

**Orquestração:** Daily webhook (`src/app/api/daily/webhook/route.ts`
e `src/pages/api/daily-webhook.ts`) → depois de atualizar o status
do appointment pra um dos 3 ramos, chama
`applyNoShowPolicy({appointmentId, finalStatus, source})`.
Desacoplado: se a política falhar, o webhook continua 200 OK (o
`daily_events` já guardou o evento bruto e admin pode reprocessar).

**Futuro (Sprint 5):**
- Submeter templates `no_show_patient_aviso` e `no_show_doctor_desculpas`
  à Meta.
- Endpoint admin pra processar refund via Asaas API (remove
  `refund_required` e preenche `refund_processed_at`).
- Dashboard de reliability por médica (incident rate, trend).
- Escalation: quando um paciente responde ao aviso de `no_show_patient`
  alegando problema técnico, abrir ticket pra admin revisar.

**Arquivos:**
- `supabase/migrations/20260420200000_no_show_policy.sql`
- `src/lib/no-show-policy.ts`
- `src/lib/wa-templates.ts` (+2 kinds, stubs)
- `src/lib/notifications.ts` (dispatch dos 2 kinds novos)
- `src/app/api/daily/webhook/route.ts` (integração)
- `src/pages/api/daily-webhook.ts` (integração fallback)

---

## D-031 · WhatsApp como fila persistente (`appointment_notifications`) + worker HTTP · 2026-04-20

**Contexto:** Sprint 4.1 previa enviar 5 mensagens WhatsApp pro paciente
(confirmação + 4 lembretes temporais) e 2 pra médica. Opções
consideradas:

1. **Disparo direto no handler** (ex: dentro do webhook Asaas manda
   a confirmação na hora). Simples, mas acopla o fluxo crítico do
   pagamento à disponibilidade da Meta Graph API — se o Meta estiver
   com problema, o webhook falha e o Asaas re-tenta, virando duplicata.
2. **`setTimeout` in-memory** pros lembretes. Serverless mata isso
   — a função termina assim que devolve resposta.
3. **Fila persistente no DB + worker periódico.** Escrever uma linha
   `pending` com `scheduled_for`, e rodar um worker a cada minuto
   que varre pendentes vencidas. Escala, é observável, e separa
   infraestrutura de pagamento de infraestrutura de mensageria.

**Decisão:** 3 (fila persistente). Usa a tabela
`public.appointment_notifications` (já criada na migration 004) como
fila single-source-of-truth. Fluxo:

```
webhook Asaas (RECEIVED)
  │
  ├─► enqueueImmediate(appt, 'confirmacao')           ── insere pending, scheduled_for = now()
  └─► scheduleRemindersForAppointment(appt)           ── insere 4 pendings com scheduled_for futuros
                                                          (T-24h, T-1h, T-15min, T+10min)

cron wa-reminders (*/1 min, Vercel Cron)
  └─► processDuePending(limit=20)
          ├─► SELECT status=pending AND scheduled_for <= now() LIMIT 20
          ├─► dispatch(row) → helper tipado em wa-templates.ts
          └─► UPDATE status = sent|failed|pending (conforme outcome)
```

**Peças novas:**

- **Migration 011** (`20260420100000_...scheduler.sql`):
  - `public.schedule_appointment_notifications(appointment_id)` —
    insere 4 linhas, idempotente via índice unique parcial
    `ux_an_appt_kind_alive (appointment_id, kind) WHERE status IN
    (pending, sent, delivered, read)`. Pula kinds cujo horário já
    passou (ex: agendamento pra daqui 30 min pula T-24h e T-1h).
  - `public.enqueue_appointment_notification(appt, kind, template,
    scheduled_for, payload)` — insere 1 linha. Idempotente (retorna
    NULL se conflito).
  - Índice `idx_an_due (scheduled_for) WHERE status='pending'`
    acelera o worker.

- **`src/lib/wa-templates.ts`**: 9 wrappers tipados (7 templates +
  2 operacionais), 1 por template aprovado na Meta. Cada wrapper
  respeita:
  - Flag `WHATSAPP_TEMPLATES_APPROVED` (default `false`) → stub
    `ok:false, message:templates_not_approved` enquanto templates
    estão em review. Worker interpreta como "retry", mantém
    `pending`.
  - Flag `WHATSAPP_TEMPLATE_VERSION` → permite rotacionar pra v2
    sem mexer em código se algum template for rejeitado.
  - Formatação pt_BR consistente (`formatConsultaDateTime`,
    `formatTime`, `firstName`).

- **`src/lib/notifications.ts`**: enqueue helpers + worker
  `processDuePending(limit)`. Worker:
  - Hidrata cada notif com `appointments → customers (name, phone)`
    e `doctors (display_name, full_name)` via select aninhado.
  - Monta URL pública `/consulta/[id]` (HMAC feito dentro da API de
    join, aqui é só o id mesmo; o link abre a página pública que
    renderiza o banner com botão "Entrar").
  - Despacha pro helper correto via `switch(kind)`.
  - Retry seletivo: só mantém `pending` se o erro for
    `templates_not_approved`. Qualquer outro erro marca `failed`
    com mensagem — inspeção manual via admin (quando tiver UI).

- **`/api/internal/cron/wa-reminders`**: handler HTTP mínimo.
  Autenticação idêntica ao cron de expiração (D-030). Aceita
  `?limit=100` pra backlog manual.

- **`vercel.json`**: novo cron `* * * * *` apontando pra a rota;
  `maxDuration=60s` (template com ~20 disparos + rede).

**Integrações:**

- Webhook Asaas (RECEIVED) — após ativar appointment + provisionar
  sala Daily + criar earning, enfileira `confirmacao` + 4 lembretes.
- Cron de expiração (D-030) — após liberar slot abandonado,
  enfileira `reserva_expirada` (template reaproveita
  `pagamento_pix_pendente` até criarmos um próprio).

**Por que um template "faz duplo papel" (reserva_expirada →
pagamento_pix_pendente)?** O doc só lista 7 templates pra Meta e
a copy do PIX expirando se encaixa bem no caso de reserva abandonada
("seu pagamento não caiu → finalize agora"). Quando tivermos tração
podemos submeter um template dedicado. Registrado como débito
técnico pra Sprint 5.

**Flag `WHATSAPP_TEMPLATES_APPROVED` em produção:**

- Hoje: NÃO setada → worker entra em loop inofensivo (processa a
  cada minuto, retorna `retried` pra todas as linhas pending, não
  gasta quota da Meta).
- Quando a Meta aprovar os 7 templates (1-24h tipicamente): setar
  `WHATSAPP_TEMPLATES_APPROVED=true` no Vercel (production +
  preview + development) e fazer redeploy. Todas as linhas pendentes
  vão ser tentadas imediatamente no próximo tick do cron.

**Decorrências / futuros:**

- Template dedicado `reserva_expirada` (nova copy, Sprint 5).
- UI admin pra inspecionar `appointment_notifications`
  (status=failed/pending + retry manual).
- Métricas: taxa de entrega, lead time entre scheduled_for e sent_at,
  taxa de no-show pós lembrete.
- Redundância pg_cron (mesmo padrão de D-030) pode ser adicionada
  quando tivermos volume > 500 notifs/dia pra proteger de
  indisponibilidade do Vercel.

---

## D-030 · Expiração de reservas `pending_payment` via sweep duplo (pg_cron + Vercel Cron) · 2026-04-20

**Contexto:** a migration 008 (D-027) introduziu o estado
`pending_payment` em `appointments` com TTL curto
(`pending_payment_expires_at`, default 15 min). Isso permite ao
paciente reservar um slot enquanto o checkout está aberto sem
que outro paciente roube o mesmo horário. Problema: se o paciente
abandona o checkout e NINGUÉM tenta reservar o mesmo slot nos 15
minutos seguintes, a reserva fica órfã — ocupa agenda, bloqueia
outras reservas, e não gera receita. A função
`book_pending_appointment_slot()` tem um "fast path" local (limpa
expiradas no mesmo slot antes de inserir), mas é insuficiente: só
dispara sob demanda.

**Decisão:** executar um **sweep global periódico** que libera
TODAS as reservas expiradas de uma vez. Implementado com
**redundância em duas camadas**:

1. **pg_cron dentro do Supabase** (*/1 min): chama
   `public.expire_abandoned_reservations()` direto no Postgres.
   Migration 010 agenda condicionalmente — se `pg_cron` não
   estiver habilitado, loga NOTICE e segue.
2. **Vercel Cron** (*/1 min): chama `GET /api/internal/cron/expire-reservations`
   autenticado via `Authorization: Bearer ${CRON_SECRET}`, que por
   sua vez dispara a mesma RPC. Redundância barata (função
   idempotente — segunda chamada na mesma janela retorna 0 linhas),
   E abre espaço pra side-effects fora do Postgres: cancelar a
   cobrança no Asaas, disparar WhatsApp "sua reserva expirou",
   logar estruturado no dashboard Vercel.

**Por que dois crons e não um?**

- Supabase free/self-hosted pode não ter `pg_cron`. Ter o HTTP
  garante que a feature nunca fica parada.
- Vercel Cron pode falhar em deploys quebrados, cold starts, ou
  downtime da Vercel. Ter o pg_cron garante que a agenda limpa
  mesmo se o app estiver down.
- Os dois juntos custam ~0 (idempotência nativa) e aumentam
  robustez operacional.

**Estado final do slot após expiração:**

```
appointments.status           = 'cancelled_by_admin'
appointments.cancelled_at     = <now>
appointments.cancelled_reason = 'pending_payment_expired'
```

O `status = 'cancelled_by_admin'` é semanticamente ruim (não foi
o admin humano que cancelou), mas aproveitamos o enum já existente
pra não precisar ampliar — o `cancelled_reason` textual distingue
casos automáticos de manuais. Reavaliaremos em Sprint 5 se
precisarmos filtrar métricas por "expirado vs cancelado manualmente";
nesse momento adicionamos `cancelled_by_system` ao enum.

**Side-effects futuros (Sprint 4.2+, preparados mas não ligados):**

- Cancelar `payments` no Asaas via API (`DELETE /payments/{id}`):
  hoje o payment local permanece `PENDING` e vira `OVERDUE` sozinho.
- Enviar WhatsApp "sua reserva de [horário] com Dra. X expirou.
  Quer reagendar?" com link pra `/agendar/[plano]` — melhora
  recuperação.
- Métrica `abandon_rate` (reservas expiradas / reservas criadas)
  no admin.

**Decorrências:**

- `CRON_SECRET` adicionado ao Vercel (production/preview/development)
  em 2026-04-20, 40 chars random base64.
- `vercel.json` ganhou seção `crons` (antes só tinha `functions` e
  `headers`).
- `/api/internal/cron/expire-reservations` aceita GET e POST,
  valida `Bearer <CRON_SECRET>` (oficial Vercel) e
  `x-cron-secret: <CRON_SECRET>` (debug manual), e no dev
  (`CRON_SECRET` ausente) aceita qualquer caller pra facilitar
  smoke test local.

---

## D-029 · Webhook do Daily via Pages Router + incompatibilidade HTTP/2 · 2026-04-20

**Contexto:** ao tentar registrar o webhook `/api/daily/webhook` via
`POST https://api.daily.co/v1/webhooks` usando a API key real do
Instituto, o Daily retorna:

```
{"error":"invalid-request-error",
 "info":"non-200 status code returned from webhook endpoint, recvd undefined"}
```

Diagnóstico completo:

1. **O endpoint responde 200** pra qualquer cliente HTTP/1.1 ou HTTP/2
   (curl, httpie, webhook.site como intermediário). Confirmado com
   múltiplos deploys.
2. **Outros provedores funcionam** contra o mesmo endpoint — o
   webhook da Asaas (cadastrado na mesma URL pattern
   `/api/asaas/webhook`) entrega eventos sem issue.
3. **httpbin.org funciona no Daily** como URL de webhook — prova que
   Daily consegue bater em endpoints externos.
4. **Pesquisa:** o superagent usado pelo Daily na verificação
   (`node-superagent/3.8.3`, de 2017) tem
   [bug conhecido com HTTP/2 via ALPN](https://github.com/forwardemail/superagent/issues/1754).
   Vercel serve todos os endpoints em HTTP/2 por default e não expõe
   flag pra desabilitar. O "recvd undefined" é exatamente o sintoma
   desse bug — superagent não consegue parsear o status code do
   response HTTP/2.

**Decisão:** ao invés de bloquear o projeto esperando Daily atualizar
o superagent, **mantemos TODO o código do webhook pronto e deployed**
e planejamos dois caminhos futuros (não-bloqueantes pra MVP):

1. **Re-tentar quando subir o domínio `institutonovamedida.com.br`**
   (Cloudflare-fronted). Cloudflare pode servir HTTP/1.1 pro origin
   Daily e proxyar pra Vercel.
2. **Polling como fallback**: uma Vercel Cron roda a cada 5min,
   busca meetings ativos via `GET /v1/meetings?active=true` do Daily
   e atualiza `appointments` correspondentes (started_at, ended_at,
   no-show heurística).

**Onde o código ficou:**

- `src/app/api/daily/webhook/route.ts` — App Router handler
  (HTTP/2, headers RSC). Funciona pra clientes modernos.
- `src/pages/api/daily-webhook.ts` — Pages Router handler (mesmo
  handler, sem Vary RSC). Tentativa de contornar o bug — falhou
  também, confirmando que o problema é HTTP/2, não os headers.

**Rationale:**

- "Remover o código" seria desperdiçar o trabalho; quando o bug
  do Daily for resolvido OU quando subirmos via Cloudflare, o
  webhook volta a funcionar sem nenhuma mudança.
- Pages Router handler fica como segunda porta de entrada para
  clientes que tenham issues específicos com App Router (debug e
  testes manuais continuam possíveis).

**Envs já configuradas no Vercel (production + preview + development):**

- `DAILY_API_KEY`, `DAILY_DOMAIN=instituto-nova-medida`,
  `DAILY_WEBHOOK_SECRET` (base64, 32 bytes random).
- O secret tem que ser base64 válido: a API do Daily rejeita hmac
  em formato livre (`whsec_...`), só aceita strings base64-encoded.

**Pendências (action items do operador quando o webhook voltar a
registrar):**

1. Cadastrar o webhook manualmente no dashboard do Daily (pode
   contornar a verification em alguns casos) OU
2. Aguardar suporte do Daily corrigir o superagent OU
3. Implementar polling via cron (não depende do webhook).

**Consequências imediatas:**

- Status da consulta (`in_progress`, `completed`, `no_show_*`)
  NÃO atualiza automaticamente no MVP.
- `started_at`, `ended_at`, `duration_seconds` ficam `NULL`
  até resolvermos.
- O fluxo do paciente (agendar → pagar → entrar na sala) continua
  100% funcional. Só a telemetria depois-do-fato que está parada.

**Arquivos de referência:** este doc, `src/lib/video.ts`,
`src/app/api/daily/webhook/route.ts`, `src/pages/api/daily-webhook.ts`.

---

## D-028 · Webhook do Daily fecha o ciclo da consulta + detecta no-show · 2026-04-19

**Contexto:** com o paciente entrando na sala (D-027), faltava
**telemetria de consulta**: saber quando começou, quando terminou,
quanto durou e — crucialmente — se alguma das partes não
compareceu. Sem isso o painel financeiro não consegue distinguir
"consulta realizada (gera earning)" de "no-show paciente (estorna)".

**Decisão:** consumimos os webhooks `meeting.started`, `meeting.ended`,
`participant.joined` e `participant.left` do Daily. Persistimos
TODOS os payloads em `daily_events` (auditoria + idempotência via
unique `(event_id, event_type)`), e atualizamos `appointments` com
`started_at`, `ended_at`, `duration_seconds` e `status` final.

**Resolução do appointment:** pelo `payload.room` que é o nome
determinístico que criamos (`c-<8 hex>`). Eventos sem appointment
correspondente são marcados como órfãos e ignorados (salas de teste).

**Lógica de status final em `meeting.ended`** (executada só se o
status atual NÃO for terminal):

| Quem entrou         | Duração reportada    | Novo status          |
|---------------------|----------------------|----------------------|
| paciente + médica   | ≥ 3 min              | `completed`          |
| paciente + médica   | < 3 min              | `completed` (cons.)  |
| só paciente         | qualquer             | `no_show_doctor`     |
| só médica           | qualquer             | `no_show_patient`    |
| ninguém             | qualquer             | `cancelled_by_admin` (`expired_no_one_joined`) |

A presença de cada parte é deduzida agregando `participant.joined`
(filtrando `is_owner`) já persistidos em `daily_events` — por isso
**precisamos persistir TODO `participant.joined`**, mesmo sem ação
imediata.

**Auth:** HMAC-SHA256 oficial do Daily
(`X-Webhook-Signature` = base64 de `HMAC(secret, "<ts>.<body>")`,
janela anti-replay de 5 min). Fallback `x-daily-webhook-secret`
(secret bruto via header) mantido pra setups antigos / proxy. Em
dev sem `DAILY_WEBHOOK_SECRET`, aceita e loga (modo permissivo
explícito).

**Resposta:** sempre 200 quando a auth passa (tem o RAW pra
reprocessar). Falhas no processamento ficam em
`daily_events.processing_error` para retry manual. Daily retenta
agressivamente em 5xx — por isso jamais respondemos 5xx pós-auth.

**Não decidido aqui:**

- `recording.ready` é só persistido — quando ligarmos gravação por
  default (vide D-023), implementamos extração de URL e gravação no
  bucket privado.
- "No-show paciente" hoje **não** dispara estorno automático no Asaas.
  Decisão financeira pendente (D-029?): regra é "estornar 100%" ou
  "cobrar taxa de no-show"? Por enquanto a admin opera manualmente
  pela UI de payouts.
- Reabrir consulta após `meeting.ended` (paciente caiu, volta) ainda
  funciona porque o `JoinRoomButton` regenera o token Daily a cada
  clique e o status `in_progress` é restaurado por um próximo
  `meeting.started`. Mas o status final calculado pode "regredir" pra
  `completed` quando o segundo `meeting.ended` chegar — aceitável.

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
