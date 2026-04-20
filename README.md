# Instituto Nova Medida

> **Não é sobre força de vontade — é sobre o método certo.**

Plataforma de telessaúde brasileira para emagrecimento individualizado.
Avaliação médica online, prescrição quando indicada e acompanhamento
contínuo com a mesma médica pelo WhatsApp.

**Em produção (URL temporária):** **https://instituto-nova-medida.vercel.app**

Domínio definitivo: `institutonovamedida.com.br` (a registrar)

---

## Status

**Sprint 1** ✅ — Landing page completa (hero, identification, shift,
access, how-it-works, desire, cost, quiz interativo, captura LGPD, FAQ,
sucesso com share, footer compliant).

**Sprint 2** ✅ — Backend Supabase (`leads`, RLS, migrations versionadas)
+ pipeline WhatsApp Cloud API (lib + tracking + webhook) + disparo
automático de MSG 1 quando lead cai no banco.

**Deploy** ✅ — No ar em **https://instituto-nova-medida.vercel.app**
(Vercel, região `gru1` São Paulo, deploy automático a cada push na
`main`). Aguardando Meta reativar Business Manager pra trocar User AT
por System User Token e destravar disparo WhatsApp em produção. Ver
`D-018` em `docs/DECISIONS.md`.

**Sprint 3** ✅ — Pagamentos Asaas em sandbox (produção destravada
quando o CNPJ próprio sair, sem code change — ver `D-019`/`D-020`).
Schema completo (`plans`, `customers`, `payments`, `subscriptions`,
`asaas_events`), seed dos 3 tiers, lib `src/lib/asaas.ts`, API
`/api/checkout` + webhook `/api/asaas/webhook`, páginas `/planos`,
`/checkout/[plano]`, `/checkout/sucesso` e `/checkout/aguardando`.
Validado E2E na produção. Landing conectada (Header, Hero, Cost e
Success modal apontam para `/planos`); lead capturado pelo quiz é
vinculado à compra via `localStorage`.

**Sprint 4.1** 🟡 — **Em andamento** (1/3, 2/3 e parte de 3/3 concluídas).

- **1/3** ✅ Schema completo (`doctors`, `doctor_availability`,
  `doctor_payment_methods`, `doctor_compensation_rules`, `appointments`,
  `appointment_notifications`, `doctor_earnings`, `doctor_payouts`,
  `doctor_billing_documents`), funções Postgres pra cálculo de
  disponibilidade e geração de payouts mensais, 2 cron jobs ativos
  (`pg_cron`), RLS deny-by-default, view `doctors_public`, lib
  `src/lib/video.ts` (DailyProvider operacional). Decisões: **D-021**
  Daily.co MVP, **D-022** controle financeiro interno, **D-023** não
  gravar por default, **D-024** PJ + valores fixos.
- **2/3** ✅ Auth magic-link (Supabase Auth + `@supabase/ssr`),
  middleware com hard-gate `/admin/*` e `/medico/*`, painel admin
  completo: dashboard, CRUD de médicas (perfil + agenda + compensação
  versionada + PIX), gestão de payouts com workflow draft → approved
  → pix_sent → confirmed → cancelled. Webhook Asaas estendido pra
  gerar `doctor_earnings` em `PAYMENT_RECEIVED` e clawbacks em
  `PAYMENT_REFUNDED`/CHARGEBACK. Decisão: **D-025** magic-link only,
  roles em `app_metadata`. Usuário admin inicial:
  `cabralandre@yahoo.com.br`.
