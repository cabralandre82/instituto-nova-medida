# Runbook · Checklist pré-produção · Instituto Nova Medida

> Lista verificável antes de mudar o DNS canônico pra produção, liberar
> tráfego pago ou expor a plataforma ao público geral. Foca em **o que
> precisa estar verdadeiro pra não quebrar / não infringir / não cobrar
> indevidamente**. Complementa:
>
> - `docs/RUNBOOK.md` — operação do dia a dia e incidentes comuns.
> - `docs/RUNBOOK-E2E.md` — teste ponta-a-ponta manual antes de release grande.
> - `docs/SECRETS.md` — catálogo e template de envs.
> - `docs/PRS-PENDING.md` — o que ainda está bloqueado por input operacional.
>
> **Quando rodar:** antes de cada um destes marcos, do início pro fim:
>
> 1. **Go-live inicial** (primeira liberação pra paciente real).
> 2. **Antes de ligar tráfego pago** (Meta Ads / Google Ads).
> 3. **Antes de habilitar `LEGACY_PURCHASE_ENABLED=true`** (se um dia for revertido).
> 4. **Antes de promover state machine D-070 pra `enforce`**.
> 5. **Antes de rotacionar qualquer secret em produção**.
>
> **Filosofia:** este checklist não testa — ele **verifica**. Se um item
> falhar, **pare** e resolva antes de destravar. Release sob pressão com
> checklist vermelho é como operar com o cinto desligado: às vezes dá
> certo, às vezes você morre.

---

## Sumário

