/**
 * Regras de confiabilidade da médica (D-036) — Instituto Nova Medida.
 *
 * Consome `doctor_reliability_events` (migration 015) pra:
 *
 *   1. Registrar incidentes vindo da política de no-show (D-032) em
 *      linhas individuais auditáveis (em vez de só incrementar
 *      `doctors.reliability_incidents`).
 *   2. Avaliar contagem de eventos ATIVOS (não dispensados) na janela
 *      de 30 dias e, ao atingir threshold hard, pausar a médica
 *      automaticamente.
 *   3. Permitir ao admin pausar, despausar e dispensar eventos
 *      individuais (ex: "foi bug da plataforma, não conta").
 *
 * Regras (parametrizadas via const — não configuração dinâmica, pra
 * garantir comportamento previsível e auditável via commit history):
 *
 *   - WINDOW_DAYS = 30
 *   - SOFT_WARN  = 2 eventos → alerta no dashboard admin, médica segue
 *     atendendo.
 *   - HARD_BLOCK = 3 eventos → auto-pause; médica sai de `/agendar`.
 *
 * Idempotência:
 *   - `recordReliabilityEvent` usa `unique(appointment_id)` parcial
 *     (migration 015). Re-execução via webhook + cron (D-035) não cria
 *     duplicata.
 *   - `pauseDoctor` é idempotente via guard em `reliability_paused_at`.
 *     Re-chamar com auto=true em médica já pausada manualmente não
 *     sobrescreve os metadados do pause manual (respeita "admin está
 *     no volante").
 *   - `unpauseDoctor` + `dismissEvent` são idempotentes na mesma linha
 *     de raciocínio.
 */

import { getSupabaseAdmin } from "@/lib/supabase";

// ────────────────────────────────────────────────────────────────────────────
// Constantes de política (D-036)
// ────────────────────────────────────────────────────────────────────────────

/** Janela de análise em dias pras regras de threshold. */
export const RELIABILITY_WINDOW_DAYS = 30;

/** Nº de eventos ativos pra médica aparecer como "em alerta" no admin. */
export const RELIABILITY_SOFT_WARN = 2;

/** Nº de eventos ativos pra disparar auto-pause da médica. */
export const RELIABILITY_HARD_BLOCK = 3;

// ────────────────────────────────────────────────────────────────────────────
// Tipos
// ────────────────────────────────────────────────────────────────────────────

export type ReliabilityEventKind =
  | "no_show_doctor"
  | "expired_no_one_joined"
  | "manual";

export type ReliabilityEvent = {
  id: string;
  doctor_id: string;
  appointment_id: string | null;
  kind: ReliabilityEventKind;
  occurred_at: string;
  notes: string | null;
  dismissed_at: string | null;
  dismissed_by: string | null;
  dismissed_reason: string | null;
  created_at: string;
};

export type DoctorReliabilitySnapshot = {
  doctorId: string;
  activeEventsInWindow: number;
  windowDays: number;
  softWarn: number;
  hardBlock: number;
  isInSoftWarn: boolean;
  isAtHardBlock: boolean;
  isPaused: boolean;
  pausedAt: string | null;
  pausedAuto: boolean;
  pausedReason: string | null;
};

export type RecordEventInput = {
  doctorId: string;
  appointmentId: string | null;
  kind: ReliabilityEventKind;
  notes?: string | null;
};

export type RecordEventResult =
  | { ok: true; eventId: string; alreadyRecorded: boolean }
  | { ok: false; code: "db_error"; message: string };

export type PauseInput = {
  doctorId: string;
  reason: string;
  /** ID do admin logado; null se acionado por automação. */
  triggeredBy: string | null;
  auto: boolean;
  /** Quando true (default), médica só sai do pause após revisão manual. */
  untilReviewed?: boolean;
};

export type PauseResult =
  | {
      ok: true;
      doctorId: string;
      pausedAt: string;
      alreadyPaused: boolean;
      previouslyPausedAuto: boolean;
    }
  | { ok: false; code: "doctor_not_found" | "db_error"; message: string };

export type UnpauseInput = {
  doctorId: string;
  unpausedBy: string;
  notes?: string | null;
};

export type UnpauseResult =
  | { ok: true; doctorId: string; wasPaused: boolean }
  | { ok: false; code: "doctor_not_found" | "db_error"; message: string };

export type DismissEventInput = {
  eventId: string;
  dismissedBy: string;
  reason: string;
};

export type DismissResult =
  | { ok: true; eventId: string; alreadyDismissed: boolean }
  | {
      ok: false;
      code: "event_not_found" | "db_error";
      message: string;
    };

// ────────────────────────────────────────────────────────────────────────────
// Record + Evaluate
// ────────────────────────────────────────────────────────────────────────────

