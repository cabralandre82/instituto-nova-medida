/**
 * src/lib/error-log.ts — D-045 · 3.G
 *
 * Timeline consolidada de falhas operacionais, pra o operador solo
 * abrir UMA tela (`/admin/errors`) e saber o que quebrou nas últimas
 * 24h/7d sem precisar SSH, sem precisar abrir logs do Vercel, sem
 * precisar lembrar de 5 tabelas diferentes.
 *
 * Fontes agregadas:
 *
 *   1. `cron_runs` com status='error' → cron que morreu.
 *   2. `asaas_events` com processing_error is not null → webhook
 *      de pagamento que não conseguimos processar.
 *   3. `daily_events` com processing_error is not null → webhook
 *      de videoconferência que não conseguimos processar.
 *   4. `appointment_notifications` com status='failed' → notificação
 *      WhatsApp que não conseguimos enviar (template errado, número
 *      inválido, janela 24h fechada).
 *   5. `whatsapp_events` com status='failed' → evento de entrega
 *      `failed` retornado pela Meta (telefone bloqueado, número
 *      errado). Diferente do item 4: aqui foi a Meta que falhou em
 *      entregar, não nós em enviar.
 *
 * Design:
 *   - LIB PURA. Recebe `SupabaseClient`, devolve dados. Sem UI, sem
 *     side effects. Testável.
 *   - `loadErrorLog` aceita `windowHours` (default 24h) e `limit`
 *     (default 200). Operador raramente precisa ver mais que isso —
 *     se precisar, paginação na UI.
 *   - Todas as queries em paralelo (`Promise.all`). Pior caso: 5
 *     queries simples < 500ms total.
 *   - Source de cada entry é `ErrorSource` — string literal tipada
 *     pra a UI agrupar ou filtrar facilmente.
 *   - `ErrorEntry.reference` guarda o ID natural da origem (cron_run
 *     id, asaas_event id, etc), útil pra o admin copiar e investigar
 *     no SQL editor direto.
 *   - Timeline retornada ordenada DESC por `occurredAt` — mais
 *     recente primeiro.
 *
 * O que esta lib NÃO faz:
 *   - Não reprocessa erros (isso é decisão humana; admin decide se
 *     chama RPC específica ou marca resolvido).
 *   - Não deleta. Erros ficam eternos pra auditoria/LGPD. Purga é
 *     decisão separada (retenção por tabela).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// ────────────────────────────────────────────────────────────────────────
// Tipos
// ────────────────────────────────────────────────────────────────────────

export type ErrorSource =
  | "cron"
  | "asaas_webhook"
  | "daily_webhook"
  | "notification"
  | "whatsapp_delivery";

export type ErrorEntry = {
  /** Timestamp em que a falha foi detectada. */
  occurredAt: string;
  source: ErrorSource;
  /** Label curta legível (ex: "Cron · auto-deliver"). */
  label: string;
  /** Mensagem do erro, truncada em 500 chars se necessário. */
  message: string;
  /**
   * ID da linha de origem. Formato `tabela:uuid` pra facilitar o
   * SELECT no SQL editor (ex: "cron_runs:abc-def-123").
   */
  reference: string;
  /**
   * Metadados contextuais opcionais. Mantém valores escalares pra
   * serialização simples; objetos complexos ficam no payload da
   * origem e o operador consulta pelo `reference`.
   */
  context: Record<string, string | number | boolean | null>;
};

export type ErrorLog = {
  /** Janela temporal (horas) consultada. */
  windowHours: number;
  /** Limite por fonte. */
  perSourceLimit: number;
  /** Total agregado retornado. */
  total: number;
  /**
   * Contagem bruta POR fonte ANTES do slice pelo `limit` total.
   * Útil pra mostrar "Mostrando 100 de 453" quando há truncagem.
   */
  sourceCounts: Record<ErrorSource, number>;
  entries: ErrorEntry[];
};

