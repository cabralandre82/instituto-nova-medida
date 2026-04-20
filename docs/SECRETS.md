# Credenciais Necessárias · Instituto Nova Medida

> Este documento lista **apenas os nomes** das chaves necessárias.
> **Nunca** armazene valores reais aqui. Use `.env.local` (gitignored)
> e/ou cofre de secrets do provedor (Vercel Environment Variables).

## `.env.local` (template)

```bash
# === Supabase ===
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=          # server-only, nunca expor ao cliente

# === Asaas (pagamentos) ============================================
# Sandbox: gera no painel https://sandbox.asaas.com → Configurações → Integrações
# Produção: depois de o CNPJ próprio estar liberado em https://www.asaas.com
# (chave começa com "$aact_" em sandbox e em produção; o que diferencia é o painel
# em que foi gerada e a env var ASAAS_ENV abaixo)
ASAAS_API_KEY=
# Token estático que enviamos no header `asaas-access-token` do webhook.
# Nós escolhemos o valor (ex: random base64 64 chars), e configuramos
# o mesmo no painel Asaas → Webhooks → Token de autenticação.
ASAAS_WEBHOOK_TOKEN=
# 'sandbox' (testes, sem mover dinheiro) ou 'production' (real).
# Ver decisão D-019 em DECISIONS.md.
ASAAS_ENV=sandbox

# === Memed (prescrição) ===
MEMED_API_KEY=
MEMED_API_SECRET=
MEMED_ENV=sandbox

# === Daily.co (vídeo, Sprint 4) ===
# API key gerada em https://dashboard.daily.co → Developers → API keys.
# Usada apenas no servidor (nunca exposta ao cliente). Rotacionar a
# cada 90 dias. Free tier: 10k participant-min/mês (cobre o MVP).
DAILY_API_KEY=
# Subdomínio Daily da conta. Descoberto via GET /v1/ → domain_name.
# Ex: 'instituto-nova-medida' → salas em
# https://instituto-nova-medida.daily.co/{room}.
DAILY_DOMAIN=
# Secret HMAC pra validar assinatura dos webhooks do Daily.
# IMPORTANTE: a API do Daily (POST /v1/webhooks) exige que seja
# uma string **base64 válida** (ex: 32 bytes random). Secrets em
# formato livre como `whsec_...` são rejeitados com
# `"hmac" must be a valid base64 string`.
# Gerar: `python3 -c "import os,base64; print(base64.b64encode(os.urandom(32)).decode())"`
DAILY_WEBHOOK_SECRET=
# Provider de vídeo ativo. Default 'daily'. Trocar pra 'jitsi' quando
# migrarmos (D-021). Sem valor = 'daily'.
# VIDEO_PROVIDER=daily

# === WhatsApp Cloud API (Meta) ===
META_APP_ID=
META_APP_SECRET=
META_CLIENT_TOKEN=                  # opcional; usado pelo Meta Pixel client-side
WHATSAPP_BUSINESS_ACCOUNT_ID=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_WEBHOOK_VERIFY_TOKEN=      # nós escolhemos, configurar no painel da Meta
WHATSAPP_PHONE_DISPLAY=             # só exibição (rodapé/landing), não usado em APIs

# === Analytics ===
NEXT_PUBLIC_META_PIXEL_ID=
NEXT_PUBLIC_GA4_ID=
NEXT_PUBLIC_GTM_ID=

# === E-mail transacional (Resend) ===
RESEND_API_KEY=
EMAIL_FROM="Instituto Nova Medida <contato@institutonovamedida.com.br>"

# === Domínio / Auth / Links públicos ===
# URL canônica do site (marketing + SEO). Ficará
# https://institutonovamedida.com.br após migração do DNS.
NEXT_PUBLIC_SITE_URL=https://institutonovamedida.com.br
# URL usada pra montar links públicos de consulta (ex: /consulta/[id]).
# Em dev pode ser http://localhost:3000, em prod fica igual
# NEXT_PUBLIC_SITE_URL após a virada. Hoje aponta pra
# https://instituto-nova-medida.vercel.app.
NEXT_PUBLIC_BASE_URL=https://instituto-nova-medida.vercel.app
# HMAC secret usado pelos tokens de acesso público do paciente à
# consulta (/consulta/[id]?t=...). Rotacionar invalida todos os
# links já enviados — aceitável porque paciente pode recuperar via
# WhatsApp. Gerar: `openssl rand -base64 32`.
PATIENT_TOKEN_SECRET=
```

