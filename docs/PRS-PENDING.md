# PRs Pendentes — Inputs Aguardando do Operador

Lista consolidada de PRs identificados na auditoria (`docs/AUDIT-FINDINGS.md`) que **não podem ser abertos só pelo engenheiro**: dependem de dados reais, decisões do operador ou acesso externo.

Atualizado em: **2026-04-21** (pós-PR-042 / D-058 — fetchWithTimeout canônico + migração de fetches externos).

---

## PR-023 · Preencher CNPJ + Responsável Técnico Médico no footer

**Status:** ⏸️ **BLOQUEADO — aguardando dados do operador**
**Severidade do finding:** 🔴 CRÍTICO (audit [7.1])
**Arquivo afetado:** `src/components/Footer.tsx`

### Por que é CRÍTICO

O rodapé público hoje contém literalmente `CNPJ [a preencher]` e `Responsável Técnico Médico: Dra. [Nome], CRM/[UF] [número]`.

- **CFM 2.314/2022** exige identificação clara do responsável técnico em qualquer site de telemedicina.
- Sem CNPJ real: auditor fiscal externo ou Procon podem autuar.
- Com tráfego pago ativo + placeholder visível = infração direta CFM + LGPD (Art. 9º) + CDC Art. 31.

Enquanto o placeholder estiver lá, **não é recomendado publicidade paga nem veiculação em redes**.

### O que preciso do operador

Copie-cole na próxima mensagem:

```text
CNPJ da pessoa jurídica (clínica): ________________
Razão social completa: ________________
Responsável Técnico Médico — nome completo: ________________
CRM (somente número): ________________
CRM UF (estado da inscrição, ex: "SP"): ________________
E-mail institucional do DPO (privacidade@...): ________________
Número de WhatsApp comercial (apenas dígitos, com DDI 55): ________________
Endereço físico da sede (rua, número, bairro, cidade, UF, CEP): ________________
```

### O que será feito quando chegar

1. Substituir placeholders em `src/components/Footer.tsx`.
2. Mover os valores fixos para `src/config/legal.ts` (centralizado, tipado, com JSDoc citando CFM 2.314/2022).
3. Acrescentar smoke test `src/components/Footer.test.tsx` que **falha o build** se qualquer placeholder (`[a preencher]`, `[Nome]`, `[número]`, `[UF]`) for re-introduzido.
4. Registrar ADR no `docs/DECISIONS.md` (D-048).
5. Validar via `rg "\\[a preencher\\]|\\[Nome\\]|\\[n[úu]mero\\]|\\[UF\\]" src/` devolver zero resultados.

---

## Outros PRs com dependência de decisão do operador (não CRÍTICOS)

### PR-022 (CANCELADO) · Crons UTC→BRT

- **Status original:** 🔴 CRÍTICO proposto na auditoria.
- **Status atual:** ♻️ **Cancelado em 2026-04-20.**
- **Motivo:** Verificação pós-auditoria confirmou que os schedules `vercel.json` **já estão corretos em UTC** e cada `route.ts` documenta a conversão UTC→BRT. Não era bug, é preferência operacional.
- **Follow-up opcional:** se o operador quiser ajustar horários (ex.: mover `admin-digest` de 08:30 BRT para 09:00 BRT), abrir PR isolado trivial no `vercel.json`.

### PR-033 (parte B) · DPA com farmácia parceira

- **Status:** ⏸️ Aguardando operador (audit [6.6]).
- **O que preciso:**
  - Qual farmácia de manipulação é a parceira oficial?
  - Existe Data Processing Agreement (DPA) ou Termo de Operador LGPD assinado?
  - Se não, precisa elaborar. Recomendo consultar advogado + template da ANPD.
- **Bloqueante para:** ativação completa da rotulagem "parceiro LGPD".

### PR-038 · 2FA obrigatório para admin

- **Status:** ⏸️ Aguardando decisão do operador (audit [3.X PARTE 1]).
- **O que preciso:**
  - Operador prefere TOTP (Google Authenticator / Authy) ou Passkey (WebAuthn)?
  - Telefone secundário para recovery (caso perca device)?
- Supabase já suporta TOTP nativo (já está em `config.toml` com `enroll_enabled=true`), falta só forçar o fluxo obrigatório para role=admin.

### PR-046 · Multi-médica (quando chegar a 2ª)

- **Status:** ⏸️ Fora de escopo até existir 2ª médica contratada (audit [12.1]).
- **O que será necessário:**
  - Schema de `doctor_specialties` + routing por prioridade.
  - UI admin de triagem (atribuir paciente a médica).
  - Split financeiro por médica atendente vs RT.

