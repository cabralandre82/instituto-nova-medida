/**
 * src/lib/soft-delete.ts — PR-066 · D-074
 *
 * Helper canônico para soft-deletar rows em tabelas protegidas pela
 * migration `20260511000000_soft_delete_clinical_tables`:
 *
 *   - appointments
 *   - fulfillments
 *   - doctor_earnings
 *   - doctor_payouts
 *
 * Motivação (finding [10.8]):
 *   Essas tabelas compõem o prontuário clínico + audit financeiro que o
 *   CFM Res. 1.821/2007 Art. 8º exige reter por 20 anos. `DELETE` físico
 *   nelas é proibido em nível de DB (trigger `prevent_hard_delete_*`).
 *   O único caminho permitido é o soft delete: `UPDATE SET deleted_at = now()`,
 *   com `deleted_reason` obrigatório e snapshot do actor (D-072).
 *
 * Design:
 *
 *   - Opera sempre com service_role (passa `supabase` explicitamente —
 *     chamadas vêm de rotas autenticadas que já exerceram o gate).
 *   - Valida `reason` local pra não depender só da CHECK constraint
 *     (mensagem melhor pra caller).
 *   - Normaliza `actor` via `actor-snapshot.ts` (D-072) pra que o email
 *     fique em lowercase, trim e empty→null consistente com as outras
 *     colunas de audit.
 *   - Idempotência: se a row já está soft-deletada, retorna sucesso
 *     sem novo UPDATE (evita reescrever `deleted_at`, o que corromperia
 *     a linha do tempo).
 *   - Sem hard delete bypass aqui: bypass é trabalho de DBA via
 *     `SET LOCAL app.soft_delete.allow_hard_delete='true'` no psql, nunca
 *     pela aplicação.
 *
 * Não mexe em admin_audit_log aqui — o call-site que dispara o soft
 * delete já tem responsabilidade separada de logar a ação administrativa
 * (via `logAdminAction`). Esta lib foca só na mecânica de escrita segura.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeActorSnapshot, type ActorKind } from "./actor-snapshot";
import { logger } from "./logger";

const log = logger.with({ module: "soft-delete" });

/**
 * Tabelas do escopo do PR-066 (onda A). Expandir só junto com migration
 * adicional (onda B), nunca só em TS.
 */
export const SOFT_DELETE_TABLES = [
  "appointments",
  "fulfillments",
  "doctor_earnings",
  "doctor_payouts",
] as const;

export type SoftDeleteTable = (typeof SOFT_DELETE_TABLES)[number];

export type SoftDeleteInput = {
  /** Nome da tabela protegida. Checado em runtime contra `SOFT_DELETE_TABLES`. */
  table: SoftDeleteTable;
  /** UUID da row alvo. */
  id: string;
  /** Motivo humano-legível. Obrigatório (CHECK + trigger no DB). */
  reason: string;
  /** Actor que está executando (admin/doctor/system). */
  actor: {
    userId?: string | null;
    email?: string | null;
    kind?: ActorKind;
  };
  /** Relógio injetável pra testes. */
  now?: Date;
};

export type SoftDeleteResult =
  | { ok: true; alreadyDeleted: boolean; deletedAt: string }
  | { ok: false; error: SoftDeleteError };

export type SoftDeleteError =
  | "invalid_table"
  | "invalid_id"
  | "invalid_reason"
  | "not_found"
  | "db_error";

const MIN_REASON_LEN = 4;
const MAX_REASON_LEN = 500;

/**
 * Normaliza e valida o motivo. Strings só com espaço/caractere de controle
 * viram inválidas. Trimamos pra gravação.
 */
function validateReason(reason: unknown): string | null {
  if (typeof reason !== "string") return null;
  // Remove caracteres de controle (exceto \n \r \t que podem ser úteis em
  // motivos mais longos como "Fix manual: <texto>\n\nContexto: ...").
  const cleaned = reason.replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F]/g, "");
  const trimmed = cleaned.trim();
  if (trimmed.length < MIN_REASON_LEN) return null;
  if (trimmed.length > MAX_REASON_LEN) {
    return trimmed.slice(0, MAX_REASON_LEN);
  }
  return trimmed;
}

/**
 * UUID v4-ish — não validamos formato exato (postgres faz isso), só
 * evitamos passar string vazia / não-string.
 */
function validateId(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const trimmed = id.trim();
  if (trimmed.length < 8) return null;
  return trimmed;
}

/**
 * Soft-deleta uma row. Devolve `{ ok: true, alreadyDeleted: true }` quando
 * a row já estava soft-deletada (idempotente).
 */
