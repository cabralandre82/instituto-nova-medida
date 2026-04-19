# Instituto Nova Medida

> **Não é sobre força de vontade — é sobre o método certo.**

Plataforma de telessaúde brasileira para emagrecimento individualizado.
Avaliação médica online, prescrição quando indicada e acompanhamento
contínuo com a mesma médica pelo WhatsApp.

Domínio em produção: **[institutonovamedida.com.br](https://institutonovamedida.com.br)** (a registrar)

---

## Status

**Sprint 1** ✅ — Landing page completa (hero, identification, shift,
access, how-it-works, desire, cost, quiz interativo, captura LGPD, FAQ,
sucesso com share, footer compliant).

**Sprint 2** ✅ — Backend Supabase (`leads`, RLS, migrations versionadas)
+ pipeline WhatsApp Cloud API (lib + tracking + webhook + tunnel) +
disparo automático de MSG 1 quando lead cai no banco.

Próxima sprint: **Sprint 3** — Pagamentos (Asaas: PIX, cartão até 3x,
webhook).

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
│   │   └── api/
│   │       └── lead/route.ts
│   ├── components/          # 13 componentes
│   └── lib/utils.ts
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
