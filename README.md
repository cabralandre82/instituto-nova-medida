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
Validado E2E: criação de customer + payment na Asaas sandbox e webhook
`PAYMENT_RECEIVED` atualizando `payments.status` no Supabase com
`signature_valid=true`. Landing conectada (Header, Hero, Cost e
Success modal apontam para `/planos`); lead capturado pelo quiz é
vinculado à compra via `localStorage`. **Pendente operador:** subir
sub-conta dedicada na Asaas quando o CNPJ próprio chegar e ativar
split automático (Sprint 6).

Próxima sprint: **Sprint 4** — Avaliação clínica + videoconsulta
(Daily.co) + prescrição digital (Memed).

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
│       ├── asaas.ts                  # cliente Asaas
│       ├── supabase.ts
│       ├── whatsapp.ts
│       └── utils.ts
├── supabase/migrations/              # SQL versionado
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
