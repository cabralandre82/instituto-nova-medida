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
# Secret estático que o Daily envia em x-daily-webhook-secret nos
# webhooks. Configurado em dashboard.daily.co → Developers → Webhooks.
# Nós escolhemos o valor.
DAILY_WEBHOOK_SECRET=
# Provider de vídeo ativo. Default 'daily'. Trocar pra 'jitsi' quando
# migrarmos (D-021). Sem valor = 'daily'.
# VIDEO_PROVIDER=daily

# === WhatsApp Cloud API (Meta) ===
META_APP_ID=
META_APP_SECRET=
WHATSAPP_BUSINESS_ACCOUNT_ID=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_WEBHOOK_VERIFY_TOKEN=      # nós escolhemos, configurar no painel da Meta

# === Analytics ===
NEXT_PUBLIC_META_PIXEL_ID=
NEXT_PUBLIC_GA4_ID=
NEXT_PUBLIC_GTM_ID=

# === E-mail transacional (Resend) ===
RESEND_API_KEY=
EMAIL_FROM="Instituto Nova Medida <contato@institutonovamedida.com.br>"

# === Domínio / Auth ===
NEXT_PUBLIC_SITE_URL=https://institutonovamedida.com.br
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
