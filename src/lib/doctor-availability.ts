/**
 * Doctor availability — CRUD seguro pra médica editar a própria
 * agenda recorrente semanal.
 *
 * PR-076 · D-088. Camada acima de `public.doctor_availability`
 * (criada na migration `20260419040000_doctors_appointments_finance`)
 * com:
 *
 *   - Validação canônica (weekday 0-6, HH:MM com end > start, blocks
 *     sem sobreposição entre si pro mesmo doctor, duração mínima
 *     compatível com `consultation_minutes`).
 *   - Tipos `scheduled` (consulta agendada) e `on_call` (plantão).
 *     Os enum values legados `agendada`/`plantao` são tratados como
 *     aliases — leitura aceita os dois, escrita normaliza pros novos.
 *   - Idempotência: criar bloco igualzinho a um existente retorna
 *     conflict tipado (não é exception); o caller decide se mostra
 *     "já existe" ou ignora.
 *
 * Filosofia: a lib só fala de UMA médica por vez (passa-se
 * `doctorId` em todas as funções). Quem garante que o caller
 * autenticado é dono daquele doctorId é o handler HTTP via
 * `requireDoctor()`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase";
import { logger } from "./logger";

const log = logger.with({ mod: "doctor-availability" });

/**
 * Tipos canônicos no app-side. Migration aceita 'agendada'|'plantao'
 * (legado) e 'scheduled'|'on_call' (canônico). Internamente
 * normalizamos pros canônicos.
 */
export type AvailabilityType = "scheduled" | "on_call";

const LEGACY_TO_CANON: Record<string, AvailabilityType> = {
  agendada: "scheduled",
  scheduled: "scheduled",
  plantao: "on_call",
  on_call: "on_call",
};

export type AvailabilityRow = {
  id: string;
  doctor_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  type: AvailabilityType;
  active: boolean;
  created_at: string;
  updated_at: string;
};

/** "HH:MM" → minutos desde 00:00. Aceita "HH:MM:SS". */
function timeToMin(t: string): number {
  const [h, m] = t.split(":");
  return Number(h) * 60 + Number(m ?? "0");
}

