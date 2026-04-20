# Changelog · Instituto Nova Medida

> Registro cronológico de tudo que foi entregue. A entrada mais recente
> fica no topo. Cada entrada tem data, autor (humano ou IA) e o que
> mudou.

---

## 2026-04-20 · Desligar CTAs públicos do fluxo antigo de checkout (D-044 · onda 2.G · final) · IA

**Por quê:** com o novo fluxo completo (ondas 2.A–2.F), qualquer
botão público que leve a `/checkout/[slug]` contradiz o pacto
sanitário: tratamento só é contratado após consulta gratuita,
indicação médica e aceite formal. Essa onda audita, desativa os
CTAs públicos que restaram e reescreve a copy das páginas
relevantes pra refletir o modelo correto — sem remover o
`/checkout/[slug]` em si, que fica como back-office.

**Entregáveis:**

- **`/planos` redesenhada como página informativa.** O card de cada
  plano perdeu o botão "Quero esse plano" e ganhou um bloco
  explicativo: "A contratação deste plano ocorre somente após a
  consulta médica gratuita e indicação clínica." O hero da página
  ganhou copy nova e um único CTA: "Agendar minha consulta
  gratuita →" apontando pra `/` (home/quiz). Meta `noindex,
  nofollow` já estava ativa desde a onda 1.
- **`/paciente/renovar` reescrita.** Seção principal agora é
  "Agendar reconsulta" com CTA pro WhatsApp da equipe — renovação
  exige reavaliação médica (evolução, exames, tolerância) antes
  de qualquer contratação. Os cards dos planos ficam como
  referência informativa, sem botão de compra. O texto "Como
  funciona a renovação" foi reescrito pra documentar o novo
  caminho (reconsulta → prescrição → aceite → pagamento).
- **`/checkout/[plano]` documentada como back-office.** Novo
  JSDoc de topo explicita que a rota é preservada para envio
  manual de links excepcionais (lead externo, renovação
  aprovada fora do fluxo), mas não é CTA público em nenhum
  lugar. Meta `noindex, nofollow` já estava ativa.
- **Auditoria completa de CTAs públicos.** `grep` no código
  confirma: nenhum `href="/checkout..."` em componentes,
  páginas ou layouts públicos. As únicas referências restantes
  são: docs, comentários explicativos, redirects internos do
  próprio `CheckoutForm` (pra `/checkout/sucesso`), e o
  endpoint `/api/checkout`.

**Decisões-chave:**

- **Preservar `/checkout/[plano]` em vez de remover.** A equipe
  ainda pode precisar enviar link manual em casos pontuais
  (lead que veio por fora do funil, renovação excepcional
  aprovada em reunião, migração de paciente antigo). Manter a
  rota ativa como back-office é mais seguro que deletar +
  ter que restaurar depois. Meta `noindex` + zero CTA público
  já garantem que nenhum novo visitante entra por ali.
- **Renovação via WhatsApp por ora.** Idealmente, `/paciente/renovar`
  levaria a uma página de agendamento self-service — mas essa
  página ainda não existe no MVP (consultas são agendadas
  offline pela equipe). Link direto pro WhatsApp resolve hoje
  e é substituível facilmente quando construirmos agendamento
  automatizado.
- **`/planos` continua existindo mesmo com CTAs desligados.**
  É útil como material de consulta: a equipe pode enviar o link
  pra um paciente pré-consulta que quer "ver o que é", ou a
  médica pode referenciar durante a consulta. Sem CTA de
  compra + `noindex` + fora do sitemap = zero risco de
  conversão indevida.
- **Card informativo no lugar do botão.** Em vez de esconder o
  preço, mostramos o preço + uma linha explicando que a
  contratação depende da consulta. Isso mantém transparência
  (LGPD-friendly de quebra — não esconde informação que o
  paciente pode precisar pra decidir se quer agendar).
- **Nenhum teste automatizado nesta onda.** A mudança é 100%
  estática (copy + remoção de links). Cobertura via `next build`
  + `tsc` + `lint` + teste manual.

**Arquivos modificados:**

- `src/app/planos/page.tsx` (CTA do `PlanCard` substituído por
  bloco informativo; hero com CTA de consulta gratuita)
- `src/app/paciente/(shell)/renovar/page.tsx` (reescrita
  completa; CTA primário é WhatsApp pra reconsulta)
- `src/app/checkout/[plano]/page.tsx` (JSDoc de topo
  documentando papel de back-office)
- `docs/CHANGELOG.md`, `docs/DECISIONS.md`, `docs/SPRINTS.md`

**Métricas:**

- 296 testes passam (nenhum novo, nenhum quebrado).
- `npx tsc --noEmit` limpo.
- `npx next lint` limpo.
- `npx next build` OK; nenhuma rota removida.
- `rg "href=['\"]/checkout" src/` → 0 matches.

**Status:** D-044 COMPLETO. O loop paciente → consulta →
prescrição → aceite → pagamento → fulfillment → confirmação está
inteiro: UI pública, UI do paciente, UI do admin, webhook e
notificações. Fluxo antigo permanece como back-office.

**Próximos passos sugeridos (fora desta decisão):**

- Medir taxa de confirmação espontânea de `delivered` pelos
  pacientes; se <50%, criar cron `system` auto-delivered após
  N dias sem confirmação (hook na lib já existe).
- Construir página pública de agendamento de consulta —
  hoje a equipe agenda offline; quando virar self-service,
  substituir o link de WhatsApp em `/paciente/renovar`.
- Adicionar lembretes automatizados de reconsulta X dias
  antes do fim do ciclo (WhatsApp + notificação no
  dashboard).

---

## 2026-04-20 · Área do paciente: card "Meu tratamento" + confirmar recebimento (D-044 · onda 2.F) · IA

**Por quê:** depois do pagamento (2.D), o fulfillment fica `paid`,
caminha pra `pharmacy_requested` e `shipped` via admin (2.E), mas o
paciente não tinha como acompanhar onde estava a caixa nem como
confirmar recebimento — precisava esperar alguém do Instituto perguntar
no WhatsApp. Esta entrega fecha o loop: o dashboard `/paciente` mostra
em tempo real a etapa atual, timeline compacta, rastreio e CTA
"já recebi o medicamento" quando aplicável.

**Entregáveis:**

- **`listActiveFulfillments(customerId)`** em `src/lib/patient-treatment.ts`:
  retorna fulfillments em `paid | pharmacy_requested | shipped`
  (somente — `delivered` e `cancelled` saem da visão de ação).
  Ordena desc por `created_at`, cap 10. Traz plano, médica,
  timestamps das etapas e tracking_note.
- **`POST /api/paciente/fulfillments/[id]/confirm-delivery`**:
  endpoint do paciente. `requirePatient` + **ownership check
  explícito** (cruza `fulfillment.customer_id` com `customerId` da
  sessão) antes de chamar `transitionFulfillment` com
  `actor: 'patient'`. 403 em mismatch (não 404, pra não virar oracle
  de IDs). WhatsApp best-effort pro próprio paciente com
  `composeDeliveredMessage` fechando o ciclo.
- **`ActiveFulfillmentCard`** (client component): timeline visual de
  4 passos (pago → na farmácia → a caminho → recebido) com dots
  destacando a etapa atual. Mostra rastreio e data de despacho
  quando `shipped`, hint específica por etapa quando não-shipped.
  Botão "Já recebi o medicamento" só aparece em `shipped`,
  desabilita durante submit, reage a erros. `router.refresh()`
  após sucesso.
- **Dashboard do paciente atualizado:** nova seção "Meu tratamento
  em andamento" logo abaixo das ofertas pendentes. Título só
  aparece quando há fulfillments ativos, zero empty state
  dedicado — card some quando não há o que mostrar.
- **Testes unitários** (8 novos, 296 totais): `listActiveFulfillments`
  cobre happy path 3-status, filtro por `customer_id`, garantia
  de **não** incluir delivered/cancelled/pending_*, fallback de
  nome da médica, normalização de relação array vs single, erro
  do supabase, ordenação e limit.

**Decisões-chave:**

- **Ownership check explícito no endpoint, não apenas na lib.**
  A lib `transitionFulfillment` valida ator ("patient só pode
  delivered"), mas não valida dono — porque ela também serve pra
  admin e system. O endpoint do paciente adiciona a camada de
  dono: `SELECT customer_id WHERE id = :ffId` e compara com o
  `customerId` da sessão. Sem isso, qualquer paciente autenticado
  poderia marcar entregas alheias. Defesa em profundidade.
- **403 em vez de 404 no mismatch.** Evita enumeração de IDs — um
  paciente malicioso não consegue descobrir quais IDs existem.
- **Status `delivered` some da lista de ativos.** Após confirmar,
  o card desaparece do dashboard. O `TreatmentCard` (D-043) continua
  mostrando o ciclo do tratamento; o card de fulfillment é
  especificamente pra etapa logística. Isso evita duplicar
  informação e mantém o dashboard enxuto.
- **CTA só em `shipped`, com copy curto.** Em `paid` e
  `pharmacy_requested` o paciente recebe hints explicativos sem
  botão — nada pra ele fazer ainda. Reduz ansiedade e evita
  pressão pra confirmar algo que não chegou.
- **Timeline de 4 steps, não a máquina de estados inteira.**
  A visão do paciente agrupa `pending_acceptance` e
  `pending_payment` noutras seções (ofertas pendentes), e
  `cancelled` aparece em histórico no futuro. Aqui só os 4
  estados do "caminho feliz" pra evitar confundir.
- **WhatsApp best-effort.** Falha de WA loga e segue; a
  transição no banco é a fonte de verdade. Paciente pode
  clicar mil vezes — idempotência das 3 camadas (lib, UPDATE
  guard, alreadyAtTarget) protege.
- **Sem testar endpoint diretamente.** O ownership check é
  uma comparação de 3 linhas; a transição já é exaustivamente
  testada (23 testes na 2.E). Adicionar testes de endpoint
  daria pouco valor e acoplamento extra com mocks de
  `requirePatient`. Se surgir bug real, criamos teste na
  ocasião.

**Arquivos modificados/criados:**

- `src/lib/patient-treatment.ts` (+90 linhas, nova função
  `listActiveFulfillments` + tipos)
- `src/lib/patient-treatment-fulfillments.test.ts` (+140 linhas, novo)
- `src/app/api/paciente/fulfillments/[id]/confirm-delivery/route.ts`
  (+160 linhas, novo)
- `src/app/paciente/(shell)/_ActiveFulfillmentCard.tsx`
  (+210 linhas, novo)
- `src/app/paciente/(shell)/page.tsx` (+16 linhas, integração)
- `docs/CHANGELOG.md`, `docs/DECISIONS.md`, `docs/SPRINTS.md`

**Métricas:**

- 296 testes passam (8 novos).
- `npx tsc --noEmit` limpo.
- `npx next lint` limpo.
- `npx next build` OK; rota nova:
  `/api/paciente/fulfillments/[id]/confirm-delivery`.
  `/paciente` cresceu 2.02 kB pelo client component.

**Status:** Entregue em produção. Só falta a 2.G (desligar CTAs
públicos do fluxo antigo `/checkout`) pra D-044 estar completo.

---

## 2026-04-20 · Painel admin de fulfillments + transições operacionais (D-044 · onda 2.E) · IA

**Por quê:** as ondas 2.A–2.D criaram o fluxo paciente→webhook: aceite,
pagamento, promoção automática pra `paid`. Agora o fulfillment precisa
avançar no mundo real — alguém do Instituto tem que enviar a receita
pra farmácia, receber a caixa, despachar pro paciente. Esta onda
entrega o painel admin onde esse trabalho acontece, com botões
específicos por estado, modal que respeita o compromisso legal
(farmácia não vê endereço) e notificação WhatsApp best-effort a cada
transição.

**Entregáveis:**

- **`src/lib/fulfillment-transitions.ts`:** `transitionFulfillment`
  idempotente, reaproveita `canTransition` da lib existente.
  Regras de ator (defense-in-depth): admin pode tudo exceto
  `paid` (só webhook); paciente só pode `shipped → delivered`;
  system livre (futuros crons). UPDATE tem guard
  (`.eq('status', currentStatus)`) pra race-safety — se dois
  admins apertarem simultâneo, o segundo recebe
  `invalid_transition` limpo ao invés de corromper estado.
  Valida `tracking_note` (≥3 chars) em `shipped` e
  `cancelled_reason` em `cancelled`. Grava
  `updated_by_user_id` + timestamp específico da etapa.
- **`src/lib/fulfillment-messages.ts`:** composers puros
  (`composePharmacyRequestedMessage`, `composeShippedMessage`,
  `composeDeliveredMessage`, `composeCancelledMessage`). Tom
  editorial alinhado com 2.D, sem emoji, primeiro nome,
  uma ação clara por mensagem. Garantia LGPD: nenhuma mensagem
  expõe CPF, CEP ou logradouro — WhatsApp é canal público.
- **Testes:** 23 novos (15 de transições + 8 de mensagens),
  cobrindo happy path, idempotência, guard de race, validações,
  sequência completa `paid → delivered`, e checagem regex
  contra vazamento de CPF/CEP/endereço nas mensagens.
- **`POST /api/admin/fulfillments/[id]/transition`:** único
  endpoint de transição operacional. `requireAdmin`, body
  `{ to, tracking_note?, cancelled_reason? }`. Chama a lib,
  depois carrega contexto da view `fulfillments_operational` e
  dispara WhatsApp best-effort com o composer apropriado.
  Falha WA loga e segue — transição não regride.
  Códigos HTTP mapeados: 404 `not_found`, 409
  `invalid_transition`, 400 `invalid_payload`, 403
  `forbidden_actor`, 500 `db_error`.
- **`/admin/fulfillments`:** lista operacional com 4 seções:
  pagos (ação: enviar à farmácia), na farmácia (ação:
  despachar), despachados (ação: forçar entrega; paciente
  costuma confirmar em 2.F), e pendentes (só visibilidade —
  aceite/pagamento ainda em curso). Lê direto da view
  `fulfillments_operational` (2.C.1), ordenada por
  `created_at desc`, cap 200/grupo.
- **`/admin/fulfillments/[id]`:** detalhe com cabeçalho
  (status + valor + ciclo), ações disponíveis (client
  component `FulfillmentActions`), painéis de paciente,
  prescrição (link Memed), cobrança (Asaas status + invoice),
  endereço de entrega **gated** por status (só aparece a partir
  de `pharmacy_requested`), e timeline completa. Compromisso
  legal explicitado em copy no painel de endereço ("não é
  compartilhado com a farmácia").
- **`_FulfillmentActions.tsx` (client):** modais específicos
  por transição. Modal "enviar à farmácia" mostra só
  nome + CPF + link da prescrição (**SEM endereço**).
  Modal "marcar despachado" mostra endereço completo e
  exige tracking. Modal "cancelar" exige motivo. Modal
  "entrega forçada" é simples confirmação. Todos usam
  `router.refresh()` pra reler o server component.
- **Nav admin:** item "Fulfillments" adicionado em primeiro
  lugar após "Visão geral" — é a operação mais frequente
  daqui em diante.

**Decisões-chave:**

- **Compromisso legal visível na UI:** o termo de aceite do
  paciente (2.C.2) declara que a farmácia não recebe endereço.
  O painel admin reforça isso duas vezes: (a) modal de envio
  à farmácia não mostra endereço mesmo que o admin esteja
  curioso; (b) painel de endereço exibe um disclaimer
  lembrando que é uso só do Instituto.
- **Idempotência em três camadas:** lib (alreadyAtTarget),
  UPDATE guard (race entre admins) e endpoint (duplo clique
  vira 200 com flag). A UI ainda desabilita botões durante
  submit, mas não é a defesa crítica.
- **WhatsApp best-effort:** falha de WA loga e segue. A
  transição no banco é a fonte de verdade; operador pode
  re-enviar manualmente se precisar.
- **`forbidden_actor` vs `invalid_transition`:** separei pra
  deixar claro quando a regra é ator (paciente não pode
  despachar; admin não pode aprovar pagamento) vs quando é
  estado (paid → shipped sem passar por pharmacy_requested).
  Facilita debug e auditoria.
- **Endereço gated na UI do admin:** antes de
  `pharmacy_requested` o endereço já existe em
  `fulfillments.shipping_*` (gravado no aceite em 2.C.2),
  mas não há razão pro admin vê-lo. Só aparece quando a
  etapa operacional precisa dele.
- **Sem tabela de audit log separada:** os timestamps
  específicos + `updated_by_user_id` já dão trilha de
  auditoria. Podemos evoluir pra tabela de eventos se
  surgir demanda de compliance (veremos no mercado real).

**Arquivos modificados/criados:**

- `src/lib/fulfillment-transitions.ts` (+240 linhas, novo)
- `src/lib/fulfillment-transitions.test.ts` (+280 linhas, novo)
- `src/lib/fulfillment-messages.ts` (+100 linhas, novo)
- `src/lib/fulfillment-messages.test.ts` (+90 linhas, novo)
- `src/app/api/admin/fulfillments/[id]/transition/route.ts` (+220 linhas, novo)
- `src/app/admin/(shell)/fulfillments/page.tsx` (+230 linhas, novo)
- `src/app/admin/(shell)/fulfillments/[id]/page.tsx` (+360 linhas, novo)
- `src/app/admin/(shell)/fulfillments/[id]/_FulfillmentActions.tsx` (+330 linhas, novo)
- `src/app/admin/(shell)/_components/AdminNav.tsx` (+1 linha, item Fulfillments)
- `docs/CHANGELOG.md`, `docs/DECISIONS.md`, `docs/SPRINTS.md`

**Métricas:**

- 288 testes passam (23 novos).
- `npx tsc --noEmit` limpo.
- `npx next lint` limpo.
- `npx next build` OK; rotas novas: `/admin/fulfillments`,
  `/admin/fulfillments/[id]`,
  `/api/admin/fulfillments/[id]/transition`.

**Status:** Entregue em produção. Pendente: 2.F (card no
`/paciente` com status + CTA confirmar recebimento) e 2.G
(desligar CTAs públicos do fluxo antigo `/checkout`).

---

## 2026-04-20 · Webhook Asaas promove fulfillment + WhatsApp (D-044 · onda 2.D) · IA

**Por quê:** onda 2.C.2 criou a cobrança Asaas. Faltava fechar o
loop: quando o paciente paga a invoice, o fulfillment tem que
avançar sozinho pra `paid`, e o paciente tem que receber
confirmação no WhatsApp — sem depender de ninguém apertar botão.
Esta entrega extende o webhook Asaas existente pra rodar esse
fluxo em paralelo com o de consultas (earnings).

**Entregáveis:**

- **`src/lib/fulfillment-promote.ts`:** `promoteFulfillmentAfterPayment`
  idempotente. Resolve `paymentId` local a partir de `asaasPaymentId`
  quando necessário. Localiza fulfillment por `payment_id` direto,
  com fallback seguro: se não está vinculado (race entre webhook
  rápido e `ensurePaymentForFulfillment`), busca único fulfillment
  `pending_payment` sem `payment_id` do mesmo customer e amarra
  retroativamente. Aborta se houver ambiguidade (>1 candidato).
  Atua apenas em `pending_payment`; `paid+` e duplicatas viram
  `alreadyPaid`; `pending_acceptance` / `cancelled` viram
  `invalid_state`. UPDATE com guard de status (`.eq('status',
  'pending_payment')`) protege contra race de concorrência: se
  outro worker promoveu entre select e update, tratamos como
  idempotência bem-sucedida.
- **`composePaidWhatsAppMessage`:** helper puro que monta a mensagem
  personalizada com primeiro nome do paciente e nome do plano.
  Fácil de testar e de evoluir pra template aprovado futuramente.
- **`src/lib/fulfillment-promote.test.ts`:** 15 testes — happy path
  (com/sem resolução via asaas_payment_id), idempotência (paid,
  pharmacy_requested, shipped, delivered, race no UPDATE),
  estados inválidos (pending_acceptance, cancelled), fallback
  (único, ambíguo, ausente), erros de entrada (payment não
  existe, ausência de ids, db_error), composição de WhatsApp.
- **`src/app/api/asaas/webhook/route.ts` extendido:** nova função
  `handleFulfillmentLifecycle` chamada em paralelo a
  `handleEarningsLifecycle`. Detecta `PAYMENT_RECEIVED` /
  `PAYMENT_CONFIRMED` / `PAYMENT_RECEIVED_IN_CASH`, chama
  `promoteFulfillmentAfterPayment`, e se promoveu envia `sendText`
  (janela de 24h aberta pelo aceite/invoice). Erros best-effort
  (log, sem bloquear webhook). Casos `payment_not_found` /
  `fulfillment_not_found` viram log nível `log` (não `error`),
  porque são esperados em pagamentos de consulta (fluxo antigo).

**Status:**

- `npx tsc --noEmit` ✅
- `npx next lint --dir src` ✅
- `npx vitest run` ✅ — 265 testes (17 arquivos). +15 em
  `fulfillment-promote.test.ts`.
- `npx next build` ✅.

**Fluxo ponta-a-ponta agora fechado do paciente:**

1. médica finaliza consulta + prescreve (2.B) →
2. fulfillment `pending_acceptance` vira card no `/paciente` (2.C.2) →
3. paciente aceita em `/paciente/oferta/[id]`, Asaas cria cobrança (2.C.2) →
4. paciente paga na invoice →
5. **webhook Asaas promove fulfillment pra `paid` e manda WA (2.D)** →
6. admin vê lista de pagos pra enviar à farmácia (2.E, próxima) →
7. admin marca `shipped` com código de rastreio →
8. paciente confirma recebimento no painel (2.F).

**Próximo:**

- Onda 2.E: painel admin de fulfillment com transições
  (pharmacy_requested → shipped → delivered) e WhatsApp em cada
  etapa.

---

## 2026-04-20 · Aceite do paciente · endpoint + UI + Asaas (D-044 · onda 2.C.2) · IA

**Por quê:** a 2.C.1 deixou o backend do aceite pronto (hash, termo,
endereço, transação). Faltava expor ao paciente: uma tela humana pra
revisar a indicação, ler o termo, informar endereço e prosseguir pro
pagamento — tudo numa única ação idempotente. Esta entrega fecha o
caminho paciente → aceite → Asaas.

**Entregáveis:**

- **`src/lib/fulfillment-payment.ts`:** `ensurePaymentForFulfillment`
  idempotente. Carrega fulfillment + customer + plan; reusa
  `payment_id` existente se o status Asaas ainda é aproveitável
  (PENDING/AWAITING_RISK_ANALYSIS/CONFIRMED); senão cria. Garante
  `asaas_customer_id` (cria Asaas customer se faltar ou se o env
  mudou), insere row local em `payments`, cria cobrança Asaas com
  `billingType=UNDEFINED` (paciente escolhe PIX/boleto/cartão na
  invoice hospedada), vincula `fulfillments.payment_id`, retorna
  `invoice_url`. Só aceita fulfillment em `pending_payment` — antes
  disso, erro `invalid_state` (exige aceite primeiro).
- **`src/lib/fulfillment-payment.test.ts`:** 9 testes — idempotência
  (reuso PENDING), recriação quando status não-reusável, validações
  (not_found, status ≠ pending_payment, plano inativo), happy path
  com/sem asaas_customer_id existente, falhas do Asaas (customer e
  payment, este marcando row local como DELETED).
- **`POST /api/paciente/fulfillments/[id]/accept`:** transport que
  encadeia `acceptFulfillment` + `ensurePaymentForFulfillment`.
  Captura IP (`x-forwarded-for` / `x-real-ip`) e user-agent pro
  registro legal. Valida `address` e `acceptance_text`. Retorna
  `{ ok, invoiceUrl, paymentId, acceptanceId, amountCents, alreadyAccepted }`.
  Se aceite passa mas pagamento falha, devolve 502 mantendo
  `acceptanceId` pra retry só do pagamento.
- **`src/app/paciente/(shell)/oferta/[appointment_id]/page.tsx`:**
  server component. Carrega appointment + fulfillment + plan +
  customer + doctor, valida ownership explícito
  (`customer_id === customerId`), gating por status
  (`pending_acceptance` mostra form; `pending_payment` mostra card
  "falta pagar" com invoice existente; `paid+` redireciona pra
  `/paciente`; `cancelled`/sem Memed mostram EmptyState). Renderiza
  termo via `renderAcceptanceTerms` com os dados reais do
  paciente/médica/plano/prescrição. Passa `acceptanceText` pronto
  pro client — zero re-renderização no browser (garante que o hash
  bate).
- **`src/app/paciente/(shell)/oferta/[appointment_id]/OfferForm.tsx`:**
  client component. Termo em `<article>` com scroll próprio + versão
  visível. Endereço pré-preenchido a partir de `customers.address_*`
  (paciente só confirma). CEP com máscara e ViaCEP auto-complete
  (foca no número depois da busca). Checkbox legal explícita ("Li
  integralmente o termo, compreendi seus efeitos jurídicos…").
  Botão "Aceito e ir para pagamento" só libera com checkbox marcado;
  no sucesso, redirect direto pra invoice URL. Mostra
  `addressErrors` por campo vindos do backend.
- **`src/lib/patient-treatment.ts` estendida:** `listPendingOffers`
  busca fulfillments em `pending_acceptance` + `pending_payment` do
  paciente com join em plan/doctor/payment. Tipo `PendingOffer`.
- **`src/app/paciente/(shell)/page.tsx` atualizada:** card "Nova
  indicação médica" (tom sage, CTA pra `/paciente/oferta/…`) pra
  `pending_acceptance`; card "Pagamento pendente" (tom cream, CTA
  direto pra `invoice_url`) pra `pending_payment`. Renderizados no
  topo, acima dos banners de renewal, com prioridade visual máxima.

**Status:**

- `npx tsc --noEmit` ✅
- `npx next lint --dir src` ✅
- `npx vitest run` ✅ — 250 testes (16 arquivos). +9 em
  `fulfillment-payment.test.ts`.
- `npx next build` ✅ — rotas `/paciente/oferta/[appointment_id]`
  (3.18 kB) e `/api/paciente/fulfillments/[id]/accept` compilam.

**Próximo:**

- Onda 2.D: webhook Asaas promove fulfillment `pending_payment → paid`
  e dispara WhatsApp de pagamento confirmado.
- Onda 2.E: painel admin de fulfillment com transições
  (pharmacy_requested → shipped → delivered).

---

## 2026-04-20 · Endereço + termo jurídico do aceite (D-044 · onda 2.C.1 · backend) · IA

**Por quê:** a onda 2.B deixa a médica declarando "prescrevi o plano
X" e o fulfillment nasce em `pending_acceptance`. Faltava a parte do
paciente: (i) **formalizar** o aceite com registro legal probatório,
(ii) **informar o endereço de entrega** sem friccção, e (iii) garantir
que a farmácia **nunca** receba endereço. Esta entrega resolve
backend puro: schema, texto jurídico versionado, hash determinístico
com endereço dentro, orquestração transacional do aceite. UI e Asaas
ficam pra 2.C.2.

**Entregáveis:**

- **Migração `20260424010000_fulfillment_shipping_and_acceptance_snapshot.sql`:**
  - Colunas `shipping_*` em `public.fulfillments` (recipient_name,
    zipcode, street, number, complement, district, city, state) pra
    snapshot do endereço de despacho. Nullable até o aceite.
  - Coluna `shipping_snapshot jsonb` em `public.plan_acceptances` pra
    prova legal imutável do endereço aceito (o `fulfillment.shipping_*`
    é operacional; `plan_acceptances.shipping_snapshot` é legal).
  - View `public.fulfillments_operational` unindo fulfillment +
    customer + plan + doctor + appointment + payment. Vai alimentar
    painel admin (2.E) e card do paciente (2.F).
  - Índice `idx_ff_shipping_city_state` pra painel admin filtrar por
    região.

- **`src/lib/fulfillments.ts` estendida:**
  - Novo tipo `ShippingSnapshot`.
  - `FulfillmentRow` ganhou 8 campos `shipping_*`.
  - `PlanAcceptanceRow` ganhou `shipping_snapshot`.
  - `computeAcceptanceHash` agora inclui `shipping` canonicalizado
    (CEP só-dígitos, UF maiúscula, complement null↔"" unificados).
    Mudança de CEP → hash diferente. Whitespace no endereço → hash
    estável.
  - +8 testes cobrindo canonicalização.

- **`src/lib/patient-address.ts` (novo · puro):**
  - `validateAddress(input, recipientFallback)` — valida CEP, UF
    (contra lista das 27), rua, número, bairro, cidade,
    recipient_name. Agrega múltiplos erros de uma vez.
  - `snapshotToCustomerPatch` / `snapshotToFulfillmentPatch` —
    conversão pra colunas do banco.
  - `customerToAddressInput` — pré-preenche form com endereço
    salvo.
  - 22 testes cobrindo happy paths, erros agregados, round-trip.

- **`src/lib/acceptance-terms.ts` (novo · puro):**
  - `ACCEPTANCE_TERMS_VERSION = "v1-2026-04"` imutável.
  - Template v1 com 9 cláusulas, redação jurídica formal, citações
    à LGPD art. 11 II "a", CFM 2.314/2022, CDC art. 49, Lei
    5.991/1973, Lei 13.021/2014. Explícita sobre a farmácia **não**
    receber endereço. Explícita sobre não-reembolso pós-manipulação.
  - `renderAcceptanceTerms(params)` com verificação defensiva
    contra placeholders não-substituídos.
  - 11 testes cobrindo substituição completa, presença de bases
    normativas, imutabilidade do texto final.

- **`src/lib/fulfillment-acceptance.ts` (novo · orquestração):**
  - `acceptFulfillment(supabase, params)` carrega fulfillment com
    joins (appointment + plan + customer), valida ownership (por
    `user_id` OU `customer_id`), valida estado (só aceita
    `pending_acceptance`; `pending_payment`/`paid` são idempotentes
    e devolvem registro existente; resto rejeita), valida plano
    ativo e prescrição presente, valida endereço, computa hash,
    persiste em 3 passos (update customer cache, insert acceptance
    imutável, update fulfillment → `pending_payment` +
    snapshot shipping_*).
  - Trata `23505` (unique collision) como idempotência positiva.
  - 17 testes cobrindo payload, not_found, forbidden, estado,
    endereço, plano, happy path, race e falhas de DB.

**Resultado:**

- 15 test files / 241 testes passando (+50 desde 2.B).
- typecheck + ESLint limpos.
- Migração aplicada no Supabase remoto.
- Pronto pra 2.C.2 montar UI sobre esta base sem mexer em nada
  do backend.

---

## 2026-04-20 · Painel da médica "finalizar consulta" (D-044 · onda 2.B) · IA

**Por quê:** a onda 2.A criou o schema do fulfillment, mas ninguém
escrevia nele. A médica ainda tratava anamnese/conduta como texto
solto que ficava no appointment sem desfecho claro, e não havia
como declarar oficialmente "prescrevi o plano X" ou "avaliei sem
indicar". A onda 2.B é o primeiro produtor real de dados na nova
máquina de estados — sem ela, nenhum fulfillment nasce.

**Entregáveis:**

- **`src/lib/appointment-finalize.ts`** (novo · puro):
  - `validateFinalizeInput` — checagens síncronas (UUID, URL
    http/https, limites de tamanho, campos obrigatórios por
    decisão).
  - `finalizeAppointment(supabase, params)` — orquestra:
    1. valida ownership (doctor_id bate) e estado (não cancelado,
       não finalizado);
    2. se prescribed, valida que o plano existe e está ativo;
    3. faz upsert idempotente de `fulfillment(pending_acceptance)`
       — se já existe pra esse appointment, reusa o id em vez de
       tentar INSERT (evita conflito de `unique(appointment_id)`);
    4. atualiza `appointments` com `finalized_at`, decisão,
       snapshot de anamnese/hipótese/conduta e, se prescribed,
       `prescribed_plan_id` + `memed_prescription_url` +
       `memed_prescription_id`.
    5. transiciona `status` pra `completed` apenas quando atual
       é `scheduled`/`confirmed`/`in_progress` — preserva
       `no_show_*` quando médica finaliza paciente que faltou.
  - Tagged union `FinalizeResult` com `.code` mapeado pra HTTP
    status no endpoint (`not_found`, `forbidden`, `cancelled`,
    `already_finalized`, `invalid_payload`, `plan_not_active`,
    `db_error`).

- **`src/lib/appointment-finalize.test.ts`** (novo · 21 casos):
  validação pura + happy path declined/prescribed, ownership,
  já-finalizado, cancelada, plano inativo, idempotência do
  upsert, db_error em cada etapa.

- **`/api/medico/appointments/[id]/finalize`** (POST):
  rota fina em cima da lib. `requireDoctor()` + parse seguro do
  body (strings vazias viram null; anamnese aceita string OU
  objeto). Mapeia `FinalizeFailure.code` pra HTTP status.

- **`/medico/consultas/[id]/finalizar`** (novo):
  - Server component com `requireDoctor()`, dupla filtragem
    por `doctor_id`, e 3 estados de renderização:
    (a) finalizável → `FinalizeForm`;
    (b) já finalizada → tela read-only com campos salvos
        (inclui link pra receita Memed);
    (c) cancelada → mensagem + voltar.
  - Client `FinalizeForm`: radio grande com 2 opções,
    textareas de anamnese/hipótese/conduta, e bloco condicional
    de prescrição (select de plano + URL Memed + ID opcional).
    Em erro do backend, mostra a mensagem e destaca o campo via
    `field` retornado.

- **`/medico/agenda`** (editado):
  - Lê também `finalized_at` e `prescription_status`.
  - Labels de status refletem finalização ("Prescrita" / "Sem
    indicação" / "Finalizada" / "Concluída (não fechada)").
  - Histórico ganhou botão **Finalizar** em cada consulta
    passada não-finalizada (e "Ver" nas finalizadas, pra abrir
    a tela read-only).
  - `isFinalizable()` como helper explícito — qualquer cancel
    bloqueia.

**Fora do escopo (ondas seguintes):**

- WhatsApp pro paciente avisando "sua oferta está pronta" —
  espera a tela de aceite (2.C) e o painel admin (2.E).
- `/paciente/oferta/[id]` (2.C).
- Admin que move `paid` → `pharmacy_requested` → `shipped` →
  `delivered` (2.E).

**Status:** 186 testes passando (21 novos). `tsc`, `eslint`,
`next build` verdes. Rota `/medico/consultas/[id]/finalizar`
aparece no bundle (2.36 kB). Nenhuma migração nova — tudo em
cima do schema da onda 2.A.

---

## 2026-04-20 · Inversão do fluxo: fulfillment + aceite formal (D-044 · onda 2.A) · IA

**Por quê:** o fluxo antigo obrigava o paciente a pagar **antes** de
ser avaliado pela médica — desalinhado com a realidade clínica
(prescrição exige avaliação), criava fricção no funil e deixava
preços altos na home sem contexto médico ("horrível", nas palavras
do usuário). Além disso, mesmo depois do pagamento, o ciclo real
(manipulação em farmácia externa → envio → recebimento) vivia em
planilha paralela, sem rastro no sistema.

**Correção combinada:** consulta inicial passa a ser **gratuita**.
Se a médica prescrever, o paciente vê a receita na área logada,
faz **aceite formal** (texto + checkbox + submit), paga, e só
então roda o fulfillment — com estados explícitos até a entrega.

**Entregáveis (onda 2.A · só schema + domínio):**

- **Migration `20260424000000_fulfillments_and_plan_acceptance.sql`** (aplicada em produção):
  - Enum `fulfillment_status` com 7 estados
    (`pending_acceptance` → `pending_payment` → `paid` →
    `pharmacy_requested` → `shipped` → `delivered`, mais
    `cancelled` como sumidouro). `delivered` e `cancelled` são
    terminais.
  - Tabela `fulfillments` 1:1 com appointment via
    `unique(appointment_id)`, com timestamps por transição,
    `tracking_note` (texto livre do operador) e
    `updated_by_user_id` (auditoria).
  - Tabela `plan_acceptances` com texto exato + hash SHA-256 do
    conjunto canonicalizado. Trigger
    `prevent_plan_acceptance_changes` bloqueia UPDATE e DELETE —
    aceite é prova legal imutável.
  - `appointments` ganhou 3 colunas: `prescribed_plan_id`,
    `prescription_status` (`none`/`prescribed`/`declined`),
    `finalized_at`.
  - RLS: admin ALL + médica SELECT do que é dela.
    `current_doctor_id()` / `jwt_role()` já existiam.
  - Índices: parcial `idx_ff_open` pra listar fulfillments em
    aberto sem varrer terminais.

- **`src/lib/fulfillments.ts`** (novo · puro, sem I/O):
  - Tipos `FulfillmentRow`, `PlanAcceptanceRow`, `FulfillmentStatus`.
  - `canTransition(from, to)` — fonte da verdade da máquina de estados.
  - `nextAllowedStatuses(from)` — pra UI renderizar só os botões válidos.
  - `isTerminalStatus`, `fulfillmentStatusLabel` (pt-BR).
  - `timestampsForTransition(to, at)` — evita operador esquecer de
    preencher o timestamp correspondente.
  - `computeAcceptanceHash({ acceptanceText, planSlug, prescriptionUrl, appointmentId })`
    — SHA-256 do JSON canonicalizado (chaves ordenadas, NFC
    Unicode, whitespace colapsado, slug em lowercase).

- **`src/lib/fulfillments.test.ts`** (novo · 24 testes):
  - Caminho feliz completo.
  - Cancel a partir de cada etapa pré-`delivered`.
  - Bloqueio de pulo, retrocesso, auto-transição e "reviver" terminais.
  - Determinismo do hash + sensibilidade a texto/plano/prescrição/appointment.
  - Resiliência do hash a whitespace, case do slug e Unicode NFC/decomposto.

**Fora do escopo da onda 2.A (chegam nas próximas):**

- UI da médica finalizar consulta (2.B)
- Tela de aceite do paciente (2.C)
- Extensão do webhook Asaas (2.D)
- Painel admin de fulfillment (2.E)
- Card "meu tratamento" no /paciente (2.F)
- Remover CTAs do fluxo antigo (2.G)

**Status:** 165 testes passando (24 novos). TypeScript e ESLint
verdes. Migração aplicada no Supabase remoto sem erros. Nenhuma
UI exposta — onda seguinte é 2.B (painel da médica finalizar
consulta com seletor de plano).

---

## 2026-04-20 · Retirada de `/planos` da home pública · IA

**Por quê:** o usuário apontou que os preços altos do `/planos`
exibidos na home (sem explicação médica) assustam o visitante. O
fluxo correto é o paciente chegar ao preço **depois** da consulta,
com a indicação da médica já em mãos.

**Entregáveis:**

- `src/components/Header.tsx`: link "Planos" removido da nav.
- `src/components/Hero.tsx`: CTA secundário trocado pra
  "Como funciona" (âncora pra `#como-funciona`).
