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

**Restante da Sprint 4.1 (3/3):** webhook Daily
(`meeting.started/ended` atualiza `appointment.status`), cron de
expiração de `pending_payment`, helpers WhatsApp pros 7 templates,
env vars Daily + `PATIENT_TOKEN_SECRET` no Vercel.

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
│   │       ├── admin/                        # APIs do painel admin
│   │       │   ├── doctors/[id]/(compensation|payment-method|availability)
│   │       │   └── payouts/[id]/(approve|pay|confirm|cancel|proof)
│   │       ├── medico/                       # APIs do painel da médica
│   │       │   ├── profile (PATCH)
│   │       │   ├── payouts/[id]/proof (GET → signed URL 60s)
│   │       │   └── appointments/[id]/join (POST → cria sala Daily)
│   │       └── paciente/                     # APIs públicas (token HMAC)
│   │           └── appointments/[id]/join (POST → URL Daily, janela 30 min)
│   ├── components/                   # 16+ componentes
│   └── lib/
│       ├── asaas.ts                  # cliente Asaas (sandbox/prod)
│       ├── auth.ts                   # requireAdmin/requireDoctor + getSessionUser
│       ├── earnings.ts               # geração de earnings/clawbacks
│       ├── payouts.ts                # state machine de payouts
│       ├── payout-proofs.ts          # bucket privado de comprovantes PIX
│       ├── scheduling.ts             # slots disponíveis + reserva atomic
│       ├── patient-tokens.ts         # HMAC do link /consulta/[id]
│       ├── supabase.ts               # admin (service role) + anon
│       ├── supabase-server.ts        # @supabase/ssr (server components)
│       ├── video.ts                  # VideoProvider + DailyProvider
│       ├── whatsapp.ts
│       └── utils.ts
├── supabase/migrations/              # SQL versionado
│   ├── 20260419000000_initial_leads.sql
│   ├── 20260419010000_leads_whatsapp_tracking.sql
│   ├── 20260419020000_whatsapp_events.sql
│   ├── 20260419030000_asaas_payments.sql
│   ├── 20260419040000_doctors_appointments_finance.sql
│   ├── 20260419050000_payouts_admin_fields.sql
│   ├── 20260419060000_payout_proofs_bucket.sql
│   └── 20260419070000_appointment_booking.sql   # 008: pending_payment + slot reserve
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
