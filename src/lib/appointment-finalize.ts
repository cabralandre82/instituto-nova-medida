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
import { sanitizeFreeText } from "./text-sanitize";

// ────────────────────────────────────────────────────────────────────────
// Tipos
// ────────────────────────────────────────────────────────────────────────

export type PrescriptionDecision = "prescribed" | "declined";

// Limites pra campos clínicos livres. Ajustados pro caso clínico real
// (anamnese pode ser longa quando a médica cola relato; hipotese/conduta
// são mais concisas). Usados também como base das CHECK constraints no
// banco (migration `20260503000000_clinical_text_hardening.sql`).
export const APPOINTMENT_TEXT_LIMITS = {
  hipoteseMaxLen: 4000,
  hipoteseMaxLines: 80,
  condutaMaxLen: 4000,
  condutaMaxLines: 80,
  anamneseTextMaxLen: 16000,
  anamneseTextMaxLines: 400,
  /**
   * Limite do JSONB `anamnese` serializado (todos campos). Usado pro
   * CHECK (pg_column_size) no banco. Com folga pra evolução futura.
   */
  anamneseJsonMaxBytes: 32768,
} as const;

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

/**
 * Versão do payload após `validateFinalizeInput`. Campos de texto livre
 * passaram por `sanitizeFreeText` (controles removidos, linhas
 * normalizadas), e `anamnese.text` foi sanitizada (quando presente). É
 * essa forma que é gravada no banco.
 */
export type FinalizeInputSanitized = Omit<
  FinalizeInput,
  "hipotese" | "conduta" | "anamnese"
> & {
  hipotese: string | null;
  conduta: string | null;
  anamnese: Record<string, unknown> | null;
};

export type FinalizeValidationResult =
  | FinalizeFailure
  | { ok: true; sanitized: FinalizeInputSanitized };

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

function reasonMessageForClinicalField(
  field: "hipotese" | "conduta" | "anamnese",
  reason: "empty" | "too_long" | "too_many_lines" | "control_chars"
): string {
  const labels = {
    hipotese: "Hipótese",
    conduta: "Conduta",
    anamnese: "Anamnese",
  } as const;
  const label = labels[field];
  switch (reason) {
    case "empty":
      return `${label} inválida.`;
    case "too_long":
      return `${label} excede o tamanho permitido.`;
    case "too_many_lines":
      return `${label} tem muitas linhas. Condense ou divida em seções.`;
    case "control_chars":
      return `${label} contém caracteres não permitidos (controle, zero-width ou bidi override).`;
    default:
      return `${label} inválida.`;
  }
}

/**
 * Valida forma do payload + sanitiza campos de texto livre.
 *
 * Regras:
 *   - `decision` obrigatório.
 *   - Se prescribed: `prescribed_plan_id` e `memed_prescription_url`
 *     são obrigatórios. A URL precisa ser http(s).
 *   - `prescribed_plan_id` em formato UUID quando presente.
 *   - `hipotese` / `conduta`: texto livre multi-linha, ≤ 4000 chars e
 *     ≤ 80 linhas cada. Rejeita controles malignos (NULL, ESC, DEL,
 *     zero-width, bidi override, line/paragraph separator).
 *   - `anamnese`: jsonb opcional. Quando presente, é um objeto cujo
 *     único campo conhecido é `text` (string). O `text` também passa
 *     por `sanitizeFreeText` com limites mais generosos (16k / 400
 *     linhas). Campos extras no objeto são PRESERVADOS (schema futuro
 *     de anamnese estruturada), mas o JSON inteiro não pode exceder
 *     o limite total. Outras chaves-valor não são sanitizadas aqui —
 *     virá em iteração futura quando o schema estruturado existir.
 *
 * Retorno: em sucesso, devolve `{ ok: true, sanitized }` com os textos
 * já normalizados (NFC, trim right por linha, collapse de blank runs).
 * É essa forma sanitizada que é gravada.
 */
