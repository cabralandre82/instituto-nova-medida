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

**Sprint 4.1** 🟡 — **Em andamento** (entrega 1/3 concluída). Fundação
multi-médico: schema completo (`doctors`, `doctor_availability`,
`doctor_payment_methods`, `doctor_compensation_rules`, `appointments`,
`appointment_notifications`, `doctor_earnings`, `doctor_payouts`,
`doctor_billing_documents`), funções Postgres pra cálculo de
disponibilidade e geração de payouts mensais, 2 cron jobs ativos
(`pg_cron`), RLS deny-by-default com helpers `current_doctor_id()` /
`jwt_role()`, view pública `doctors_public`, lib `src/lib/video.ts`
abstraindo provider (DailyProvider operacional). Decisões registradas:
**D-021** Daily.co MVP, **D-022** controle financeiro interno (sem
split Asaas), **D-023** não gravar por default (opt-in), **D-024**
médicas como PJ + valores fixos. Veja `docs/COMPENSATION.md` e
`docs/WHATSAPP_TEMPLATES.md`.

**Próximas entregas Sprint 4.1:** auth (médica + admin), páginas
admin (`/admin/doctors|payouts|financeiro`), painel médica (`/medico*`),
fluxo paciente (`/agendar`), API routes (appointments, webhook Daily,
extensão webhook Asaas, payouts), helpers WhatsApp pros 7 templates.

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
│   ├── app/                 # Rotas, layout, API
│   │   ├── layout.tsx
│   │   ├── page.tsx         # Landing
│   │   ├── globals.css
│   │   ├── sitemap.ts
│   │   ├── robots.ts
│   │   ├── icon.svg
│   │   ├── planos/page.tsx           # catálogo de planos
│   │   ├── checkout/
│   │   │   ├── [plano]/page.tsx      # formulário de checkout
│   │   │   ├── sucesso/page.tsx
│   │   │   └── aguardando/page.tsx
│   │   ├── sobre/page.tsx
│   │   ├── termos/page.tsx
│   │   ├── privacidade/page.tsx
│   │   └── api/
│   │       ├── lead/route.ts
│   │       ├── checkout/route.ts
│   │       ├── asaas/webhook/route.ts
│   │       └── wa/webhook/route.ts
│   ├── components/                   # 16+ componentes
│   └── lib/
│       ├── asaas.ts                  # cliente Asaas (sandbox/prod)
│       ├── video.ts                  # VideoProvider + DailyProvider
│       ├── supabase.ts
│       ├── whatsapp.ts
│       └── utils.ts
├── supabase/migrations/              # SQL versionado
│   ├── 20260419000000_initial_leads.sql
│   ├── 20260419010000_leads_whatsapp_tracking.sql
│   ├── 20260419020000_whatsapp_events.sql
│   ├── 20260419030000_asaas_payments.sql
│   └── 20260419040000_doctors_appointments_finance.sql
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