## Onde criar cada conta (passo a passo no Sprint 2)

| Serviço | URL | Plano inicial | O que precisamos da sua parte |
|---|---|---|---|
| **Supabase** | https://supabase.com | Free (suficiente até ~50k req/mês) | Criar conta, criar projeto na região São Paulo |
| **Asaas (sandbox)** | https://sandbox.asaas.com | Free | Email + senha. **Não exige CNPJ.** Usado em todo o desenvolvimento da Sprint 3. |
| **Asaas (produção)** | https://www.asaas.com | Conta PJ (CNPJ) | CNPJ próprio (D-020), dados bancários, ativar split (Sprint 6) |
| **Memed** | https://api.memed.com.br | Free para médicos | Cadastro com CRM da médica RT |
| **Daily.co** | https://daily.co | Free (10k min/mês) | Conta criada, API key validada, subdomínio `instituto-nova-medida.daily.co`. Em produção: assinar DPA + cláusulas LGPD (D-021) |
| **Meta for Developers** | https://developers.facebook.com | Free + custos por mensagem | Criar app, conectar WhatsApp Business, validar número |
| **Vercel** | https://vercel.com | Hobby grátis para começar; Pro quando precisar | Conectar GitHub, deploy automático |
| **Cloudflare** | https://cloudflare.com | Free | Apontar nameservers do `institutonovamedida.com.br` |
| **Resend** (e-mail) | https://resend.com | Free 3k e-mails/mês | Verificar domínio, criar API key |

## Boas práticas

- **NUNCA** comitar `.env.local` no git (já está no `.gitignore`)
- **Rotacionar** chaves a cada 90 dias
- **Usar service role keys apenas no servidor** (nunca enviar para o cliente)
- **Ambiente sandbox** (Asaas, Memed) para todo desenvolvimento; só usar
  produção a partir do beta fechado
- **Webhook secrets** sempre validados antes de processar payload

## Estado atual no Vercel (production + preview + development)

Snapshot em **2026-04-20** após setup ops via CLI + REST API:

| Nome | Adicionada em | Observação |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_PROJECT_REF` | Sprint 2 | Supabase |
| `ASAAS_API_KEY`, `ASAAS_ENV`, `ASAAS_WALLET_ID`, `ASAAS_WEBHOOK_TOKEN` | Sprint 3 | Sandbox |
| `META_APP_ID`, `META_APP_SECRET`, `META_CLIENT_TOKEN` | 2026-04-20 | `META_CLIENT_TOKEN` faltava |
| `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_PHONE_DISPLAY` | Sprint 2/4 | `PHONE_DISPLAY` faltava |
| `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_BASE_URL` | 2026-04-20 | `BASE_URL` faltava |
| `DAILY_API_KEY`, `DAILY_DOMAIN`, `DAILY_WEBHOOK_SECRET` | 2026-04-20 | Faltavam todas |
| `PATIENT_TOKEN_SECRET` | 2026-04-20 | Faltava |

**Faltam ainda** (para sprints futuras): `MEMED_API_KEY`, `MEMED_API_SECRET`,
`MEMED_ENV`, `RESEND_API_KEY`, `EMAIL_FROM`, `NEXT_PUBLIC_META_PIXEL_ID`,
`NEXT_PUBLIC_GA4_ID`, `NEXT_PUBLIC_GTM_ID`.

## Gotchas documentados

- **Vercel CLI `env add name production preview development`** só insere
  em `production` e `development` (ignora `preview` silenciosamente).
  Usar `POST /v10/projects/{id}/env` com `target: ["preview"]` e
  `upsert=true` para o terceiro ambiente.
- **Daily `DAILY_WEBHOOK_SECRET`** precisa ser **base64 válido**
  (ex: `base64(os.urandom(32))` → 44 chars com `=`). Secrets em
  formato livre (`whsec_...`) são rejeitados pela API com
  `"hmac" must be a valid base64 string`.
- **Daily `X-Webhook-Timestamp`** vem em **milissegundos**, não
  segundos. Normalizar antes da janela anti-replay.
- **Daily `POST /v1/webhooks` + Vercel HTTP/2** → erro
  `"recvd undefined"` por bug do superagent 3.8.3. Ver D-029.
