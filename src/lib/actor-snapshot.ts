/**
 * src/lib/actor-snapshot.ts — PR-064 · D-072
 *
 * Pequena lib utilitária pra produzir snapshots imutáveis da identidade
 * do actor que está executando uma ação auditada.
 *
 * Motivação (finding [10.6]):
 *   Colunas como `fulfillments.updated_by_user_id`, `plan_acceptances
 *   .user_id`, `doctor_payouts.approved_by` referenciam `auth.users`
 *   com `on delete set null`. Se o user for deletado (LGPD Art. 18),
 *   o UUID vira null e a audit trail perde identidade. A estratégia
 *   adotada (D-072) é **pareamento UUID + snapshot de email**:
 *
 *     - o UUID serve pra JOIN enquanto o user existir;
 *     - o email snapshot (gravado no INSERT/UPDATE) sobrevive pra
 *       eternidade, virando prova de quem foi.
 *
 * Esta lib padroniza a normalização de entrada (trim, lowercase,
 * empty → null) pra que toda chamada produza o mesmo formato de
 * snapshot. Sem dependências externas — puro TS.
 *
 * Uso típico:
 *
 *   import { normalizeActorSnapshot } from "./actor-snapshot";
 *   const actor = normalizeActorSnapshot({ userId: user.id, email: user.email });
 *   // INSERT ...
 *   //   updated_by_user_id: actor.userId,
 *   //   updated_by_email: actor.email,
 *
 * As funções são testadas em `actor-snapshot.test.ts`.
 */

export type ActorKind = "admin" | "doctor" | "patient" | "system";

export type ActorSnapshot = {
  /** UUID do `auth.users`. Null quando a ação é de sistema/automação. */
  userId: string | null;
  /**
   * Email do ator no momento da ação. Null quando kind='system' e não
   * há identidade humana associada; null também quando legado sem
   * email. Sobrevive ao delete do user — é o "pra sempre" do audit.
   */
  email: string | null;
  /**
   * Classificação do tipo de ator. Útil pra filtrar relatórios e pra
   * validar que linhas `kind='system'` não têm `userId` (semântica
   * análoga à de `admin_audit_log.actor_kind`).
   */
  kind: ActorKind;
};

export type NormalizeActorInput = {
  userId?: string | null;
  email?: string | null;
  kind?: ActorKind;
};

/**
 * Normaliza a entrada pra garantir invariantes:
 *
 *   - string vazia/espaço-em-branco vira `null` (user_id e email);
 *   - email trimado e lowercased (case-insensitive — RFC 5321 §2.4
 *     recomenda, e Supabase Auth já armazena lowercase);
 *   - kind default 'admin' — a maioria dos usos hoje é admin. Rotas
 *     de paciente/médica passam explícito. System actions passam
 *     explícito.
 *   - kind='system' com userId não-null é coerced pra userId=null
 *     (fail-soft — o banco tem check constraint em admin_audit_log
 *     que confere isto; aqui só não quebramos outros pontos que
 *     eventualmente integrem).
 *
 * Retorna sempre um objeto — nunca lança.
 */
export function normalizeActorSnapshot(
  input: NormalizeActorInput = {}
): ActorSnapshot {
  const kind = input.kind ?? "admin";

  // email: trim + lowercase + empty→null
  let email: string | null = null;
  if (typeof input.email === "string") {
    const trimmed = input.email.trim().toLowerCase();
    email = trimmed.length > 0 ? trimmed : null;
  }

  // userId: trim + empty→null
  let userId: string | null = null;
  if (typeof input.userId === "string") {
    const trimmed = input.userId.trim();
    userId = trimmed.length > 0 ? trimmed : null;
  }

  // Invariantes de binding:
  //   kind='system' ⇒ userId=null
  //   kind!='system' aceita userId=null (legado/anonymous) mas loga
  //   implicitamente via ausência de email.
  if (kind === "system" && userId !== null) {
    userId = null;
  }

  return { userId, email, kind };
}

/**
 * Helper pra rotas: recebe o `SessionUser` (ou similar) e a kind
 * desejada, retorna o ActorSnapshot pronto pra gravar.
 *
 * Usar assim:
 *
 *   const actor = actorSnapshotFromSession({ id: admin.id, email: admin.email }, "admin");
 *
 * Aceita objeto com `id` e `email` — mais flexível que `SessionUser`
 * pra conseguir usar também com `{ id: doctor.user_id, email: doctor.email }`.
 */
export function actorSnapshotFromSession(
  user: { id?: string | null; email?: string | null } | null | undefined,
  kind: ActorKind = "admin"
): ActorSnapshot {
  if (!user) {
    return normalizeActorSnapshot({ kind });
  }
  return normalizeActorSnapshot({
    userId: user.id ?? null,
    email: user.email ?? null,
    kind,
  });
}

/**
 * Snapshot pré-montado pra ações de sistema (crons, webhooks,
 * reconcile, retention). Aceita um rótulo pra virar email identificável
 * em relatórios (ex: "system:asaas-webhook", "system:reconcile").
 *
 *   const actor = systemActorSnapshot("asaas-webhook");
 *   // => { userId: null, email: "system:asaas-webhook", kind: "system" }
 */
export function systemActorSnapshot(label: string): ActorSnapshot {
  const clean = label.trim().toLowerCase();
  const prefix = clean.startsWith("system:") ? "" : "system:";
  return {
    userId: null,
    email: clean.length > 0 ? `${prefix}${clean}` : null,
    kind: "system",
  };
}