export type LoadErrorLogOptions = {
  /** Janela em horas (default 24). Clampada em [1, 720] (30 dias). */
  windowHours?: number;
  /**
   * Máximo de linhas POR fonte consultada (default 200). Evita
   * ler 10k asaas_events quebrados num incidente longo. Clampado
   * em [1, 1000].
   */
  perSourceLimit?: number;
  /**
   * `Date` de referência (default `new Date()`). Parâmetro pra
   * testes determinísticos.
   */
  now?: Date;
};

// ────────────────────────────────────────────────────────────────────────
// Helpers puros (exportados pra teste)
// ────────────────────────────────────────────────────────────────────────

export function truncate(s: string | null | undefined, max = 500): string {
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function clampWindowHours(hours: number): number {
  if (!Number.isFinite(hours)) return 24;
  return Math.min(Math.max(Math.round(hours), 1), 720);
}

export function clampPerSourceLimit(n: number): number {
  if (!Number.isFinite(n)) return 200;
  return Math.min(Math.max(Math.round(n), 1), 1000);
}

export function sinceIso(now: Date, windowHours: number): string {
  const since = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
  return since.toISOString();
}

// ────────────────────────────────────────────────────────────────────────
// Loader
// ────────────────────────────────────────────────────────────────────────

export async function loadErrorLog(
  supabase: SupabaseClient,
  opts: LoadErrorLogOptions = {}
): Promise<ErrorLog> {
  const now = opts.now ?? new Date();
  const windowHours = clampWindowHours(opts.windowHours ?? 24);
  const perSourceLimit = clampPerSourceLimit(opts.perSourceLimit ?? 200);
  const since = sinceIso(now, windowHours);

  const [crons, asaas, daily, notifs, whatsapp] = await Promise.all([
    loadCronErrors(supabase, since, perSourceLimit),
    loadAsaasErrors(supabase, since, perSourceLimit),
    loadDailyErrors(supabase, since, perSourceLimit),
    loadNotificationErrors(supabase, since, perSourceLimit),
    loadWhatsappDeliveryErrors(supabase, since, perSourceLimit),
  ]);

  const entries = [
    ...crons,
    ...asaas,
    ...daily,
    ...notifs,
    ...whatsapp,
  ].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  return {
    windowHours,
    perSourceLimit,
    total: entries.length,
    sourceCounts: {
      cron: crons.length,
      asaas_webhook: asaas.length,
      daily_webhook: daily.length,
      notification: notifs.length,
      whatsapp_delivery: whatsapp.length,
    },
    entries,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Fontes individuais
// ────────────────────────────────────────────────────────────────────────

async function loadCronErrors(
  supabase: SupabaseClient,
  since: string,
  limit: number
): Promise<ErrorEntry[]> {
  const { data, error } = await supabase
    .from("cron_runs")
    .select("id, job, started_at, finished_at, error_message, duration_ms")
    .eq("status", "error")
    .gte("started_at", since)
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  return (data ?? []).map((row) => {
    const r = row as {
      id: string;
      job: string;
      started_at: string;
      finished_at: string | null;
      error_message: string | null;
      duration_ms: number | null;
    };
    return {
      occurredAt: r.finished_at ?? r.started_at,
      source: "cron" as const,
      label: `Cron · ${r.job}`,
      message: truncate(r.error_message ?? "Cron falhou sem mensagem."),
      reference: `cron_runs:${r.id}`,
      context: {
        job: r.job,
        started_at: r.started_at,
        finished_at: r.finished_at,
        duration_ms: r.duration_ms,
      },
    };
  });
}

async function loadAsaasErrors(
  supabase: SupabaseClient,
  since: string,
  limit: number
): Promise<ErrorEntry[]> {
  const { data, error } = await supabase
    .from("asaas_events")
    .select(
      "id, event_type, asaas_payment_id, received_at, processed_at, processing_error"
    )
    .not("processing_error", "is", null)
    .gte("received_at", since)
    .order("received_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  return (data ?? []).map((row) => {
    const r = row as {
      id: string;
      event_type: string | null;
      asaas_payment_id: string | null;
      received_at: string;
      processed_at: string | null;
      processing_error: string | null;
    };
    return {
      occurredAt: r.received_at,
      source: "asaas_webhook" as const,
      label: `Asaas · ${r.event_type ?? "evento"}`,
      message: truncate(r.processing_error),
      reference: `asaas_events:${r.id}`,
      context: {
        event_type: r.event_type,
        asaas_payment_id: r.asaas_payment_id,
        processed_at: r.processed_at,
      },
    };
  });
}

async function loadDailyErrors(
  supabase: SupabaseClient,
  since: string,
  limit: number
): Promise<ErrorEntry[]> {
  const { data, error } = await supabase
    .from("daily_events")
    .select("id, event_type, received_at, processed_at, processing_error")
    .not("processing_error", "is", null)
    .gte("received_at", since)
    .order("received_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  return (data ?? []).map((row) => {
    const r = row as {
      id: string;
      event_type: string | null;
      received_at: string;
      processed_at: string | null;
      processing_error: string | null;
    };
    return {
      occurredAt: r.received_at,
      source: "daily_webhook" as const,
      label: `Daily · ${r.event_type ?? "evento"}`,
      message: truncate(r.processing_error),
      reference: `daily_events:${r.id}`,
      context: {
        event_type: r.event_type,
        processed_at: r.processed_at,
      },
    };
  });
}

async function loadNotificationErrors(
  supabase: SupabaseClient,
  since: string,
  limit: number
): Promise<ErrorEntry[]> {
  const { data, error } = await supabase
    .from("appointment_notifications")
    .select(
      "id, appointment_id, kind, template_name, scheduled_for, updated_at, error"
    )
    .eq("status", "failed")
    .gte("updated_at", since)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  return (data ?? []).map((row) => {
    const r = row as {
      id: string;
      appointment_id: string;
      kind: string;
      template_name: string | null;
      scheduled_for: string | null;
      updated_at: string;
      error: string | null;
    };
    return {
      occurredAt: r.updated_at,
      source: "notification" as const,
      label: `WhatsApp envio · ${r.kind}`,
      message: truncate(r.error ?? "Notificação marcada como failed sem mensagem."),
      reference: `appointment_notifications:${r.id}`,
      context: {
        appointment_id: r.appointment_id,
        kind: r.kind,
        template_name: r.template_name,
        scheduled_for: r.scheduled_for,
      },
    };
  });
}

async function loadWhatsappDeliveryErrors(
  supabase: SupabaseClient,
  since: string,
  limit: number
): Promise<ErrorEntry[]> {
  const { data, error } = await supabase
    .from("whatsapp_events")
    .select(
      "id, event_type, message_id, recipient_id, received_at, error_code, error_title, error_message"
    )
    .eq("status", "failed")
    .gte("received_at", since)
    .order("received_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  return (data ?? []).map((row) => {
    const r = row as {
      id: string;
      event_type: string | null;
      message_id: string | null;
      recipient_id: string | null;
      received_at: string;
      error_code: number | null;
      error_title: string | null;
      error_message: string | null;
    };
    const composed = [r.error_title, r.error_message]
      .filter((x): x is string => typeof x === "string" && x.length > 0)
      .join(" · ");
    return {
      occurredAt: r.received_at,
      source: "whatsapp_delivery" as const,
      label: `WhatsApp entrega · ${r.recipient_id ?? "?"}`,
      message: truncate(composed || "Meta retornou status=failed sem detalhes."),
      reference: `whatsapp_events:${r.id}`,
      context: {
        event_type: r.event_type,
        message_id: r.message_id,
        recipient_id: r.recipient_id,
        error_code: r.error_code,
      },
    };
  });
}
