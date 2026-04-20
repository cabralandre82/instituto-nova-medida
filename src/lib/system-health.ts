/**
 * Health check dos subsistemas (D-039) — Instituto Nova Medida.
 *
 * Executa checks paralelos contra DB + integrações + efeitos colaterais
 * de cron/webhook pra responder duas perguntas:
 *
 *   1. "Todos os subsistemas estão vivos agora?"  → dashboard admin
 *      (`/admin/health`) consulta default (sem ping externo).
 *   2. "As integrações externas estão respondendo?" → smoke sintético
 *      (`/api/internal/e2e/smoke?ping=1`), roda ping HTTP real em
 *      Asaas/Daily/WhatsApp Graph (gasta quota, só sob demanda).
 *
 * Filosofia:
 *   - READ-ONLY. Zero mutation.
 *   - TOLERANTE. Nenhum check individual pode derrubar o report — se
 *     falhar, vira `status: "error"` na linha dele, resto segue.
 *   - PARALELO. `Promise.all` de checks independentes, cada um timeout
 *     seu próprio (5s default). Relatório total < 10s mesmo no pior caso.
 *   - TRANSPARENTE. Cada check tem `summary` legível + `details`
 *     estruturados pra debug (IDs, timestamps, contagens).
 *
 * Integrações sabidamente problemáticas:
 *   - Webhook Daily (D-029) não registra em hosts do Vercel por bug
 *     HTTP/2 deles. O check `daily_signal` aceita tanto webhook quanto
 *     cron reconcile como sinal — ambos confirmam que o fluxo de
 *     finalização de consulta tá funcionando.
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import { getReconciliationCounts } from "@/lib/reconciliation";
import { listDoctorReliabilityOverview } from "@/lib/reliability";
import { getLatestRun, type CronJob } from "@/lib/cron-runs";

// ────────────────────────────────────────────────────────────────────────────
// Tipos
// ────────────────────────────────────────────────────────────────────────────

export type HealthStatus = "ok" | "warning" | "error" | "unknown";

export type HealthCheck = {
  /** Identificador estável pra automação ler (ex: UptimeRobot JSON). */
  key: string;
  /** Label pra UI humana. */
  label: string;
  status: HealthStatus;
  /** Frase curta legível. */
  summary: string;
  /** Detalhes estruturados (IDs, contagens, timestamps ISO). */
  details: Record<string, string | number | boolean | null>;
  elapsedMs: number;
};

export type HealthReport = {
  runAt: string;
  /** Agregado: pior status entre todos os checks. */
  overall: HealthStatus;
  totalMs: number;
  pingedExternal: boolean;
  checks: HealthCheck[];
};

export type HealthOptions = {
  /**
   * Se true, faz requisição HTTP real contra Asaas/Daily/WhatsApp
   * Graph pra validar autenticação + reachability. Default false
   * (dashboard admin não precisa gastar quota a cada refresh).
   */
  pingExternal?: boolean;
  /** Timeout por check, em ms. Default 5000. */
  perCheckTimeoutMs?: number;
};

// ────────────────────────────────────────────────────────────────────────────
// Policy / thresholds
// ────────────────────────────────────────────────────────────────────────────

/** Ingestão de webhook Asaas: sem evento nos últimos N min = warning. */
const ASAAS_EVENT_WARN_HOURS = 48;
/** Sem evento nos últimos N horas = erro (sistema com pagamento ativo). */
const ASAAS_EVENT_ERROR_DAYS = 30;

/** Daily signal: webhook OU cron reconcile recente = ok. */
const DAILY_SIGNAL_WARN_HOURS = 48;
const DAILY_SIGNAL_ERROR_DAYS = 30;

/** WhatsApp event: sem evento há muito tempo pode ser ambiente ocioso. */
const WHATSAPP_EVENT_WARN_DAYS = 14;