export function validateFinalizeInput(
  input: FinalizeInput
): FinalizeValidationResult {
  if (input.decision !== "prescribed" && input.decision !== "declined") {
    return {
      ok: false,
      code: "invalid_payload",
      message: "Decisão da consulta é obrigatória (prescribed ou declined).",
      field: "decision",
    };
  }

  // ───────── Sanitização de texto livre (PR-036-B · D-055) ─────────
  const hipoteseResult = sanitizeFreeText(input.hipotese ?? "", {
    maxLen: APPOINTMENT_TEXT_LIMITS.hipoteseMaxLen,
    maxLines: APPOINTMENT_TEXT_LIMITS.hipoteseMaxLines,
    allowEmpty: true,
  });
  if (!hipoteseResult.ok) {
    return {
      ok: false,
      code: "invalid_payload",
      message: reasonMessageForClinicalField("hipotese", hipoteseResult.reason),
      field: "hipotese",
    };
  }
  const hipoteseSanitized = hipoteseResult.value || null;

  const condutaResult = sanitizeFreeText(input.conduta ?? "", {
    maxLen: APPOINTMENT_TEXT_LIMITS.condutaMaxLen,
    maxLines: APPOINTMENT_TEXT_LIMITS.condutaMaxLines,
    allowEmpty: true,
  });
  if (!condutaResult.ok) {
    return {
      ok: false,
      code: "invalid_payload",
      message: reasonMessageForClinicalField("conduta", condutaResult.reason),
      field: "conduta",
    };
  }
  const condutaSanitized = condutaResult.value || null;

  let anamneseSanitized: Record<string, unknown> | null = null;
  if (input.anamnese !== null && input.anamnese !== undefined) {
    if (
      typeof input.anamnese !== "object" ||
      Array.isArray(input.anamnese)
    ) {
      return {
        ok: false,
        code: "invalid_payload",
        message: "Anamnese precisa ser um objeto.",
        field: "anamnese",
      };
    }
    const rawAnamnese = input.anamnese as Record<string, unknown>;
    // Hoje só `text` é consumido pela UI. Sanitiza-o; preserva o resto
    // (o schema pode evoluir no futuro, mas sem bypassar a CHECK de
    // tamanho total no banco).
    const nextAnamnese: Record<string, unknown> = { ...rawAnamnese };
    if (
      rawAnamnese.text !== undefined &&
      rawAnamnese.text !== null &&
      rawAnamnese.text !== ""
    ) {
      const textResult = sanitizeFreeText(rawAnamnese.text, {
        maxLen: APPOINTMENT_TEXT_LIMITS.anamneseTextMaxLen,
        maxLines: APPOINTMENT_TEXT_LIMITS.anamneseTextMaxLines,
        allowEmpty: true,
      });
      if (!textResult.ok) {
        return {
          ok: false,
          code: "invalid_payload",
          message: reasonMessageForClinicalField(
            "anamnese",
            textResult.reason
          ),
          field: "anamnese",
        };
      }
      nextAnamnese.text = textResult.value;
    }
    // Defesa adicional: pgbyteasize-lite. Se o JSON serializado passou
    // do limite pré-banco (32KB), rejeita antes de hit no CHECK.
    try {
      const serialized = JSON.stringify(nextAnamnese);
      if (
        Buffer.byteLength(serialized, "utf8") >
        APPOINTMENT_TEXT_LIMITS.anamneseJsonMaxBytes
      ) {
        return {
          ok: false,
          code: "invalid_payload",
          message: reasonMessageForClinicalField("anamnese", "too_long"),
          field: "anamnese",
        };
      }
    } catch {
      return {
        ok: false,
        code: "invalid_payload",
        message: "Anamnese não serializável.",
        field: "anamnese",
      };
    }
    anamneseSanitized = nextAnamnese;
  }

  const baseSanitized: FinalizeInputSanitized = {
    ...input,
    hipotese: hipoteseSanitized,
    conduta: condutaSanitized,
    anamnese: anamneseSanitized,
  };

  if (input.decision === "declined") {
    return { ok: true, sanitized: baseSanitized };
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

  return { ok: true, sanitized: baseSanitized };
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
    /**
     * Email da médica no momento da finalização. Gravado como
     * snapshot em `fulfillments.updated_by_email` quando criarmos
     * o fulfillment (PR-064 · D-072). Null se legacy/desconhecido.
     */
    userEmail?: string | null;
    input: FinalizeInput;
    now?: Date;
  }
): Promise<FinalizeResult> {
  const validation = validateFinalizeInput(params.input);
  if (!validation.ok) return validation;
  const sanitizedInput = validation.sanitized;

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
  if (sanitizedInput.decision === "prescribed") {
    const planRes = await supabase
      .from("plans")
      .select("id, slug, active")
      .eq("id", sanitizedInput.prescribed_plan_id as string)
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

  if (sanitizedInput.decision === "prescribed") {
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
      // Snapshot de email da médica (PR-064 · D-072).
      const finalizeActorEmail =
        typeof params.userEmail === "string" &&
        params.userEmail.trim().length > 0
          ? params.userEmail.trim().toLowerCase()
          : null;
      const insertRes = await supabase
        .from("fulfillments")
        .insert({
          appointment_id: appt.id,
          customer_id: appt.customer_id,
          doctor_id: appt.doctor_id,
          plan_id: sanitizedInput.prescribed_plan_id,
          status: "pending_acceptance",
          updated_by_user_id: params.userId,
          updated_by_email: finalizeActorEmail,
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
    prescription_status: sanitizedInput.decision,
    status: nextStatus,
    updated_at: now,
    anamnese: sanitizedInput.anamnese,
    hipotese: sanitizedInput.hipotese,
    conduta: sanitizedInput.conduta,
  };

  if (sanitizedInput.decision === "prescribed") {
    patch.prescribed_plan_id = sanitizedInput.prescribed_plan_id;
    patch.memed_prescription_url = sanitizedInput.memed_prescription_url;
    patch.memed_prescription_id = sanitizedInput.memed_prescription_id ?? null;
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
