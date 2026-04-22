/**
 * src/lib/user-retention.ts — PR-064 · D-072
 *
 * Anonimização de contas `auth.users` (admins e médicas) preservando
 * o row pra não cascatear null em `on delete set null`.
 *
 * Contexto do problema (finding [10.6]):
 *   Várias colunas de audit apontam pra `auth.users(id)` com
 *   `on delete set null` (ex: `fulfillments.updated_by_user_id`,
 *   `plan_acceptances.user_id`, `doctor_payouts.approved_by`,
 *   `appointments.refund_processed_by`). Se um admin/médica invocar
 *   o direito ao esquecimento (LGPD Art. 18) e sua row em
 *   `auth.users` for deletada, a FK vira null e a audit trail perde
 *   identidade.
 *
 *   A migration PR-064 (D-072) pareou cada FK com uma coluna snapshot
 *   `*_email` que sobrevive. Mas há outro cenário: queremos desativar
 *   um admin/médica sem perder a row (ex: médica sai da plataforma,
 *   admin é substituído). Neste caso, a prática industry-standard é
 *   **anonimizar in-place**: zerar PII, bloquear login, preservar UUID.
 *
 * O que esta lib NÃO faz:
 *   - Não anonimiza pacientes — use `anonymizePatient` em
 *     `patient-lgpd.ts`, que mexe em `customers` e é o escopo certo
 *     pro fluxo LGPD do titular.
 *   - Não DELETA o row de `auth.users`. Deletar cascata em set null
 *     é exatamente o que a estratégia D-072 quer evitar.
 *   - Não é chamada por nenhum cron automático hoje. É helper
 *     disponível pra quando operacionalmente precisarmos (futuro
 *     PR-064-C que vai expor UI admin pra isto).
 *
 * Idempotência:
 *   Chamar 2x retorna `already_anonymized=true` na segunda. A
 *   detecção usa o padrão de email anonimizado (sufixo `@deleted.local`).
 *
 * Dependência externa:
 *   Usa `supabase.auth.admin.updateUserById` — requer service_role.
 *   Cliente deve vir de `getSupabaseAdmin()`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import { logger } from "./logger";

const log = logger.with({ mod: "user-retention" });

/**
 * Domínio reservado pra emails anonimizados. Não é um domínio real
 * (não existe na internet). Padrão RFC 2606 §2 recomenda `.test`,
 * `.example` ou `.invalid`; usamos `.local` que é costume em Supabase
 * (não tem DNS público, não é deliverable).
 */
export const ANON_USER_EMAIL_DOMAIN = "deleted.local";

export type AnonymizeUserResult =
  | {
      ok: true;
      userId: string;
      anonymizedAt: string;
      /** true se o user já estava anonimizado (chamada repetida). */
      alreadyAnonymized: boolean;
      /** Email placeholder gravado (pra log / audit trail). */
      anonymizedEmail: string;
    }
  | {
      ok: false;
      code:
        | "not_found"
        | "update_failed"
        | "invalid_user_id";
      message: string;
    };

/**
 * Retorna um email placeholder determinístico pra um user_id.
 * Como `auth.users.email` tem UNIQUE, precisamos garantir que dois
 * users anonimizados não colidam. Hash curto (12 chars) já basta —
 * colisão SHA-256 truncada 48 bits é desprezível pro volume da
 * clínica. Formato: `anon-<hash12>@deleted.local`.
 *
 * Determinístico: re-anonimizar o mesmo user_id produz o mesmo email.
 */
export function anonymizedEmailForUser(userId: string): string {
  const hash = createHash("sha256").update(userId).digest("hex").slice(0, 12);
  return `anon-${hash}@${ANON_USER_EMAIL_DOMAIN}`;
}

/**
 * Reconhece se um email é um placeholder anonimizado (pra idempotência).
 */
export function isAnonymizedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return email.toLowerCase().endsWith(`@${ANON_USER_EMAIL_DOMAIN}`);
}

/**
 * Anonimiza uma conta `auth.users` in-place:
 *
 *   1. Verifica que o user existe e ainda não foi anonimizado.
 *   2. Substitui email por placeholder determinístico.
 *   3. Zera `phone`, `raw_user_meta_data`, `raw_app_meta_data`.
 *   4. Bane o user (impede re-login): `banned_until = '9999-12-31'`.
 *   5. NÃO mexe em `customers`, `doctors`, `patient_access_log`,
 *      `admin_audit_log`, ou qualquer linha fora de `auth.users`.
 *      Os snapshots `*_email` gravados antes da anonimização
 *      continuam válidos — é exatamente o objetivo do D-072.
 *
 * O caller deve:
 *   - Chamar `logAdminAction({ action: 'user.anonymize', ... })`
 *     ou equivalente pra registrar QUEM anonimizou quem. Esta lib
 *     não faz audit própria pra não acoplar.
 *
 * Segurança:
 *   Require service_role. A auth de quem chamou (admin humano vs
 *   cron) é responsabilidade do caller — tipicamente uma rota
 *   `/api/admin/…` com `requireAdmin()`.
 */
export async function anonymizeUserAccount(
  supabase: SupabaseClient,
  userId: string,
  opts: { now?: Date } = {}
): Promise<AnonymizeUserResult> {
  if (!userId || typeof userId !== "string" || userId.trim().length === 0) {
    return {
      ok: false,
      code: "invalid_user_id",
      message: "userId inválido.",
    };
  }

  const adminAuth = supabase.auth.admin;

  const getRes = await adminAuth.getUserById(userId);
  if (getRes.error || !getRes.data?.user) {
    return {
      ok: false,
      code: "not_found",
      message: `User ${userId} não encontrado em auth.users.`,
    };
  }

  const current = getRes.data.user;

  // Idempotência: email já tem sufixo de anonimização? Considera
  // já anonimizado e devolve ok=true. Evita sobrescrever timestamp
  // em re-chamadas e mantém os snapshots `*_email` legados.
  if (isAnonymizedEmail(current.email)) {
    return {
      ok: true,
      userId,
      anonymizedAt:
        (current.user_metadata?.anonymized_at as string | undefined) ??
        (current.updated_at ?? new Date().toISOString()),
      alreadyAnonymized: true,
      anonymizedEmail: current.email ?? anonymizedEmailForUser(userId),
    };
  }

  const anonymizedEmail = anonymizedEmailForUser(userId);
  const nowIso = (opts.now ?? new Date()).toISOString();

  // Update in-place. `banned_until` bloqueia login; `email` placeholder
  // libera o email original pra eventual re-uso em nova conta.
  // Não mexemos em `id` — é a âncora das FKs.
  const updRes = await adminAuth.updateUserById(userId, {
    email: anonymizedEmail,
    phone: "",
    email_confirm: true, // sem reenviar confirmação pro email fake
    ban_duration: "876000h", // ~100 anos — efetivamente banido
    user_metadata: {
      anonymized_at: nowIso,
      anonymized_reason: "user_retention",
    },
    app_metadata: {
      anonymized: true,
      role: null,
    },
  });

  if (updRes.error) {
    log.error("falha em updateUserById", {
      err: updRes.error.message,
      user_id: userId,
    });
    return {
      ok: false,
      code: "update_failed",
      message: `Falha ao anonimizar: ${updRes.error.message}`,
    };
  }

  log.info("user anonimizado", {
    user_id: userId,
    anonymized_at: nowIso,
  });

  return {
    ok: true,
    userId,
    anonymizedAt: nowIso,
    alreadyAnonymized: false,
    anonymizedEmail,
  };
}