- `src/components/Cost.tsx`: link "Ver planos de tratamento" e
  dependência `Link` removidos; copy ajustada pra
  "avaliação gratuita + só paga se a médica indicar".
- `src/components/Success.tsx`: bloco "Já dá pra ver os planos"
  substituído por "O que vem agora" (consulta antes, cobrança
  só se houver prescrição).
- `src/app/planos/page.tsx`: `robots: noindex, nofollow`; página
  segue acessível por URL direta (operacional envia no WhatsApp).
- `src/app/sitemap.ts`: `/planos` fora do sitemap.

**Status:** commit `d62f65b` no `main`. 165 testes passando,
TypeScript e ESLint verdes.

---

## 2026-04-20 · Área logada do paciente "meu tratamento" (D-043) · IA

**Por quê:** depois do checkout, o paciente sumia do app. Qualquer
pergunta (quando é minha próxima consulta? quantos dias faltam pra
acabar o ciclo? onde renovo?) virava WhatsApp pra equipe. Sem
`/paciente`, não existia canal de retenção nem de auto-renovação.

**Entregáveis:**

- **Migration `20260423000000_customers_user_id.sql`:**
  - `customers.user_id uuid references auth.users(id) on delete
    set null` + unique partial index.
  - Backfill: liga customers existentes ao auth.user correspondente
    via e-mail.
  - Trigger `link_customer_to_new_auth_user` (security definer) —
    sincroniza o vínculo toda vez que um auth.user novo nasce.