- **3/3 (parcial)** ✅ Painel da médica (`/medico/*`): login próprio,
  dashboard com 4 cards, agenda com botão "Entrar na sala" (cria sala
  Daily idempotente), extrato de ganhos por mês com filtro, histórico
  de repasses read-only e edição de perfil restrita
  (`display_name`, `bio`, `phone`, `consultation_minutes`).
  ✅ Storage privado para comprovantes PIX (bucket `payouts-proofs`,
  upload + signed URL via API mediada — D-026). Migration 007 aplicada.
  ✅ **Fluxo do paciente E2E** (D-027): `/agendar/[plano]` com slot
  picker, reserva atomic (migration 008 + função SQL
  `book_pending_appointment_slot`), checkout em modo reserve
  (`/api/agendar/reserve`), ativação automática do appointment +
  provisionamento da sala Daily ao confirmar pagamento (webhook Asaas),
  link público da consulta `/consulta/[id]?t=<HMAC>` com contagem
  regressiva e botão "Entrar na sala" (`/api/paciente/.../join`).
  ✅ **Webhook do Daily** (D-028): `/api/daily/webhook` com HMAC
  oficial, persistência crua em `daily_events` (migration 009),
  detecção automática de no-show por agregação de
  `participant.joined`, atualização de `started_at`/`ended_at`/
  `duration_seconds`/`status` (`in_progress` → `completed`/
  `no_show_patient`/`no_show_doctor`/`cancelled_by_admin`).
  ✅ **Ops Vercel + Daily** (2026-04-20): 7 envs adicionadas em
  production/preview/development (Daily keys, `PATIENT_TOKEN_SECRET`,
  `NEXT_PUBLIC_BASE_URL`, `META_CLIENT_TOKEN`, `WHATSAPP_PHONE_DISPLAY`),
  `DAILY_WEBHOOK_SECRET` trocado pra base64 válido, handler Pages
  Router `/api/daily-webhook` criado como fallback. **Registro do
  webhook no Daily bloqueado por bug HTTP/2 do superagent — D-029**.
  ✅ **Cron de expiração de `pending_payment`** (D-030): migration
  010 com `expire_abandoned_reservations()` + pg_cron agendado
  `*/1 min` no Supabase; rota `/api/internal/cron/expire-reservations`
  protegida por `CRON_SECRET` agendada no `vercel.json` também
  `*/1 min` (redundância defense-in-depth). Reservas abandonadas
  caem pra `cancelled_by_admin` com `cancelled_reason='pending_payment_expired'`.
  ✅ **WhatsApp: fila persistente + 7 helpers + worker** (D-031):
  migration 011 com `schedule_appointment_notifications()` +
  `enqueue_appointment_notification()` sobre
  `appointment_notifications`; 9 wrappers tipados em
  `src/lib/wa-templates.ts`; worker `/api/internal/cron/wa-reminders`
  processa a fila cada 1 min; webhook Asaas enfileira
  confirmação + 4 lembretes (T-24h/T-1h/T-15min/T+10min) no
  `RECEIVED`; cron de expiração enfileira "reserva expirada".
  Gate `WHATSAPP_TEMPLATES_APPROVED=false` mantém fila em retry
  até Meta aprovar templates.
  ✅ **Política financeira de no-show** (D-032): migration 012 com
  flags `no_show_policy_applied_at`, `refund_required` em
  `appointments` e métrica `reliability_incidents` em `doctors`.
  Lib `src/lib/no-show-policy.ts` aplica tratamento assimétrico —
  `no_show_patient` mantém earning / `no_show_doctor` e sala
  expirada disparam clawback automático (reusa `createClawback()`)
  + flag de refund pendente + bump reliability. Webhooks Daily
  (App e Pages Router) chamam a política após fixar o status
  terminal. Idempotente; templates Meta dedicados ficam pra Sprint 5.

**Restante da Sprint 4.1 (3/3):** submeter os 7 templates na Meta
(1-24h) + templates dedicados de no-show, refund automático no
Asaas (Sprint 5).

Veja [`docs/SPRINTS.md`](./docs/SPRINTS.md) para o roadmap completo.

---

## Documentação completa

Toda a documentação viva do projeto está em [`docs/`](./docs/):

