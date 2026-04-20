# Changelog · Instituto Nova Medida

> Registro cronológico de tudo que foi entregue. A entrada mais recente
> fica no topo. Cada entrada tem data, autor (humano ou IA) e o que
> mudou.

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