- **`src/lib/auth.ts`:** `requirePatient()` — hard-gate que exige
  sessão + `role='patient'` + `customers.user_id` vinculado.
  Redireciona pra `/paciente/login` com mensagem apropriada em
  cada falha.

- **`src/lib/patient-treatment.ts`** (novo): fonte única do domínio.
  - `getActiveTreatment(customerId, now)` — último payment
    CONFIRMED + plan + janela do ciclo (paid_at..paid_at+cycle_days)
    + daysRemaining + progressPct.
  - `getRenewalInfo(customerId, now)` — status `none` /
    `active` / `expiring_soon` (≤14 dias) / `expired`.
  - `getUpcomingAppointment`, `listPastAppointments`,
    `getPatientProfile`.
  - Helpers puros de label (pt-BR).

- **`/api/paciente/auth/magic-link`** (novo): fluxo dedicado do
  paciente. Se e-mail bate um `customer` existente, cria
  `auth.user` com role=patient, vincula e dispara o link mágico
  — tudo num POST. Se nada bate, retorna 200 silencioso
  (anti-enumeração).

- **UI `/paciente`:**
  - `/paciente/login` (+ `PatientLoginForm`): magic-link.
  - `/paciente/(shell)/layout.tsx` + `PatientNav` (Visão geral
    / Minhas consultas / Renovar).
  - `/paciente` — dashboard: banners condicionais para
    `expired`/`expiring_soon`, card de próxima consulta (com
    botão "Entrar na sala" via HMAC quando está na janela),
    card de tratamento (% progresso + CTA renovação), últimas
    3 consultas, resumo do investimento.
  - `/paciente/consultas` — agenda + histórico completo,
    clicáveis.
  - `/paciente/consultas/[id]` — detalhe + **reaproveita**
    `JoinRoomButton` + `/api/paciente/appointments/[id]/join`
    via token HMAC gerado server-side (sem duplicar janela de
    entrada).
  - `/paciente/renovar` — status do ciclo + lista de planos
    ativos (o plano atual aparece destacado como "recomendado")
    + redireciona pra `/checkout/[slug]` já existente.

- **Middleware:** adiciona `/paciente/*` ao hard-gate de sessão
  (redirecionando pra `/paciente/login`).

- **`/checkout/sucesso`:** ganha card destacado com link pra
  `/paciente/login` — fecha o loop "comprei → acompanho".

- **`/api/auth/callback`:** reconhece `/paciente/*` pra direcionar
  erros pro login certo.

- **Testes:** 21 novos em `src/lib/patient-treatment.test.ts`.
  Total: 141/141 passando. Cobre transições de `RenewalStatus`,
  fallback de `doctors` null, filtro `.or` do histórico e
  propagação de erros.

- **Docs:** ADR `D-043` em `docs/DECISIONS.md` + atualização
  de Sprint 5 em `docs/SPRINTS.md`.

**Impacto direto:**
- Paciente ganha bookmark fixo (`/paciente`). Token do
  WhatsApp expirou? Loga, abre a consulta, gera um novo.
- Renovação agora é 2 cliques: `/paciente/renovar` → checkout.
- Reduz WhatsApp operacional: perguntas recorrentes ficam
  self-service.
- Destrava os próximos: pré-consulta, prescrições, NF-e do
  paciente, tracking de medicação.

---

## 2026-04-20 · PIX self-service da médica (D-042) · IA

**Por quê:** com o ciclo fiscal fechado (D-041) e o cron de payouts
operando (D-040), o único gargalo humano no onboarding da médica
virou o PIX — só o admin podia cadastrar/trocar. Cada nova médica e
cada troca de chave virava ticket. Sem histórico auditável, também
não conseguíamos responder "pro PIX certo daquele mês?".

**Entregáveis:**

- **Migration `20260422000000_doctor_payment_methods_history.sql`:**
  - `doctor_payment_methods.replaced_at timestamptz` + `replaced_by
    uuid references auth.users` — quem trocou, quando.
  - Índice `idx_dpm_history(doctor_id, created_at desc)` pra listar
    histórico rápido.
  - RLS não muda — `dpm_doctor_self` (mig 005) já permitia médica
    ler/escrever o próprio PIX.

- **`src/lib/doctor-payment-methods.ts`** (novo): fonte única de
  CRUD + validação.
  - `PIX_KEY_TYPES`, `isValidPixKey`, `normalizePixKey`,
    `validatePixInput`, `isHolderConsistent` — validação por tipo
    (cpf/cnpj/email/phone/random).
  - `listPaymentMethods`, `getActivePaymentMethod`.
  - **`createOrReplacePaymentMethod`** — troca **não-destrutiva**:
    marca default vigente como `active=false, is_default=false,
    replaced_at=now(), replaced_by=userId` e faz INSERT do novo.
    Invariante de 1 `active=true` por médica mantida (cron D-040
    continua funcionando sem mudança).
  - `deleteHistoricalPaymentMethod` — só permite remover não-default.
  - `maskPixKey`, `labelForPixType` — helpers de UI.

- **APIs HTTP novas:**
  - `GET /api/medico/payment-methods` — lista default + histórico.
  - `POST /api/medico/payment-methods` — cria/substitui.
  - `DELETE /api/medico/payment-methods/[id]` — remove histórico.
  - `POST /api/admin/doctors/[id]/payment-method` **refatorado** pra
    delegar pra mesma lib. Admin também grava `replaced_by`.

- **UI `/medico/perfil/pix`:**
  - Card vigente (tipo + chave mascarada + titular + verified_at).
  - Form de troca com `window.confirm` (ação sensível).
  - Lista de histórico com botão "Remover" por item.
  - Sidebar educativa ("como funcionam os repasses", "dicas").

- **Integração no `/medico/perfil`:** novo card "Chave PIX" com
  preview mascarado + CTA "Gerenciar →" (ou "Cadastrar →" se vazio).

