/**
 * src/lib/appointment-finalize.ts — D-044 · onda 2.B
 *
 * Fonte única de verdade pro ato médico "finalizar consulta".
 *
 * Encapsula:
 *   - validação do payload (prescribed exige plano + URL Memed,
 *     declined aceita sem plano);
 *   - verificação de ownership (a médica só finaliza o que é dela);
 *   - proteção contra re-finalização (idempotência por
 *     `appointments.finalized_at` não-nulo);
 *   - criação idempotente do fulfillment quando há prescrição
 *     (unique(appointment_id) no banco + checagem prévia aqui);
 *   - transição natural de `appointments.status` pra `completed`
 *     quando faz sentido;
 *   - snapshot da decisão clínica em `anamnese`, `hipotese`,
 *     `conduta` e campos `memed_prescription_*`.
 *
 * A função é **server-only** (usa SupabaseClient com service role)
 * mas a lógica é suficientemente isolada pra ser testada com o
 * mock `createSupabaseMock` sem banco real.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// ────────────────────────────────────────────────────────────────────────
// Tipos
// ────────────────────────────────────────────────────────────────────────

export type PrescriptionDecision = "prescribed" | "declined";

/**
 * Payload que chega da UI. Campos opcionais viram null/undefined
 * no banco. `anamnese` aceita objeto livre (jsonb) — a UI hoje
 * manda `{ text: "..." }`, mas o formato fica aberto pra anamnese
 * estruturada no futuro sem migração.
 */
export type FinalizeInput = {
  decision: PrescriptionDecision;
  anamnese?: Record<string, unknown> | null;
  hipotese?: string | null;
  conduta?: string | null;
  // Só usados quando decision === 'prescribed'
  prescribed_plan_id?: string | null;
  memed_prescription_url?: string | null;
  memed_prescription_id?: string | null;
};

export type FinalizeSuccess = {
  ok: true;
  appointmentId: string;
  fulfillmentId: string | null;
  status: "completed";
  alreadyFinalized: false;
};

export type FinalizeFailure = {
  ok: false;
  code:
    | "not_found"
    | "forbidden"
    | "cancelled"
    | "already_finalized"
    | "invalid_payload"
    | "plan_not_active"
    | "db_error";
  message: string;
  field?: keyof FinalizeInput;
};

export type FinalizeResult = FinalizeSuccess | FinalizeFailure;

type AppointmentRow = {
  id: string;
  doctor_id: string;
  customer_id: string;
  status: string;
  finalized_at: string | null;
};

type PlanRow = {
  id: string;
  slug: string;
  active: boolean;
};

type FulfillmentRow = {
  id: string;
  appointment_id: string;
};

// ────────────────────────────────────────────────────────────────────────
// Helpers puros
// ────────────────────────────────────────────────────────────────────────

const CANCELLED_APPT_STATUSES = new Set([
  "cancelled",
  "cancelled_by_patient",
  "cancelled_by_doctor",
  "cancelled_by_admin",
]);

/**
 * Consulta que ainda deveria receber transição pra `completed` ao
 * finalizar. `no_show_*` e `completed` preservamos como estão.
 */
function shouldMarkCompleted(currentStatus: string): boolean {
  return (
    currentStatus === "scheduled" ||
    currentStatus === "confirmed" ||
    currentStatus === "in_progress"
  );
}

/**
 * Valida forma do payload. Checagens que não dependem do banco.
 *
 * Regras:
 *   - `decision` obrigatório.
 *   - Se prescribed: `prescribed_plan_id` e `memed_prescription_url`
 *     são obrigatórios. A URL precisa ser http(s).
 *   - `prescribed_plan_id` em formato UUID quando presente.
 *   - Campos de texto livre não podem exceder 8000 chars (evita
 *     payload maligno sem precisar de limite hard no banco).
 */
export function validateFinalizeInput(
  input: FinalizeInput
): FinalizeFailure | null {
  if (input.decision !== "prescribed" && input.decision !== "declined") {
    return {
      ok: false,
      code: "invalid_payload",
      message: "Decisão da consulta é obrigatória (prescribed ou declined).",
      field: "decision",
    };
  }

  const maxLen = 8000;
  if (typeof input.hipotese === "string" && input.hipotese.length > maxLen) {
    return {
      ok: false,
      code: "invalid_payload",
      message: "Hipótese excede 8000 caracteres.",
      field: "hipotese",
    };
  }
  if (typeof input.conduta === "string" && input.conduta.length > maxLen) {
    return {
      ok: false,
      code: "invalid_payload",
      message: "Conduta excede 8000 caracteres.",
      field: "conduta",
    };
  }

  if (input.decision === "declined") {
    return null;
  }

  // Aqui em diante: prescribed.
  if (!input.prescribed_plan_id || !isUuid(input.prescribed_plan_id)) {
    return {
      ok: false,
      code: "invalid_payload",
      message: "Para prescrever, selecione um plano válido.",
      field: "prescribed_plan_id",
    };
  }

  if (
    !input.memed_prescription_url ||
    !isHttpUrl(input.memed_prescription_url)
  ) {
    return {
      ok: false,
      code: "invalid_payload",
      message: "Cole a URL da receita Memed (https://...).",
      field: "memed_prescription_url",
    };
  }

  return null;
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    s
  );
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Orquestração principal
// ────────────────────────────────────────────────────────────────────────