### PR-047 · Break-glass account

- **Status:** ⏸️ Aguardando operador (audit [3.X PARTE 1]).
- **O que preciso:**
  - Qual e-mail secundário (fora de `cabralandre@yahoo.com.br`) para conta de emergência?
  - Cofre físico / 1Password / Bitwarden onde a credencial fica lacrada?
- Sem isso, se o Yahoo Mail cair ou a conta for comprometida, o operador perde acesso irrecuperável à plataforma.

---

## Cadência recomendada

Enquanto o operador colhe os dados acima, o engenheiro segue com os PRs que não dependem de inputs externos.

**Status pós-PR-042 (2026-04-21):**

- ✅ Concluídos:
  - Onda 1A (D-047): PR-024, PR-025, PR-026 (dark patterns + fail-fast CRON_SECRET)
  - Onda 1B (D-048): PR-013, PR-020, PR-030, PR-031 (integridade financeira, prontuário, audit log)
  - Onda 1C (D-049): PR-011, PR-015, PR-021 (acceptance server-side, race em payment, timezone BR)
  - Onda 1D (D-050): PR-014 (earning financeiro só em PAYMENT_RECEIVED)
  - Onda 2A (D-051): PR-016 (allowlist em export LGPD), PR-017 (self-service /paciente/meus-dados), PR-032 (patient_access_log + logPatientAccess integrado em view, export, anonymize, search, lgpd_fulfill, lgpd_reject)
  - Onda 2B (D-052): PR-033-A (retenção LGPD automática — cron semanal anonimiza ghost customers > 24 meses; actor_kind formalizado em admin_audit_log + patient_access_log; bug do `patient_access_log.admin_user_id NOT NULL` corrigido; seção informativa em /admin/lgpd-requests; freshness check em /admin/health)
  - Onda 2C (D-053): PR-035 (ViaCEP blindado) — proxy server-side `/api/cep/[cep]` com schema estrito + charset allowlist + rate-limit + cache de borda; `validateAddress` server-side ganha `hasControlChars` + regex de charset em todos os campos; clients migrados pra consumir o proxy. Fecha audit [22.1] e prepara [9.1] (agentes LLM).
  - Onda 2D (D-054): **PR-036 (`/api/lead` endurecido)** — lib `text-sanitize` (compartilhada) + `lead-validate` (charset slug em `answers`, limites em nome/phone/utm/referrer/landingPath, 37 testes) + rate-limit 10/15min por IP + body-guard 8 KB pré-parse + migration com CHECK constraints em `pg_column_size(answers/utm)` e `char_length(name/phone/status_notes/referrer/landing_path)` + índice parcial `leads_ip_created_at_idx` pra futuro cron de anti-spike. Fecha audit [9.3] e [22.2]; mitiga [9.1] em `leads.answers`.
  - Onda 2E (D-055): **PR-036-B (clínico/operacional endurecido)** — `hasEvilControlChars` + `cleanFreeText` + `sanitizeFreeText` em `text-sanitize` (aceita `\n\r\t`, bloqueia NULL/ESC/DEL/zero-width/bidi/U+2028-29); aplicado em `appointment-finalize.ts` (hipotese/conduta/anamnese.text com limites 4 KB/16 KB) e `fulfillment-transitions.ts` (tracking_note 500ch / cancelled_reason 2 KB); `validateFinalizeInput` passa a devolver `{ ok, sanitized }`; migration `20260503000000` com CHECK em `appointments.hipotese/conduta/anamnese` + `fulfillments.tracking_note/cancelled_reason` + defensivamente em `doctors.notes`, `doctor_payouts.{notes,failed_reason,cancelled_reason}`, `doctor_billing_documents.validation_notes`. **Fecha [9.1] totalmente.**
  - Onda 2F (D-056): **PR-037 (guardrails pra agentes de IA + blindagem `customers.name`)** — primitivas `prompt-envelope.ts` (wrapUserInput com nonce + formatStructuredFields), `prompt-redact.ts` (CPF/CEP/email/phone/UUID/Asaas token/JWT), `customer-display.ts` (displayFirstName/FullName/PlanName/CityState com fallback seguro); `fulfillment-messages.ts` refatorado pra usar os `display*` + helper `safeOpNote`; `/api/checkout` e `/api/agendar/reserve` agora rodam `sanitizeShortText` com pattern `personName`; migration `20260504000000` com backfill idempotente + CHECK em `customers.name` (char_length ≤ 120, POSIX `[[:cntrl:]]`); `AGENTS.md` no root do repo (contrato normativo lido pelos agentes). **76 testes novos. Fecha [9.2] e [9.4].**
  - PR-039 (D-057): **logger canônico estruturado + migração inicial** — `src/lib/logger.ts` zero-deps (JSON em prod, pretty em dev, silencioso em test, `redactForLog` automática via D-056, child loggers com contexto encadeável, sink pluggable). Migração dos caminhos críticos: `cron-runs`, `cron-auth`, `admin-audit-log`, `patient-access-log`, `retention`, `patient-lgpd-requests`, 8 rotas `/api/internal/cron/*`, `/api/asaas/webhook` (29 call-sites). **23 testes novos.** `AGENTS.md` atualizado com o pipeline de logging. **Finding [14.1] rebaixado de 🟠 ALTO pra 🟡 PARCIAL** — infra pronta; plugar drain externo (Axiom/Sentry) aguarda input operacional.
  - PR-042 (D-058): **`fetchWithTimeout` canônico + migração de fetches externos** — `src/lib/fetch-timeout.ts` zero-deps (drop-in replacement do `fetch()` com timeout por `AbortController`, `FetchTimeoutError` classificado, composição com AbortSignal externo, log via logger canônico D-057, `PROVIDER_TIMEOUTS` calibrados). Migrado em `asaas.ts::request` (10s), `whatsapp.ts::postToGraph` (8s), `video.ts::dailyRequest` (8s), `cep.ts::fetchViaCep` (2.5s), `system-health.ts::checkAsaasEnv/checkDailyEnv`. **12 testes novos.** **Finding [13.1] ✅ RESOLVED** — total de ALTOs cai de 6 pra 5.