- **Banner no `/medico` (dashboard):** se a médica não tem PIX
  cadastrado, aparece alerta terracotta "Cadastre seu PIX para
  liberar os repasses" com CTA direto pro form.

- **Testes (29 novos, todos verdes):**
  `src/lib/doctor-payment-methods.test.ts` cobrindo: validação por
  tipo (cpf, cnpj, email, phone, random, vazio), normalização
  (dígitos/lowercase), `validatePixInput` (campos e mensagens),
  `isHolderConsistent` (CPF/CNPJ bate com chave), `maskPixKey`,
  `labelForPixType`, `createOrReplacePaymentMethod` (insere, marca
  antigo, propaga erro, valida antes de tocar banco),
  `deleteHistoricalPaymentMethod` (OK, bloqueia default, rejeita
  outra médica, NOT FOUND).

  Total: 91 → **120 testes passando**.

**Impacto:**
- Onboarding da médica agora é 100% self-service:
  convite → login → completa perfil → cadastra PIX → recebe.
  Admin-in-the-loop zero.
- Troca de chave auditável (sabemos quem trocou, quando, de qual
  chave pra qual).

**Decisão adiada (consciente):** validação Asaas do holder via
`/v3/accounts/validatePixKey` — sem execução PIX via Asaas hoje,
validar só a chave é falsa segurança. Retomado quando D-04X
automatizar a execução.

---

## 2026-04-20 · Painel financeiro da médica + upload NF-e + cron de cobrança (D-041) · IA

**Por quê:** o D-040 automatizou a geração do payout, mas o ciclo
fiscal continuava fora do sistema (médica emitia NF externamente,
mandava por e-mail, admin arquivava em pasta). Sem NF dentro do
sistema: passivo tributário invisível + ~30 min/ciclo de follow-up
manual + auditoria dependente de Drive. Resolvido fechando o
loop dentro do produto.

**Entregáveis:**

- **Migration `20260421010000_billing_documents.sql`:**
  - Bucket privado `billing-documents` (10 MB hard cap, aceita
    PDF/XML/PNG/JPG/WEBP).
  - `UNIQUE(payout_id)` em `doctor_billing_documents` — 1 NF por
    payout, substituição é DELETE+POST explícito.
  - `doctor_payouts.last_nf_reminder_at` + índice parcial — idempotência
    do cron.

- **`src/lib/billing-documents.ts`** (novo): helpers espelho do
  `payout-proofs.ts` mas apontando pro bucket novo. `buildStoragePath`
  monta `billing/{payout_id}/{ts}-{slug}.{ext}`. Bucket separado
  permite retention policies independentes no futuro.

- **`src/lib/doctor-finance.ts`** (novo): fonte única da verdade do
  lado da médica.
  - `getDoctorBalance(supabase, doctorId)` → agrega por status.
  - `estimateNextPayout(supabase, doctorId, now)` → separa `eligible`
    (available_at < mês atual) de `deferred` (cairá no próximo ciclo).
    `scheduledAt` = próximo dia 1 às 09:15 UTC (alinhado com cron D-040).
  - `listPayoutsWithDocuments(supabase, doctorId, limit)` → join
    payouts + NFs em camelCase.
  - `countPendingBillingDocuments(supabase, doctorId?)` → distingue
    `pendingUpload` (sem doc) de `awaitingValidation` (doc sem
    `validated_at`).

- **APIs da médica:**
  - `POST /api/medico/payouts/[id]/billing-document` (multipart) —
    upload com ownership check e UNIQUE guard.
  - `GET` — signed URL 60s.
  - `DELETE` — remove ENQUANTO não validado; após validação só admin
    remove.

- **APIs do admin:**
  - `GET /api/admin/payouts/[id]/billing-document` — signed URL.
  - `DELETE` — remove a qualquer momento (casos de correção).
  - `POST /api/admin/payouts/[id]/billing-document/validate[?unvalidate=1]`
    — mutação explícita (POST + body opcional pra `validation_notes`).
    Revalidar preserva o `validated_at` original (auditoria).

- **UI médica:**
  - `/medico/repasses` reescrito: 4 cards de saldo (disponível,
    aguardando, próximo repasse, total recebido); banner "NF pendente
    em N repasses"; por payout: status + comprovante PIX (quando
    confirmado) + `BillingDocumentBlock` (form com arquivo / número /
    data / valor NF).
  - `/medico` dashboard: banner alerta quando há payouts confirmados
    sem NF.

- **UI admin:**
  - `BillingDocumentAdminPanel` no sidebar de `/admin/payouts/[id]`:
    mostra NF, destaca divergência de valor, textarea de notes,
    botões Validar / Desvalidar / Remover.

- **Cron `notify-pending-documents`** (novo, diário 09:00 UTC ≈ 06:00 BRT):
  - `src/lib/notify-pending-documents.ts`: query payouts `confirmed`
    com `paid_at ≤ now - 7d` sem NF validada; envia
    `sendMedicaDocumentoPendente` via WhatsApp; interval guard de 24h
    via `last_nf_reminder_at`.
  - Defesa contra loop: médica sem phone/nome OU template stub
    (`templates_not_approved`) → pula MAS marca o timestamp mesmo
    assim.
  - Max 100 notificações/run pra proteger quota Meta.
  - `vercel.json` agendado; rota `GET /api/internal/cron/notify-pending-documents`
    protegida por `CRON_SECRET`.

- **`src/lib/system-health.ts`** ganha check
  `cron_notify_pending_documents` (warn 36h / error 7d).
  `payloadSummary` estendido pra mostrar `evaluated, notified,
  skippedInterval, skippedTemplate, skippedMissingPhone` no dashboard.

- **Testes (27 novos, 91 total):**
  - `doctor-finance.test.ts` — balance, estimate (boundary dez/jan),
    list com join, count pending/awaiting.
  - `billing-documents.test.ts` — slugify, buildStoragePath (MIME
    variations), constantes.
  - `notify-pending-documents.test.ts` — idempotência via
    interval, skip missing phone/name, stub → marca timestamp,
    exceção do send, db error.

**Como testar:**

1. Como médica com payout confirmed (seed ou banco real), entrar em
   `/medico/repasses` → ver saldo + banner "NF pendente".
2. Clicar "Enviar NF-e" no card do payout → selecionar PDF → submit
   → recarrega com "NF enviada — aguardando validação".
3. Como admin, abrir `/admin/payouts/{id}` → ver painel NF-e → clicar
   "Ver NF" (signed URL abre em nova aba) → "Validar NF" → recarrega
   "Validada".
4. Voltar à médica em `/medico/repasses` → badge vira "NF validada".
5. Manual cron: `curl -H "x-cron-secret: $CRON_SECRET"
   https://.../api/internal/cron/notify-pending-documents` → JSON
   com `notified`, `skippedInterval` etc.
6. `/admin/health?ping=1` → novo check `cron_notify_pending_documents`.

---

## 2026-04-20 · Crons financeiros em Node com observabilidade (D-040) · IA

**Por quê:** as RPCs Postgres `recalculate_earnings_availability()` e
`generate_monthly_payouts()` existiam desde D-022 agendadas via
`pg_cron`, mas tinham três furos graves: dependência do `pg_cron`
estar habilitado (silencioso se não estivesse), zero observabilidade
(só retornam `int`), e médicas com saldo mas sem PIX eram silenciosamente
ignoradas. Earnings ficando em `pending` indefinidamente e payouts
nunca sendo gerados — sem ninguém saber — era risco real.

**Entregáveis:**

- **`src/lib/earnings-availability.ts`** (novo):
  `recalculateEarningsAvailability(supabase)` reimplementa a lógica
  em Node. Regra (paridade COMPENSATION.md): earning sem payment
  promove imediatamente; com payment, soma janela de risco ao paid_at
  (PIX 7d, BOLETO 3d, CARTÃO/UNDEFINED 30d). Retorno estruturado com
  `inspected, scheduledFuture, promoted, skippedMissingPaidAt, errors`.
  Idempotente via `.eq("status","pending")` guard.

- **`src/lib/monthly-payouts.ts`** (novo):
  `generateMonthlyPayouts(supabase, { referencePeriod? })` gera drafts
  mensais por médica. `defaultReferencePeriod(now)` sempre retorna o
  mês anterior em UTC ('YYYY-MM'). Pipeline: SELECT available +
  sem payout → agrega por médica → valida status/PIX → INSERT draft
  (`auto_generated=true`) → UPDATE earnings (`in_payout`). Tratamento
  explícito de `23505` como idempotente. Warnings pra médica inativa,
  sem PIX cadastrado, PIX vazia, payout já existente.

- **`src/lib/cron-runs.ts`** (novo): `startCronRun` / `finishCronRun`
  / `getLatestRun` / `getLatestSuccessfulRun`. Persiste cada execução
  em `public.cron_runs` (status, duration_ms, payload jsonb, error).

- **`GET /api/internal/cron/recalculate-earnings`** (novo, diário
  03:15 UTC). Auth via `CRON_SECRET` (mesmo padrão das outras crons).

- **`GET /api/internal/cron/generate-payouts`** (novo, mensal dia 1
  09:15 UTC). Suporta `?period=YYYY-MM` pra backfill manual.

- **Migration `20260421000000_earnings_crons.sql`:**
  - `doctor_payouts.auto_generated boolean not null default false`
  - `public.cron_runs` table + índices + RLS habilitada (service-only)

- **`src/lib/system-health.ts`** estendido com `cron_earnings_availability`
  e `cron_monthly_payouts`. Freshness: warn > 36h / error > 7d
  (earnings); warn > 40d / error > 70d (payouts — mensal). Última
  execução com status `error` eleva em 1 nível. Payload summary no
  details expõe `promoted`, `payoutsCreated`, `errors` no dashboard.

- **`/admin/payouts`**: badge "auto" (sage) ao lado do nome da médica
  quando `auto_generated=true`. Mantém histórico transparente de
  origem do draft.

- **`vercel.json`**: 2 crons novas + `maxDuration` (60s earnings,
  120s payouts — mais folga pro batch mensal).

- **Testes (28 novos, total agora 85):**
  - `earnings-availability.test.ts` — 16 testes (cada billing_type,
    sem payment, paid_at null, idempotência, erros, múltiplas mistas).
  - `monthly-payouts.test.ts` — 12 testes (happy path, defaultReferencePeriod
    cross-boundary, PIX missing/vazia, inativa, sum-zero, 23505, erro
    parcial isolado, 2 médicas).

**Coexistência com pg_cron:** as RPCs SQL continuam no banco como
backup. Ambas (Node + SQL) são idempotentes — se uma rodar primeiro,
a outra vira noop via guards de status/unique. No dev sem `pg_cron`,
Vercel é o único motor e finalmente é observável.

**Pós-condição:** ciclo financeiro completo automatizado e visível.
Médicas recebem PIX no primeiro dia útil do mês sem ação manual.
Quebras ficam visíveis em minutos no `/admin/health`. Missing PIX
aparece no payload da última cron_run. **Sprint 4.1 fechada, abre
Sprint 5.**

---

## 2026-04-20 · Prova de fogo E2E — runbook + health endpoint + dashboard (D-039) · IA

**Por quê:** até aqui, validar que "tudo continua funcionando" era
tácito: admin abria `/admin/*` e conferia. Com a pilha atual (3 crons,
3 webhook sinks, no-show policy, auto-pause, conciliação financeira),
essa verificação informal deixou de ser confiável. D-029 mostrou que
integração externa pode falhar silenciosa por semanas; precisávamos de
detecção ativa.

**Entregáveis:**

- **`src/lib/system-health.ts`** (novo): `runHealthCheck({ pingExternal })`
  roda 9 checks paralelos com timeout individual (5s default), tolerância
  a falha por check (um travando não derruba os outros), e agregado
  final ok/warning/error/unknown. Cobertura:
  - `database` — count em `doctors`
  - `asaas_env` — validação env vars; ping opcional (GET /customers?limit=1)
  - `asaas_webhook` — freshness de `asaas_events.received_at`
  - `daily_env` — validação env vars; ping opcional (GET /rooms?limit=1)
  - `daily_signal` — max(webhook Daily, cron reconcile) — aceita
    qualquer dos dois caminhos como sinal vivo
  - `whatsapp_env` — validação env vars (sem ping pra não gastar
    rate limit Meta Graph)
  - `whatsapp_webhook` — freshness de `whatsapp_events.received_at`
  - `reconciliation` — reuso de `getReconciliationCounts()` (D-037)
  - `reliability` — reuso de `listDoctorReliabilityOverview()` (D-036)

- **`GET /api/internal/e2e/smoke`** (novo): endpoint JSON protegido por
  `CRON_SECRET` (padrão igual aos crons existentes). Retorna `HealthReport`
  completo. HTTP 503 quando `overall: "error"` pra facilitar monitoria
  externa (UptimeRobot, Better Uptime) que só olha status code. Query
  `?ping=1` força ping HTTP real em Asaas/Daily. Zero side effect —
  seguro pra bater a cada minuto.

- **`/admin/health`** (novo): dashboard server-rendered mostra status
  agregado no topo + 9 cards por subsistema com dot ok/warn/error,
  summary humano, detalhes estruturados (IDs, timestamps, contagens) e
  tempo de execução por check. Toggle "Rodar com ping" força
  `pingExternal: true`. Rodapé explica integração com UptimeRobot.

- **`docs/RUNBOOK-E2E.md`** (novo): roteiro de prova de fogo com 7
  cenários (paciente feliz, no-show médica, sala expirada sem ninguém,
  refund manual, refund via Asaas API, payout mensal completo,
  conciliação limpa, auto-pause de médica). Cada cenário tem
  pré-requisitos, passos numerados, checklist de validação (com SQL
  quando aplicável) e cleanup. Inclui troubleshooting pros 2 tipos de
  discrepância financeira mais comuns + query template de limpeza de
  dados de teste.

- **AdminNav**: novo link "Saúde" apontando pra `/admin/health`.

**Decisões deliberadas:**

- NÃO automatizar os 7 cenários via Playwright agora: não temos
  staging separado; Playwright em produção cria dados reais em cada
  run. Reavaliar na Sprint 6/7 quando volume justificar staging.
- NÃO persistir histórico de health checks em tabela: event tables
  existentes (`asaas_events`, `daily_events`, `whatsapp_events`) +
  `appointments.reconciled_at` já dão rastreabilidade histórica pros
  sinais que importam.
- NÃO usar APM pago (Datadog, Sentry APM): overkill pra operação
  atual. UptimeRobot grátis batendo no smoke endpoint resolve 80%.

**Validação:**

- `npm test` → 29/29 passando (nada nos testes regride; `system-health`
  sem cobertura própria — depende de DB e integrações externas, melhor
  validado pelo próprio runbook)
- `tsc --noEmit` → limpo
- `npm run build` → limpo
- Sprint 4.1: **100% entregue** ✅

---

## 2026-04-20 · Testes automatizados unitários com Vitest (D-038) · IA

**Por quê:** antes desta entrega o projeto rodava em `tsc --noEmit` +
`next build` + testes manuais. Isso escalou enquanto a lógica de negócio
era pequena; mas com D-032 (política de no-show), D-036 (confiabilidade
+ auto-pause), D-037 (conciliação financeira) e D-034 (refund via Asaas
com feature flag), ficou claro que regressão silenciosa nesses arquivos
tem dano financeiro/operacional concreto. 29 testes automatizados
cobrem os pontos de maior risco em ~500ms.

**Entregáveis:**

- **Vitest 4.x** instalado + `vitest.config.ts` com alias `@/*` e
  scripts `npm test` / `npm run test:watch`.

