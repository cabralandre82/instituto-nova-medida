# Arquitetura · Instituto Nova Medida

## Visão geral

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Cloudflare (DNS + WAF + CDN)                    │
└────────────────┬────────────────────────────────────────────────────┘
                 │
        ┌────────▼─────────┐         ┌──────────────────────────┐
        │   Vercel (Edge)  │◄───────►│   Supabase (São Paulo)   │
        │  Next.js 14 SSR  │         │  Postgres + Auth + RLS   │
        │  /landing        │         │  + Storage (exames PDF)  │
        │  /paciente       │         └──────────────────────────┘
        │  /medica         │
        │  /admin          │         ┌──────────────────────────┐
        │  /api/*          │◄───────►│   Asaas (pagamentos)     │
        └────┬─────────────┘         │  PIX, cartão, split      │
             │                       └──────────────────────────┘
             │
             │  ┌──────────────────────────┐
             ├─►│  WhatsApp Cloud API      │
             │  │  (Meta) — webhooks       │
             │  └──────────────────────────┘
             │
             │  ┌──────────────────────────┐
             ├─►│  Memed (prescrição)      │
             │  │  ICP-Brasil embutido     │
             │  └──────────────────────────┘
             │
             │  ┌──────────────────────────┐
             └─►│  Daily.co (vídeo)        │
                │  Regional residency BR   │
                └──────────────────────────┘
```

## Frontend

### Stack

- **Next.js 14** (App Router, RSC + Client Components)
- **TypeScript** estrito
- **Tailwind CSS** com design tokens próprios
- **Framer Motion** para animações
- **Fontes Google**: Fraunces (display serif) + Inter (sans)
- **Lucide React** para ícones (quando necessário)

### Estrutura de pastas

```
src/
├── app/
│   ├── layout.tsx           # Root layout (fontes, metadata)
│   ├── page.tsx             # Landing pública
│   ├── globals.css          # Tailwind + custom utilities
│   ├── icon.svg             # Favicon
│   ├── sitemap.ts           # Sitemap dinâmico
│   ├── robots.ts            # robots.txt
│   ├── api/
│   │   └── lead/route.ts    # Recebe captura do quiz
│   ├── paciente/            # [futuro] Painel paciente
│   ├── medica/              # [futuro] Painel médica
│   └── admin/               # [futuro] Painel admin
├── components/
│   ├── Logo.tsx
│   ├── Header.tsx
│   ├── Hero.tsx
│   ├── Identification.tsx
│   ├── Shift.tsx
│   ├── Access.tsx
│   ├── HowItWorks.tsx
│   ├── Desire.tsx
│   ├── Cost.tsx
│   ├── Faq.tsx
│   ├── Footer.tsx
│   ├── Quiz.tsx
│   ├── CaptureForm.tsx
│   └── Success.tsx
└── lib/
    └── utils.ts             # cn() helper
```

## Backend (Sprint 2 em diante)

### Banco de dados (Supabase / Postgres)

```sql
-- Schema preliminar (será detalhado no Sprint 2)

-- Leads (captura inicial via quiz)
leads (
  id uuid pk,
  name text,
  phone text,
  answers jsonb,
  consent boolean,
  ip text,
  user_agent text,
  utm jsonb,
  status enum ('novo', 'contactado', 'agendado', 'consultado', 'convertido', 'descartado'),
  created_at timestamptz
)

-- Pacientes (após primeira consulta)
pacientes (
  id uuid pk,
  lead_id uuid fk,
  cpf text unique,
  email text,
  data_nasc date,
  endereco jsonb,
  tcle_assinado_em timestamptz,
  ...
)

-- Médicas
medicas (
  id uuid pk,
  nome text,
  crm text,
  uf_crm text,
  especialidade text,
  asaas_subaccount_id text,
  ativo boolean
)

-- Consultas
consultas (
  id uuid pk,
  paciente_id uuid fk,
  medica_id uuid fk,
  tipo enum ('inicial', 'reconsulta'),
  agendada_para timestamptz,
  iniciada_em timestamptz,
  finalizada_em timestamptz,
  daily_room_url text,
  status enum ('agendada', 'em_andamento', 'finalizada', 'no_show', 'cancelada'),
  resultado enum ('aprovado', 'nao_indicado', 'precisa_exames'),
  prontuario jsonb
)

-- Prescrições
prescricoes (
  id uuid pk,
  consulta_id uuid fk,
  memed_prescription_id text,
  pdf_url text,
  emitida_em timestamptz,
  medicamento text,
  dose text,
  posologia text
)

-- Ciclos de tratamento
ciclos (
  id uuid pk,
  paciente_id uuid fk,
  medica_id uuid fk,
  plano enum ('essencial', 'avancado', 'avancado_plus', 'premium'),
  inicio date,
  fim date,
  asaas_subscription_id text,
  status enum ('ativo', 'finalizado', 'cancelado')
)

-- Mensagens WhatsApp
mensagens_wa (
  id uuid pk,
  paciente_id uuid fk,
  direcao enum ('in', 'out'),
  template text,
  payload jsonb,
  status text,
  enviada_em timestamptz
)

-- Eventos LGPD
eventos_lgpd (
  id uuid pk,
  paciente_id uuid fk,
  tipo enum ('consentimento', 'acesso', 'correcao', 'exclusao', 'portabilidade'),
  detalhes jsonb,
  registrada_em timestamptz
)
```

### Row Level Security (RLS)

- **Pacientes** só veem seus próprios dados.
- **Médicas** só veem pacientes/consultas/prescrições onde foram designadas.
- **Admin** vê tudo (claim `role = 'admin'` no JWT).
- Service role (server-side) para operações de sistema.

## Integrações

| Serviço | Uso | Auth | Webhook |
|---|---|---|---|
| **Asaas** | Cobrança, PIX, cartão, split | API key + webhook secret | Sim (status pagamento) — `/api/asaas/webhook` |
| **Memed** | Prescrição com ICP-Brasil | OAuth + API token | Sim (status receita) |
| **Daily.co** | Vídeo teleconsulta | API key + HMAC secret | Sim — **bloqueado até migração Cloudflare (D-029)**; código pronto em `/api/daily/webhook` (App Router) e `/api/daily-webhook` (Pages Router) |
| **WhatsApp Cloud API** | Mensagens automáticas e suporte | App secret + access token | Sim (mensagens recebidas) |
| **Meta Ads / Google Ads** | Conversões | Pixel + Conversion API | Não |

### Webhooks que recebemos — detalhes operacionais

**Por que dois handlers para o Daily?**

- `/api/daily/webhook` (App Router, Node runtime): handler "canônico".
  Adiciona `Vary: RSC, Next-Router-State-Tree, Next-Router-Prefetch`
  automaticamente por design do Next 14. Funciona pra qualquer
  cliente HTTP moderno.
- `/api/daily-webhook` (Pages Router, Node runtime): handler
  "sem-Vary-RSC", criado pra contornar o bug do `node-superagent/3.8.3`
  que o Daily usa no check de verificação do `POST /v1/webhooks`.
  Mesmo handler lógico (HMAC idêntico, idempotência idêntica).
  Não resolveu o bug (é em nível HTTP/2, não de header) mas fica
  como segunda porta pra testes manuais e pro futuro (Cloudflare
  na frente servindo HTTP/1.1 ao origin Daily).

Ambos escrevem em `daily_events` (raw + idempotência via
`unique(event_id, event_type)`) e atualizam `appointments`.
Trocar o URL no Daily não quebra nada — o segundo handler é drop-in.

## Segurança

- **TLS 1.3** obrigatório (Vercel + Cloudflare)
- **HSTS** + **CSP** headers
- **LGPD**: consentimento granular, logs de acesso, DPO contato público
- **CFM 2.314/2022**: TCLE eletrônico, prontuário completo, ICP-Brasil para
  controlados, criptografia E2E nas teleconsultas
- **Backups**: Supabase point-in-time recovery (7 dias) + snapshot semanal
- **Logs**: estruturados (JSON), sem PII em logs de aplicação

## Observabilidade

- **Vercel Analytics** (Web Vitals)
- **Sentry** para erros frontend/backend (a configurar)
- **Logflare** ou **Better Stack** para logs estruturados

## Deploy

- **Branch `main`** → produção em `institutonovamedida.com.br`
- **Branch `develop`** → preview em `dev.institutonovamedida.com.br`
- **Pull Requests** geram preview URLs automaticamente (Vercel)