/**
 * Finaliza uma consulta. Idempotente por design:
 *
 *   1. Se já há `finalized_at`, retorna `already_finalized` (409).
 *   2. Se há fulfillment existente pra esse appointment, NÃO cria
 *      outro (unique no banco blinda, mas checamos antes pra
 *      devolver ID coerente).
 *   3. O UPDATE só é aplicado depois do INSERT do fulfillment ter
 *      sucesso. Se o INSERT falhar, o appointment fica intacto.
 *
 * Observações:
 *   - Não fazemos transação SQL real (Supabase JS não tem begin/commit
 *     exposto). O risco é: fulfillment criado + UPDATE falha. Mitigação:
 *     a re-chamada vê fulfillment existente e segue pro UPDATE.
 *   - Quando `decision='declined'`, NÃO criamos fulfillment.
 */
export async function finalizeAppointment(
  supabase: SupabaseClient,
  params: {
    appointmentId: string;
    doctorId: string;
    userId: string | null;
    input: FinalizeInput;
    now?: Date;
  }
): Promise<FinalizeResult> {
  const validation = validateFinalizeInput(params.input);
  if (validation) return validation;

  // 1. Carrega appointment e valida ownership + estado
  const apptRes = await supabase
    .from("appointments")
    .select("id, doctor_id, customer_id, status, finalized_at")
    .eq("id", params.appointmentId)
    .maybeSingle();

  if (apptRes.error) {
    return {
      ok: false,
      code: "db_error",
      message: `Erro ao carregar consulta: ${apptRes.error.message}`,
    };
  }
  if (!apptRes.data) {
    return { ok: false, code: "not_found", message: "Consulta não encontrada." };
  }
  const appt = apptRes.data as AppointmentRow;

  if (appt.doctor_id !== params.doctorId) {
    return {
      ok: false,
      code: "forbidden",
      message: "Essa consulta não é da médica autenticada.",
    };
  }

  if (CANCELLED_APPT_STATUSES.has(appt.status)) {
    return {
      ok: false,
      code: "cancelled",
      message: "Consulta cancelada não pode ser finalizada.",
    };
  }

  if (appt.finalized_at) {
    return {
      ok: false,
      code: "already_finalized",
      message: `Consulta já finalizada em ${appt.finalized_at}.`,
    };
  }

  // 2. Se prescribed, valida plano ativo
  if (params.input.decision === "prescribed") {
    const planRes = await supabase
      .from("plans")
      .select("id, slug, active")
      .eq("id", params.input.prescribed_plan_id as string)
      .maybeSingle();
    if (planRes.error) {
      return {
        ok: false,
        code: "db_error",
        message: `Erro ao carregar plano: ${planRes.error.message}`,
      };
    }
    if (!planRes.data) {
      return {
        ok: false,
        code: "plan_not_active",
        message: "Plano indicado não existe.",
        field: "prescribed_plan_id",
      };
    }
    const plan = planRes.data as PlanRow;
    if (!plan.active) {
      return {
        ok: false,
        code: "plan_not_active",
        message: "Esse plano não está ativo no catálogo.",
        field: "prescribed_plan_id",
      };
    }
  }

  // 3. Upsert idempotente do fulfillment (só quando prescribed)
  let fulfillmentId: string | null = null;

  if (params.input.decision === "prescribed") {
    const existingRes = await supabase
      .from("fulfillments")
      .select("id, appointment_id")
      .eq("appointment_id", appt.id)
      .maybeSingle();

    if (existingRes.error) {
      return {
        ok: false,
        code: "db_error",
        message: `Erro ao checar fulfillment: ${existingRes.error.message}`,
      };
    }

    if (existingRes.data) {
      fulfillmentId = (existingRes.data as FulfillmentRow).id;
    } else {
      const insertRes = await supabase
        .from("fulfillments")
        .insert({
          appointment_id: appt.id,
          customer_id: appt.customer_id,
          doctor_id: appt.doctor_id,
          plan_id: params.input.prescribed_plan_id,
          status: "pending_acceptance",
          updated_by_user_id: params.userId,
        })
        .select("id")
        .single();

      if (insertRes.error || !insertRes.data) {
        return {
          ok: false,
          code: "db_error",
          message: `Erro ao criar fulfillment: ${
            insertRes.error?.message ?? "sem resposta"
          }`,
        };
      }
      fulfillmentId = (insertRes.data as { id: string }).id;
    }
  }

  // 4. Atualiza o appointment (fica imutável a partir daqui)
  const now = (params.now ?? new Date()).toISOString();
  const nextStatus = shouldMarkCompleted(appt.status) ? "completed" : appt.status;

  const patch: Record<string, unknown> = {
    finalized_at: now,
    prescription_status: params.input.decision,
    status: nextStatus,
    updated_at: now,
    anamnese: params.input.anamnese ?? null,
    hipotese: params.input.hipotese ?? null,
    conduta: params.input.conduta ?? null,
  };

  if (params.input.decision === "prescribed") {
    patch.prescribed_plan_id = params.input.prescribed_plan_id;
    patch.memed_prescription_url = params.input.memed_prescription_url;
    patch.memed_prescription_id = params.input.memed_prescription_id ?? null;
  } else {
    patch.prescribed_plan_id = null;
    patch.memed_prescription_url = null;
    patch.memed_prescription_id = null;
  }

  const updRes = await supabase
    .from("appointments")
    .update(patch)
    .eq("id", appt.id);

  if (updRes.error) {
    return {
      ok: false,
      code: "db_error",
      message: `Erro ao atualizar consulta: ${updRes.error.message}`,
    };
  }

  return {
    ok: true,
    appointmentId: appt.id,
    fulfillmentId,
    status: "completed",
    alreadyFinalized: false,
  };
}