- **`src/test/mocks/supabase.ts`** (novo): helper que cria um mock do
  Supabase client via fila por tabela. O teste enfileira explicitamente
  as respostas que cada `.from('tabela')` deve consumir, o builder
  aceita toda a chain fluente e resolve via `thenable` ou terminais
  (`.single()` / `.maybeSingle()`). Transparente, sem simulação de DB.

- **`src/lib/reliability.test.ts`** (novo, 12 testes):
  - `recordReliabilityEvent` happy path + dedupe 23505 (unique parcial
    em `appointment_id`) + propagação de erro não-23505 como `db_error`.
  - `evaluateAndMaybeAutoPause` não pausa abaixo do hard block, pausa
    quando atinge, é noop se médica já pausada.
  - `pauseDoctor` persiste metadados corretos + é idempotente (não
    sobrescreve pause manual com metadados de auto-pause).
  - `unpauseDoctor` limpa campos + é idempotente.
  - Constantes `RELIABILITY_*` batem com o doc (soft=2, hard=3, 30d).

- **`src/lib/refunds.test.ts`** (novo, 10 testes):
  - `isAsaasRefundsEnabled` é literal-`"true"`-only (case-sensitive,
    `"1"`/`"TRUE"`/vazio não habilitam — proteção contra flag vazando
    pra on sem intenção).
  - `markRefundProcessed` marca corretamente + é idempotente (retorna
    `alreadyProcessed=true` sem re-update) + falha cedo com
    `refund_not_required` quando flag é false + normaliza `externalRef`
    e `notes` (trim + vazio → null).
  - Verifica que o UPDATE tem a segunda trava `.is('refund_processed_at',
    null)` pra proteger race condition.

- **`src/lib/reconciliation.test.ts`** (novo, 7 testes):
  - `KIND_LABELS` cobre exaustivamente `DiscrepancyKind` (teste quebra
    se alguém adicionar um kind novo sem label).
  - Confere que são exatamente 4 críticos + 2 warnings por design D-037.
  - `runReconciliation` devolve report vazio coerente com DB limpo.
  - `runReconciliation` é tolerante a erro em check individual (não
    propaga exceção).
  - `getReconciliationCounts` devolve só os dois contadores, sem vazar
    detalhes (proteção de contrato pro dashboard).

**Números:**

- 29 testes, 3 arquivos, ~500ms de runtime.
- `npm test` → todos verdes.
- `tsc --noEmit` → limpo.
- `npm run build` → limpo.

**Fora do escopo (próximo passo D-039):** E2E com Playwright em
staging; cobertura de `no-show-policy.ts` / `appointment-lifecycle.ts`
/ `slot-reservation.ts` (os três mais complexos, ficaram pra segunda
leva por envolverem fluxos multi-tabela mais elaborados).

---

## 2026-04-20 · Conciliação financeira read-only (D-037) · IA

**Por quê:** payments/earnings/payouts têm ciclos de vida
independentes com handlers diferentes (webhook Asaas, cron, admin).
Mesmo com idempotência em cada ponto, há modos de falha que deixam
os três dessincronizados (earning que não foi criada, clawback que
falhou silencioso, payout pago mas earnings ainda `in_payout`, drift
de valores após edição manual). Antes de D-037 a única forma de
descobrir era a médica reclamar ou o admin desconfiar do saldo.

**Entregáveis:**

- **`src/lib/reconciliation.ts`** (novo): função `runReconciliation()`
  que roda 6 checks em paralelo, agrega tudo em um `ReconciliationReport`
  com discrepâncias tipadas (kind, severity, detalhes, hint de ação).
  Também exporta `getReconciliationCounts()` pra chamadas leves no
  dashboard global. Hard limit de 100 itens por check com flag
  `truncated` na UI.

- **Checks críticos:**
  - `consultation_without_earning` — appointment completed há >1h
    sem earning type='consultation'
  - `no_show_doctor_without_clawback` — no-show com policy aplicada
    + payment_id, sem earning type='refund_clawback'
  - `payout_paid_earnings_not_paid` — payout paid/confirmed com
    earnings em status != 'paid'
  - `payout_amount_drift` — soma earnings.amount_cents != payout.amount_cents
    (ou contagem em drift)

- **Checks warning:**
  - `earning_available_stale` — earning `available` há >45d sem payout
  - `refund_required_stale` — refund_required=true há >7d sem processar

- **`/admin/financeiro/page.tsx`** (novo): dashboard de conciliação
  que chama `runReconciliation()` no request. 4 cards de resumo
  (críticas, warnings, checks rodados, rodado em). Seções separadas
  por severidade e agrupadas por kind. Cada item mostra detalhes
  estruturados (com formatação inteligente pra valores em reais e
  timestamps) + hint de ação. Estado "nada pra reconciliar" quando
  tudo bate.

- **Dashboard global (`/admin`)**: 2 alertas novos em "Próximos
  passos" (N críticas → link vermelho; N warnings → link neutro).
  Condição "Tudo em dia" incorpora os dois contadores. Chama a
  mesma lib pra garantir consistência.

**Operação:**

- Zero mutations. Toda correção é manual via SQL (hint dá a sugestão).
  Razão: auto-fix em finanças é risco assimétrico.
- Sem cron automático nesta versão. Admin roda on-demand — recomendação
  toda sexta antes de fechar o mês.
- 6 queries rápidas por request; todas passam por índices existentes.

**Pendente (Sprint 5+):**

- Alerta automático (WhatsApp/email) quando `totalCritical > 0`.
- Ações "1 clique" pros casos triviais (ex: propagar paid_at nas
  earnings do payout confirmado).
- Conciliação bancária (extrato PIX vs payouts pagos) — precisa
  Open Finance ou parser OFX.
- Export CSV do relatório pra contador.

---

## 2026-04-20 · Regras de confiabilidade da médica (D-036) · IA

**Por quê:** até agora `doctors.reliability_incidents` era só um
contador informativo — crescia ao longo do tempo, sem janela temporal,
sem ação automática, sem forma de dispensar casos comprovadamente
não-culpa da médica. Resultado: uma médica com histórico ruim podia
continuar recebendo reservas indefinidamente, e admin tinha que
vigiar manualmente. D-036 institui regra automática com eventos
granulares, soft warn (2 em 30d) e auto-pause (3 em 30d).

**Entregáveis:**

- **Migration 015** (`20260420230000_doctor_reliability_events.sql`):
  tabela `doctor_reliability_events` (id, doctor_id, appointment_id,
  kind, occurred_at, notes, dismissed_at/by/reason) com unique parcial
  em `appointment_id` pra idempotência + colunas de pause em
  `doctors` (reliability_paused_at/by/reason/auto/until_reviewed).

- **`src/lib/reliability.ts`** (novo): `recordReliabilityEvent`,
  `getDoctorReliabilitySnapshot`, `evaluateAndMaybeAutoPause`,
  `pauseDoctor`, `unpauseDoctor`, `dismissEvent`, `listRecentEvents`,
  `listDoctorReliabilityOverview`. Constantes de política
  (`RELIABILITY_WINDOW_DAYS=30`, `SOFT_WARN=2`, `HARD_BLOCK=3`)
  exportadas pro UI poder explicar regras ao admin.

- **Integração com `applyNoShowPolicy` (D-032):** após o bump do
  contador antigo, registra evento granular + roda avaliação. Se
  atingir threshold e não estiver pausada, pausa automaticamente. O
  contador antigo continua sendo atualizado pra não quebrar métricas
  existentes. Resultado volta em `NoShowResult.doctorAutoPaused` +
  `activeReliabilityEvents`.

- **Barreira no agendamento (D-027):**
  - `src/lib/scheduling.ts` `getPrimaryDoctor()` filtra
    `reliability_paused_at IS NULL`.
  - `src/app/api/agendar/reserve/route.ts` rejeita reserva com
    `doctor_reliability_paused` 409 se a médica estiver pausada.
  - Appointments já marcados ANTES do pause seguem seu curso normal
    — decisão deliberada, explicada no ADR D-036.

- **API routes (`requireAdmin`):**
  - `POST /api/admin/doctors/[id]/reliability/pause` — pause manual
    com motivo obrigatório (≥4 chars).
  - `POST /api/admin/doctors/[id]/reliability/unpause` — reativa
    médica; notas opcionais.
  - `POST /api/admin/reliability/events/[id]/dismiss` — dispensa
    evento individual com motivo obrigatório.

- **UI `/admin/reliability`:** página server component com 4 cards de
  resumo (Pausadas, Em alerta, OK, Eventos ativos), tabela
  "Pausadas" (botão Reativar), tabela "Em alerta" (botão Pausar),
  feed "Eventos recentes" (últimos 50, botão Dispensar pra ativos).
  Client component `_Actions.tsx` usa `window.prompt()` pras ações —
  volume baixo (~1-2/mês), UX simples, direto ao ponto.

- **AdminNav:** item "Confiabilidade" entre "Médicas" e "Repasses".

- **Dashboard `/admin`:** dois novos alertas em "Próximos passos"
  (`N médicas pausadas`, `N em alerta`) e condição "Tudo em dia"
  incorpora os contadores.

**Operação:**

- Auto-pause dispara em cascata com D-035: webhook bloqueado em
  produção (D-029) → cron polling detecta meeting ended → dispara
  applyNoShowPolicy → registra evento granular → avalia threshold →
  pausa médica se ≥3 eventos ativos em 30d. Admin é notificado via
  dashboard na próxima visita.

- Eventos dispensados NÃO contam pro threshold, mas ficam no
  histórico com `dismissed_at/by/reason` pra auditoria. Admin pode
  dispensar eventos sem reativar a médica (ou vice-versa) — decisões
  são independentes, respeitando caso-a-caso.

- Pause manual e auto-pause são distinguíveis via coluna
  `reliability_paused_auto` — UI mostra badge diferente, o que ajuda
  admin a priorizar quem conversar primeiro.

**Pendente (Sprint 5+):**

- Notificação WhatsApp pra médica quando for pausada (precisa
  template novo + aprovação Meta).
- Métrica "% de eventos dispensados por admin" como sinal de
  calibração do threshold.
- Thresholds configuráveis por médica (senior vs iniciante) — campo
  `reliability_threshold_override` em `doctors` + lógica em
  `evaluateAndMaybeAutoPause`. Estrutura preparada, não ativada.

---

## 2026-04-20 · Cron de reconciliação Daily (D-035) · IA

**Por quê:** D-029 bloqueou o webhook Daily em produção (bug no cliente
`superagent` deles contra hosts Vercel). Sem webhook,
`meeting.ended` nunca chega, appointments ficam travados, política de
no-show D-032 nunca dispara, `reliability_incidents` fica zerado,
UI D-033/D-034 nunca recebem casos reais, E2E validation fica inviável.
Em vez de esperar Daily consertar ou migrar DNS, implementamos fallback
via polling da REST API do próprio Daily — destrava tudo sem depender
de terceiros.

**Entregáveis:**

- **Migration 014** (`20260420220000_appointment_reconciliation.sql`):
  `appointments.reconciled_at` + `appointments.reconciled_by_source`
  (`daily_webhook` | `daily_cron` | `admin_manual`) + índice parcial
  pra dashboards.

- **`src/lib/video.ts`**: novo método `listMeetingsForRoom()` no
  `VideoProvider` batendo em Daily `GET /meetings?room=…`. Normaliza
  resposta em `MeetingSummary[]` com participantes e duração individual.

- **`src/lib/reconcile.ts`** (novo): `reconcileAppointmentFromMeetings()`
  é a função central consumida por webhook E cron. Decide status final
  (completed, no_show_patient, no_show_doctor, cancelled_by_admin expired)
  a partir da lista de meetings, atualiza appointment (status, ended_at,
  duration_seconds, started_at, reconciled_at, reconciled_by_source),
  chama `applyNoShowPolicy()` quando aplicável. Idempotente em 2 níveis:
  colunas de audit trail + guard existente de `no_show_policy_applied_at`.

- **Webhook Daily refatorado** (`src/app/api/daily/webhook/route.ts`):
  `meeting.ended` agora delega a `reconcileAppointmentFromMeetings({source:
  'daily_webhook'})` via `buildMeetingSummaryFromWebhookEvents()` que
  reconstrói `MeetingSummary` a partir de `daily_events.participant.joined`
  já persistidos. ~80 linhas de lógica duplicada removidas.

- **Novo cron** (`src/app/api/internal/cron/daily-reconcile/route.ts`):
  agendado `*/5 * * * *`. Janela `scheduled_at + consultation_minutes`
  entre `now() - 2h` e `now() - 5min`, não-terminais, com
  `video_room_name IS NOT NULL` e `reconciled_at IS NULL`. Pra cada
  candidato, chama Daily REST + reconciler com `source='daily_cron'`.
  Autenticado por `CRON_SECRET`. Report estruturado por action.

- **`vercel.json`**: cron + `maxDuration: 60`.

- **Dashboard admin**: novo card "Reconciliação Daily · últimas 24h"
  com breakdown por source + alerta `reconcileStuck` na seção
  "Próximos passos" quando houver appointments > 2h sem fechamento.

**Operação:**

- **Coexistência**: cron e webhook rodam em paralelo por design. Webhook
  ganha em tempo real; cron é safety net com ~5 min de latência.
  `reconciled_by_source` marca qual caminho fechou cada appointment —
  observabilidade pura.
- **Quando D-029 voltar**: nada muda. Dashboard vai mostrar
  `daily_webhook` subindo e `daily_cron` caindo naturalmente.
- **Sem env nova pra configurar**: reaproveita `DAILY_API_KEY` e
  `DAILY_DOMAIN` já existentes.

**Smoke tests:**

```bash
# 1. Sem CRON_SECRET → 401 (esperado)
curl -i https://instituto-nova-medida.vercel.app/api/internal/cron/daily-reconcile

# 2. Com secret → JSON report
curl -H "x-cron-secret: $CRON_SECRET" \
  https://instituto-nova-medida.vercel.app/api/internal/cron/daily-reconcile

# 3. Forçar janela maior (manual):
curl -H "x-cron-secret: $CRON_SECRET" \
  "https://instituto-nova-medida.vercel.app/api/internal/cron/daily-reconcile?limit=100"
```

Response em ambiente sem appointments na janela:
`{ ok: true, processed: 0, by_action: {...todas_em_zero}, errors: 0, empty_meetings: 0 }`.

**Limites conhecidos:**

- Janela do cron assume `consultation_minutes` máximo de 60 min. Se
  médica configurar consulta de 90 min, estender a janela no código.
- Sem retry dentro da mesma execução em caso de erro transiente do
  Daily; como próximo tick vem em 5 min e `reconciled_at IS NULL` é
  o filtro, a reconciliação retenta naturalmente.

---

## 2026-04-20 · Estorno automático via Asaas API (D-034) · IA

**Por quê:** A UI D-033 deixou o flow de estorno funcional mas manual
demais: admin abre o painel Asaas, emite o refund lá, volta, cola o id
no nosso form. Caro em atenção e com janela de erro (esquecer de
marcar do nosso lado). Esta entrega automatiza o estorno via Asaas
API, gated por feature flag, com fallback manual inline em erro.

**Entregáveis:**

- **Integração Asaas refund** (`src/lib/asaas.ts`): novo helper
  `refundPayment({ asaasPaymentId, amountCents?, description? })`
  batendo em `POST /payments/{id}/refund`. Tipo `AsaasRefundResponse`.
  Full refund é default (omitindo `value`).

