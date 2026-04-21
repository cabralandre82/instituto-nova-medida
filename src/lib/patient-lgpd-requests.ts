/**
 * src/lib/patient-lgpd-requests.ts — PR-017 · D-051 · Onda 2A
 *
 * Lib de orquestração das solicitações LGPD feitas pelo próprio
 * paciente na área logada. Lê e escreve em `lgpd_requests` (migration
 * 20260430000000).
 *
 * Regras:
 *
 *   1. Paciente anonimizado não pode criar nova solicitação — o único
 *      caminho é o operador (humanamente raro; se surgir, usa o
 *      endpoint admin direto).
 *
 *   2. No máximo 1 solicitação pendente por (customer, kind). Enforced
 *      por unique index parcial SQL. Esta lib tratará 23505 como
 *      "already pending" e retorna sem erro.
 *
 *   3. `createLgpdRequest(kind='export_copy')` só serve para auditoria
 *      — o próprio endpoint de export já entregou o JSON. A lib cria
 *      o row já como `fulfilled`. Para `kind='anonymize'`, o row vira
 *      `pending` aguardando operador.
 *
 *   4. `fulfillAnonymizeRequest` é chamado pelo admin e:
 *      - chama `anonymizePatient()` (mesmo caminho do endpoint admin),
 *      - se sucesso, marca o request `fulfilled`,
 *      - se falha por fulfillment ativo, mantém pending e devolve a
 *        mensagem específica.
 *      - `logAdminAction` é responsabilidade da rota admin; esta lib
 *        não loga pra manter pureza testável.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { anonymizePatient } from "./patient-lgpd";

// ────────────────────────────────────────────────────────────────────────
// Tipos
// ────────────────────────────────────────────────────────────────────────

export type LgpdRequestKind = "export_copy" | "anonymize";
export type LgpdRequestStatus =
  | "pending"
  | "fulfilled"
  | "rejected"
  | "cancelled";

export type LgpdRequestRecord = {
  id: string;
  customer_id: string;
  kind: LgpdRequestKind;
  status: LgpdRequestStatus;
  requested_at: string;
  fulfilled_at: string | null;
  rejected_reason: string | null;
  cancelled_at: string | null;
  fulfilled_by_user_id: string | null;
  rejected_by_user_id: string | null;
  requester_ip: string | null;
  requester_user_agent: string | null;
  export_bytes: number | null;
  created_at: string;
  updated_at: string;
};

export type RequestContext = {
  /** IP do paciente. Suporta null (desconhecido), string crua ou IPv4/IPv6. */
  ip?: string | null;
  userAgent?: string | null;
};

export type CreateExportAuditInput = {
  customerId: string;
  exportBytes: number;
} & RequestContext;

export type CreateAnonymizeInput = {
  customerId: string;
} & RequestContext;

export type CreateResult =
  | {
      ok: true;
      requestId: string;
      created: true;
      alreadyPending: false;
    }
  | {
      ok: true;
      requestId: string;
      created: false;
      alreadyPending: true;
    }
  | {
      ok: false;
      code:
        | "customer_not_found"
        | "customer_anonymized"
        | "insert_failed";
      message: string;
    };

// ────────────────────────────────────────────────────────────────────────
// Guards comuns
// ────────────────────────────────────────────────────────────────────────

async function loadCustomerStatus(
  supabase: SupabaseClient,
  customerId: string
): Promise<
  | { ok: true; anonymized: boolean }
  | { ok: false; code: "customer_not_found"; message: string }
> {
  const { data } = await supabase
    .from("customers")
    .select("id, anonymized_at")
    .eq("id", customerId)
    .maybeSingle();
  if (!data) {
    return {
      ok: false,
      code: "customer_not_found",
      message: "Paciente não encontrado.",
    };
  }
  const anonymized =
    (data as { anonymized_at?: string | null }).anonymized_at != null;
  return { ok: true, anonymized };
}

function isUniqueViolation(error: { code?: string } | null | undefined): boolean {
  return error?.code === "23505";
}

// ────────────────────────────────────────────────────────────────────────
// createExportAudit — registra o export JSON que acabou de ser entregue.
// ────────────────────────────────────────────────────────────────────────
// Filosofia: export é síncrono (GET retorna o JSON no ato). Esta lib
// só registra o rastro para trilha LGPD. Se o insert falhar, NÃO
// bloqueamos o paciente — loga e continua. O paciente não pode ser
// privado de seus dados por uma indisponibilidade de audit.

export async function createExportAudit(
  supabase: SupabaseClient,
  input: CreateExportAuditInput
): Promise<
  | { ok: true; requestId: string }
  | { ok: false; code: "insert_failed"; message: string }
