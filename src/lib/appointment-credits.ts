/**
 * src/lib/appointment-credits.ts — PR-073 · D-081 · finding 2.4
 *
 * Gerencia a tabela `appointment_credits` (migration 20260516000000),
 * que formaliza o direito a reagendamento gratuito quando:
 *
 *   - a médica não comparece (`appointments.status='no_show_doctor'`);
 *   - a sala expira sem participantes
 *     (`cancelled_by_admin` + `cancelled_reason='expired_no_one_joined'`
 *     → risco da plataforma).
 *
 * Ciclo de vida canônico (todas as transições são funções puras
 * refletidas em CHECK constraints + trigger de imutabilidade):
 *
 *     active ──► consumed   (admin cria novo appointment)
 *            │
 *            ├─► expired    (passou `expires_at`; "expired" pode ser
 *            │               computado on-read ou persistido por cron
 *            │               futuro PR-073-B)
 *            │
 *            └─► cancelled  (admin descarta explicitamente com razão)
 *
 *   consumed e cancelled são **terminais** — nenhum caller pode retornar
 *   pra active.
 *
 * Conceitos importantes de implementação:
 *
 *   - **Idempotência**: `grantNoShowCredit` trata colisão 23505 no
 *     UNIQUE partial `ux_appointment_credits_source_active` como
 *     `alreadyExisted: true`. Chamadas repetidas a partir de
 *     `applyNoShowPolicy` (retries, webhooks duplicados, bug na
 *     orquestração) nunca duplicam.
 *
 *   - **Fail-soft**: funções devolvem discriminated unions
 *     `{ ok:true, ... } | { ok:false, error:"..." }`. Nunca `throw`
 *     em caminho de produção — o caller decide se loga e continua.
 *     Crédito é *benefício ao paciente*; se o INSERT falhar, a
 *     política financeira (clawback + refund_required) já foi
 *     aplicada e o admin vê na trilha de reliability. Pior caso =
 *     paciente volta via WhatsApp e admin emite manualmente.
 *
 *   - **Status computado**: `computeCurrentStatus(row, now)` devolve
 *     `'expired'` quando `row.status='active'` mas
 *     `expires_at <= now`. Isso mantém o watchdog administrativo
 *     honesto até existir um cron dedicado de expiração.
 *
 *   - **Privacidade**: a tabela só é lida via `service_role`. Nunca
 *     expõe nada ao cliente; quem renderiza pro paciente é
 *     `patient-quick-links.ts` (D-080), projetando os campos
 *     seguros.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "./logger";
import type { ActorSnapshot } from "./actor-snapshot";

const log = logger.with({ mod: "appointment-credits" });

// ────────────────────────────────────────────────────────────────────
// Constantes de política
// ────────────────────────────────────────────────────────────────────

/**
 * Janela de validade do crédito. 90 dias é conservador:
 *   - suficiente pra cobrir férias/feriados prolongados;
 *   - curto o bastante pra evitar "crédito zumbi" de 2 anos atrás
 *     quando a médica que atendia já nem está mais na clínica.
 * Trade-off explícito em D-081.
 */
export const CREDIT_EXPIRY_DAYS = 90;

/** Razões aceitas pela CHECK constraint. Ordem = precedência de display. */
export const CREDIT_REASONS = [
  "no_show_doctor",
  "cancelled_by_admin_expired",
] as const;
export type AppointmentCreditReason = (typeof CREDIT_REASONS)[number];

/** Status persistidos em DB (compute-on-read também retorna 'expired'). */
export const CREDIT_STATUSES = [
  "active",
  "consumed",
  "expired",
  "cancelled",
] as const;
export type AppointmentCreditStatus = (typeof CREDIT_STATUSES)[number];

// ────────────────────────────────────────────────────────────────────
// Tipos de row
// ────────────────────────────────────────────────────────────────────

export type AppointmentCreditRow = {
  id: string;
  customer_id: string;
  source_appointment_id: string;
  source_reason: AppointmentCreditReason;
  status: AppointmentCreditStatus;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  consumed_appointment_id: string | null;
  consumed_by: string | null;
  consumed_by_email: string | null;
  cancelled_at: string | null;
  cancelled_reason: string | null;
  cancelled_by: string | null;
  cancelled_by_email: string | null;
  metadata: Record<string, unknown>;
};