- **Core refund** (`src/lib/refunds.ts`):
  - `isAsaasRefundsEnabled()` — feature flag via
    `REFUNDS_VIA_ASAAS === "true"`, default OFF.
  - `processRefundViaAsaas({ appointmentId, processedBy })` real —
    carrega appointment + payment, valida (`refund_required=true`, não
    já processado, `asaas_payment_id` presente), chama Asaas, só marca
    `refund_processed_at` após sucesso. Retorna `RefundResult` rico com
    códigos de erro estruturados (`asaas_api_error`, `asaas_disabled`,
    `asaas_payment_missing`, `appointment_no_payment`).
  - `RefundResult` agora inclui `asaasStatus` e `asaasCode` pra UI
    expor detalhes da falha.

- **API endpoint atualizado** (`POST /api/admin/appointments/[id]/refund`):
  aceita `method?: 'manual' | 'asaas_api'` no body. Resolve default
  inteligente pelo estado da flag. `asaas_api` explícito com flag OFF
  vira HTTP 400. Erros da Asaas viram HTTP 502 estruturados.

- **UI /admin/refunds atualizada**: quando flag está ligada, botão
  primário verde "Estornar no Asaas" + link sutil pra abrir fallback
  manual. Em erro do Asaas, form manual é **auto-expandido e
  pré-preenchido** com o motivo da falha. Card "Método ativo" no topo
  mostra "Asaas API" ou "Manual" conforme o flag.

- **Dedupe no webhook Asaas** (`src/app/api/asaas/webhook/route.ts`):
  em `PAYMENT_REFUNDED`, se o appointment tem `refund_required=true` e
  `refund_processed_at IS NULL`, marca via `markRefundProcessed()` com
  `processedBy=null`. Fecha o loop nos 3 casos: refund via nossa UI
  (noop pois já marcado), refund direto no painel Asaas, chargeback da
  bandeira.

**Operação:**

- Em **produção**: `REFUNDS_VIA_ASAAS=false` (OFF — comportamento D-033
  preservado). UI mostra só o form manual.
- Em **dev/sandbox**: setar `REFUNDS_VIA_ASAAS=true` no `.env.local`
  pra testar o fluxo automático contra o Asaas sandbox.
- Flip pra produção: basta setar `REFUNDS_VIA_ASAAS=true` no Vercel +
  redeploy trivial. Nenhuma migration necessária (schema D-033 já
  suporta `method='asaas_api'`).

**Smoke tests:**

```bash
# 1. Sem admin session → 307 (comportamento esperado)
curl -I -X POST https://instituto-nova-medida.vercel.app/api/admin/appointments/00000000-0000-0000-0000-000000000000/refund

# 2. Com admin session em sandbox, flag ON, method=asaas_api:
#    resposta 200 com { method: "asaas_api", already_processed: false }
#    + appointment aparece em /admin/refunds na aba histórico.

# 3. Com flag OFF + method=asaas_api explícito:
#    resposta 400 { code: "asaas_disabled", error: "..." }

# 4. Com flag ON mas payment sem asaas_payment_id:
#    resposta 409 { code: "asaas_payment_missing", error: "..." }
#    UI auto-abre fallback manual.
```

**Limites conhecidos:**

- **Full refund only**: `value` não exposto na UI nem no endpoint.
  Casos de refund parcial permanecem negociação manual fora do sistema.
- **Sem retry automático em erro transiente**: admin decide refazer ou
  cair pro manual.
- **Sem métrica formalizada** de "% estornos automáticos". Coluna
  `refund_processed_method` permite query ad-hoc quando tiver volume.

---

## 2026-04-20 · UI admin · notifications + refunds (D-033) · IA

**Por quê:** D-031 (fila WhatsApp) e D-032 (política no-show) entregaram
infra viva em produção que setava flags sem nenhuma forma do operador
enxergar/agir. O worker de notificações roda a cada 1 min e, sem UI, a
única forma de descobrir `failed` ou `pending` travado era SQL manual. A
flag `appointments.refund_required=true` (criada pela política de no-show)
ficava dormindo até alguém lembrar de abrir o painel Asaas. Esta entrega
fecha a lacuna operacional.

**Entregáveis:**

- **Migration 013** (`20260420210000_admin_refund_metadata.sql`) — 4
  colunas novas em `appointments`:
  - `refund_external_ref` — id do refund Asaas (ou txid PIX) pra
    auditoria. Serve igual pra registro manual e pra automação futura
    (Sprint 5) — zero re-modelagem quando ligarmos a Asaas API.
  - `refund_processed_by` (FK `auth.users`) — quem acionou.
  - `refund_processed_notes` — observações humanas.
  - `refund_processed_method` check constraint (`'manual' | 'asaas_api'`)
    — distingue fluxo humano de automação, permite métrica "quanto
    ainda é manual?".
  - Índice parcial `ix_appt_refund_processed` acelera histórico.

- **`src/lib/refunds.ts`** — única porta de entrada pra marcar refund
  processado. `markRefundProcessed()` valida pré-condições
  (`refund_required=true`, não processado antes), é idempotente com
  guard na coluna + segunda trava `.is('refund_processed_at', null)`
  no UPDATE (anti-race). `processRefundViaAsaas()` fica como stub
  explícito — Sprint 5 troca o corpo sem mexer em chamadores.

- **2 API routes admin:**
  - `POST /api/admin/notifications/[id]/retry` — reseta notif `failed`
    ou `pending` pra `pending + scheduled_for=now()`, deixa o cron
    existente dispatching. Não dispara síncrono (evita duplicar lógica
    de dispatch e respeitar rate-limit global). Idempotente.
  - `POST /api/admin/appointments/[id]/refund` — marca via lib
    `refunds.ts` com `method='manual'`. Gancho pra `method='asaas_api'`
    na Sprint 5.

- **2 páginas no admin:**
  - `/admin/notifications` — contadores por status, filtros via query
    string (server-rendered), tabela paginada 50/página, botão Retry
    em linhas `failed`/`pending`. Ordenação favorece `failed` no topo.
  - `/admin/refunds` — seção "Pendentes" com card por appointment
    (formulário inline: external_ref + notes + botão) + seção
    "Histórico" dos últimos 50 processados (badge manual/asaas_api).
    Explica o fluxo Asaas passo-a-passo dentro do card.

- **Dashboard admin (`/admin`)** ganhou 2 alertas novos:
  - "X estornos pendentes" (terracotta) → link pra `/admin/refunds`.
  - "Y notificações com falha" → link pra `/admin/notifications?status=failed`.
  Mensagem "Tudo em dia" só aparece quando os 4 contadores (repasses
  draft, estornos pendentes, notifs failed) estiverem zerados.

- **AdminNav** ganhou 2 entradas (6 no total).

**Gotchas / decisões operacionais:**

- Retry de notificação NÃO dispara o envio síncrono. Ele só muda o
  status pra `pending` e o `scheduled_for` pra agora — o cron de 1 min
  pega no próximo tick. Mais previsível, evita race, respeita o
  rate-limit global do worker.
- `/admin/refunds` só oferece modo manual na UI. A lib já tem o gancho
  `method='asaas_api'` pronto mas desligado — não cria falso senso de
  automação.
- Histórico de refunds é view-only. Uma vez processado, não tem como
  "reabrir" pela UI. Se precisar corrigir (ex: operador digitou
  external_ref errado), é SQL manual documentado em ADR.
- Observabilidade pura; nenhum fluxo crítico novo. Se a página quebrar,
  a fila e a política de no-show continuam funcionando igual.

**Smoke test em produção (próximo):**

Depois do deploy, rodar:
1. Aplicar migration 013 via `supabase db push --include-all`.
2. GET `/admin/notifications` autenticado → 200 com a fila visível.
3. GET `/admin/refunds` → 200 (esperado: 0 pendentes até termos volume).
4. GET `/admin` → ver os 2 alertas novos (ou "Tudo em dia").
5. SQL spot-check: `select count(*) from appointments where
   refund_processed_method is not null` = 0 pré-migration, schema
   válido pós-migration.

---

## 2026-04-20 · Política financeira de no-show (D-032) · IA

**Por quê:** Fechar o ciclo clínico-financeiro da Sprint 4.1. O webhook
do Daily já detectava `no_show_patient`/`no_show_doctor` e marcava o
status do appointment, mas não decidia o que fazer com a earning da
médica e o refund pro paciente. Agora decide, de forma idempotente e
auditável.

**Política aplicada (D-032):**

- `no_show_patient` (paciente faltou, médica esperou):
  médica mantém earning integral, sem refund, paciente é avisado via
  WhatsApp e pode escalar ao admin. Zero overhead financeiro.
- `no_show_doctor` (médica faltou, paciente esperou):
  clawback automático da earning (idempotente, usa `createClawback()`
  existente), flag `refund_required=true` no appointment pro admin
  processar refund no Asaas, incrementa
  `doctors.reliability_incidents`, notifica paciente.
- `cancelled_by_admin` + `cancelled_reason='expired_no_one_joined'`
  (ninguém entrou): tratado como `no_show_doctor` — risco é da
  plataforma, não do paciente.

**Entregáveis:**

- **Migration 012** (`20260420200000_no_show_policy.sql`):
  - `appointments`: `no_show_policy_applied_at` (guard idempotência),
    `refund_required` + `refund_processed_at` (pra admin), `no_show_notes`.
  - `doctors`: `reliability_incidents` + `last_reliability_incident_at`.
  - Índice parcial `ix_appt_refund_required` pra acelerar listagem
    admin de refunds pendentes.
  - Índice `ix_appt_no_show_applied` pra métricas de histórico.

- **`src/lib/no-show-policy.ts`**:
  - `classifyFinalStatus(status, reason)` → `NoShowFinalStatus | null`.
    Normaliza `cancelled_by_admin+expired_no_one_joined` pra o ramo
    "expired" (mesmo tratamento de `no_show_doctor`).
  - `applyNoShowPolicy({appointmentId, finalStatus, source})`:
    carrega appt, respeita guard, aplica política financeira (reuso
    `createClawback()`), marca flags, bump reliability, enfileira
    notificação via `enqueueImmediate`. Retorna `NoShowResult`
    estruturado (action, clawbackCount, reliabilityIncidentsTotal,
    refundRequired) pra logs/testes/admin UI futura.
  - Tolerante a falhas parciais: clawback falhou mas guard marca
    assim mesmo (evita retry duplicar notificação), log de error.

- **`src/lib/wa-templates.ts`** — 2 novos kinds:
  - `no_show_patient` → `sendNoShowPatient()` (stub até Meta aprovar
    template `no_show_patient_aviso`).
  - `no_show_doctor` → `sendNoShowDoctor()` (stub até Meta aprovar
    template `no_show_doctor_desculpas`).
  - Ambos retornam `templates_not_approved` → worker mantém em
    `pending` pra re-tentar quando os templates entrarem no ar.
  - `NotificationKind` estendido, `KIND_TO_TEMPLATE` mapeado.

- **`src/lib/notifications.ts`** — dispatch dos 2 kinds novos
  no switch do worker.

- **Integração** em ambos handlers Daily:
  - `src/app/api/daily/webhook/route.ts`: após `update appointments`
    pro status final, chama `applyNoShowPolicy` quando aplicável.
  - `src/pages/api/daily-webhook.ts` (fallback D-029): idem, além de
    passar a gravar `cancelled_at` + `cancelled_reason` quando o ramo
    "ninguém entrou" dispara (antes ia só status).

**Gotchas / decisões operacionais:**

- Refund NÃO é automático ainda. Sprint 5 leva isso: endpoint admin
  que chama Asaas API + preenche `refund_processed_at`. Motivo:
  integração idempotente cross-system (Asaas ↔ appointment ↔ dedupe
  evento) merece escopo próprio.
- Reliability incidents só contabilizam agora — regras de corte
  (ex: "bloquear agenda se > N no mês") ficam pra quando tivermos
  histórico. Coluna reset-able pelo admin.
- O template `no_show_patient_aviso` exige revisão jurídica antes de
  submeter à Meta — redação do "você perdeu sua consulta" precisa ser
  cuidadosa pra não gerar reclamação ANS/Procon. Por isso stub.

**Bloqueio herdado:** ativação real depende do Daily webhook registrar,
ainda bloqueado por D-029 (HTTP/2 + superagent). A lógica da política
roda hoje se alguém atualizar o status do appointment manualmente (via
admin), então não está ociosa — só não dispara no happy path até D-029
destravar.

---

## 2026-04-20 · WhatsApp · fila persistente + 7 helpers + worker (D-031) · IA

**Por quê:** Sprint 4.1 precisa de 5 mensagens automáticas pra paciente
(confirmação + 4 lembretes temporais) e 2 pra médica. Implementado com
fila persistente em `appointment_notifications` + worker HTTP chamado
pelo Vercel Cron.

**Entregáveis:**

- **Migration 011** (`20260420100000_appointment_notifications_scheduler.sql`):
  - Índice unique parcial `ux_an_appt_kind_alive` — idempotência
    (1 notif viva por appointment+kind).
  - Índice `idx_an_due` — acelera o varredor.
  - Função `schedule_appointment_notifications(appt)` — enfileira
    os 4 lembretes temporais (T-24h/T-1h/T-15min/T+10min),
    calcula `scheduled_for` a partir de `appointments.scheduled_at`,
    pula kinds cujo horário já passou, retorna 1 linha por kind.
  - Função `enqueue_appointment_notification(appt, kind, template,
    scheduled_for, payload)` — insere 1 linha isolada.

- **`src/lib/wa-templates.ts`** — 9 wrappers tipados (7 templates
  externos + 2 operacionais equipe):
  - `sendConfirmacaoAgendamento`, `sendLembrete24h`, `sendLembrete1h`,
    `sendLinkSala`, `sendVezChegouOnDemand`, `sendPosConsultaResumo`,
    `sendPagamentoPixPendente`.
  - `sendMedicaRepassePago`, `sendMedicaDocumentoPendente`.
  - Formatadores pt_BR consistentes (`formatConsultaDateTime`,
    `formatRelativeTomorrow`, `formatTime`, `firstName`).
  - Flag `WHATSAPP_TEMPLATES_APPROVED` (default false) → dry-run
    enquanto Meta não aprova templates; worker trata como "retry".
  - Flag `WHATSAPP_TEMPLATE_VERSION` pronta pra rotação pós-rejeição.
  - Mapa `KIND_TO_TEMPLATE` pro worker.

- **`src/lib/notifications.ts`** — enqueue + worker:
  - `scheduleRemindersForAppointment(appt)` → wrapper RPC.
  - `enqueueImmediate(appt, kind, opts)` → wrapper RPC.
  - `processDuePending(limit=20)`:
    * SELECT pending + scheduled_for <= now(), hidratado com
      customer.phone e doctor.display_name.
    * Despacha via switch(kind) pros helpers.
    * Update `sent`/`failed`/mantém `pending` (retry seletivo).
  - URL pública da consulta montada via `NEXT_PUBLIC_BASE_URL` +
    `/consulta/[id]`.

- **`/api/internal/cron/wa-reminders`** (GET + POST):
  - Auth via `Bearer CRON_SECRET` ou `x-cron-secret` (mesmo padrão
    do expire-reservations). Dev sem CRON_SECRET aceita qualquer
    caller.
  - Query param `?limit=N` (cap 200) pra drenar backlog manual.
  - Chama `processDuePending(limit)` e retorna report
    `{ processed, sent, failed, retried, details: [...], ran_at }`.

- **`vercel.json`**:
  - Novo cron `* * * * *` apontando pro wa-reminders.
  - `functions.maxDuration=60s` pra caber 20 disparos + rede.