- 🔜 Próximos sem input:
  1. **PR-039-cont** — migração dos ~60 `console.*` remanescentes (libs especializadas, rotas admin individuais). Cosmético; não bloqueia.
  2. **PR-040** — dashboard temporal de `cron_runs`.
  3. **PR-033-Clinical** — retenção pós-20-anos para pacientes com prontuário (só relevante em 2045+).
- ⏸️ Bloqueados por input operacional não-crítico:
  - **PR-043** — plugar drain externo no `logger` (`setSink(axiomSink)` + alertas Slack/WA). Precisa: chaves Axiom/Sentry + budget aprovado.
- ⏸️ Bloqueados pelo operador: PR-023 (footer CNPJ/RT — **crítico, bloqueia tráfego pago**), PR-033-B (DPA farmácia), PR-038 (2FA), PR-047 (break-glass)
- ⏸️ Bloqueados por maturação operacional: PR-046 (multi-médica, só quando chegar a 2ª)

**Estado dos CRÍTICOS:** dos 11 CRÍTICOS originais do audit, 10 estão resolvidos (1.1, 2.1/1.3/8.2, 5.1, 5.2, 5.3, 6.1, 10.1, 17.1, 3.x). O único pendente é [7.1] (bloqueado pelo operador — aguardando CNPJ/RT).

**Estado dos ALTOs / MÉDIOs da família 9.x (AI/prompt-injection):** 100% fechados. Findings 9.1 (Ondas 2C+2D+2E), 9.2 (Onda 2F), 9.3 (Onda 2D), 9.4 (Onda 2F). Quando LLM externo for plugado, as primitivas (`prompt-envelope.ts`, `prompt-redact.ts`, `customer-display.ts`) + check-list em `AGENTS.md` são as referências normativas. Tudo sem débito técnico.

**Estado dos demais ALTOs:** fechados também 22.1 (ViaCEP), 22.2 (leads DoS), 13.1 (fetchWithTimeout — PR-042), LGPD 6.3/6.4/17.3/Art. 16. 14.1 foi rebaixado pra 🟡 PARCIAL pela D-057. Pendentes são não-AI: 5.5 (clawback), 5.6 (checkout consent persistido), 5.8/5.12 (asaas_events retention + PII redact), 17.4 (signed URL log), 13.2 (circuit breaker — próximo candidato natural após PR-042).

Ou seja: **zero CRÍTICOS sem caminho de resolução ativo, zero ALTOs LGPD, zero ALTOs trust-boundary externo, zero ALTOs DoS, zero ALTOs prompt-injection, zero ALTOs/MÉDIOs AI-agent**. Toda família 9.x (AI adversário) fechada pra superfície atual. Quando os inputs do operador chegarem, PR-023 entra **com prioridade máxima** (pré-requisito para qualquer tráfego pago).