> {
  const { data, error } = await supabase
    .from("lgpd_requests")
    .insert({
      customer_id: input.customerId,
      kind: "export_copy",
      status: "fulfilled",
      fulfilled_at: new Date().toISOString(),
      requester_ip: input.ip ?? null,
      requester_user_agent: input.userAgent ?? null,
      export_bytes: input.exportBytes,
    })
    .select("id")
    .single();

  if (error || !data) {
    return {
      ok: false,
      code: "insert_failed",
      message: error?.message ?? "insert returned no row",
    };
  }
  return { ok: true, requestId: (data as { id: string }).id };
}

// ────────────────────────────────────────────────────────────────────────
// createAnonymizeRequest — paciente pede anonimização; fica pending.
// ────────────────────────────────────────────────────────────────────────

export async function createAnonymizeRequest(
  supabase: SupabaseClient,
  input: CreateAnonymizeInput
): Promise<CreateResult> {
  const status = await loadCustomerStatus(supabase, input.customerId);
  if (!status.ok) return status;

  if (status.anonymized) {
    return {
      ok: false,
      code: "customer_anonymized",
      message:
        "Paciente já foi anonimizado; nova solicitação não é aplicável.",
    };
  }

  const { data, error } = await supabase
    .from("lgpd_requests")
    .insert({
      customer_id: input.customerId,
      kind: "anonymize",
      status: "pending",
      requester_ip: input.ip ?? null,
      requester_user_agent: input.userAgent ?? null,
    })
    .select("id")
    .single();

  if (error) {
    if (isUniqueViolation(error)) {
      // Lost race com request idêntico concorrente — recupera o
      // pending existente pra devolver ao paciente.
      const { data: existing } = await supabase
        .from("lgpd_requests")
        .select("id")
        .eq("customer_id", input.customerId)
        .eq("kind", "anonymize")
        .eq("status", "pending")
        .maybeSingle();
      if (existing) {
        return {
          ok: true,
          requestId: (existing as { id: string }).id,
          created: false,
          alreadyPending: true,
        };
      }
    }
    return {
      ok: false,
      code: "insert_failed",
      message: error.message,
    };
  }

  return {
    ok: true,
    requestId: (data as { id: string }).id,
    created: true,
    alreadyPending: false,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Listagem para UI do paciente e para admin inbox
// ────────────────────────────────────────────────────────────────────────

export async function listLgpdRequestsForCustomer(
  supabase: SupabaseClient,
  customerId: string,
  limit = 20
): Promise<LgpdRequestRecord[]> {
  const { data } = await supabase
    .from("lgpd_requests")
    .select(
      "id, customer_id, kind, status, requested_at, fulfilled_at, rejected_reason, cancelled_at, fulfilled_by_user_id, rejected_by_user_id, requester_ip, requester_user_agent, export_bytes, created_at, updated_at"
    )
    .eq("customer_id", customerId)
    .order("requested_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as LgpdRequestRecord[];
}

export async function getPendingAnonymizeRequest(
  supabase: SupabaseClient,
  customerId: string
): Promise<LgpdRequestRecord | null> {
  const { data } = await supabase
    .from("lgpd_requests")
    .select(
      "id, customer_id, kind, status, requested_at, fulfilled_at, rejected_reason, cancelled_at, fulfilled_by_user_id, rejected_by_user_id, requester_ip, requester_user_agent, export_bytes, created_at, updated_at"
    )
    .eq("customer_id", customerId)
    .eq("kind", "anonymize")
    .eq("status", "pending")
    .maybeSingle();
  return (data ?? null) as LgpdRequestRecord | null;
}

export async function countPendingAnonymizeRequests(
  supabase: SupabaseClient
): Promise<number> {
  const { count } = await supabase
    .from("lgpd_requests")
    .select("id", { count: "exact", head: true })
    .eq("kind", "anonymize")
    .eq("status", "pending");
  return count ?? 0;
}

// ────────────────────────────────────────────────────────────────────────
// cancelRequest — paciente desiste antes da triagem.
// ────────────────────────────────────────────────────────────────────────

export async function cancelLgpdRequest(
  supabase: SupabaseClient,
  params: { requestId: string; customerId: string }
): Promise<
  | { ok: true; cancelled: boolean }
  | { ok: false; code: "not_found" | "not_pending"; message: string }
> {
  const { data: current } = await supabase
    .from("lgpd_requests")
    .select("id, customer_id, status")
    .eq("id", params.requestId)
    .maybeSingle();
  if (!current) {
    return { ok: false, code: "not_found", message: "Pedido não encontrado." };
  }
  if ((current as { customer_id: string }).customer_id !== params.customerId) {
    // Não revelamos ao caller que existe com outro owner — trata como not_found.
    return { ok: false, code: "not_found", message: "Pedido não encontrado." };
  }
  if ((current as { status: string }).status !== "pending") {
    return {
      ok: false,
      code: "not_pending",
      message: "Pedido já foi atendido, recusado ou cancelado.",
    };
  }
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("lgpd_requests")
    .update({
      status: "cancelled",
      cancelled_at: now,
      updated_at: now,
    })
    .eq("id", params.requestId)
    // optimistic: só cancela se ainda está pending
    .eq("status", "pending");
  if (error) {
    return { ok: false, code: "not_pending", message: error.message };
  }
  return { ok: true, cancelled: true };
}

// ────────────────────────────────────────────────────────────────────────
// fulfillAnonymizeRequest — admin triagem e executa.
// ────────────────────────────────────────────────────────────────────────

export type FulfillInput = {
  requestId: string;
  adminUserId: string;
  /** Força execução mesmo com fulfillment ativo (raro; exige justificativa escrita). */
  force?: boolean;
};

export type FulfillResult =
  | {
      ok: true;
      requestId: string;
      customerId: string;
      anonymizedAt: string;
      anonymizedRef: string;
    }
  | {
      ok: false;
      code:
        | "not_found"
        | "not_pending"
        | "customer_not_found"
        | "already_anonymized"
        | "has_active_fulfillment"
        | "update_failed";
      message: string;
    };

export async function fulfillAnonymizeRequest(
  supabase: SupabaseClient,
  input: FulfillInput
): Promise<FulfillResult> {
  const { data: req } = await supabase
    .from("lgpd_requests")
    .select("id, customer_id, kind, status")
    .eq("id", input.requestId)
    .maybeSingle();
  if (!req) {
    return { ok: false, code: "not_found", message: "Pedido não encontrado." };
  }
  const record = req as {
    id: string;
    customer_id: string;
    kind: string;
    status: string;
  };
  if (record.kind !== "anonymize") {
    return {
      ok: false,
      code: "not_found",
      message: "Pedido não é de anonimização.",
    };
  }
  if (record.status !== "pending") {
    return {
      ok: false,
      code: "not_pending",
      message: `Pedido já está '${record.status}'.`,
    };
  }

  const anon = await anonymizePatient(supabase, record.customer_id, {
    force: input.force === true,
  });
  if (!anon.ok) {
    // Mantém pending pra retry. Repassamos o motivo específico.
    return anon;
  }

  const now = new Date().toISOString();
  const { error: updErr } = await supabase
    .from("lgpd_requests")
    .update({
      status: "fulfilled",
      fulfilled_at: now,
      fulfilled_by_user_id: input.adminUserId,
      updated_at: now,
    })
    .eq("id", input.requestId)
    .eq("status", "pending");
  if (updErr) {
    // Paciente já foi anonimizado (irreversível). Logamos mas devolvemos
    // sucesso com warning — a ação principal foi concluída.
    console.error(
      "[lgpd-requests] anonymize aplicado mas request update falhou:",
      updErr.message
    );
  }

  return {
    ok: true,
    requestId: input.requestId,
    customerId: record.customer_id,
    anonymizedAt: anon.anonymizedAt,
    anonymizedRef: anon.anonymizedRef,
  };
}

// ────────────────────────────────────────────────────────────────────────
// rejectAnonymizeRequest — admin recusa com motivo.
// ────────────────────────────────────────────────────────────────────────

export async function rejectAnonymizeRequest(
  supabase: SupabaseClient,
  params: {
    requestId: string;
    adminUserId: string;
    reason: string;
  }
): Promise<
  | { ok: true; customerId: string }
  | {
      ok: false;
      code: "not_found" | "not_pending" | "update_failed";
      message: string;
    }
> {
  if (!params.reason.trim()) {
    return {
      ok: false,
      code: "update_failed",
      message: "Motivo de recusa é obrigatório.",
    };
  }
  const { data: req } = await supabase
    .from("lgpd_requests")
    .select("id, status, customer_id")
    .eq("id", params.requestId)
    .maybeSingle();
  if (!req) {
    return { ok: false, code: "not_found", message: "Pedido não encontrado." };
  }
  const reqRow = req as { status: string; customer_id: string };
  if (reqRow.status !== "pending") {
    return {
      ok: false,
      code: "not_pending",
      message: `Pedido não está pendente.`,
    };
  }
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("lgpd_requests")
    .update({
      status: "rejected",
      rejected_reason: params.reason.trim(),
      rejected_by_user_id: params.adminUserId,
      updated_at: now,
    })
    .eq("id", params.requestId)
    .eq("status", "pending");
  if (error) {
    return { ok: false, code: "update_failed", message: error.message };
  }
  return { ok: true, customerId: reqRow.customer_id };
}