| Documento | O que tem |
|---|---|
| [`docs/PRODUCT.md`](./docs/PRODUCT.md) | Visão, modelo de negócio, personas, jornada |
| [`docs/DECISIONS.md`](./docs/DECISIONS.md) | Registro de decisões (ADRs) |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Stack, schema, integrações |
| [`docs/SPRINTS.md`](./docs/SPRINTS.md) | Cronograma e backlog |
| [`docs/COMPLIANCE.md`](./docs/COMPLIANCE.md) | CFM, Anvisa, LGPD |
| [`docs/PRICING.md`](./docs/PRICING.md) | Tiers, splits, lógica financeira |
| [`docs/BRAND.md`](./docs/BRAND.md) | Paleta, tipografia, voz |
| [`docs/COPY.md`](./docs/COPY.md) | Copy oficial |
| [`docs/SECRETS.md`](./docs/SECRETS.md) | Credenciais necessárias |
| [`docs/COMPENSATION.md`](./docs/COMPENSATION.md) | Modelo financeiro das médicas |
| [`docs/WHATSAPP_TEMPLATES.md`](./docs/WHATSAPP_TEMPLATES.md) | Templates pra submeter na Meta |
| [`docs/CHANGELOG.md`](./docs/CHANGELOG.md) | Histórico cronológico |

---

## Stack

- **Next.js 14** (App Router) + **TypeScript** estrito
- **Tailwind CSS** + design tokens próprios
- **Framer Motion** para microinterações
- **Fraunces** (serif display) + **Inter** (sans corpo)
- Imagens hospedadas localmente em `/public`

## Estrutura

```
instituto-nova-medida/
├── docs/                    # Documentação viva
├── public/                  # Imagens e assets estáticos
├── src/
│   ├── middleware.ts        # auth + refresh de sessão Supabase
│   ├── app/                 # Rotas, layout, API
│   │   ├── layout.tsx
│   │   ├── page.tsx         # Landing
│   │   ├── globals.css
│   │   ├── sitemap.ts
│   │   ├── robots.ts
│   │   ├── icon.svg
│   │   ├── planos/page.tsx           # catálogo de planos
│   │   ├── checkout/
│   │   │   ├── [plano]/page.tsx
│   │   │   ├── sucesso/page.tsx     # + ConsultaLinkBanner
│   │   │   └── aguardando/page.tsx  # + ConsultaLinkBanner
│   │   ├── agendar/[plano]/         # slot picker → checkout reserve
│   │   │   ├── page.tsx
│   │   │   └── SlotPicker.tsx
│   │   ├── consulta/[id]/           # link público com token HMAC
│   │   │   ├── page.tsx
│   │   │   └── JoinRoomButton.tsx
│   │   ├── sobre/page.tsx
│   │   ├── termos/page.tsx
│   │   ├── privacidade/page.tsx
│   │   ├── admin/                    # painel administrativo
│   │   │   ├── login/                # magic link form
│   │   │   └── (shell)/              # layout com sidebar (requer admin)
│   │   │       ├── page.tsx          # dashboard
│   │   │       ├── doctors/          # CRUD de médicas
│   │   │       └── payouts/          # gestão de repasses
│   │   ├── medico/                   # painel da médica
│   │   │   ├── login/                # magic link form
│   │   │   └── (shell)/              # layout com sidebar (requer doctor)
│   │   │       ├── page.tsx          # dashboard
│   │   │       ├── agenda/           # consultas + entrar na sala
│   │   │       ├── ganhos/           # extrato com filtro mensal
│   │   │       ├── repasses/         # histórico read-only
│   │   │       └── perfil/           # edição limitada
│   │   └── api/
│   │       ├── lead/route.ts
│   │       ├── checkout/route.ts
│   │       ├── asaas/webhook/route.ts        # + ativa appt + provisiona Daily
│   │       ├── wa/webhook/route.ts
│   │       ├── auth/                         # magic-link / callback / signout
│   │       ├── agendar/reserve/route.ts      # cria customer + reserva slot + cobra
│   │       ├── daily/webhook/route.ts        # meeting.* → status do appointment (App Router)
│   │       ├── internal/cron/
│   │       │   ├── expire-reservations/route.ts  # Vercel Cron (*/1 min) + pg_cron
│   │       │   └── wa-reminders/route.ts         # Vercel Cron (*/1 min) → processDuePending
│   │       ├── admin/                        # APIs do painel admin
│   │       │   ├── doctors/[id]/(compensation|payment-method|availability)
│   │       │   └── payouts/[id]/(approve|pay|confirm|cancel|proof)
│   │       ├── medico/                       # APIs do painel da médica
│   │       │   ├── profile (PATCH)
│   │       │   ├── payouts/[id]/proof (GET → signed URL 60s)
│   │       │   └── appointments/[id]/join (POST → cria sala Daily)
│   │       └── paciente/                     # APIs públicas (token HMAC)
│   │           └── appointments/[id]/join (POST → URL Daily, janela 30 min)
│   ├── pages/api/
│   │   └── daily-webhook.ts          # Pages Router handler (fallback D-029)
│   ├── components/                   # 16+ componentes
│   └── lib/
│       ├── asaas.ts                  # cliente Asaas (sandbox/prod)
│       ├── auth.ts                   # requireAdmin/requireDoctor + getSessionUser
│       ├── earnings.ts               # geração de earnings/clawbacks
│       ├── payouts.ts                # state machine de payouts
│       ├── payout-proofs.ts          # bucket privado de comprovantes PIX
│       ├── scheduling.ts             # slots disponíveis + reserva atomic
│       ├── patient-tokens.ts         # HMAC do link /consulta/[id]
│       ├── notifications.ts          # fila + worker wa-reminders
│       ├── no-show-policy.ts         # política financeira D-032
│       ├── supabase.ts               # admin (service role) + anon
│       ├── supabase-server.ts        # @supabase/ssr (server components)
│       ├── video.ts                  # VideoProvider + DailyProvider
│       ├── wa-templates.ts           # 11 wrappers tipados (7 Meta + 2 internos + 2 no-show stub)
│       ├── whatsapp.ts               # sendTemplate + sendText (Graph API)
│       └── utils.ts
├── supabase/migrations/              # SQL versionado
│   ├── 20260419000000_initial_leads.sql
│   ├── 20260419010000_leads_whatsapp_tracking.sql
│   ├── 20260419020000_whatsapp_events.sql
│   ├── 20260419030000_asaas_payments.sql
│   ├── 20260419040000_doctors_appointments_finance.sql
│   ├── 20260419050000_payouts_admin_fields.sql
│   ├── 20260419060000_payout_proofs_bucket.sql
│   ├── 20260419070000_appointment_booking.sql   # 008: pending_payment + slot reserve
│   ├── 20260419080000_daily_events.sql          # 009: webhook Daily (raw + idempot.)
│   ├── 20260420000000_expire_pending_payment.sql            # 010: cron expiração
│   ├── 20260420100000_appointment_notifications_scheduler.sql # 011: scheduler + funcs
│   └── 20260420200000_no_show_policy.sql                    # 012: política no-show
├── package.json
├── tailwind.config.ts
├── tsconfig.json
└── next.config.js
```