- [0 · Como usar este checklist](#0--como-usar-este-checklist)
- [1 · Bloqueantes legais + regulatórios](#1--bloqueantes-legais--regulatórios)
- [2 · Envs por criticidade](#2--envs-por-criticidade)
- [3 · Crons instalados (Vercel + pg_cron)](#3--crons-instalados-vercel--pg_cron)
- [4 · Feature flags e gates](#4--feature-flags-e-gates)
- [5 · Acesso + contas](#5--acesso--contas)
- [6 · Observabilidade + alarmes](#6--observabilidade--alarmes)
- [7 · Smoke test final (10 min)](#7--smoke-test-final-10-min)
- [8 · Rotação de secrets (quando fizer)](#8--rotação-de-secrets-quando-fizer)

---

## 0 · Como usar este checklist

- Cada item tem **severidade**: 🔴 **bloqueante** (não sobe), 🟠 **degradação**
  (sobe, mas feature X fica capada), 🟡 **observabilidade** (sobe, mas você
  vai trabalhar "às cegas" em parte).
- Marque `[x]` quando validado. Não marque por otimismo.
- Itens 🔴 com `[ ]` abaixo = **não liberar pra público**.
- Quando um item apontar pra outro doc, abra aquele doc no mesmo passo
  em vez de confiar na memória.

---

## 1 · Bloqueantes legais + regulatórios

Estes itens são responsabilidade **do operador**, não do engenheiro. Cada
linha vermelha reflete uma exposição regulatória real (CFM, LGPD, CDC,
Procon). Sem eles, a plataforma pode rodar tecnicamente, mas expor o
operador a autuação.

- [ ] 🔴 **CNPJ + Responsável Técnico Médico no footer** (audit [7.1],
      PR-023). Hoje `src/components/Footer.tsx` tem placeholders
      literais `[a preencher]`. CFM 2.314/2022 exige identificação
      explícita. **Incompatível com tráfego pago.** Ver `docs/PRS-PENDING.md` §PR-023.
- [ ] 🔴 **Razão social + endereço físico da sede** idem acima.
- [ ] 🔴 **E-mail do DPO** configurado em `NEXT_PUBLIC_DPO_EMAIL` e
      publicado em `/privacidade`. LGPD Art. 41 exige controlador
      identificar encarregado.
- [ ] 🔴 **Política de privacidade + Termos de uso** versionados e
      publicados (`/privacidade`, `/termos`). PR-053 · D-064 persiste
      aceite em `checkout_consents` com hash canônico; se o texto
      legal mudar, bumpar `TERMS_VERSION` correspondente.
- [ ] 🔴 **DPA com farmácia de manipulação parceira** (PR-033-B).
      LGPD Art. 39 exige contrato entre controlador e operador. Sem
      ele, não há base legal pra transferir CPF/endereço pra farmácia.
      Ver `docs/PRS-PENDING.md` §PR-033.
- [ ] 🟠 **Farmácia identificada em `/privacidade`** ("subcontratado
      operador LGPD"). Sem isso, consentimento de compartilhamento é
      genérico — defensável, mas frágil.
- [ ] 🟡 **Contrato de prestação de serviço com médica(s) RT** com
      cláusula explícita de retenção de prontuário por 20 anos (CFM
      1.821/2007).

---

## 2 · Envs por criticidade

Classificação: 🔴 app não sobe · 🟠 feature específica quebra · 🟡
observabilidade degrada. Para rotação, ver §8.

### 2.1 · Supabase (infra base)

- [ ] 🔴 `NEXT_PUBLIC_SUPABASE_URL`
- [ ] 🔴 `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- [ ] 🔴 `SUPABASE_SERVICE_ROLE_KEY` — **server-only**, nunca expor ao
      cliente. `src/lib/supabase.ts::getSupabaseAdmin()` lança na
      ausência em runtime.

### 2.2 · Asaas (cobrança)

- [ ] 🔴 `ASAAS_API_KEY` — sem ela, checkout/refund não chamam Asaas.
- [ ] 🔴 `ASAAS_ENV` — `sandbox` ou `production`. **Checar
      explicitamente antes de liberar pagamento real.** `src/lib/asaas.ts:55`.
- [ ] 🔴 `ASAAS_WEBHOOK_TOKEN` — validado em `/api/asaas/webhook` via
      header `asaas-access-token`. Sem ele, webhooks são rejeitados.
- [ ] 🟠 `ASAAS_WALLET_ID` — futuro split de repasse (D-020). Hoje
      não é usado no fluxo.
- [ ] 🟠 `REFUNDS_VIA_ASAAS` (`true` | `false`) — default `false`
      (conservador). Quando `true`, `/admin/refunds` oferece botão
      "Estornar no Asaas" que chama `POST /payments/{id}/refund`. Só
      ligar depois de testar em sandbox. `src/lib/refunds.ts:49`.

### 2.3 · Daily.co (vídeo)

- [ ] 🟠 `DAILY_API_KEY` + `DAILY_DOMAIN` — **sem elas o checkout ainda
      funciona**, mas consultas em tempo real caem. Webhook Asaas
      detecta ausência e grava `daily_room_url=null`
      (`src/app/api/asaas/webhook/route.ts:348`). Fluxo sem vídeo só é
      viável em teste.
- [ ] 🔴 `DAILY_WEBHOOK_SECRET` — **base64 válido** (32 bytes random).
      Secrets em formato livre (`whsec_...`) são rejeitados pela API
      do Daily. Ver `docs/SECRETS.md` gotchas.

### 2.4 · WhatsApp Cloud API (Meta)

- [ ] 🔴 `WHATSAPP_PHONE_NUMBER_ID` + `WHATSAPP_ACCESS_TOKEN` — sem
      eles nenhum WA sai. Pacientes não recebem confirmação/lembrete.
      Suite de crons `wa-reminders` + `admin-digest` + `notify-pending-documents`
      + `nudge-reconsulta` capa em cascata.
- [ ] 🔴 `WHATSAPP_WEBHOOK_VERIFY_TOKEN` — validado no GET do handshake
      Meta em `/api/wa/webhook`. Tem que bater com o configurado no
      painel de Meta for Developers.
- [ ] 🟠 `WHATSAPP_TEMPLATES_APPROVED` (`true` quando a Meta aprovar
      os 7 templates D-031). Default `false` → `wa-templates.ts` retorna
      stub `templates_not_approved`; worker mantém notifs em `pending`.
      Vai ligar **depois** da aprovação, não antes.
- [ ] 🟡 `WHATSAPP_TEMPLATE_VERSION` (só setar `2` quando template v2
      for aprovado após rejeição de v1).
- [ ] 🟡 `WHATSAPP_PHONE_DISPLAY` — só exibição (rodapé/landing).
- [ ] 🟡 `NEXT_PUBLIC_WA_SUPPORT_NUMBER` — número do admin usado em
      CTAs do paciente (`/paciente/renovar`, banner PR-073, CTA PR-071).
      Fallback defensivo em `src/lib/contact.ts:53` pra não quebrar
      build; **confirmar valor correto antes de produção**.

### 2.5 · Cron + tokens HMAC

- [ ] 🔴 `CRON_SECRET` — Vercel Cron envia `Authorization: Bearer $CRON_SECRET`.
      Sem ele, `assertCronRequest()` em `src/lib/cron-auth.ts` rejeita 401
      e **nenhum cron roda**. Fail-fast em produção (`NODE_ENV==='production'`).
- [ ] 🔴 `PATIENT_TOKEN_SECRET` — HMAC dos tokens públicos de consulta
      (`/consulta/[id]?t=...`). Rotacionar invalida todos os links
      enviados — aceitável porque paciente recupera via WA.

### 2.6 · Domínio + URLs

- [ ] 🔴 `NEXT_PUBLIC_SITE_URL` — URL canônica (`https://institutonovamedida.com.br`
      após virada). Usado em sitemap, `<head>`, links absolutos em WA.
- [ ] 🔴 `NEXT_PUBLIC_BASE_URL` — URL pra tokens públicos (`/consulta/[id]?t=...`).
      Em produção igual a `NEXT_PUBLIC_SITE_URL`. Pré-virada aponta pra Vercel preview.

### 2.7 · E-mail transacional + diagnóstico

- [ ] 🟠 `RESEND_API_KEY` + `EMAIL_FROM` — magic-link do Supabase Auth
      por padrão vai via SMTP Supabase. Se migrar pra Resend, setar.
- [ ] 🟡 `ADMIN_DIGEST_PHONE` — E.164 pro rollup diário via WA. Sem
      ele, cron `admin-digest` roda mas não envia; você perde o resumo
      automático. Mitigação: abrir `/admin` manualmente todo dia.

### 2.8 · Memed (prescrição)

- [ ] 🟠 `MEMED_API_KEY` + `MEMED_API_SECRET` + `MEMED_ENV` — sem elas,
      médica não consegue gerar receita assinada digitalmente. Fluxo
      consulta não-clínica funciona; consulta com prescrição fica
      truncada.

### 2.9 · Analytics (opcional, Sprint 7)

- [ ] 🟡 `NEXT_PUBLIC_META_PIXEL_ID` / `NEXT_PUBLIC_GA4_ID` / `NEXT_PUBLIC_GTM_ID`
      / `META_CLIENT_TOKEN` — só mexem se tráfego pago. Não sair do
      `sandbox` desses antes de PR-023 estar resolvido.

### 2.10 · Feature gates operacionais

Ver §4. Estão em env var mas a lógica de **quando mexer** é conceitual,
não técnica.

- [ ] 🔴 `LEGACY_PURCHASE_ENABLED` — **default sem valor = `false` em
      produção, `true` em dev** (`src/lib/legacy-purchase-gate.ts:43`).
      Controla rotas `/checkout/[plano]` + `/agendar/[plano]` do modelo
      antigo. Gate PR-020 · D-048. Em produção: `false` estrito.

---

## 3 · Crons instalados (Vercel + pg_cron)

Autoridade: `vercel.json` + migrations `*_earnings_crons.sql`
`*_expire_pending_payment.sql` `*_retention_and_system_actor.sql`
`*_asaas_events_retention.sql`. **Schedules em UTC** (cronjobs Vercel
não aceitam timezone); coluna BRT é referência humana (UTC-3 durante
todo o ano hoje, já que o Brasil não usa horário de verão desde 2019).

| # | Path | Schedule (UTC) | BRT (aprox.) | Finalidade | Se falhar |
|---|---|---|---|---|---|
| 1 | `expire-reservations` | `* * * * *` | a cada min | Expira reservas de horário que não pagaram em 15min | Horário fica lockado |
| 2 | `wa-reminders` | `* * * * *` | a cada min | Dispara `appointment_notifications` agendadas (confirma, T-24h, T-1h, T+10min) | Paciente não recebe lembrete |
| 3 | `daily-reconcile` | `*/5 * * * *` | a cada 5 min | Reconcilia appointments via Daily events + aplica política D-032 (no-show, sala expirada) | Clawback/refund não disparam; reliability não registra |
| 4 | `recalculate-earnings` | `15 3 * * *` | 00:15 | Atualiza `doctor_earnings.status=available` depois do hold de segurança | Earnings ficam `pending` indefinidamente |
| 5 | `generate-payouts` | `15 9 1 * *` | 06:15 dia 1 | Agrega earnings `available` em `doctor_payouts` draft do mês | Pagamento mensal não é criado |
| 6 | `notify-pending-documents` | `0 9 * * *` | 06:00 | WA pra médica cobrando NF-e atrasada | Médica deixa de ser cobrada |
| 7 | `auto-deliver-fulfillments` | `0 10 * * *` | 07:00 | `shipped → delivered` após 14 dias | Fulfillments ficam `shipped` pra sempre |
| 8 | `nudge-reconsulta` | `0 11 * * *` | 08:00 | WA pro paciente 20d antes do fim do plano | Paciente não renova em tempo |
| 9 | `admin-digest` | `30 11 * * *` | 08:30 | Rollup diário do operador via WA | Você não recebe resumo (abra `/admin` manualmente) |
| 10 | `retention-anonymize` | `0 4 * * 0` | 01:00 dom | LGPD Art. 16: anonimiza customers "ghost" > 24 meses | Backlog LGPD cresce |
| 11 | `asaas-events-purge` | `0 5 * * 0` | 02:00 dom | LGPD: purga `asaas_events.payload` > 180d (PII) | PII persiste indefinidamente |
| 12 | `expire-appointment-credits` | `0 12 * * *` | 09:00 | Sweep `appointment_credits` `active+expirado → expired` (D-083) | Relatórios SQL raw ficam menos limpos; UI segue honesta via compute-on-read |

**pg_cron adicional** (roda no próprio Postgres, fora do Vercel):

- [ ] `expire_pending_payment` — expira `appointments.status='pending_payment'`
      após janela de 15min (migration `20260420000000_expire_pending_payment.sql`).
      Hoje **legacy** (D-044 tornou primeira consulta gratuita); redundante com o
      watchdog `appointment_pending_payment_stale` do admin-inbox (PR-071), mas
      continua instalado.

**Verificação:**

```sql
select jobid, schedule, jobname, active
from cron.job
order by jobname;
```

Esperado: cada job `active=true`. Se algum `active=false`, rodar
`select cron.alter_job(jobid := N, active := true)`.

**Retention/purge com threshold customizado** (pra testes):

```bash
curl -H "x-cron-secret: $CRON_SECRET" \
  "https://app.institutonovamedida.com.br/api/internal/cron/retention-anonymize?dryRun=1&thresholdDays=365"
```

---

## 4 · Feature flags e gates

| Flag | Env var / GUC | Default | Quando promover |
|---|---|---|---|
| Fluxo de compra legado (`/checkout/[plano]`, `/agendar/[plano]`) | `LEGACY_PURCHASE_ENABLED` | `false` em prod | **Nunca.** Modelo D-044 é "consulta grátis → plano depois". Revertido só em emergência. |
| Refund automático via Asaas | `REFUNDS_VIA_ASAAS` | `false` | Após rodar Cenário 4 do RUNBOOK-E2E em sandbox com `method=asaas_api` + conferir idempotência do webhook `PAYMENT_REFUNDED`. |
| Templates WA aprovados | `WHATSAPP_TEMPLATES_APPROVED` | `false` | Após Meta aprovar os 7 templates D-031 individualmente. Promover antes da aprovação faz Meta bloquear o número. |
| Rotação de template WA | `WHATSAPP_TEMPLATE_VERSION` | `1` (vazio) | Só setar `2` se um template foi rejeitado e a v2 foi aprovada. |
| State machine D-070 em `appointments.status` | GUC `app.appointment_state_machine.mode` | `warn` (registra mas não bloqueia) | Após 7 dias consecutivos com `appointment_state_transition_log` sem `action='warning'` ou `'blocked'`. Ver RUNBOOK §15 State machine. |
| Soft delete D-074 | (sempre ativo, trigger DB) | bloqueia `DELETE` bruto | Nunca desligar em runtime normal. Bypass só via `SET LOCAL app.soft_delete.allow_hard_delete='true'` numa transação DBA. |
| Imutabilidade do magic-link log | GUC `app.magic_link_log.allow_mutation` | `false` | Nunca ligar em runtime normal. Só pra DBA corrigir dado corrompido. |

---

## 5 · Acesso + contas

- [ ] 🔴 **Admin principal** cadastrado com `app_metadata.role='admin'`
      no Supabase Auth. Sem isso, `/admin` cai em redirect loop.
- [ ] 🔴 **Primeira médica** cadastrada em `doctors` + `doctor_payment_methods`
      (chave PIX) + `doctor_availability` + `doctor_compensation_rules`.
      Sem uma médica ativa, `/agendar` não oferece horários.
- [ ] 🟠 **Break-glass account** (PR-047) configurada com e-mail
      secundário e credencial lacrada. Sem ela, se o Yahoo cair você
      perde o acesso. Ver `docs/PRS-PENDING.md` §PR-047.
- [ ] 🟡 **2FA obrigatório pra admin** (PR-038). Supabase TOTP já
      suportado; falta forçar. Mitigação até lá: senha forte + 2FA
      opcional no Yahoo Mail.

---

## 6 · Observabilidade + alarmes

- [ ] 🔴 `/admin/health` respondendo `overall: "ok"` no pré-release.
      Qualquer `error` trava o go-live.
- [ ] 🔴 `/admin/crons` mostrando os 12 crons rodando nos últimos 7
      dias. Cron sem execução recente em janela > schedule × 2 =
      suspeita imediata.
- [ ] 🟠 `/admin/errors` com janela 24h e filtro por `source` funcionando.
      Se `/admin/errors` retornar erro, a visibilidade de problemas cai
      drasticamente.
- [ ] 🟠 Rollup diário WA (`admin-digest` → `ADMIN_DIGEST_PHONE`)
      chegando. Teste: forçar manualmente uma execução do cron (ver
      RUNBOOK §10) e conferir entrega.
- [ ] 🟡 **Drain externo de logs** (Axiom/Sentry via `setSink`, PR-043).
      Pendente — `docs/PRS-PENDING.md`. Enquanto não plugado, logs de
      produção só ficam no Vercel Logs (retenção limitada).

---

## 7 · Smoke test final (10 min)

Este é o "abrir a porta e olhar" antes de publicar. Roda **depois**
de todos os envs estarem setados + migrations aplicadas.

```bash
# 1 · Endpoint de smoke sintético (cobre Asaas, Daily, WA, DB, crons)
curl -sH "x-cron-secret: $CRON_SECRET" \
  "https://app.institutonovamedida.com.br/api/internal/e2e/smoke?ping=1" \
  | jq '.report.overall'
# Esperado: "ok"

# 2 · Ping de health público
curl -s "https://app.institutonovamedida.com.br/api/health" | jq '.'
# Esperado: { ok: true }

# 3 · Home carrega sem erro 5xx
curl -sI "https://app.institutonovamedida.com.br/" | head -1
# Esperado: HTTP/2 200

# 4 · Login admin redireciona certo (não 500)
curl -sI "https://app.institutonovamedida.com.br/admin" | head -5
# Esperado: 307/302 pra /admin/login (não autenticado)
```

**Verificações manuais (browser):**

- [ ] Home `/` carrega em < 3s.
- [ ] `/agendar` lista horários da médica cadastrada.
- [ ] `/admin/login` recebe magic link (checar caixa do admin).
- [ ] Clicar no link leva pra `/admin` autenticado.
- [ ] `/paciente/login` recebe magic link (checar com paciente de
      teste).
- [ ] `/privacidade` + `/termos` renderizam **sem `[a preencher]`**.
- [ ] Rodapé tem CNPJ + RT (PR-023) + DPO (PR-057).

---

## 8 · Rotação de secrets (quando fizer)

**Cadência recomendada:** 90 dias. **Sempre que:** suspeita de leak,
saída de colaborador, auditoria externa.

**Roteiro padrão:**

1. Rotacionar no painel do provedor (Asaas, Meta, Daily, Supabase).
2. Atualizar em **Vercel → Settings → Environment Variables** para
   production **+ preview + development** (3 ambientes, ver gotcha em
   `docs/SECRETS.md`).
3. Redeploy (Vercel faz sozinho ao salvar env, mas redeploy manual
   garante reexecução de build cache).
4. Rodar `curl /api/health` + smoke do §7.
5. Registrar em planilha externa: data, motivo, última 4 caracteres
   da chave antiga (pra rastrear em logs).

**Envs que não podem ser rotacionadas sem coordenação:**

| Env | Impacto | Mitigação |
|---|---|---|
| `PATIENT_TOKEN_SECRET` | Invalida todos os `/consulta/[id]?t=...` já enviados | Paciente recupera link via WA (seção 7 RUNBOOK). Comunicar se fizer em massa. |
| `CRON_SECRET` | Crons param 0-2min até Vercel sincronizar | Sem impacto real; rotacionar em horário vazio só por higiene |
| `ASAAS_WEBHOOK_TOKEN` | Asaas continua enviando com token antigo até você atualizar o painel | Atualizar no painel **antes** de atualizar na Vercel — durante a janela, webhooks vão ser rejeitados com 401 (Asaas re-envia automaticamente) |
| `DAILY_WEBHOOK_SECRET` | Daily fica sem validar novas assinaturas | Atualizar no painel Daily via `POST /v1/webhooks` **antes** de atualizar na Vercel |
| `WHATSAPP_ACCESS_TOKEN` | WA para de sair imediatamente | **Nunca rotacionar sem agendar.** Pacientes param de receber confirmação/lembrete. Fazer em janela vazia (madrugada) |
| `NEXT_PUBLIC_*` | Só afetam build; trocar requer redeploy | Sem surpresa, mas lembrar que são inlined no JS do cliente — tratamento como secret **não aplica** |

---

## Apêndice · O que fazer se um item ficar vermelho

- **Item 1.x vermelho (legal):** pare o release. Ative `robots: noindex`
  via metadata override, bloqueie `/` no middleware temporariamente,
  aguarde PR-023 / PR-033-B.
- **Item 2.x vermelho (env crítico):** app sobe mas feature inteira
  quebra. Release só com autorização explícita sua + plano de recuperação
  escrito.
- **Item 3.x vermelho (cron):** app sobe, features rodam, mas backlog
  silencioso vai acumulando. Aceitável **por 24h** se você consegue
  monitorar manualmente; inaceitável em > 48h.
- **Item 4-5 vermelho (flag/acesso):** release degradado. Marcar em
  `/admin/health` como `warning` e abrir issue de follow-up.

---

*Última revisão: 2026-04-20 · D-082 · PR-074*
