/**
 * src/lib/on-call-monitor.ts — PR-081 · D-093
 *
 * Monitor + settler de blocos `on_call` programados.
 *
 * Responsabilidades
 * ─────────────────
 *   1. **Sample temporal**: a cada execução do cron, identifica blocos
 *      `on_call` ativos AGORA (em SP) e, pra cada médica cuja presença
 *      esteja online/busy + heartbeat fresh, INSERT em
 *      `doctor_presence_samples` (idempotente via bucket de 5min).
 *
 *   2. **Settlement**: pra cada bloco que ENCERROU nos últimos
 *      `SETTLEMENT_GRACE_MINUTES` (default 30min) e ainda não foi
 *      liquidado, conta samples e decide:
 *        - coverage_ratio ≥ MIN_COVERAGE_FOR_PAYMENT → INSERT
 *          `doctor_earnings` (type='plantao_hour') proporcional,
 *          outcome='paid'.
 *        - caso contrário → INSERT `doctor_reliability_events`
 *          (kind='on_call_no_show'), outcome='no_show'.
 *      Sempre: INSERT `on_call_block_settlements` (idempotência
 *      via unique (availability_id, block_start_utc)).
 *
 * Princípios
 * ──────────
 *   - **Helpers puros, IO no orquestrador.** As funções de cálculo
 *     (`computeBlockOccurrence`, `computeCoverage`, `computeEarningCents`,
 *     `bucketFor`) são puras e testáveis sem mock de Supabase.
 *   - **Idempotência multi-camadas.** Sample tem unique no bucket;
 *     settlement tem unique na ocorrência; reliability event do tipo
 *     on_call_no_show é gravado dentro do settlement (sem unique
 *     próprio) — settlement bloqueia duplo INSERT.
 *   - **Reusa heurística de presence**: `STALE_PRESENCE_THRESHOLD_SECONDS`
 *     pra fresh-check (mesma definição em `doctor-presence.ts` e em
 *     `on-demand.ts`).
 *   - **Earning proporcional acima do threshold**. Médica que cumpriu
 *     80% recebe 80% do valor (não bloco inteiro). Abaixo de 50% trata
 *     como no-show pra não "premiar" plantão fantasma.
 *   - **Snapshot de regra**. amount_cents_snapshot grava o valor pago
 *     no settlement; doctor_earnings.amount_cents pode ser estornado
 *     depois sem quebrar o registro histórico.
 *
 * Não inclui (escopo deliberadamente fora)
 * ────────────────────────────────────────
 *   - UI pra dispensar settlements (ficaria em PR futuro caso operador
 *     queira "perdoar" no-show pontual sem mexer em doctor_reliability_events).
 *   - Notificação WhatsApp pra médica de "você cumpriu plantão, R$ XX".
 *     Resumo mensal já cobre via doctor_daily_summary (PR-077).
 *   - Re-settle automático ao mudar regra de compensação. Snapshot é
 *     deliberado: regra mudou → vale pra futuros, não pra retroativo.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase";
import { STALE_PRESENCE_THRESHOLD_SECONDS } from "./doctor-presence";
import { logger } from "./logger";

const log = logger.with({ mod: "on-call-monitor" });

// ────────────────────────────────────────────────────────────────────
// Constantes
// ────────────────────────────────────────────────────────────────────

/** Intervalo nominal entre samples (em minutos). Bate com o schedule
 * do cron `monitor-on-call`. Se mudar o schedule, atualizar aqui. */
export const SAMPLE_INTERVAL_MINUTES = 5;

/** Quanto tempo após o fim do bloco ainda aceitamos liquidar.
 * Generoso pra absorver atrasos de cron, manutenção etc. */
export const SETTLEMENT_GRACE_MINUTES = 30;

/** Mínimo de cobertura pra contar como "cumpriu" o plantão. Abaixo
 * disso vira no-show. Nominal 50% — médica que apareceu menos da
 * metade do bloco não cumpriu o compromisso. */
export const MIN_COVERAGE_FOR_PAYMENT = 0.5;