// ────────────────────────────────────────────────────────────────────
// Helpers puros
// ────────────────────────────────────────────────────────────────────

/** Default `now` consistente por chamada (facilita teste determinístico). */
function nowOr(n?: Date | string): Date {
  if (!n) return new Date();
  if (n instanceof Date) return n;
  return new Date(n);
}

function toIso(d: Date | string): string {
  if (typeof d === "string") return d;
  return d.toISOString();
}

function addDays(base: Date, days: number): Date {
  const copy = new Date(base.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

/**
 * Calcula o status efetivo considerando expiração. Se a row está
 * `active` mas o `expires_at` já passou, devolve `expired` — o DB
 * pode estar defasado (cron de sweep ainda não rodou) mas o
 * consumidor precisa da verdade temporal.
 */
export function computeCurrentStatus(
  row: Pick<AppointmentCreditRow, "status" | "expires_at">,
  now: Date | string = new Date(),
): AppointmentCreditStatus {
  if (row.status !== "active") return row.status;
  const nowD = nowOr(now);
  try {
    if (new Date(row.expires_at).getTime() <= nowD.getTime()) {
      return "expired";
    }
  } catch {
    return row.status;
  }
  return "active";
}

export function isCreditActive(
  row: Pick<AppointmentCreditRow, "status" | "expires_at">,
  now: Date | string = new Date(),
): boolean {
  return computeCurrentStatus(row, now) === "active";
}

/** Dias restantes até `expires_at`. Negativo se já expirou.
 *  `expires_at` mal formatado → 0 (defensivo: caller deve tratar como
 *  "expirado", jamais usar como "a vontade"). */
export function daysUntilExpiry(
  row: Pick<AppointmentCreditRow, "expires_at">,
  now: Date | string = new Date(),
): number {
  const nowD = nowOr(now);
  try {
    const exp = new Date(row.expires_at).getTime();
    if (!Number.isFinite(exp)) return 0;
    const diffMs = exp - nowD.getTime();
    return Math.floor(diffMs / (1000 * 60 * 60 * 24));
  } catch {
    return 0;
  }
}

// ────────────────────────────────────────────────────────────────────
// grantNoShowCredit — dispara em applyNoShowPolicy
// ────────────────────────────────────────────────────────────────────

export type GrantNoShowCreditInput = {
  supabase: SupabaseClient;
  customerId: string;
  sourceAppointmentId: string;
  reason: AppointmentCreditReason;
  /** Override do `now` pra teste determinístico. */
  now?: Date;
  /** Override opcional de validade (default CREDIT_EXPIRY_DAYS). */
  expiryDays?: number;
  /** Metadata estruturada; stringifica em INSERT. */
  metadata?: Record<string, unknown>;
};

export type GrantNoShowCreditResult =
  | {
      ok: true;
      credit: AppointmentCreditRow;
      alreadyExisted: boolean;
    }
  | {
      ok: false;
      error:
        | "invalid_customer_id"
        | "invalid_appointment_id"
        | "invalid_reason"
        | "insert_failed";
      message?: string;
    };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function grantNoShowCredit(
  input: GrantNoShowCreditInput,
): Promise<GrantNoShowCreditResult> {
  const { supabase, customerId, sourceAppointmentId, reason } = input;

  if (!customerId || !UUID_RE.test(customerId)) {
    return { ok: false, error: "invalid_customer_id" };
  }
  if (!sourceAppointmentId || !UUID_RE.test(sourceAppointmentId)) {
    return { ok: false, error: "invalid_appointment_id" };
  }
  if (!CREDIT_REASONS.includes(reason)) {
    return { ok: false, error: "invalid_reason" };
  }

  const now = nowOr(input.now);
  const expiryDays = Math.max(
    1,
    Math.min(365, input.expiryDays ?? CREDIT_EXPIRY_DAYS),
  );
  const expiresAt = addDays(now, expiryDays);

  const insertPayload = {
    customer_id: customerId,
    source_appointment_id: sourceAppointmentId,
    source_reason: reason,
    status: "active" as const,
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    metadata: input.metadata ?? {},
  };

  const { data, error } = await supabase
    .from("appointment_credits")
    .insert(insertPayload)
    .select("*")
    .single();

  if (!error && data) {
    return {
      ok: true,
      credit: data as AppointmentCreditRow,
      alreadyExisted: false,
    };
  }

  // Idempotência: UNIQUE partial colidiu → já existe crédito ativo
  // pro mesmo source_appointment_id. Lê e devolve.
  if (error && (error as { code?: string }).code === "23505") {
    const { data: existing, error: selErr } = await supabase
      .from("appointment_credits")
      .select("*")
      .eq("source_appointment_id", sourceAppointmentId)
      .neq("status", "cancelled")
      .maybeSingle();

    if (!selErr && existing) {
      return {
        ok: true,
        credit: existing as AppointmentCreditRow,
        alreadyExisted: true,
      };
    }
    log.error("grantNoShowCredit · 23505 mas re-select falhou", {
      appointment_id: sourceAppointmentId,
      err: selErr?.message,
    });
    return {
      ok: false,
      error: "insert_failed",
      message: "unique_conflict_but_reselect_failed",
    };
  }

  log.error("grantNoShowCredit · insert falhou", {
    appointment_id: sourceAppointmentId,
    customer_id: customerId,
    err: error?.message,
  });
  return {
    ok: false,
    error: "insert_failed",
    message: error?.message,
  };
}

// ────────────────────────────────────────────────────────────────────
// listActiveCreditsForCustomer — dashboard do paciente
// ────────────────────────────────────────────────────────────────────

export type ListActiveCreditsInput = {
  supabase: SupabaseClient;
  customerId: string;
  now?: Date;
};

export type ActiveCreditSummary = {
  id: string;
  sourceAppointmentId: string;
  sourceReason: AppointmentCreditReason;
  createdAt: string;
  expiresAt: string;
  daysRemaining: number;
};

/**
 * Retorna só créditos realmente ativos (status='active' E ainda dentro
 * do prazo). Ordem: mais antigo primeiro (ordem de atendimento).
 *
 * Não lança. Erro devolve lista vazia + log.error — a UI continua.
 */
export async function listActiveCreditsForCustomer(
  input: ListActiveCreditsInput,
): Promise<ActiveCreditSummary[]> {
  const { supabase, customerId, now } = input;
  if (!customerId || !UUID_RE.test(customerId)) return [];

  const nowD = nowOr(now);
  const { data, error } = await supabase
    .from("appointment_credits")
    .select(
      "id, source_appointment_id, source_reason, created_at, expires_at, status",
    )
    .eq("customer_id", customerId)
    .eq("status", "active")
    .gt("expires_at", nowD.toISOString())
    .order("created_at", { ascending: true });

  if (error) {
    log.error("listActiveCreditsForCustomer", {
      customer_id: customerId,
      err: error.message,
    });
    return [];
  }

  const rows = (data ?? []) as Array<
    Pick<
      AppointmentCreditRow,
      "id" | "source_appointment_id" | "source_reason" | "created_at" | "expires_at" | "status"
    >
  >;

  return rows.map((r) => ({
    id: r.id,
    sourceAppointmentId: r.source_appointment_id,
    sourceReason: r.source_reason,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    daysRemaining: Math.max(0, daysUntilExpiry(r, nowD)),
  }));
}

// ────────────────────────────────────────────────────────────────────
// markCreditConsumed — admin marca que reagendou
// ────────────────────────────────────────────────────────────────────

export type MarkCreditConsumedInput = {
  supabase: SupabaseClient;
  creditId: string;
  consumedAppointmentId: string;
  actor: ActorSnapshot;
  now?: Date;
};

export type MarkCreditConsumedResult =
  | { ok: true; alreadyConsumed: boolean }
  | {
      ok: false;
      error:
        | "invalid_credit_id"
        | "invalid_appointment_id"
        | "not_found"
        | "not_active"
        | "db_error";
      message?: string;
    };

export async function markCreditConsumed(
  input: MarkCreditConsumedInput,
): Promise<MarkCreditConsumedResult> {
  const { supabase, creditId, consumedAppointmentId, actor } = input;

  if (!creditId || !UUID_RE.test(creditId)) {
    return { ok: false, error: "invalid_credit_id" };
  }
  if (!consumedAppointmentId || !UUID_RE.test(consumedAppointmentId)) {
    return { ok: false, error: "invalid_appointment_id" };
  }

  const now = toIso(nowOr(input.now));
  // `actor.email` já vem normalizado (trim+lowercase) via
  // normalizeActorSnapshot; aqui só propagamos.
  const actorUserId =
    actor.kind === "system" ? null : (actor.userId ?? null);

  // Guard por status='active' evita sobrescrever um consumo anterior.
  const { data, error } = await supabase
    .from("appointment_credits")
    .update({
      status: "consumed",
      consumed_at: now,
      consumed_appointment_id: consumedAppointmentId,
      consumed_by: actorUserId,
      consumed_by_email: actor.email,
    })
    .eq("id", creditId)
    .eq("status", "active")
    .select("id")
    .maybeSingle();

  if (!error && data) {
    return { ok: true, alreadyConsumed: false };
  }

  if (error) {
    log.error("markCreditConsumed update falhou", {
      credit_id: creditId,
      err: error.message,
    });
    return { ok: false, error: "db_error", message: error.message };
  }

  // UPDATE não afetou row — ou não existe ou não está active. Diferencia
  // pra o caller distinguir idempotência (already consumed) de bug.
  const { data: existing } = await supabase
    .from("appointment_credits")
    .select("status, consumed_appointment_id")
    .eq("id", creditId)
    .maybeSingle();

  if (!existing) return { ok: false, error: "not_found" };

  const row = existing as {
    status: AppointmentCreditStatus;
    consumed_appointment_id: string | null;
  };

  if (
    row.status === "consumed" &&
    row.consumed_appointment_id === consumedAppointmentId
  ) {
    return { ok: true, alreadyConsumed: true };
  }

  return {
    ok: false,
    error: "not_active",
    message: `status=${row.status}`,
  };
}

// ────────────────────────────────────────────────────────────────────
// cancelCredit — admin descarta manualmente
// ────────────────────────────────────────────────────────────────────

export type CancelCreditInput = {
  supabase: SupabaseClient;
  creditId: string;
  reason: string;
  actor: ActorSnapshot;
  now?: Date;
};

export type CancelCreditResult =
  | { ok: true; alreadyCancelled: boolean }
  | {
      ok: false;
      error:
        | "invalid_credit_id"
        | "invalid_reason"
        | "not_found"
        | "not_cancellable"
        | "db_error";
      message?: string;
    };

export async function cancelCredit(
  input: CancelCreditInput,
): Promise<CancelCreditResult> {
  const { supabase, creditId, actor } = input;

  if (!creditId || !UUID_RE.test(creditId)) {
    return { ok: false, error: "invalid_credit_id" };
  }
  const reason = (input.reason ?? "").trim();
  if (reason.length < 4 || reason.length > 500) {
    return { ok: false, error: "invalid_reason" };
  }

  const now = toIso(nowOr(input.now));
  const actorUserId =
    actor.kind === "system" ? null : (actor.userId ?? null);

  const { data, error } = await supabase
    .from("appointment_credits")
    .update({
      status: "cancelled",
      cancelled_at: now,
      cancelled_reason: reason,
      cancelled_by: actorUserId,
      cancelled_by_email: actor.email,
    })
    .eq("id", creditId)
    .eq("status", "active")
    .select("id")
    .maybeSingle();

  if (!error && data) {
    return { ok: true, alreadyCancelled: false };
  }

  if (error) {
    log.error("cancelCredit update falhou", {
      credit_id: creditId,
      err: error.message,
    });
    return { ok: false, error: "db_error", message: error.message };
  }

  const { data: existing } = await supabase
    .from("appointment_credits")
    .select("status")
    .eq("id", creditId)
    .maybeSingle();

  if (!existing) return { ok: false, error: "not_found" };
  const row = existing as { status: AppointmentCreditStatus };
  if (row.status === "cancelled") {
    return { ok: true, alreadyCancelled: true };
  }
  return {
    ok: false,
    error: "not_cancellable",
    message: `status=${row.status}`,
  };
}