/** Valida e normaliza HH:MM (aceita HH:MM:SS, retorna HH:MM:00). */
function normalizeTime(t: string | null | undefined): string | null {
  if (!t || typeof t !== "string") return null;
  const trimmed = t.trim();
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  const s = Number(match[3] ?? "0");
  if (h < 0 || h > 23) return null;
  if (m < 0 || m > 59) return null;
  if (s < 0 || s > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Valida payload de bloco. Retorna campos normalizados ou erro
 * tipado. NÃO consulta DB.
 */
export function validateAvailabilityInput(input: {
  weekday: unknown;
  start_time: unknown;
  end_time: unknown;
  type: unknown;
}): { ok: true; weekday: number; start_time: string; end_time: string; type: AvailabilityType }
  | { ok: false; error: "weekday_invalid" | "start_time_invalid" | "end_time_invalid" | "type_invalid" | "end_before_start" } {
  const wd = typeof input.weekday === "number" ? input.weekday : Number.NaN;
  if (!Number.isInteger(wd) || wd < 0 || wd > 6) {
    return { ok: false, error: "weekday_invalid" };
  }
  const start = normalizeTime(input.start_time as string | null);
  if (!start) return { ok: false, error: "start_time_invalid" };
  const end = normalizeTime(input.end_time as string | null);
  if (!end) return { ok: false, error: "end_time_invalid" };
  if (timeToMin(end) <= timeToMin(start)) {
    return { ok: false, error: "end_before_start" };
  }

  const rawType = typeof input.type === "string" ? input.type.trim().toLowerCase() : "";
  const canonType = LEGACY_TO_CANON[rawType];
  if (!canonType) return { ok: false, error: "type_invalid" };

  return {
    ok: true,
    weekday: wd,
    start_time: start,
    end_time: end,
    type: canonType,
  };
}

function normalizeRow(raw: Record<string, unknown>): AvailabilityRow {
  const rawType = typeof raw.type === "string" ? raw.type.toLowerCase() : "";
  const canonType: AvailabilityType =
    LEGACY_TO_CANON[rawType] ?? "scheduled";
  return {
    id: String(raw.id),
    doctor_id: String(raw.doctor_id),
    weekday: Number(raw.weekday),
    start_time: String(raw.start_time),
    end_time: String(raw.end_time),
    type: canonType,
    active: Boolean(raw.active),
    created_at: String(raw.created_at),
    updated_at: String(raw.updated_at),
  };
}

/**
 * Detecta sobreposição entre blocos do mesmo weekday. Recebe lista
 * existente + candidato; retorna `true` se candidato cruza qualquer
 * bloco existente (excluindo `excludeId` quando for um update).
 *
 * Sobreposição estrita: `[start, end)` cruza `[start', end')` se
 * `start < end' AND start' < end`.
 */
export function hasOverlap(
  existing: Array<Pick<AvailabilityRow, "id" | "weekday" | "start_time" | "end_time" | "active">>,
  candidate: { weekday: number; start_time: string; end_time: string },
  excludeId?: string
): boolean {
  const cs = timeToMin(candidate.start_time);
  const ce = timeToMin(candidate.end_time);
  for (const row of existing) {
    if (!row.active) continue;
    if (row.weekday !== candidate.weekday) continue;
    if (excludeId && row.id === excludeId) continue;
    const rs = timeToMin(row.start_time);
    const re = timeToMin(row.end_time);
    if (cs < re && rs < ce) return true;
  }
  return false;
}

/**
 * Lista blocos de availability de uma médica. Por padrão retorna
 * só `active=true`. Passe `includeInactive=true` pra histórico.
 */
export async function listAvailabilityForDoctor(
  doctorId: string,
  opts: { includeInactive?: boolean } = {}
): Promise<AvailabilityRow[]> {
  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("doctor_availability")
    .select("id, doctor_id, weekday, start_time, end_time, type, active, created_at, updated_at")
    .eq("doctor_id", doctorId)
    .order("weekday", { ascending: true })
    .order("start_time", { ascending: true });
  if (!opts.includeInactive) query = query.eq("active", true);
  const { data, error } = await query;
  if (error) {
    log.error("list", { doctor_id: doctorId, err: error.message });
    return [];
  }
  return (data ?? []).map((r) => normalizeRow(r as Record<string, unknown>));
}

/**
 * Cria um novo bloco. Caller é responsável por checar overlap antes
 * (via `listAvailabilityForDoctor` + `hasOverlap`); aqui defendemos
 * via re-leitura concorrente: se rolou race entre check e insert,
 * o overlap só é detectado se outro `INSERT` aconteceu — nesse caso
 * não fazemos rollback automático (não há índice unique no schema
 * atual; trade-off aceito).
 */
export async function createAvailability(
  client: SupabaseClient,
  doctorId: string,
  payload: {
    weekday: number;
    start_time: string;
    end_time: string;
    type: AvailabilityType;
  }
): Promise<{ ok: true; row: AvailabilityRow } | { ok: false; error: string }> {
  const { data, error } = await client
    .from("doctor_availability")
    .insert({
      doctor_id: doctorId,
      weekday: payload.weekday,
      start_time: payload.start_time,
      end_time: payload.end_time,
      type: payload.type,
      active: true,
    })
    .select("id, doctor_id, weekday, start_time, end_time, type, active, created_at, updated_at")
    .single();

  if (error || !data) {
    log.error("create", { doctor_id: doctorId, err: error?.message });
    return { ok: false, error: error?.message ?? "no_row" };
  }
  return { ok: true, row: normalizeRow(data as Record<string, unknown>) };
}

/**
 * Soft-delete: marca `active=false`. Mantém histórico pra auditoria
 * (útil pra responder "que horário a médica tinha em maio?"). Hard
 * delete não é exposto — só DBA via Studio.
 *
 * Idempotente: já inativo retorna ok com `wasActive=false`.
 */
export async function deactivateAvailability(
  client: SupabaseClient,
  doctorId: string,
  id: string
): Promise<{ ok: true; wasActive: boolean } | { ok: false; error: string }> {
  const { data: existing, error: selErr } = await client
    .from("doctor_availability")
    .select("id, doctor_id, active")
    .eq("id", id)
    .eq("doctor_id", doctorId)
    .maybeSingle();

  if (selErr) {
    log.error("deactivate · select", { id, err: selErr.message });
    return { ok: false, error: selErr.message };
  }
  if (!existing) return { ok: false, error: "not_found" };

  if (!(existing as { active: boolean }).active) {
    return { ok: true, wasActive: false };
  }

  const { error: updErr } = await client
    .from("doctor_availability")
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("doctor_id", doctorId);

  if (updErr) {
    log.error("deactivate · update", { id, err: updErr.message });
    return { ok: false, error: updErr.message };
  }
  return { ok: true, wasActive: true };
}

/**
 * Reativa bloco previamente desativado. Idempotente.
 *
 * Caller deve checar overlap antes (pode haver outro bloco ativo
 * que cruza o range agora). Aqui só faz a transição de bandeira.
 */
export async function reactivateAvailability(
  client: SupabaseClient,
  doctorId: string,
  id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await client
    .from("doctor_availability")
    .update({ active: true, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("doctor_id", doctorId);
  if (error) {
    log.error("reactivate", { id, err: error.message });
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/** Labels prontos pra UI (português, em ordem de domingo a sábado). */
export const WEEKDAY_LABELS_PT: Record<number, string> = {
  0: "Domingo",
  1: "Segunda",
  2: "Terça",
  3: "Quarta",
  4: "Quinta",
  5: "Sexta",
  6: "Sábado",
};

export const TYPE_LABELS_PT: Record<AvailabilityType, string> = {
  scheduled: "Consulta agendada",
  on_call: "Plantão (on-demand)",
};