/** Quantos blocos no máximo varrer por execução. Defesa contra
 * runaway em caso de bug (ex.: 1000 médicas com plantão simultâneo). */
export const MAX_BLOCKS_PER_RUN = 200;

/** Default fallback se compensation_rules ausente (improvável). */
const DEFAULT_PLANTAO_HOUR_CENTS = 3000; // R$ 30/h

// ────────────────────────────────────────────────────────────────────
// Tipos
// ────────────────────────────────────────────────────────────────────

export type AvailabilityBlock = {
  id: string;
  doctor_id: string;
  weekday: number; // 0..6
  start_time: string; // 'HH:MM' (ou 'HH:MM:SS')
  end_time: string;
};

export type BlockOccurrence = {
  /** Início do bloco em UTC (precisão ao minuto). */
  startUtc: Date;
  /** Fim do bloco em UTC. */
  endUtc: Date;
  /** Duração em minutos. */
  blockMinutes: number;
  /** True se `now` ∈ [startUtc, endUtc). */
  isActive: boolean;
  /** True se já encerrou e está dentro de SETTLEMENT_GRACE. */
  isFinishedRecently: boolean;
};

export type SettlementOutcome = "paid" | "no_show";

export type SettlementResult = {
  availabilityId: string;
  doctorId: string;
  blockStartUtc: string;
  outcome: SettlementOutcome;
  coverageRatio: number;
  amountCents: number | null;
  earningId: string | null;
  reliabilityEventId: string | null;
  /** True se a operação criou registros novos; false se já estava liquidado. */
  created: boolean;
};

export type MonitorReport = {
  blocksConsidered: number;
  samplesInserted: number;
  samplesSkipped: number; // bucket dup, presence stale, etc.
  settlementsCreated: number;
  settlementsSkipped: number; // já liquidado
  paidCount: number;
  noShowCount: number;
  errors: Array<{ availabilityId: string; reason: string }>;
};

// ────────────────────────────────────────────────────────────────────
// Helpers puros (testáveis sem Supabase)
// ────────────────────────────────────────────────────────────────────

/**
 * Trunca uma data UTC pro bucket de 5min mais próximo (pra baixo) e
 * formata como "YYYY-MM-DDTHH:MM" (sem segundos, sem TZ).
 *
 * Exemplo: 2026-04-27T14:32:18Z → "2026-04-27T14:30".
 *
 * Usado pra deduplicar samples no `sample_bucket` da tabela.
 */