## Rodar localmente

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # build de produção
npm start        # rodar o build
```

## Deploy

Recomendado: **Vercel** + **Cloudflare** (DNS).

### Primeiro deploy no Vercel

1. Importe o repositório no Vercel (https://vercel.com/new)
2. Vercel detecta Next.js automaticamente — não precisa configurar nada
3. Em **Environment Variables**, cole as variáveis do seu `.env.local`
   (mínimo: as do Supabase + as do WhatsApp/Meta)
4. Deploy
5. URL inicial: `instituto-nova-medida-<hash>.vercel.app`
6. Quando registrar o domínio, configurar em **Settings → Domains**

Variáveis de ambiente necessárias: ver [`docs/SECRETS.md`](./docs/SECRETS.md)
e o template completo em [`.env.example`](./.env.example).

## Convenções

- Sempre que tomar uma decisão importante → registrar em
  [`docs/DECISIONS.md`](./docs/DECISIONS.md)
- Sempre que entregar algo → registrar em
  [`docs/CHANGELOG.md`](./docs/CHANGELOG.md)
- Toda mudança de copy → atualizar [`docs/COPY.md`](./docs/COPY.md)
- Mudança de schema → atualizar [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
- Mudança regulatória → atualizar [`docs/COMPLIANCE.md`](./docs/COMPLIANCE.md)