/** Cron earnings (diário): falta > 36h = warning, > 7d = erro. */
const CRON_EARNINGS_WARN_HOURS = 36;
const CRON_EARNINGS_ERROR_DAYS = 7;

/** Cron payouts (mensal): folga grande, roda dia 1; 40d = warning, 70d = erro. */
const CRON_PAYOUTS_WARN_DAYS = 40;
const CRON_PAYOUTS_ERROR_DAYS = 70;

/** Cron notify-pending-documents (diário): > 36h = warning, > 7d = erro. */
const CRON_NOTIFY_DOCS_WARN_HOURS = 36;
const CRON_NOTIFY_DOCS_ERROR_DAYS = 7;

const DEFAULT_TIMEOUT_MS = 5000;

// ────────────────────────────────────────────────────────────────────────────
// Runner
// ────────────────────────────────────────────────────────────────────────────

export async function runHealthCheck(
  opts: HealthOptions = {}
): Promise<HealthReport> {
  const start = Date.now();
  const pingExternal = opts.pingExternal ?? false;
  const timeoutMs = opts.perCheckTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  const checks = await Promise.all([
    withTimeout("database", "Banco de dados", checkDatabase, timeoutMs),
    withTimeout(
      "asaas_env",
      "Asaas · configuração",
      () => checkAsaasEnv(pingExternal, timeoutMs),
      timeoutMs + 1000
    ),
    withTimeout(
      "asaas_webhook",
      "Asaas · webhooks recebidos",
      checkAsaasWebhook,
      timeoutMs
    ),
    withTimeout(
      "daily_env",
      "Daily.co · configuração",
      () => checkDailyEnv(pingExternal, timeoutMs),
      timeoutMs + 1000
    ),
    withTimeout(
      "daily_signal",
      "Daily.co · sinal (webhook ou cron)",
      checkDailySignal,
      timeoutMs
    ),
    withTimeout(
      "whatsapp_env",
      "WhatsApp · configuração",
      () => checkWhatsappEnv(),
      timeoutMs
    ),
    withTimeout(
      "whatsapp_webhook",
      "WhatsApp · webhooks recebidos",
      checkWhatsappWebhook,
      timeoutMs
    ),
    withTimeout(
      "reconciliation",
      "Conciliação financeira",
      checkReconciliation,
      timeoutMs * 2 // roda 6 sub-queries, merece mais tempo
    ),
    withTimeout(
      "reliability",
      "Confiabilidade das médicas",
      checkReliability,
      timeoutMs
    ),
    withTimeout(
      "cron_earnings_availability",
      "Cron · availability de earnings",
      () =>
        checkCronFreshness(
          "recalc_earnings_availability",
          CRON_EARNINGS_WARN_HOURS * 60 * 60 * 1000,
          CRON_EARNINGS_ERROR_DAYS * 24 * 60 * 60 * 1000
        ),
      timeoutMs
    ),
    withTimeout(
      "cron_monthly_payouts",
      "Cron · geração mensal de payouts",
      () =>
        checkCronFreshness(
          "generate_monthly_payouts",
          CRON_PAYOUTS_WARN_DAYS * 24 * 60 * 60 * 1000,
          CRON_PAYOUTS_ERROR_DAYS * 24 * 60 * 60 * 1000
        ),
      timeoutMs
    ),
    withTimeout(
      "cron_notify_pending_documents",
      "Cron · cobrança de NF-e",
      () =>
        checkCronFreshness(
          "notify_pending_documents",
          CRON_NOTIFY_DOCS_WARN_HOURS * 60 * 60 * 1000,
          CRON_NOTIFY_DOCS_ERROR_DAYS * 24 * 60 * 60 * 1000
        ),
      timeoutMs
    ),
  ]);

  const overall = aggregateStatus(checks.map((c) => c.status));

  return {
    runAt: new Date().toISOString(),
    overall,
    totalMs: Date.now() - start,
    pingedExternal: pingExternal,
    checks,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Checks individuais
// ────────────────────────────────────────────────────────────────────────────

async function checkDatabase(): Promise<Omit<HealthCheck, "key" | "label" | "elapsedMs">> {
  const supabase = getSupabaseAdmin();
  const { count, error } = await supabase
    .from("doctors")
    .select("id", { head: true, count: "exact" });

  if (error) {
    return {
      status: "error",
      summary: `Falha ao consultar doctors: ${error.message}`,
      details: { error_code: (error as { code?: string }).code ?? null },
    };
  }

  return {
    status: "ok",
    summary: `DB respondendo. ${count ?? 0} médica(s) cadastrada(s).`,
    details: { doctors_count: count ?? 0 },
  };
}

async function checkAsaasEnv(
  pingExternal: boolean,
  timeoutMs: number
): Promise<Omit<HealthCheck, "key" | "label" | "elapsedMs">> {
  const apiKey = process.env.ASAAS_API_KEY;
  const env = process.env.ASAAS_ENV ?? "sandbox";
  const webhookToken = process.env.ASAAS_WEBHOOK_TOKEN;

  const missing: string[] = [];
  if (!apiKey) missing.push("ASAAS_API_KEY");
  if (!webhookToken) missing.push("ASAAS_WEBHOOK_TOKEN");

  if (missing.length > 0) {
    return {
      status: "error",
      summary: `Variáveis ausentes: ${missing.join(", ")}`,
      details: { missing: missing.join(","), env },
    };
  }

  if (!pingExternal) {
    return {
      status: "ok",
      summary: `Configurado (${env}). Ping não executado.`,
      details: { env, pinged: false, has_webhook_token: true },
    };
  }

  // Ping: GET /customers?limit=1 — barato e valida auth.
  const baseUrl =
    env === "production"
      ? "https://api.asaas.com/v3"
      : "https://sandbox.asaas.com/api/v3";

  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${baseUrl}/customers?limit=1`, {
      headers: { access_token: apiKey! },
      signal: ctrl.signal,
    });
    clearTimeout(tid);

    if (!res.ok) {
      return {
        status: "error",
        summary: `Asaas respondeu ${res.status} ${res.statusText}`,
        details: { env, http_status: res.status, pinged: true },
      };
    }
    return {
      status: "ok",
      summary: `Asaas ok (${env}, ${res.status}).`,
      details: { env, http_status: res.status, pinged: true },
    };
  } catch (err) {
    return {
      status: "error",
      summary: `Ping Asaas falhou: ${errMsg(err)}`,
      details: { env, pinged: true, error: errMsg(err) },
    };
  }
}

async function checkAsaasWebhook(): Promise<
  Omit<HealthCheck, "key" | "label" | "elapsedMs">
> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("asaas_events")
    .select("id, event_type, received_at, processed_at, processing_error")
    .order("received_at", { ascending: false })
    .limit(1);

  if (error) {
    return {
      status: "error",
      summary: `Falha ao consultar asaas_events: ${error.message}`,
      details: {},
    };
  }

  const row = (data ?? [])[0] as
    | {
        id: string;
        event_type: string;
        received_at: string;
        processed_at: string | null;
        processing_error: string | null;
      }
    | undefined;

  if (!row) {
    return {
      status: "unknown",
      summary: "Nenhum webhook Asaas recebido ainda.",
      details: { last_event_at: null },
    };
  }

  const ageMs = Date.now() - new Date(row.received_at).getTime();
  const ageHours = Math.round(ageMs / (60 * 60 * 1000));
  const status: HealthStatus = decideFreshness(
    ageMs,
    ASAAS_EVENT_WARN_HOURS * 60 * 60 * 1000,
    ASAAS_EVENT_ERROR_DAYS * 24 * 60 * 60 * 1000
  );

  return {
    status,
    summary: `Último evento há ${ageHours}h (${row.event_type}).`,
    details: {
      last_event_type: row.event_type,
      last_event_at: row.received_at,
      processed: row.processed_at != null,
      has_error: row.processing_error != null,
      age_hours: ageHours,
    },
  };
}

async function checkDailyEnv(
  pingExternal: boolean,
  timeoutMs: number
): Promise<Omit<HealthCheck, "key" | "label" | "elapsedMs">> {
  const apiKey = process.env.DAILY_API_KEY;
  const domain = process.env.DAILY_DOMAIN;
  const webhookSecret = process.env.DAILY_WEBHOOK_SECRET;

  const missing: string[] = [];
  if (!apiKey) missing.push("DAILY_API_KEY");
  if (!domain) missing.push("DAILY_DOMAIN");

  if (missing.length > 0) {
    return {
      status: "error",
      summary: `Variáveis ausentes: ${missing.join(", ")}`,
      details: {
        missing: missing.join(","),
        domain: domain ?? null,
        has_webhook_secret: !!webhookSecret,
      },
    };
  }

  if (!pingExternal) {
    return {
      status: "ok",
      summary: `Configurado (domain: ${domain}). Ping não executado.`,
      details: {
        domain: domain!,
        pinged: false,
        has_webhook_secret: !!webhookSecret,
      },
    };
  }

  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch("https://api.daily.co/v1/rooms?limit=1", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    clearTimeout(tid);

    if (!res.ok) {
      return {
        status: "error",
        summary: `Daily respondeu ${res.status} ${res.statusText}`,
        details: { domain: domain!, http_status: res.status, pinged: true },
      };
    }
    return {
      status: "ok",
      summary: `Daily ok (${res.status}).`,
      details: { domain: domain!, http_status: res.status, pinged: true },
    };
  } catch (err) {
    return {
      status: "error",
      summary: `Ping Daily falhou: ${errMsg(err)}`,
      details: { domain: domain!, pinged: true, error: errMsg(err) },
    };
  }
}

async function checkDailySignal(): Promise<
  Omit<HealthCheck, "key" | "label" | "elapsedMs">
> {
  const supabase = getSupabaseAdmin();

  const [{ data: webhookRow }, { data: reconcileRow }] = await Promise.all([
    supabase
      .from("daily_events")
      .select("event_type, received_at")
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("appointments")
      .select("reconciled_at, reconciled_source")
      .not("reconciled_at", "is", null)
      .order("reconciled_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const wh = webhookRow as
    | { event_type: string; received_at: string }
    | null;
  const rc = reconcileRow as
    | { reconciled_at: string; reconciled_source: string | null }
    | null;

  // Escolhe o timestamp mais recente entre os dois sinais.
  const whTs = wh ? new Date(wh.received_at).getTime() : -1;
  const rcTs = rc ? new Date(rc.reconciled_at).getTime() : -1;
  const pickWebhook = whTs >= rcTs;
  const latestMs = pickWebhook ? whTs : rcTs;

  if (latestMs < 0) {
    return {
      status: "unknown",
      summary: "Sem sinal Daily registrado (nem webhook, nem reconcile).",
      details: { last_webhook_at: null, last_reconcile_at: null },
    };
  }

  const ageMs = Date.now() - latestMs;
  const ageHours = Math.round(ageMs / (60 * 60 * 1000));
  const status: HealthStatus = decideFreshness(
    ageMs,
    DAILY_SIGNAL_WARN_HOURS * 60 * 60 * 1000,
    DAILY_SIGNAL_ERROR_DAYS * 24 * 60 * 60 * 1000
  );

  return {
    status,
    summary: `Último sinal há ${ageHours}h via ${
      pickWebhook ? "webhook" : "cron reconcile"
    }.`,
    details: {
      last_webhook_at: wh?.received_at ?? null,
      last_reconcile_at: rc?.reconciled_at ?? null,
      last_reconcile_source: rc?.reconciled_source ?? null,
      newer_signal: pickWebhook ? "webhook" : "cron",
      age_hours: ageHours,
    },
  };
}

async function checkWhatsappEnv(): Promise<
  Omit<HealthCheck, "key" | "label" | "elapsedMs">
> {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const webhookSecret = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

  const missing: string[] = [];
  if (!phoneId) missing.push("WHATSAPP_PHONE_NUMBER_ID");
  if (!token) missing.push("WHATSAPP_ACCESS_TOKEN");

  if (missing.length > 0) {
    return {
      status: "error",
      summary: `Variáveis ausentes: ${missing.join(", ")}`,
      details: {
        missing: missing.join(","),
        has_webhook_secret: !!webhookSecret,
      },
    };
  }

  // WhatsApp/Meta: não fazemos ping real por default — o token é
  // longa duração e ping gasta rate limit. Se quisermos validar,
  // a melhor chamada é GET /{phone-number-id} que retorna metadata.
  return {
    status: "ok",
    summary: `Configurado (phone_number_id: ${phoneId!.slice(0, 6)}…).`,
    details: {
      has_token: true,
      has_webhook_secret: !!webhookSecret,
    },
  };
}

async function checkWhatsappWebhook(): Promise<
  Omit<HealthCheck, "key" | "label" | "elapsedMs">
> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("whatsapp_events")
    .select("id, received_at")
    .order("received_at", { ascending: false })
    .limit(1);

  if (error) {
    return {
      status: "error",
      summary: `Falha ao consultar whatsapp_events: ${error.message}`,
      details: {},
    };
  }

  const row = (data ?? [])[0] as { received_at: string } | undefined;
  if (!row) {
    return {
      status: "unknown",
      summary: "Nenhum webhook WhatsApp recebido ainda.",
      details: { last_event_at: null },
    };
  }

  const ageMs = Date.now() - new Date(row.received_at).getTime();
  const ageDays = Math.round(ageMs / (24 * 60 * 60 * 1000));
  // WhatsApp tem volume menor que Asaas; tolera silêncio por mais tempo.
  const warnMs = WHATSAPP_EVENT_WARN_DAYS * 24 * 60 * 60 * 1000;
  const status: HealthStatus =
    ageMs < warnMs ? "ok" : ageDays > 60 ? "error" : "warning";

  return {
    status,
    summary: `Último webhook há ${ageDays}d.`,
    details: { last_event_at: row.received_at, age_days: ageDays },
  };
}

async function checkReconciliation(): Promise<
  Omit<HealthCheck, "key" | "label" | "elapsedMs">
> {
  const counts = await getReconciliationCounts();
  let status: HealthStatus = "ok";
  if (counts.totalCritical > 0) status = "error";
  else if (counts.totalWarning > 0) status = "warning";

  const parts: string[] = [];
  if (counts.totalCritical > 0)
    parts.push(`${counts.totalCritical} crítica(s)`);
  if (counts.totalWarning > 0) parts.push(`${counts.totalWarning} warning(s)`);
  const summary =
    parts.length === 0 ? "Sem divergências." : parts.join(" · ");

  return {
    status,
    summary,
    details: {
      critical: counts.totalCritical,
      warning: counts.totalWarning,
    },
  };
}

async function checkReliability(): Promise<
  Omit<HealthCheck, "key" | "label" | "elapsedMs">
> {
  const overview = await listDoctorReliabilityOverview();
  const paused = overview.filter((d) => d.isPaused).length;
  const softWarn = overview.filter(
    (d) => d.isInSoftWarn && !d.isPaused
  ).length;
  const atHard = overview.filter((d) => d.isAtHardBlock && !d.isPaused).length;

  let status: HealthStatus = "ok";
  if (atHard > 0 || paused > 0) status = "warning"; // não é erro de sistema, é política aplicando
  // Softwarn sozinho é só info — mantém ok.

  const parts: string[] = [];
  if (paused > 0) parts.push(`${paused} pausada(s)`);
  if (atHard > 0) parts.push(`${atHard} em hard block (não pausada ainda)`);
  if (softWarn > 0) parts.push(`${softWarn} em alerta`);
  const summary =
    parts.length === 0
      ? `${overview.length} médica(s), todas ok.`
      : parts.join(" · ");

  return {
    status,
    summary,
    details: {
      total_doctors: overview.length,
      paused,
      at_hard_block: atHard,
      in_soft_warn: softWarn,
    },
  };
}

async function checkCronFreshness(
  job: CronJob,
  warnThresholdMs: number,
  errorThresholdMs: number
): Promise<Omit<HealthCheck, "key" | "label" | "elapsedMs">> {
  const supabase = getSupabaseAdmin();
  const latest = await getLatestRun(supabase, job);

  if (!latest) {
    return {
      status: "unknown",
      summary: "Nenhuma execução registrada ainda.",
      details: { last_run_at: null, job },
    };
  }

  const referenceTs =
    latest.finished_at ?? latest.started_at; // freshness = último término
  const ageMs = Date.now() - new Date(referenceTs).getTime();
  const ageHours = Math.round(ageMs / (60 * 60 * 1000));
  const freshness = decideFreshness(ageMs, warnThresholdMs, errorThresholdMs);

  // Se a última execução foi erro, eleva pelo menos pra warning
  // (mesmo que fresh). Erro recente e persistente vira error.
  let status: HealthStatus = freshness;
  if (latest.status === "error") {
    status = status === "ok" ? "warning" : "error";
  }

  const when = `${ageHours}h atrás`;
  const summary =
    latest.status === "error"
      ? `Última execução FALHOU ${when}: ${latest.error_message ?? "erro"}`
      : latest.status === "running"
      ? `Execução em curso iniciada ${when}.`
      : `Última execução ok ${when}.`;

  return {
    status,
    summary,
    details: {
      job,
      last_run_at: referenceTs,
      last_run_status: latest.status,
      last_run_duration_ms: latest.duration_ms,
      age_hours: ageHours,
      payload_summary: payloadSummary(latest.payload),
    },
  };
}

function payloadSummary(
  payload: Record<string, unknown> | null
): string | null {
  if (!payload) return null;
  const keys = [
    "promoted",
    "scheduledFuture",
    "inspected",
    "payoutsCreated",
    "payoutsSkippedExisting",
    "payoutsSkippedMissingPix",
    "totalCentsDrafted",
    "evaluated",
    "notified",
    "skippedInterval",
    "skippedTemplate",
    "skippedMissingPhone",
    "errors",
  ];
  const parts: string[] = [];
  for (const k of keys) {
    if (k in payload && typeof payload[k] === "number") {
      parts.push(`${k}=${payload[k]}`);
    }
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function decideFreshness(
  ageMs: number,
  warnThresholdMs: number,
  errorThresholdMs: number
): HealthStatus {
  if (ageMs > errorThresholdMs) return "error";
  if (ageMs > warnThresholdMs) return "warning";
  return "ok";
}

function aggregateStatus(statuses: HealthStatus[]): HealthStatus {
  if (statuses.includes("error")) return "error";
  if (statuses.includes("warning")) return "warning";
  if (statuses.every((s) => s === "ok")) return "ok";
  return "unknown";
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function withTimeout(
  key: string,
  label: string,
  fn: () => Promise<Omit<HealthCheck, "key" | "label" | "elapsedMs">>,
  timeoutMs: number
): Promise<HealthCheck> {
  const start = Date.now();
  try {
    const result = await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`timeout ${timeoutMs}ms`)),
          timeoutMs
        )
      ),
    ]);
    return { key, label, elapsedMs: Date.now() - start, ...result };
  } catch (err) {
    return {
      key,
      label,
      status: "error",
      summary: `Check falhou: ${errMsg(err)}`,
      details: { error: errMsg(err) },
      elapsedMs: Date.now() - start,
    };
  }
}