export function bucketFor(now: Date): string {
  const minute = Math.floor(now.getUTCMinutes() / SAMPLE_INTERVAL_MINUTES) *
    SAMPLE_INTERVAL_MINUTES;
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const minStr = String(minute).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${minStr}`;
}

/**
 * Computa a OCORRÊNCIA atual do bloco recorrente (weekday + start/end
 * time em SP) considerando `now`. Retorna null se nem ativo nem
 * recém-encerrado.
 *
 * Precisão de minutos. SP fixo UTC-3 (sem DST desde 2019).
 *
 * Algoritmo:
 *   - Calcula a ocorrência candidata pra o weekday alvo nesta semana
 *     (em SP).
 *   - Se start ≤ now < end → isActive=true.
 *   - Se end ≤ now < end + GRACE → isFinishedRecently=true.
 *   - Senão → null (bloco em outra semana / outro weekday).
 */
export function computeBlockOccurrence(input: {
  weekday: number;
  startTime: string;
  endTime: string;
  now: Date;
}): BlockOccurrence | null {
  const { weekday, startTime, endTime, now } = input;
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return null;
  const start = parseHM(startTime);
  const end = parseHM(endTime);
  if (!start || !end) return null;
  const blockMinutes = (end.h - start.h) * 60 + (end.m - start.m);
  if (blockMinutes <= 0) return null;

  // Determina o "hoje" em SP (sem DST).
  const sp = new Date(
    now.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" })
  );
  const nowSpWeekday = sp.getDay();

  // Tenta a ocorrência desta semana E da semana passada — necessário
  // pra capturar blocos que terminaram hoje cedo (ex.: bloco quarta
  // 23:00-00:30, query rodando quinta 00:35).
  for (const weekOffset of [0, -1] as const) {
    const daysSince = ((nowSpWeekday - weekday + 7) % 7) + (weekOffset === -1 ? 7 : 0);
    const candidateSp = new Date(sp);
    candidateSp.setDate(sp.getDate() - daysSince);
    candidateSp.setHours(0, 0, 0, 0); // zera tempo no candidate

    // SP é UTC-3 fixo: hora local SP H ↔ UTC H+3.
    const startUtc = new Date(
      Date.UTC(
        candidateSp.getFullYear(),
        candidateSp.getMonth(),
        candidateSp.getDate(),
        start.h + 3,
        start.m,
        0,
        0
      )
    );
    const endUtc = new Date(startUtc.getTime() + blockMinutes * 60 * 1000);

    const nowMs = now.getTime();
    if (nowMs >= startUtc.getTime() && nowMs < endUtc.getTime()) {
      return {
        startUtc,
        endUtc,
        blockMinutes,
        isActive: true,
        isFinishedRecently: false,
      };
    }
    if (
      nowMs >= endUtc.getTime() &&
      nowMs < endUtc.getTime() + SETTLEMENT_GRACE_MINUTES * 60 * 1000
    ) {
      return {
        startUtc,
        endUtc,
        blockMinutes,
        isActive: false,
        isFinishedRecently: true,
      };
    }
  }
  return null;
}

/**
 * Determina se uma presença é "fresh" (último heartbeat ≤ threshold
 * atrás) E se o status é elegível pra contar como cumprimento de
 * plantão.
 */
export function isPresenceFreshAndOnline(input: {
  status: string;
  lastHeartbeatAt: string | Date;
  now: Date;
  thresholdSeconds?: number;
}): boolean {
  const { status, lastHeartbeatAt, now } = input;
  const threshold = input.thresholdSeconds ?? STALE_PRESENCE_THRESHOLD_SECONDS;
  if (status !== "online" && status !== "busy") return false;
  const t =
    lastHeartbeatAt instanceof Date
      ? lastHeartbeatAt
      : new Date(lastHeartbeatAt);
  if (!Number.isFinite(t.getTime())) return false;
  const ageSeconds = (now.getTime() - t.getTime()) / 1000;
  return ageSeconds >= 0 && ageSeconds <= threshold;
}

/**
 * Computa a cobertura do bloco a partir do número de samples.
 * coverage_minutes = min(samples * SAMPLE_INTERVAL_MINUTES, blockMinutes).
 * coverage_ratio = coverage_minutes / blockMinutes ∈ [0, 1].
 */
export function computeCoverage(input: {
  samplesCount: number;
  blockMinutes: number;
}): { coverageMinutes: number; coverageRatio: number } {
  const { samplesCount, blockMinutes } = input;
  if (blockMinutes <= 0) return { coverageMinutes: 0, coverageRatio: 0 };
  const naive = Math.max(0, samplesCount) * SAMPLE_INTERVAL_MINUTES;
  const capped = Math.min(naive, blockMinutes);
  const ratio = capped / blockMinutes;
  // Clamp defensivo em [0, 1] e arredonda pra 4 casas (precisão da coluna).
  const clamped = Math.max(0, Math.min(1, ratio));
  return {
    coverageMinutes: capped,
    coverageRatio: Math.round(clamped * 10000) / 10000,
  };
}

/**
 * Calcula o valor a pagar pelo bloco (em centavos), proporcional à
 * cobertura. Retorna 0 se coverage abaixo do threshold (no-show).
 */
export function computeEarningCents(input: {
  coverageMinutes: number;
  hourlyCents: number;
  coverageRatio: number;
}): number {
  if (input.coverageRatio < MIN_COVERAGE_FOR_PAYMENT) return 0;
  if (input.hourlyCents <= 0) return 0;
  if (input.coverageMinutes <= 0) return 0;
  // Pagamento proporcional pelos minutos cobertos.
  const cents = (input.coverageMinutes / 60) * input.hourlyCents;
  // Arredonda pra inteiro (centavos não fracionam em PIX).
  return Math.round(cents);
}

/**
 * Decide outcome a partir da coverage_ratio.
 */
export function decideOutcome(coverageRatio: number): SettlementOutcome {
  return coverageRatio >= MIN_COVERAGE_FOR_PAYMENT ? "paid" : "no_show";
}

/**
 * Formata uma descrição humana pra `doctor_earnings.description`.
 * Usado em /admin/payouts e /medico/ganhos.
 *
 * Exemplo: "Plantão 27/04 14:00-18:00 (3h12 cumpridos · 80%)"
 */
export function formatEarningDescription(input: {
  blockStartUtc: Date;
  blockEndUtc: Date;
  coverageMinutes: number;
  coverageRatio: number;
}): string {
  const startSp = toSpHM(input.blockStartUtc);
  const endSp = toSpHM(input.blockEndUtc);
  const dateSp = toSpDate(input.blockStartUtc);
  const hours = Math.floor(input.coverageMinutes / 60);
  const minutes = input.coverageMinutes % 60;
  const hStr = `${hours}h${String(minutes).padStart(2, "0")}`;
  const pct = Math.round(input.coverageRatio * 100);
  return `Plantão ${dateSp} ${startSp}-${endSp} (${hStr} cumpridos · ${pct}%)`;
}

function parseHM(hm: string): { h: number; m: number } | null {
  const parts = hm.split(":");
  if (parts.length < 2) return null;
  const h = Number.parseInt(parts[0] ?? "", 10);
  const m = Number.parseInt(parts[1] ?? "", 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m };
}

function toSpHM(d: Date): string {
  const sp = new Date(d.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  return `${String(sp.getHours()).padStart(2, "0")}:${String(sp.getMinutes()).padStart(2, "0")}`;
}

function toSpDate(d: Date): string {
  const sp = new Date(d.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  return `${String(sp.getDate()).padStart(2, "0")}/${String(sp.getMonth() + 1).padStart(2, "0")}`;
}

// ────────────────────────────────────────────────────────────────────
// Orquestrador (com IO)
// ────────────────────────────────────────────────────────────────────

type DoctorPresenceLite = {
  doctor_id: string;
  status: string;
  last_heartbeat_at: string;
};

/**
 * Carrega blocos `on_call` ativos OU recém-encerrados (≤ GRACE) pra `now`.
 * Faz 1 query global em doctor_availability filtrando active=true e
 * type='on_call', e classifica em memória.
 */
async function loadRelevantBlocks(
  supabase: SupabaseClient,
  now: Date
): Promise<Array<{ block: AvailabilityBlock; occurrence: BlockOccurrence }>> {
  const { data, error } = await supabase
    .from("doctor_availability")
    .select("id, doctor_id, weekday, start_time, end_time, type, active")
    .eq("active", true)
    .eq("type", "on_call")
    .limit(MAX_BLOCKS_PER_RUN);
  if (error) {
    log.error("loadRelevantBlocks failed", { err: error });
    return [];
  }
  const rows = (data ?? []) as Array<AvailabilityBlock & { type: string; active: boolean }>;
  const out: Array<{ block: AvailabilityBlock; occurrence: BlockOccurrence }> = [];
  for (const row of rows) {
    const occ = computeBlockOccurrence({
      weekday: row.weekday,
      startTime: row.start_time,
      endTime: row.end_time,
      now,
    });
    if (!occ) continue;
    out.push({ block: row, occurrence: occ });
  }
  return out;
}

async function loadPresenceMap(
  supabase: SupabaseClient,
  doctorIds: string[]
): Promise<Map<string, DoctorPresenceLite>> {
  if (doctorIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from("doctor_presence")
    .select("doctor_id, status, last_heartbeat_at")
    .in("doctor_id", doctorIds);
  if (error) {
    log.error("loadPresenceMap failed", { err: error });
    return new Map();
  }
  const map = new Map<string, DoctorPresenceLite>();
  for (const row of (data ?? []) as DoctorPresenceLite[]) {
    map.set(row.doctor_id, row);
  }
  return map;
}

async function loadHourlyCents(
  supabase: SupabaseClient,
  doctorId: string
): Promise<{ ruleId: string | null; hourlyCents: number }> {
  const { data } = await supabase
    .from("doctor_compensation_rules")
    .select("id, plantao_hour_cents")
    .eq("doctor_id", doctorId)
    .is("effective_to", null)
    .maybeSingle();
  if (data) {
    return {
      ruleId: (data as { id: string }).id,
      hourlyCents:
        (data as { plantao_hour_cents: number }).plantao_hour_cents ??
        DEFAULT_PLANTAO_HOUR_CENTS,
    };
  }
  return { ruleId: null, hourlyCents: DEFAULT_PLANTAO_HOUR_CENTS };
}

/**
 * Insere 1 sample (idempotente via unique no bucket).
 */
async function insertSample(
  supabase: SupabaseClient,
  input: {
    doctorId: string;
    availabilityId: string;
    blockStartUtc: Date;
    blockEndUtc: Date;
    status: "online" | "busy";
    lastHeartbeatAt: string;
    bucket: string;
    sampledAt: Date;
  }
): Promise<{ inserted: boolean }> {
  const { error } = await supabase.from("doctor_presence_samples").insert({
    doctor_id: input.doctorId,
    availability_id: input.availabilityId,
    block_start_utc: input.blockStartUtc.toISOString(),
    block_end_utc: input.blockEndUtc.toISOString(),
    sampled_at: input.sampledAt.toISOString(),
    status: input.status,
    sample_bucket: input.bucket,
    last_heartbeat_at: input.lastHeartbeatAt,
  });
  if (error) {
    // 23505 = unique_violation. Esperado quando 2 runs caem no mesmo bucket.
    const code = (error as { code?: string }).code;
    if (code === "23505") return { inserted: false };
    log.warn("insertSample failed", {
      doctor_id: input.doctorId,
      availability_id: input.availabilityId,
      err: error,
    });
    return { inserted: false };
  }
  return { inserted: true };
}

async function isAlreadySettled(
  supabase: SupabaseClient,
  availabilityId: string,
  blockStartUtc: Date
): Promise<boolean> {
  const { data, error } = await supabase
    .from("on_call_block_settlements")
    .select("id")
    .eq("availability_id", availabilityId)
    .eq("block_start_utc", blockStartUtc.toISOString())
    .maybeSingle();
  if (error) {
    log.warn("isAlreadySettled failed", { err: error });
    return false;
  }
  return !!data;
}

async function countSamplesInBlock(
  supabase: SupabaseClient,
  availabilityId: string,
  blockStartUtc: Date,
  blockEndUtc: Date
): Promise<number> {
  const { count, error } = await supabase
    .from("doctor_presence_samples")
    .select("id", { count: "exact", head: true })
    .eq("availability_id", availabilityId)
    .gte("sampled_at", blockStartUtc.toISOString())
    .lt("sampled_at", blockEndUtc.toISOString());
  if (error) {
    log.warn("countSamplesInBlock failed", { err: error });
    return 0;
  }
  return count ?? 0;
}

/**
 * Liquida UM bloco específico (ocorrência única). Idempotente:
 * se já existe settlement pra (availability_id, block_start_utc),
 * retorna sem efeito.
 *
 * Ordem de operações (importante pra rollback caso algo falhe):
 *   1. Conta samples e calcula coverage.
 *   2. Carrega regra de compensação.
 *   3. Se outcome='paid' → INSERT earning, captura earning_id.
 *      Se outcome='no_show' → INSERT reliability event, captura id.
 *   4. INSERT settlement com FK pro outcome.
 *
 * Se passo 4 falhar por unique violation, deixa earning/event órfãos
 * — não ideal, mas raro (settlement já existe = race), e logamos
 * pra revisão manual.
 */
export async function settleBlock(
  supabase: SupabaseClient,
  input: {
    availabilityId: string;
    doctorId: string;
    blockStartUtc: Date;
    blockEndUtc: Date;
    blockMinutes: number;
    cronRunId?: string | null;
  }
): Promise<SettlementResult | null> {
  if (await isAlreadySettled(supabase, input.availabilityId, input.blockStartUtc)) {
    return {
      availabilityId: input.availabilityId,
      doctorId: input.doctorId,
      blockStartUtc: input.blockStartUtc.toISOString(),
      outcome: "no_show", // dummy — caller só liga pro `created`
      coverageRatio: 0,
      amountCents: null,
      earningId: null,
      reliabilityEventId: null,
      created: false,
    };
  }

  const samplesCount = await countSamplesInBlock(
    supabase,
    input.availabilityId,
    input.blockStartUtc,
    input.blockEndUtc
  );
  const cov = computeCoverage({
    samplesCount,
    blockMinutes: input.blockMinutes,
  });
  const outcome = decideOutcome(cov.coverageRatio);
  const rule = await loadHourlyCents(supabase, input.doctorId);
  const amountCents = computeEarningCents({
    coverageMinutes: cov.coverageMinutes,
    hourlyCents: rule.hourlyCents,
    coverageRatio: cov.coverageRatio,
  });

  let earningId: string | null = null;
  let reliabilityEventId: string | null = null;

  if (outcome === "paid" && amountCents > 0) {
    const description = formatEarningDescription({
      blockStartUtc: input.blockStartUtc,
      blockEndUtc: input.blockEndUtc,
      coverageMinutes: cov.coverageMinutes,
      coverageRatio: cov.coverageRatio,
    });
    const now = new Date().toISOString();
    const { data: earning, error: earnErr } = await supabase
      .from("doctor_earnings")
      .insert({
        doctor_id: input.doctorId,
        compensation_rule_id: rule.ruleId,
        type: "plantao_hour",
        amount_cents: amountCents,
        description,
        metadata: {
          availability_id: input.availabilityId,
          block_start_utc: input.blockStartUtc.toISOString(),
          block_end_utc: input.blockEndUtc.toISOString(),
          block_minutes: input.blockMinutes,
          coverage_minutes: cov.coverageMinutes,
          coverage_ratio: cov.coverageRatio,
          samples_count: samplesCount,
          hourly_cents: rule.hourlyCents,
          source: "on_call_settlement",
        },
        earned_at: now,
        // Plantão não tem janela de chargeback (não há payment associado).
        // Marca direto como available pro próximo payout.
        status: "available",
        available_at: now,
      })
      .select("id")
      .single();
    if (earnErr || !earning) {
      log.error("settleBlock: earning insert failed", {
        err: earnErr,
        availability_id: input.availabilityId,
      });
      return null;
    }
    earningId = (earning as { id: string }).id;
  } else {
    // No-show
    const { data: event, error: evErr } = await supabase
      .from("doctor_reliability_events")
      .insert({
        doctor_id: input.doctorId,
        kind: "on_call_no_show",
        notes: `Plantão programado ${input.blockStartUtc.toISOString()} → ${input.blockEndUtc.toISOString()} (cobertura ${(cov.coverageRatio * 100).toFixed(0)}%, ${samplesCount} samples)`,
        occurred_at: input.blockEndUtc.toISOString(),
      })
      .select("id")
      .single();
    if (evErr || !event) {
      log.error("settleBlock: reliability event insert failed", {
        err: evErr,
        availability_id: input.availabilityId,
      });
      return null;
    }
    reliabilityEventId = (event as { id: string }).id;
  }

  const { error: setErr } = await supabase
    .from("on_call_block_settlements")
    .insert({
      doctor_id: input.doctorId,
      availability_id: input.availabilityId,
      block_start_utc: input.blockStartUtc.toISOString(),
      block_end_utc: input.blockEndUtc.toISOString(),
      block_minutes: input.blockMinutes,
      samples_count: samplesCount,
      coverage_minutes: cov.coverageMinutes,
      coverage_ratio: cov.coverageRatio,
      outcome,
      earning_id: earningId,
      reliability_event_id: reliabilityEventId,
      compensation_rule_id: rule.ruleId,
      hourly_cents_snapshot: rule.hourlyCents,
      amount_cents_snapshot: outcome === "paid" ? amountCents : null,
      cron_run_id: input.cronRunId ?? null,
    });
  if (setErr) {
    // Race com outro cron run: alguém liquidou primeiro. Deixa
    // earning/event órfãos (raro). Não retorna como criado.
    const code = (setErr as { code?: string }).code;
    if (code === "23505") {
      log.warn("settleBlock: race — already settled by other run", {
        availability_id: input.availabilityId,
        block_start_utc: input.blockStartUtc.toISOString(),
        orphan_earning_id: earningId,
        orphan_reliability_event_id: reliabilityEventId,
      });
      return null;
    }
    log.error("settleBlock: settlement insert failed", {
      err: setErr,
      availability_id: input.availabilityId,
    });
    return null;
  }

  return {
    availabilityId: input.availabilityId,
    doctorId: input.doctorId,
    blockStartUtc: input.blockStartUtc.toISOString(),
    outcome,
    coverageRatio: cov.coverageRatio,
    amountCents: outcome === "paid" ? amountCents : null,
    earningId,
    reliabilityEventId,
    created: true,
  };
}

/**
 * Orquestrador principal: roda 1 ciclo de monitor + settle. Retorna
 * relatório agregado pra o cron registrar em `cron_runs.payload`.
 */
export async function runMonitorOnCallCycle(opts?: {
  now?: Date;
  supabase?: SupabaseClient;
  cronRunId?: string | null;
}): Promise<MonitorReport> {
  const supabase = opts?.supabase ?? getSupabaseAdmin();
  const now = opts?.now ?? new Date();
  const cronRunId = opts?.cronRunId ?? null;
  const report: MonitorReport = {
    blocksConsidered: 0,
    samplesInserted: 0,
    samplesSkipped: 0,
    settlementsCreated: 0,
    settlementsSkipped: 0,
    paidCount: 0,
    noShowCount: 0,
    errors: [],
  };

  const blocks = await loadRelevantBlocks(supabase, now);
  report.blocksConsidered = blocks.length;
  if (blocks.length === 0) return report;

  const doctorIds = Array.from(new Set(blocks.map((b) => b.block.doctor_id)));
  const presenceMap = await loadPresenceMap(supabase, doctorIds);
  const bucket = bucketFor(now);

  for (const { block, occurrence } of blocks) {
    try {
      // Sample (só se ativo)
      if (occurrence.isActive) {
        const presence = presenceMap.get(block.doctor_id);
        if (
          presence &&
          isPresenceFreshAndOnline({
            status: presence.status,
            lastHeartbeatAt: presence.last_heartbeat_at,
            now,
          })
        ) {
          const r = await insertSample(supabase, {
            doctorId: block.doctor_id,
            availabilityId: block.id,
            blockStartUtc: occurrence.startUtc,
            blockEndUtc: occurrence.endUtc,
            status: presence.status as "online" | "busy",
            lastHeartbeatAt: presence.last_heartbeat_at,
            bucket,
            sampledAt: now,
          });
          if (r.inserted) report.samplesInserted += 1;
          else report.samplesSkipped += 1;
        } else {
          report.samplesSkipped += 1;
        }
      }

      // Settle (só se recém-encerrado)
      if (occurrence.isFinishedRecently) {
        const result = await settleBlock(supabase, {
          availabilityId: block.id,
          doctorId: block.doctor_id,
          blockStartUtc: occurrence.startUtc,
          blockEndUtc: occurrence.endUtc,
          blockMinutes: occurrence.blockMinutes,
          cronRunId,
        });
        if (!result) {
          report.errors.push({
            availabilityId: block.id,
            reason: "settle returned null",
          });
        } else if (!result.created) {
          report.settlementsSkipped += 1;
        } else {
          report.settlementsCreated += 1;
          if (result.outcome === "paid") report.paidCount += 1;
          else report.noShowCount += 1;
        }
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      log.error("block iteration failed", {
        availability_id: block.id,
        err: e,
      });
      report.errors.push({ availabilityId: block.id, reason });
    }
  }

  return report;
}