**Integrações:**

- Webhook Asaas (PAYMENT_RECEIVED): após ativar appointment + criar
  sala Daily + gerar earning, chama `enqueueImmediate('confirmacao')`
  + `scheduleRemindersForAppointment`. Idempotente — webhook duplo
  não duplica notifs.
- Cron expire-reservations (D-030): após liberar cada slot
  abandonado, chama `enqueueImmediate('reserva_expirada')`. Template
  temporariamente reusa `pagamento_pix_pendente` — dedicado
  planejado pra Sprint 5.

**Fluxo completo ponta-a-ponta:**

```
paciente paga no checkout
  → Asaas envia PAYMENT_RECEIVED
    → webhook ativa appt + cria earning + enfileira 5 notifs (1 imediata + 4 agendadas)
  → cron wa-reminders (a cada 1 min) processa as vencidas
    → se templates aprovados (WHATSAPP_TEMPLATES_APPROVED=true): dispara via Meta
    → se não: marca retried, tenta de novo no próximo minuto
  → paciente recebe confirmação em ~1 min
    → depois recebe lembretes em T-24h, T-1h, T-15min (com link da sala)
    → T+10min: pós-consulta com link da receita (quando conectar Memed)
```

**Validação:**

- Build local: ✅ rotas `/api/internal/cron/expire-reservations` e
  `/api/internal/cron/wa-reminders` aparecem no output.
- Migration aplicada via `supabase db push`: ✅.
- RPC `schedule_appointment_notifications` direto via REST do
  Supabase: ✅.

**Gotcha corrigido durante a impl:** JSDoc com `*/1 min` quebra o SWC
(trata como fim de comentário). Substituído por "a cada 1 min".

**Docs atualizados:**

- `docs/DECISIONS.md` → D-031 com contexto, arquitetura da fila,
  flag strategy, roadmap (template dedicado, UI admin, métricas,
  redundância pg_cron).
- `docs/SPRINTS.md` → checkbox "Lib `src/lib/whatsapp.ts` extendida"
  marcado + nota da flag de ativação.
- `docs/SECRETS.md` → `WHATSAPP_TEMPLATES_APPROVED` e
  `WHATSAPP_TEMPLATE_VERSION` no template.
- `README.md` → árvore de arquivos com `wa-templates.ts`,
  `notifications.ts`, cron wa-reminders.

---

## 2026-04-20 · Cron de expiração de `pending_payment` · IA

**Por quê:** último loose end do fluxo de reserva atomic (D-027). Sem
sweep global, reservas abandonadas ficavam órfãs — bloqueando a agenda
da médica sem gerar receita. Decisão documentada em D-030.

**Entregáveis:**

- **Migration 010** (`20260420000000_expire_pending_payment.sql`):
  - Função `public.expire_abandoned_reservations()` — SECURITY
    DEFINER, retorna uma linha por slot liberado (pra caller tomar
    side-effects depois), idempotente.
  - Index parcial `ix_appointments_pending_expiry` pra acelerar o
    sweep quando a tabela crescer.
  - DO block condicional que agenda job `pg_cron` chamado
    `inm_expire_abandoned_reservations` a cada 1 minuto SE a extensão
    estiver habilitada no projeto. No Instituto o Supabase já tem
    `pg_cron` — agendado com sucesso. Idempotente (unschedule do
    jobname antes de recriar).
- **API `/api/internal/cron/expire-reservations`** (GET e POST):
  - Autenticação via `Authorization: Bearer ${CRON_SECRET}` (padrão
    Vercel Cron) OU `x-cron-secret: ${CRON_SECRET}` (debug manual).
  - Sem `CRON_SECRET` (dev): aceita qualquer caller, facilita smoke
    test local.
  - Chama `supabase.rpc('expire_abandoned_reservations')`, loga
    quando `expired_count > 0`, retorna JSON estruturado
    (`{ ok, expired_count, expired: [...], ran_at }`).
- **`vercel.json`**:
  - Nova seção `crons` agendando a rota a cada 1 minuto.
  - `functions.maxDuration = 30s` pro cron (sweep + side-effects
    futuros).
- **`CRON_SECRET`** gerado (40 chars base64 sem `=+/`) e adicionado
  nas 3 envs do Vercel via REST API.

**Arquitetura do sweep (defense in depth):**

```
           ┌─────────────────────────────────────────┐
           │ pg_cron → expire_abandoned_reservations │  (*/1 min, dentro do Postgres)
           │           (silencioso, sem side-fx)     │
           └─────────────────────────────────────────┘
                              +
           ┌─────────────────────────────────────────┐
           │ Vercel Cron → /api/internal/cron/...    │  (*/1 min, HTTP)
           │           (logável, futuros side-fx:    │
           │            Asaas cancel, WA, métricas)  │
           └─────────────────────────────────────────┘
```

Ambos chamam a MESMA função SQL. Idempotente = safe rodar dois em
paralelo. Segunda chamada na mesma janela volta 0 linhas.

**Validação pós-deploy:**

- `curl` local na RPC: retorna `[]` (nenhum slot expirado no
  momento) — sanidade OK.
- pg_cron agendado confirmado pela notice durante `supabase db push`:
  `[migration 010] pg_cron job agendado: inm_expire_abandoned_reservations (*/1 min)`.

**Docs atualizados:**

- `docs/DECISIONS.md` → D-030 (contexto, decisão, 2-layer redundância,
  side-effects futuros).
- `docs/SECRETS.md` → `CRON_SECRET` entra no inventário.
- `docs/SPRINTS.md` → checkbox "pg_cron jobs + cron expiração" marcado.
- `README.md` → árvore de arquivos + status Sprint 4.1.

---

## 2026-04-20 · Docs: ops Vercel + D-029 nos documentos · IA

Atualização de documentação refletindo o setup ops do dia e o
bloqueio D-029:

- `docs/SECRETS.md`: `.env.local` template ganhou
  `PATIENT_TOKEN_SECRET`, `NEXT_PUBLIC_BASE_URL`, `META_CLIENT_TOKEN`,
  `WHATSAPP_PHONE_DISPLAY`. Nova seção "Estado atual no Vercel"
  (snapshot 21 envs) e "Gotchas" (4 aprendizados: CLI preview, base64
  hmac Daily, timestamp ms, HTTP/2 superagent).
- `docs/ARCHITECTURE.md`: tabela de integrações marca Daily webhook
  como bloqueado (D-029); subseção nova "Webhooks que recebemos"
  explicando os dois handlers (App Router + Pages Router).
- `README.md`: status Sprint 4.1 com ✅ ops e ❌ registro webhook;
  `src/pages/api/daily-webhook.ts` entra na árvore.
- `docs/SPRINTS.md`: nota de bloqueio na Sprint 4.1 e no passo 5 da
  Definição de Pronto.

---

## 2026-04-20 · Configuração Vercel + Daily.co (ops) · IA

**Por quê:** o operador delegou o setup das envs e do registro de
webhooks que eu conseguisse fazer sozinho com as credenciais que ele
já tinha me passado.

**Vercel — 7 envs adicionadas em production + preview + development (21 inserções):**

- `DAILY_API_KEY` — chave do workspace `instituto-nova-medida` (validada
  via `GET https://api.daily.co/v1/`, retorna `domain_id` correto).
- `DAILY_DOMAIN=instituto-nova-medida`.
- `DAILY_WEBHOOK_SECRET` — **32 bytes random em base64**. O
  `POST /v1/webhooks` do Daily exige secret em base64 válido; o valor
  anterior (`whsec_daily_inm_2026_...`) foi rejeitado pela API. Novo
  secret gerado via `base64(os.urandom(32))`.
- `PATIENT_TOKEN_SECRET` — HMAC secret pra tokens de consulta pública.
- `NEXT_PUBLIC_BASE_URL=https://instituto-nova-medida.vercel.app`.
- `META_CLIENT_TOKEN` — token do Meta pra Pixel (faltava no Vercel).
- `WHATSAPP_PHONE_DISPLAY` — número público pro rodapé/links.

Notas operacionais:

- `vercel env add ... production preview development` da CLI só
  insere em `production` e `development` — preview precisou ser
  adicionado via REST API (`POST /v10/projects/{id}/env`).
- CLI interativa rejeita empty stdin; REST API com `upsert=true`
  funciona bem.

**Daily.co — registro do webhook: BLOQUEADO (D-029).**

- API key e domínio OK.
- Endpoint `/api/daily/webhook` e `/api/daily-webhook` respondem 200
  pra qualquer cliente (testado via curl, HTTP/1.1 e HTTP/2).
- `POST https://api.daily.co/v1/webhooks` retorna consistentemente
  `"non-200 status code returned from webhook endpoint, recvd
  undefined"` — reproduzido inclusive com URLs sem conteúdo dinâmico
  (raiz do site, Pages Router, deploy URL direto).
- Confirmado que é **bug do superagent 3.8.3 do Daily com HTTP/2 do
  Vercel**, não problema de envs/código.
- Decisão detalhada + caminhos de contorno em `docs/DECISIONS.md` D-029.

**Novo handler Pages Router `/api/daily-webhook`:**

- `src/pages/api/daily-webhook.ts` — mesmo handler do App Router,
  porém servido sem os headers `Vary: RSC, Next-Router-State-Tree,
  Next-Router-Prefetch` que o App Router adiciona. Tentativa de
  contornar o bug — não resolveu (bug é em nível HTTP, não header).
- Ficou como segunda porta de entrada pra testes manuais e pra
  quando a gente migrar atrás de Cloudflare. Zero custo adicional.
- Adiciona CORS permissivo + suporte a `OPTIONS` preflight.

**Correções colaterais no build:**

- `AdminNav.tsx` e `DoctorNav.tsx`: `usePathname()` pode retornar
  `null` (pre-hydration) — default pra string vazia antes de
  comparar com `href`.

**Asaas webhook — OK (checado):** 1 webhook ativo, 29 eventos
assinados, apontando pra `/api/asaas/webhook`.

**Migrations Supabase — todas aplicadas (checado):** `daily_events`,
`doctor_payouts.pix_proof_url`, bucket `payouts-proofs` — tudo OK.

---

## 2026-04-19 · Sprint 4.1 (3/3 cont.) — Webhook do Daily fecha o ciclo · IA

**Por quê:** sem telemetria de meeting, o painel financeiro não sabe
distinguir "consulta realizada" de "no-show". Decisão: **D-028**.

**Migration aplicada (009 — `20260419080000_daily_events.sql`):**

- Tabela `daily_events` (raw + idempotência), espelho do
  `asaas_events`. Campos: `event_id`, `event_type`, `event_ts`,
  `daily_room_name`, `daily_meeting_id`, `appointment_id` (FK),
  `signature` + `signature_valid`, `payload jsonb`, `processed_at`,
  `processing_error`, `received_at`.
- Índices: unique `(event_id, event_type)` para idempotência,
  por `appointment_id+type` (lookup de no-show), por `room_name`,
  parcial nos não-processados (retry).
- RLS deny-by-default; só service role escreve/lê.

**Lib `src/lib/video.ts` — extensões:**

- `validateWebhook()` agora suporta o **HMAC oficial do Daily**:
  `X-Webhook-Signature` = base64(HMAC-SHA256(secret, "ts.body")),
  janela anti-replay de 5 min. Fallback antigo (`x-daily-webhook-secret`
  com secret bruto) mantido. Modo dev permissivo explícito (sem
  `DAILY_WEBHOOK_SECRET` configurado).
- Tipos públicos novos: `VideoEventType`,
  `NormalizedVideoEvent`.
- `parseDailyEvent(raw)` — normaliza payload em forma agnóstica de
  provider (event_id, type, occurredAt, roomName, meetingId,
  participantName, participantIsOwner, durationSeconds, raw).

**Endpoint novo `POST /api/daily/webhook`:**

1. Valida assinatura (consome body cru).
2. Resolve `appointment_id` por `video_room_name = payload.room`.
3. Persiste raw em `daily_events` (idempotente).
4. Roteia o tipo:
   - `meeting.started`: `started_at`, `daily_meeting_session_id`,
     status `scheduled`/`confirmed` → `in_progress`.
   - `meeting.ended`: `ended_at`, `duration_seconds`. Decide status
     final agregando `participant.joined` por `is_owner`:
       - paciente + médica → `completed`
       - só paciente → `no_show_doctor`
       - só médica → `no_show_patient`
       - ninguém → `cancelled_by_admin` (motivo
         `expired_no_one_joined`).
     Estados terminais existentes não são regredidos.
   - `participant.joined`/`participant.left`: só persistência
     (necessária pro cálculo de no-show acima).
   - `recording.ready`: só persistência (gravação só vira coluna
     quando ligarmos D-023).
5. Sempre **200** quando auth passou (Daily faz retry agressivo em
   5xx). Falhas viram `processing_error` no `daily_events`.

**Configuração no Daily:**

- Painel Daily → Webhooks → URL
  `https://institutonovamedida.com.br/api/daily/webhook` (ou Vercel
  preview).
- Eventos: `meeting.started`, `meeting.ended`, `participant.joined`,
  `participant.left` (mín). Opcional: `recording.ready`.
- O `hmac` que o Daily mostra ao criar o webhook → vai pra env
  `DAILY_WEBHOOK_SECRET`.

**Build:** +1 rota (`/api/daily/webhook`), bundle inalterado
(server-only).

---

## 2026-04-19 · Sprint 4.1 (3/3 cont.) — Fluxo do paciente E2E · IA

**Por quê:** o produto sem fluxo de paciente é só uma tela bonita
de admin. Esta entrega fecha o ciclo: paciente escolhe horário → paga
→ entra na sala. Decisão: **D-027**.

**Migration aplicada (008 — `20260419070000_appointment_booking.sql`):**

- `pending_payment` adicionado ao enum `appointment_status`.
- Coluna `pending_payment_expires_at timestamptz` em `appointments`.
- Índice unique parcial `ux_app_doctor_slot_alive` em
  `(doctor_id, scheduled_at) WHERE status in ('pending_payment',
  'scheduled', 'confirmed', 'in_progress')` — bloqueia race condition
  na reserva.
- Função `book_pending_appointment_slot()` — atomic, com auto-limpeza
  de pending expirado no mesmo slot e tradução de unique_violation
  → `slot_taken`.
- Função `activate_appointment_after_payment()` — idempotente, promove
  pending_payment → scheduled e vincula payment_id.

**Libs novas:**

- `src/lib/scheduling.ts` (DEFAULT_TZ=America/Sao_Paulo):
  - `getPrimaryDoctor()` — primeira médica ativa (MVP).
  - `getDoctorAvailability()` — só `agendada`/`scheduled`.
  - `listAvailableSlots(doctorId, mins, opts)` — janela de N dias,
    minLead, maxPerDay; filtra slots já ocupados (pending vivos +
    scheduled + confirmed + in_progress).
  - `isSlotAvailable()` — anti-tampering server-side.
  - `bookPendingSlot()` / `activateAppointmentAfterPayment()` —
    wrappers das funções SQL.
- `src/lib/patient-tokens.ts`:
  - HMAC-SHA256 truncado a 16 bytes (128 bits).
  - Formato `appointment_id.exp.sig`, timing-safe compare.
  - TTL padrão 14 dias, mín 60s, máx 60 dias.
  - `buildConsultationUrl()` usa `NEXT_PUBLIC_BASE_URL`.

**APIs novas:**