export async function softDelete(
  supabase: SupabaseClient,
  input: SoftDeleteInput
): Promise<SoftDeleteResult> {
  // 1. Validação defensiva do input.
  if (!SOFT_DELETE_TABLES.includes(input.table)) {
    return { ok: false, error: "invalid_table" };
  }
  const id = validateId(input.id);
  if (!id) return { ok: false, error: "invalid_id" };

  const reason = validateReason(input.reason);
  if (!reason) return { ok: false, error: "invalid_reason" };

  const actor = normalizeActorSnapshot(input.actor ?? {});
  const now = (input.now ?? new Date()).toISOString();

  // 2. Lê estado atual pra decidir se já está deletado (idempotência).
  const existing = await supabase
    .from(input.table)
    .select("id, deleted_at")
    .eq("id", id)
    .maybeSingle();

  if (existing.error) {
    log.error("softDelete · select failed", {
      table: input.table,
      id,
      err: existing.error,
    });
    return { ok: false, error: "db_error" };
  }

  if (!existing.data) {
    return { ok: false, error: "not_found" };
  }

  const existingDeletedAt = (existing.data as { deleted_at: string | null }).deleted_at ?? null;
  if (existingDeletedAt !== null) {
    // Já soft-deletado. Idempotente — não sobrescreve linha do tempo.
    log.info("softDelete · already deleted, noop", {
      table: input.table,
      id,
      deleted_at: existingDeletedAt,
    });
    return {
      ok: true,
      alreadyDeleted: true,
      deletedAt: existingDeletedAt,
    };
  }

  // 3. UPDATE atomicamente (guard `deleted_at IS NULL` previne race
  //    conditions entre duas chamadas concorrentes).
  const patch = {
    deleted_at: now,
    deleted_by: actor.userId,
    deleted_by_email: actor.email,
    deleted_reason: reason,
  };

  const upd = await supabase
    .from(input.table)
    .update(patch)
    .eq("id", id)
    .is("deleted_at", null)
    .select("id, deleted_at")
    .maybeSingle();

  if (upd.error) {
    log.error("softDelete · update failed", {
      table: input.table,
      id,
      err: upd.error,
    });
    return { ok: false, error: "db_error" };
  }

  if (!upd.data) {
    // Race: outra chamada soft-deletou entre select e update. Re-lê e
    // devolve idempotência.
    const reread = await supabase
      .from(input.table)
      .select("id, deleted_at")
      .eq("id", id)
      .maybeSingle();
    if (reread.data && (reread.data as { deleted_at: string | null }).deleted_at) {
      return {
        ok: true,
        alreadyDeleted: true,
        deletedAt: (reread.data as { deleted_at: string }).deleted_at,
      };
    }
    return { ok: false, error: "db_error" };
  }

  log.info("softDelete · done", {
    table: input.table,
    id,
    actor_kind: actor.kind,
    actor_email: actor.email,
  });

  return {
    ok: true,
    alreadyDeleted: false,
    deletedAt: now,
  };
}

/**
 * Helper de leitura — quem quiser filtrar "só rows ativas" chama assim
 * em vez de repetir `.is("deleted_at", null)` ad-hoc.
 *
 * Uso:
 *   const q = addActiveFilter(
 *     supabase.from("appointments").select("..."),
 *   );
 *
 * Type param T preserva o encadeamento do `PostgrestFilterBuilder` do
 * call-site sem vazarmos detalhes de tipagem do driver.
 */
export function addActiveFilter<T extends { is: (col: string, val: null) => T }>(q: T): T {
  return q.is("deleted_at", null);
}

/**
 * Lista a transição espelho que o DB faz: dada a tabela, devolve os
 * comentários dos triggers associados. Meramente documentação em runtime
 * pra tests/debug.
 */
export function describeSoftDeleteProtection(table: SoftDeleteTable): {
  table: SoftDeleteTable;
  triggers: readonly string[];
  constraint: string;
  partialIndexes: readonly string[];
} {
  const base = {
    triggers: [
      `trg_prevent_hard_delete_${table}`,
      `trg_enforce_soft_delete_${table}`,
    ] as const,
    constraint: `${table}_soft_delete_reason_chk`,
  };
  switch (table) {
    case "appointments":
      return {
        table,
        ...base,
        partialIndexes: [
          "idx_appointments_active_scheduled",
          "idx_appointments_active_doctor_scheduled",
          "idx_appointments_active_customer_scheduled",
        ],
      };
    case "fulfillments":
      return {
        table,
        ...base,
        partialIndexes: [
          "idx_fulfillments_active_status",
          "idx_fulfillments_active_doctor",
          "idx_fulfillments_active_customer",
        ],
      };
    case "doctor_earnings":
      return {
        table,
        ...base,
        partialIndexes: ["idx_doctor_earnings_active_doctor_status"],
      };
    case "doctor_payouts":
      return {
        table,
        ...base,
        partialIndexes: ["idx_doctor_payouts_active_doctor_status"],
      };
  }
}