/**
 * Registra um evento de confiabilidade. Idempotente via unique parcial
 * em `appointment_id` (D-036 migration 015). Chamado pelo
 * `applyNoShowPolicy` (D-032) sempre que a médica tiver incidente.
 */
export async function recordReliabilityEvent(
  input: RecordEventInput
): Promise<RecordEventResult> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("doctor_reliability_events")
    .insert({
      doctor_id: input.doctorId,
      appointment_id: input.appointmentId,
      kind: input.kind,
      notes: input.notes ?? null,
    })
    .select("id")
    .single();

  if (error) {
    // Conflict em unique(appointment_id) — já registramos esse caso antes.
    if (error.code === "23505" && input.appointmentId) {
      // Busca o id da linha existente pra devolver coerente.
      const { data: existing } = await supabase
        .from("doctor_reliability_events")
        .select("id")
        .eq("appointment_id", input.appointmentId)
        .maybeSingle();
      return {
        ok: true,
        eventId: (existing?.id as string) ?? "",
        alreadyRecorded: true,
      };
    }
    console.error("[reliability] record falhou:", error);
    return { ok: false, code: "db_error", message: error.message };
  }

  return {
    ok: true,
    eventId: data.id as string,
    alreadyRecorded: false,
  };
}

/**
 * Calcula snapshot atual pra uma médica: quantos eventos ativos na
 * janela, estado de pause, se está em soft warn / hard block.
 */