- `POST /api/agendar/reserve` — body com plano + slot + dados do
  paciente. Sequência: validar → upsert customer → garantir customer
  Asaas → insert payment PENDING → reserva slot atomic → vincular
  payment_id no appointment → cobrança Asaas → assinar token →
  retornar `{ invoiceUrl, appointmentId, patientToken, consultaUrl }`.
- `POST /api/paciente/appointments/[id]/join` — autenticado por token
  HMAC (header `x-patient-token`, body, ou query `?t=`). Valida token
  + appointment_id, status, janela de entrada (30 min antes a 30 min
  depois do fim). Provisiona sala Daily on-demand se webhook não
  tiver feito. Retorna URL Daily com token paciente fresco (anti-replay).

**Webhook Asaas — estendido:**

- Ao receber `RECEIVED`/`CONFIRMED`: chama
  `activateAppointmentAfterPayment()`. Se appointment ainda não tem
  sala, chama `provisionConsultationRoom()` (best-effort, loga e
  segue se falhar). Cria earning como antes.
- **Bug fix correlato**: corrigido `customers ( full_name )` →
  `customers ( name )` (mesmo padrão do dashboard da médica).

**UI nova:**

- `/agendar/[plano]` (sem `?slot=`) — slot picker server-side
  agrupado por dia, máximo 6 horários/dia, próximos 7 dias, fuso BRT.
- `/agendar/[plano]?slot=<iso>` — reusa `CheckoutForm` em modo
  reserve (nova prop `slot`); resumo lateral mostra horário escolhido
  e prazo de 15 min.
- `/consulta/[id]?t=<token>` — página pública do paciente:
  status badge, data/hora, contagem regressiva pra abertura da sala
  (30 min antes), botão "Entrar na sala" (chama API e abre URL
  Daily na mesma janela), instruções de preparação.
- `JoinRoomButton` (client) — countdown live de 1s, estados
  closed/before-window/open, mensagens amigáveis.
- `ConsultaLinkBanner` (client) — exibido em
  `/checkout/sucesso` e `/checkout/aguardando` quando o localStorage
  tem `inm_last_consulta_url` (gravado pelo CheckoutForm em modo
  reserve). Banner sage com CTA pra `/consulta/[id]?t=...`.

**CheckoutForm:**

- Nova prop opcional `slot?: { startsAt, doctorName }`. Quando
  presente, faz POST em `/api/agendar/reserve` em vez de
  `/api/checkout`, envia `scheduledAt` e `recordingConsent`, persiste
  `inm_last_consulta_url`/`inm_last_appointment_id`/`inm_last_payment_id`
  no localStorage. Erros amigáveis pra `slot_taken`/`slot_unavailable`.
- Resumo lateral ganha card "Sua consulta" quando em modo reserve.

**Env nova:**

- `PATIENT_TOKEN_SECRET` (32+ chars, base64url 256 bits) — secret
  HMAC do link de consulta. Geramos local; precisa entrar nas 3 envs
  do Vercel (production/preview/development).
- `NEXT_PUBLIC_BASE_URL` — usado por `buildConsultationUrl()` pra
  formar links absolutos no payload da API (e nas mensagens de
  WhatsApp futuras).

**Build:** 4 rotas novas (`/agendar/[plano]`, `/consulta/[id]`,
`/api/agendar/reserve`, `/api/paciente/appointments/[id]/join`) +
componentes client. Bundle do checkout cresceu marginalmente
(reuso, não duplicação).

---

## 2026-04-19 · Sprint 4.1 (3/3 cont.) — Comprovantes PIX em Storage privado · IA

**Por quê:** o passo "Confirmar recebimento" pedia URL externa colada
manualmente — sem auditoria, sem garantia de que o link sobrevive,
sem controle de acesso. Agora o comprovante vira arquivo num bucket
Supabase privado, anexado direto no fluxo. Decisão: **D-026**.

**Migration aplicada (007 — `20260419060000_payout_proofs_bucket.sql`):**

- Cria bucket `payouts-proofs` (private, 10 MB cap, MIMEs PDF/PNG/JPG/WEBP).
- `pix_proof_url` passa a guardar storage path (`payouts/{id}/...`);
  URLs externas continuam aceitas para backfill.
- `receipt_url` marcada como deprecated via `comment on column`.
- Sem policies em `storage.objects` — autorização vive 100% nos
  handlers (ver D-026).

**Lib nova (`src/lib/payout-proofs.ts`):**

- `BUCKET`, `MAX_UPLOAD_BYTES (5 MB)`, `ALLOWED_MIMES`.
- `buildStoragePath()` — `payouts/{id}/{ts}-{slug}.{ext}` determinístico.
- `slugifyFilename()` — normaliza unicode + `[a-z0-9-]`, máx 40 chars.
- `createSignedUrl()` — signed URL curta (60s).
- `removeFromStorage()` — idempotente, 404 não é erro.
- `isStoragePath()` — distingue path interno de URL externa legacy.

**APIs novas:**

- `POST   /api/admin/payouts/[id]/proof` — multipart upload, valida MIME
  + 5 MB lógico, grava no bucket, atualiza `pix_proof_url`, **remove o
  arquivo antigo** se havia outro storage path (não toca em URLs externas).
- `GET    /api/admin/payouts/[id]/proof` — signed URL 60s.
- `DELETE /api/admin/payouts/[id]/proof` — apaga do bucket + zera colunas.
- `GET    /api/medico/payouts/[id]/proof` — signed URL 60s, **bloqueia
  se o payout não é da médica autenticada**.

**UI:**

- `PayoutActions` (admin → confirm): substituído `<input type="url">`
  por `<input type="file" accept="pdf,png,jpg,webp">` + preview de nome+tamanho.
  O upload acontece ANTES do `POST /confirm`, então em caso de falha o
  status do payout não muda (atomicidade prática).
- `ProofPanel` (admin, sidebar dos detalhes): mostra "Arquivo: X" ou
  "URL externa: hostname", com botões `Abrir` (signed URL) e `Remover`.
- `ProofLink` (médica, `/medico/repasses`): substitui `<a href>` direto
  pelo botão que pede signed URL na hora.

**Build:** 2 APIs novas + 2 componentes client. Bundle de
`/admin/payouts/[id]` cresceu de 1.75 → 2.81 kB (ProofPanel client).

---

## 2026-04-19 · Sprint 4.1 (3/3 parcial) — Painel da médica `/medico/*` · IA

**Por quê:** com magic link + papel `doctor` operacional, faltava onde
a médica cair depois de clicar no convite. Esta entrega entrega o
"home da médica": dashboard, agenda com botão de entrar na sala,
extrato de ganhos por mês, histórico de repasses e edição de perfil
limitada (`display_name`, `bio`, `phone`, `consultation_minutes`).

**Login:**

- `/medico/login` espelha `/admin/login` (anti-enumeração + rate limit
  reaproveitados de `/api/auth/magic-link`, que já aceitava `doctor`).
- `/api/auth/callback` agora detecta se o `next` é `/medico/*` e
  redireciona erros para `/medico/login` (em vez de `/admin/login`).
- `/api/auth/signout` aceita `to=` (form field ou query) para
  diferenciar logout de admin vs. médica.

**Rotas (route group `/medico/(shell)/`):**

- `/medico` — dashboard: 4 cards (consultas hoje, próxima consulta,
  a receber, recebido neste mês) + bloco "próxima consulta" com CTA.
- `/medico/agenda` — próxima consulta destacada + lista 30 dias +
  histórico 60 dias. Botão "Entrar na sala" habilitado entre 60 min
  antes do horário e 30 min depois do fim.
- `/medico/ganhos` — extrato com filtro por mês (últimos 6) e 4
  totais por status (pending / available / in_payout / paid).
- `/medico/repasses` — cards de cada `doctor_payout` com timeline
  textual (Em revisão → Aprovado → PIX enviado → Pago), exibe chave
  PIX snapshot, ID PIX e link de comprovante quando existir.
- `/medico/perfil` — formulário client com `display_name`, `phone`,
  `consultation_minutes` (15/20/30/45/60) e `bio` (1500 chars). Painel
  lateral mostra dados read-only (CRM, CNPJ, status) com aviso de
  que mudanças passam pelo operador.

**APIs (require role=doctor):**

- `POST /api/medico/appointments/[id]/join` — provisiona sala Daily
  (idempotente: reusa `video_room_url` se já existe; sempre gera
  meeting-token novo) e devolve `{ url }` pronta para abrir. Devolve
  503 amigável se `DAILY_API_KEY` não está configurada.
- `PATCH /api/medico/profile` — aceita só os 4 campos seguros; valida
  comprimento de `display_name`/`bio` e dígitos do `phone`. Nunca
  aceita `crm_*`, `email`, `cnpj`, `status` (D-024 — esses passam
  pelo operador).

**Build:** 8 rotas adicionadas (6 páginas + 2 APIs). Bundle das pages
do médico ≤ 1.6 kB cada (server-rendered).

---

## 2026-04-19 · Sprint 4.1 (2/3) — Auth + painel admin completo · IA

**Por quê:** Sprint 4.1 (1/3) entregou o schema. Agora a operação
ganha cara: o operador entra no sistema, cadastra médicas, define
regras de remuneração, recebe os payouts gerados pelo cron mensal,
aprova manualmente, executa o PIX e marca como pago. Workflow
financeiro fechado ponta a ponta.

**Decisões registradas (DECISIONS.md):**

- **D-025** — Magic link only (Supabase Auth) para operador e médicas.
  Sem senha. Roles em `app_metadata.role` (`admin` / `doctor`).
  Hard-gate em middleware + `requireAdmin()` / `requireDoctor()`.
  Anti-enumeração no endpoint de login (sempre 200, nunca revela
  existência de e-mail).

**Migration aplicada (006 — `20260419050000_payouts_admin_fields.sql`):**

- `doctor_payouts` ganhou `pix_sent_at`, `confirmed_at`, `pix_proof_url`,
  `pix_transaction_id` (separa "PIX enviado" de "Confirmado pela
  médica" — ambos timestamps importantes pra auditoria).
- `doctor_payment_methods` ganhou `is_default`, `account_holder_name`,
  `account_holder_cpf_or_cnpj` (alinhados com o painel admin).
- `availability_type` enum aceita também `'scheduled'` / `'on_call'`
  além de `'agendada'` / `'plantao'` — tira friction do front em EN.
- `doctor_earnings.description` agora nullable (webhook nem sempre tem
  descrição humana imediata).

**Auth (`src/lib/auth.ts`, `src/lib/supabase-server.ts`, `src/middleware.ts`):**

- `getSupabaseServer()` (Server Components) e `getSupabaseRouteHandler()`
  (Route Handlers que mutam cookies) sobre `@supabase/ssr` 0.10.2.
- `requireAuth()`, `requireAdmin()`, `requireDoctor()` — server-only,
  redirects automáticos.
- Middleware faz refresh de token em toda request + bloqueia rotas
  `/admin/*` e `/medico/*` sem sessão.
- APIs: `/api/auth/magic-link` (POST, anti-enumeração + rate limit
  5 / 15 min por IP), `/api/auth/callback` (GET, troca code por
  cookie de sessão), `/api/auth/signout` (POST, encerra sessão).
- Usuário admin inicial criado: **cabralandre@yahoo.com.br** com
  `app_metadata.role = 'admin'`, `email_confirmed_at` setado.

**Painel admin (`src/app/admin/(shell)/...`):**

- **/admin/login** — magic link form com mensagens de erro contextuais
  e estado "link enviado" pós-submit.
- **/admin** — dashboard com 4 cards (médicas ativas, repasses para
  revisar, receita do mês, saldo a pagar) + alertas dinâmicos.
- **/admin/doctors** — lista com status (invited/active/suspended/etc),
  CRM, contato. CTA "Nova médica".
- **/admin/doctors/new** — formulário com validação client (CRM/UF/CNPJ
  com máscaras), cria usuário Supabase Auth (`role=doctor`) +
  registro `doctors` + regra de compensação default (D-024) +
  dispara magic link de boas-vindas.
- **/admin/doctors/[id]** — 4 abas:
  - Perfil & status (mudança de status registra timestamp);
  - Compensação (regra ativa + form pra criar nova versão com
    justificativa obrigatória; histórico completo abaixo);
  - PIX (tipo + chave + titular + CPF/CNPJ; upsert idempotente);
  - Agenda (slots semanais agendada/plantão; add/remove inline).
- **/admin/payouts** — agrupa por status (draft / approved / pix_sent /
  confirmed / failed / cancelled) com valor total e médica.
- **/admin/payouts/[id]** — detalhe com lista de earnings consolidados,
  histórico de timestamps, dados PIX da médica em painel lateral, e
  ações contextuais por status.

**APIs admin (`src/app/api/admin/...`):**

- `POST /doctors` — cria médica + usuário Auth + regra default + invite.
- `PATCH /doctors/[id]` — atualiza perfil (campos editáveis); muda
  status com timestamp correspondente.
- `POST /doctors/[id]/compensation` — fecha regra atual e cria nova
  com `effective_from = now()`. Justificativa obrigatória.
- `POST /doctors/[id]/payment-method` — upsert do PIX default,
  desativa outros métodos antes de inserir novo.
- `POST/DELETE /doctors/[id]/availability` — adiciona/remove slots.
- `POST /payouts/[id]/(approve|pay|confirm|cancel)` — máquina de
  estados validada via `src/lib/payouts.ts` (`canTransition`).
  - `approve`: draft → approved, registra `approved_by` + timestamp.
  - `pay`: approved → pix_sent, registra timestamp + opcional
    `pix_transaction_id`.
  - `confirm`: pix_sent → confirmed, marca todos earnings vinculados
    como `paid`, opcionalmente anexa URL de comprovante.
  - `cancel`: draft/approved/pix_sent → cancelled, desvincula
    earnings (voltam pra `available` e entram no próximo lote).

**Webhook Asaas estendido (`src/app/api/asaas/webhook/route.ts` +
`src/lib/earnings.ts`):**

- `PAYMENT_RECEIVED` / `PAYMENT_CONFIRMED` / `PAYMENT_RECEIVED_IN_CASH`
  → busca `appointment` vinculado → cria `doctor_earnings` tipo
  `consultation` (e `on_demand_bonus` se `kind='on_demand'`) com
  snapshot da regra de compensação ativa. Dispara
  `recalculate_earnings_availability()` pra preencher `available_at`.
- `PAYMENT_REFUNDED` / `PAYMENT_REFUND_IN_PROGRESS` /
  `PAYMENT_CHARGEBACK_*` → cria earning negativo
  (`refund_clawback`) apontando pro pai via `parent_earning_id`.
  Cancela earning original se ainda `pending`/`available`. Se já
  estava `in_payout`, loga warning para revisão admin.
- Idempotente em ambos: não duplica earning/clawback se já existir
  pro mesmo `payment_id`.

**Quality:**

- Build limpo (`npm run build`): 0 erros TS, 0 warnings ESLint.
- 21 rotas total no app (3 públicas estáticas, 18 dinâmicas).
- Middleware: 80.3 kB (refresh + gate).
- Smoke test local: `/admin` → 307 → `/admin/login?next=/admin`,
  `/admin/login` → 200 com título correto, `/api/auth/magic-link`
  → 200 idempotente.

**Próximos passos (Sprint 4.1 — 3/3):**

- Painel `/medico/*` (similar ao admin: dashboard, agenda, ganhos).
- Storage privado pra comprovantes PIX e NF-e.
- Submeter os 7 templates WhatsApp à Meta (cabe ao operador).
- Adicionar env vars Daily no Vercel (precisa VERCEL_TOKEN).

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