export async function getDoctorReliabilitySnapshot(
  doctorId: string
): Promise<DoctorReliabilitySnapshot | null> {
  const supabase = getSupabaseAdmin();

  const { data: doctor, error: doctorErr } = await supabase
    .from("doctors")
    .select(
      "id, reliability_paused_at, reliability_paused_auto, reliability_paused_reason"
    )
    .eq("id", doctorId)
    .maybeSingle();

  if (doctorErr || !doctor) {
    if (doctorErr) console.error("[reliability] snapshot doctor:", doctorErr);
    return null;
  }

  const since = new Date(
    Date.now() - RELIABILITY_WINDOW_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const { count, error: countErr } = await supabase
    .from("doctor_reliability_events")
    .select("id", { head: true, count: "exact" })
    .eq("doctor_id", doctorId)
    .is("dismissed_at", null)
    .gte("occurred_at", since);

  if (countErr) {
    console.error("[reliability] snapshot count:", countErr);
    return null;
  }

  const active = count ?? 0;
  const row = doctor as {
    id: string;
    reliability_paused_at: string | null;
    reliability_paused_auto: boolean;
    reliability_paused_reason: string | null;
  };

  return {
    doctorId: row.id,
    activeEventsInWindow: active,
    windowDays: RELIABILITY_WINDOW_DAYS,
    softWarn: RELIABILITY_SOFT_WARN,
    hardBlock: RELIABILITY_HARD_BLOCK,
    isInSoftWarn: active >= RELIABILITY_SOFT_WARN && active < RELIABILITY_HARD_BLOCK,
    isAtHardBlock: active >= RELIABILITY_HARD_BLOCK,
    isPaused: row.reliability_paused_at != null,
    pausedAt: row.reliability_paused_at,
    pausedAuto: row.reliability_paused_auto,
    pausedReason: row.reliability_paused_reason,
  };
}

/**
 * Roda a avaliação e auto-pausa se necessário. Chamado logo após
 * `recordReliabilityEvent` no fluxo de no-show.
 *
 * Retorna o snapshot resultante + se houve mudança (pause disparado).
 */
export async function evaluateAndMaybeAutoPause(
  doctorId: string
): Promise<{
  snapshot: DoctorReliabilitySnapshot | null;
  autoPaused: boolean;
}> {
  const snap = await getDoctorReliabilitySnapshot(doctorId);
  if (!snap) return { snapshot: null, autoPaused: false };

  if (!snap.isAtHardBlock) return { snapshot: snap, autoPaused: false };
  if (snap.isPaused) return { snapshot: snap, autoPaused: false };

  const pauseResult = await pauseDoctor({
    doctorId,
    triggeredBy: null,
    auto: true,
    reason: `Auto-pause: ${snap.activeEventsInWindow} incidente(s) ativos em ${snap.windowDays} dias (threshold: ${snap.hardBlock}).`,
    untilReviewed: true,
  });

  if (!pauseResult.ok) {
    console.error("[reliability] auto-pause falhou:", pauseResult);
    return { snapshot: snap, autoPaused: false };
  }

  return {
    snapshot: { ...snap, isPaused: true, pausedAuto: true, pausedAt: pauseResult.pausedAt },
    autoPaused: !pauseResult.alreadyPaused,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Pause / Unpause
// ────────────────────────────────────────────────────────────────────────────

export async function pauseDoctor(input: PauseInput): Promise<PauseResult> {
  const supabase = getSupabaseAdmin();

  const { data: current, error: loadErr } = await supabase
    .from("doctors")
    .select("id, reliability_paused_at, reliability_paused_auto")
    .eq("id", input.doctorId)
    .maybeSingle();

  if (loadErr) {
    console.error("[reliability] pause load:", loadErr);
    return { ok: false, code: "db_error", message: loadErr.message };
  }
  if (!current) {
    return {
      ok: false,
      code: "doctor_not_found",
      message: `Médica ${input.doctorId} não encontrada.`,
    };
  }

  const row = current as {
    id: string;
    reliability_paused_at: string | null;
    reliability_paused_auto: boolean;
  };

  // Se já está pausada, NÃO sobrescrevemos os metadados.
  // Preserva "admin pausou manualmente e tem motivo X".
  if (row.reliability_paused_at) {
    return {
      ok: true,
      doctorId: row.id,
      pausedAt: row.reliability_paused_at,
      alreadyPaused: true,
      previouslyPausedAuto: row.reliability_paused_auto,
    };
  }

  const nowIso = new Date().toISOString();
  const { error: upErr } = await supabase
    .from("doctors")
    .update({
      reliability_paused_at: nowIso,
      reliability_paused_by: input.triggeredBy,
      reliability_paused_reason: input.reason,
      reliability_paused_auto: input.auto,
      reliability_paused_until_reviewed: input.untilReviewed ?? true,
    })
    .eq("id", input.doctorId);

  if (upErr) {
    console.error("[reliability] pause update:", upErr);
    return { ok: false, code: "db_error", message: upErr.message };
  }

  console.log("[reliability] médica pausada:", {
    doctor_id: input.doctorId,
    auto: input.auto,
    triggered_by: input.triggeredBy,
    reason: input.reason,
  });

  return {
    ok: true,
    doctorId: input.doctorId,
    pausedAt: nowIso,
    alreadyPaused: false,
    previouslyPausedAuto: false,
  };
}

export async function unpauseDoctor(
  input: UnpauseInput
): Promise<UnpauseResult> {
  const supabase = getSupabaseAdmin();

  const { data: current, error: loadErr } = await supabase
    .from("doctors")
    .select("id, reliability_paused_at")
    .eq("id", input.doctorId)
    .maybeSingle();

  if (loadErr) {
    console.error("[reliability] unpause load:", loadErr);
    return { ok: false, code: "db_error", message: loadErr.message };
  }
  if (!current) {
    return {
      ok: false,
      code: "doctor_not_found",
      message: `Médica ${input.doctorId} não encontrada.`,
    };
  }

  const wasPaused =
    (current as { reliability_paused_at: string | null })
      .reliability_paused_at != null;

  if (!wasPaused) {
    return { ok: true, doctorId: input.doctorId, wasPaused: false };
  }

  // Limpa tudo e registra quem/quando reativou nas notes se fornecidas.
  // Mantemos o histórico dos eventos — eles continuam existindo. O
  // pause atual é que some.
  const { error: upErr } = await supabase
    .from("doctors")
    .update({
      reliability_paused_at: null,
      reliability_paused_by: null,
      reliability_paused_reason: input.notes
        ? `Reativada por admin ${input.unpausedBy} · ${input.notes}`
        : null,
      reliability_paused_auto: false,
      reliability_paused_until_reviewed: true,
    })
    .eq("id", input.doctorId);

  if (upErr) {
    console.error("[reliability] unpause update:", upErr);
    return { ok: false, code: "db_error", message: upErr.message };
  }

  console.log("[reliability] médica reativada:", {
    doctor_id: input.doctorId,
    unpaused_by: input.unpausedBy,
    notes: input.notes ?? null,
  });

  return { ok: true, doctorId: input.doctorId, wasPaused: true };
}

// ────────────────────────────────────────────────────────────────────────────
// Dismiss event
// ────────────────────────────────────────────────────────────────────────────

export async function dismissEvent(
  input: DismissEventInput
): Promise<DismissResult> {
  const supabase = getSupabaseAdmin();

  const { data: current, error: loadErr } = await supabase
    .from("doctor_reliability_events")
    .select("id, dismissed_at, doctor_id")
    .eq("id", input.eventId)
    .maybeSingle();

  if (loadErr) {
    console.error("[reliability] dismiss load:", loadErr);
    return { ok: false, code: "db_error", message: loadErr.message };
  }
  if (!current) {
    return {
      ok: false,
      code: "event_not_found",
      message: `Evento ${input.eventId} não encontrado.`,
    };
  }

  const row = current as {
    id: string;
    dismissed_at: string | null;
    doctor_id: string;
  };

  if (row.dismissed_at) {
    return { ok: true, eventId: row.id, alreadyDismissed: true };
  }

  const { error: upErr } = await supabase
    .from("doctor_reliability_events")
    .update({
      dismissed_at: new Date().toISOString(),
      dismissed_by: input.dismissedBy,
      dismissed_reason: input.reason,
    })
    .eq("id", input.eventId);

  if (upErr) {
    console.error("[reliability] dismiss update:", upErr);
    return { ok: false, code: "db_error", message: upErr.message };
  }

  console.log("[reliability] evento dispensado:", {
    event_id: input.eventId,
    doctor_id: row.doctor_id,
    by: input.dismissedBy,
    reason: input.reason,
  });

  return { ok: true, eventId: input.eventId, alreadyDismissed: false };
}

// ────────────────────────────────────────────────────────────────────────────
// Listagem pra UI admin
// ────────────────────────────────────────────────────────────────────────────

export type ReliabilityEventWithContext = ReliabilityEvent & {
  doctor_name: string | null;
  appointment_scheduled_at: string | null;
};

/**
 * Lista eventos recentes (ativos + dispensados) com contexto de médica
 * e appointment pra UI do admin.
 */
export async function listRecentEvents(
  limit: number = 50
): Promise<ReliabilityEventWithContext[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("doctor_reliability_events")
    .select(
      "id, doctor_id, appointment_id, kind, occurred_at, notes, dismissed_at, dismissed_by, dismissed_reason, created_at, doctors ( display_name, full_name ), appointments ( scheduled_at )"
    )
    .order("occurred_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[reliability] list events:", error);
    return [];
  }

  return (data ?? []).map((row) => {
    const r = row as unknown as ReliabilityEvent & {
      doctors?: { display_name: string | null; full_name: string | null } | null;
      appointments?: { scheduled_at: string | null } | null;
    };
    return {
      ...r,
      doctor_name:
        r.doctors?.display_name ?? r.doctors?.full_name ?? null,
      appointment_scheduled_at: r.appointments?.scheduled_at ?? null,
    };
  });
}

/**
 * Agrega snapshot pra todas as médicas (pra dashboard). Execução:
 * 1 query nos doctors + 1 query agregada nos events. O(N) em médicas
 * — aceitável enquanto N << 100.
 */
export type DoctorReliabilityRow = {
  doctorId: string;
  doctorName: string;
  status: string;
  activeEvents: number;
  lastEventAt: string | null;
  isInSoftWarn: boolean;
  isAtHardBlock: boolean;
  isPaused: boolean;
  pausedAt: string | null;
  pausedAuto: boolean;
  pausedReason: string | null;
};

export async function listDoctorReliabilityOverview(): Promise<
  DoctorReliabilityRow[]
> {
  const supabase = getSupabaseAdmin();

  const { data: doctors, error: dErr } = await supabase
    .from("doctors")
    .select(
      "id, display_name, full_name, status, reliability_paused_at, reliability_paused_auto, reliability_paused_reason"
    )
    .in("status", ["active", "suspended", "pending"])
    .order("full_name", { ascending: true });

  if (dErr || !doctors) {
    console.error("[reliability] overview doctors:", dErr);
    return [];
  }

  const since = new Date(
    Date.now() - RELIABILITY_WINDOW_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const { data: events, error: eErr } = await supabase
    .from("doctor_reliability_events")
    .select("doctor_id, occurred_at")
    .is("dismissed_at", null)
    .gte("occurred_at", since);

  if (eErr) {
    console.error("[reliability] overview events:", eErr);
    return [];
  }

  const counts = new Map<string, { count: number; latest: string }>();
  for (const ev of events ?? []) {
    const r = ev as { doctor_id: string; occurred_at: string };
    const cur = counts.get(r.doctor_id) ?? { count: 0, latest: "" };
    cur.count += 1;
    if (!cur.latest || r.occurred_at > cur.latest) cur.latest = r.occurred_at;
    counts.set(r.doctor_id, cur);
  }

  return doctors.map((d) => {
    const row = d as {
      id: string;
      display_name: string | null;
      full_name: string;
      status: string;
      reliability_paused_at: string | null;
      reliability_paused_auto: boolean;
      reliability_paused_reason: string | null;
    };
    const c = counts.get(row.id);
    const active = c?.count ?? 0;
    return {
      doctorId: row.id,
      doctorName: row.display_name || row.full_name,
      status: row.status,
      activeEvents: active,
      lastEventAt: c?.latest ?? null,
      isInSoftWarn:
        active >= RELIABILITY_SOFT_WARN && active < RELIABILITY_HARD_BLOCK,
      isAtHardBlock: active >= RELIABILITY_HARD_BLOCK,
      isPaused: row.reliability_paused_at != null,
      pausedAt: row.reliability_paused_at,
      pausedAuto: row.reliability_paused_auto,
      pausedReason: row.reliability_paused_reason,
    };
  });
}
