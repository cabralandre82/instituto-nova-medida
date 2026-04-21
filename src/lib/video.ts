/**
 * Video provider — Instituto Nova Medida.
 *
 * Server-only. A API key do Daily.co (e qualquer secret de provider futuro)
 * nunca pode chegar ao client. Páginas e componentes consomem só os tokens
 * de meeting curtos retornados por `getJoinTokens()`.
 *
 * Por que abstração? Decisão D-021: Daily.co no MVP, com porta aberta pra
 * migrar pra Jitsi self-host quando a operação justificar (~3000 consultas/mês).
 * Toda a lógica de negócio (criar appointment → criar sala → entregar
 * link via WhatsApp) usa esta interface, então a migração é trocar
 * `DailyProvider` por `JitsiProvider` sem mexer no resto.
 *
 * Defaults da sala (D-021):
 *   - enable_prejoin_ui: true        (UI de "câmera/microfone ok?")
 *   - enable_chat: false             (zero distração — chat fica fora)
 *   - max_participants: 2            (médica + paciente)
 *   - eject_at_room_exp: true        (sai todo mundo quando expira)
 *   - enable_recording: 'local'      (off por default; ligado por
 *                                     appointment quando recording_consent)
 *
 * Docs: https://docs.daily.co/reference/rest-api
 */

import {
  FetchTimeoutError,
  fetchWithTimeout,
  PROVIDER_TIMEOUTS,
} from "./fetch-timeout";
import { logger } from "./logger";

const log = logger.with({ mod: "video" });

const DAILY_API_BASE = "https://api.daily.co/v1";

// ────────────────────────────────────────────────────────────────────────
// Tipos públicos da abstração (independentes de provider)
// ────────────────────────────────────────────────────────────────────────

export type VideoProviderName = "daily" | "jitsi";

export type CreateRoomInput = {
  /**
   * Nome único da sala (slug). Recomendamos algo como
   * `c-${appointmentId.slice(0,8)}` pra ser curto e identificável.
   * Daily aceita até 41 chars, alfanumérico + hífen.
   */
  name: string;

  /**
   * Quando a sala expira (Unix timestamp em segundos).
   * Após esse momento, ninguém consegue mais entrar e quem está dentro é ejetado.
   */
  expiresAt: number;

  /**
   * Habilitar gravação local (paciente vê banner). Default: false.
   * Só ligar quando appointment.recording_consent = true (D-023).
   */
  enableRecording?: boolean;

  /**
   * Quantos minutos antes do `expiresAt` a sala começa a aceitar conexões.
   * Default: 30. Útil pra paciente entrar cedo se quiser.
   */
  notBeforeMinutes?: number;
};

export type CreatedRoom = {
  /** ID interno do provider. */
  providerId: string;
  /** Nome da sala (mesmo do input). */
  name: string;
  /** URL pública pra entrar (ex: https://instituto-nova-medida.daily.co/c-abc-123). */
  url: string;
  /** Quando expira (passa direto do input). */
  expiresAt: number;
  /** Payload bruto do provider — útil pra auditoria/debug. */
  raw: unknown;
};

export type JoinTokensInput = {
  roomName: string;
  patientName: string;
  doctorName: string;
  /** Se true, médica consegue iniciar gravação. */
  enableRecording?: boolean;
  /** Quando o token expira (Unix segundos). Geralmente igual ao da sala. */
  expiresAt: number;
};

export type JoinTokens = {
  /** Token JWT que a médica passa via `?t=...` na URL. Permissão de owner. */
  doctorToken: string;
  /** Token JWT que o paciente passa via `?t=...` na URL. Permissão de participant. */
  patientToken: string;
  /** URLs prontas pra entregar nas mensagens (room url + ?t=token). */
  doctorUrl: string;
  patientUrl: string;
};

export type DeleteRoomResult = {
  ok: boolean;
  notFound?: boolean;
  error?: string;
};

export type WebhookValidation =
  | { ok: true; rawBody: string; testPing?: boolean }
  | { ok: false; reason: string };

// ────────────────────────────────────────────────────────────────────────
// Tipos públicos de evento (independentes de provider)
// ────────────────────────────────────────────────────────────────────────

export type VideoEventType =
  | "meeting.started"
  | "meeting.ended"
  | "participant.joined"
  | "participant.left"
  | "recording.ready"
  | "unknown";

/**
 * Forma normalizada de evento do provider. Mantemos o `raw` pra
 * auditoria, mas as chaves abaixo são suficientes pra atualizar
 * `appointments`.
 */
export type NormalizedVideoEvent = {
  /** ID único do evento (do provider). Usado pra idempotência. */
  eventId: string | null;
  type: VideoEventType;
  /** Quando o evento ocorreu no provider (não quando o webhook chegou). */
  occurredAt: Date | null;
  /** Nome da sala (ex: 'c-12345678'). Usamos pra resolver o appointment. */
  roomName: string | null;
  /** ID interno do meeting/sessão no provider. */
  meetingId: string | null;
  /** participant.* events: nome do participante (do meeting token). */
  participantName: string | null;
  /** participant.* events: true se entrou como owner (médica). */
  participantIsOwner: boolean | null;
  /** meeting.ended: duração total em segundos, se reportada. */
  durationSeconds: number | null;
  /** Payload bruto (não-normalizado) — sempre persistido. */
  raw: unknown;
};

export interface VideoProvider {
  readonly name: VideoProviderName;

  /** Cria uma sala. Idempotente por `name` (re-cria com defaults se já existe). */
  createRoom(input: CreateRoomInput): Promise<CreatedRoom>;

  /** Gera tokens de entrada (paciente + médica). */
  getJoinTokens(input: JoinTokensInput): Promise<JoinTokens>;

  /** Deleta a sala. Idempotente: 404 não é erro. */
  deleteRoom(roomName: string): Promise<DeleteRoomResult>;

  /**
   * Valida assinatura/secret do webhook. Recebe o `Request` cru
   * pra ler header + body.
   */
  validateWebhook(req: Request): Promise<WebhookValidation>;

  /**
   * Lista sessões de uma sala (REST API). Usado pelo cron de
   * reconciliação (D-035) como fallback do webhook. Retorna lista
   * vazia se ninguém entrou na sala — aí tratamos como "sala expirou
   * vazia".
   */
  listMeetingsForRoom(input: ListMeetingsInput): Promise<MeetingSummary[]>;
}

export type ListMeetingsInput = {
  roomName: string;
  /** Filtra por `start_time >= timeframeStart` (Unix segundos). Opcional. */
  timeframeStart?: number;
  /** Filtra por `start_time <= timeframeEnd` (Unix segundos). Opcional. */
  timeframeEnd?: number;
};

/**
 * Resumo normalizado de uma sessão de meeting — forma independente
 * de provider. Consumido pelo reconciler pra decidir status final
 * da consulta sem depender de eventos `participant.joined` persistidos.
 */
export type MeetingSummary = {
  meetingId: string | null;
  /** `start_time` em UTC, em segundos. */
  startTime: number | null;
  /** Duração total da sessão em segundos. */
  durationSeconds: number | null;
  /** Se a sessão ainda está em curso. */
  ongoing: boolean;
  /** Participantes da sessão, com presença individual. */
  participants: MeetingParticipantSummary[];
  /** Raw do provider — útil pra debug. */
  raw: unknown;
};

export type MeetingParticipantSummary = {
  /** `user_id` do provider (estável por participante). */
  userId: string | null;
  /** `user_name` passado no meeting-token (ex: "Dra. Ana" ou "Paciente"). */
  userName: string | null;
  /** Tempo total em segundos que esse participante ficou na sala. */
  durationSeconds: number | null;
  /** Quando entrou (Unix segundos). */
  joinTime: number | null;
  /** Se é owner (criado com is_owner=true no meeting-token). */
  isOwner: boolean | null;
};

// ────────────────────────────────────────────────────────────────────────
// DailyProvider — implementação concreta
// ────────────────────────────────────────────────────────────────────────

type DailyConfig = {
  apiKey: string;
  domain: string;
  webhookSecret: string;
};

function loadDailyConfig(): DailyConfig {
  const apiKey = process.env.DAILY_API_KEY;
  const domain = process.env.DAILY_DOMAIN;
  const webhookSecret = process.env.DAILY_WEBHOOK_SECRET ?? "";

  if (!apiKey) {
    throw new Error("[video] DAILY_API_KEY ausente. Defina em .env.local / Vercel.");
  }
  if (!domain) {
    throw new Error("[video] DAILY_DOMAIN ausente. Defina o subdomínio (ex: instituto-nova-medida).");
  }
  return { apiKey, domain, webhookSecret };
}

type DailyRoomResponse = {
  id: string;
  name: string;
  url: string;
  api_created: boolean;
  privacy: string;
  config: Record<string, unknown>;
  created_at: string;
};

type DailyMeetingTokenResponse = {
  token: string;
};

/**
 * Resposta do Daily `GET /meetings`.
 * Docs: https://docs.daily.co/reference/rest-api/meetings/list-meetings
 *
 * Cada meeting tem 1+ participantes com presença individual. Quando
 * ninguém entrou na sala, a API responde `data: []` (não um meeting
 * vazio) — o reconciler trata isso como "sala expirou vazia".
 */
type DailyMeetingsResponse = {
  total_count?: number;
  data?: DailyMeetingRow[];
};

type DailyMeetingRow = {
  id?: string;
  room?: string;
  start_time?: number;
  duration?: number;
  ongoing?: boolean;
  participants?: DailyParticipantRow[];
};

type DailyParticipantRow = {
  user_id?: string;
  user_name?: string;
  participant_id?: string;
  join_time?: number;
  duration?: number;
  // Daily não expõe `is_owner` diretamente no /meetings. A gente
  // reconstrói a propriedade a partir do `user_name` comparando com
  // o nome da médica no reconciler — mais detalhe em scheduling.ts.
};

function normalizeDailyMeeting(row: DailyMeetingRow): MeetingSummary {
  return {
    meetingId: row.id ?? null,
    startTime: typeof row.start_time === "number" ? row.start_time : null,
    durationSeconds: typeof row.duration === "number" ? row.duration : null,
    ongoing: row.ongoing === true,
    participants: (row.participants ?? []).map((p) => ({
      userId: p.user_id ?? p.participant_id ?? null,
      userName: p.user_name ?? null,
      durationSeconds: typeof p.duration === "number" ? p.duration : null,
      joinTime: typeof p.join_time === "number" ? p.join_time : null,
      // A API pública não expõe is_owner. Deixamos null e o
      // reconciler cruza com o doctor_name do appointment.
      isOwner: null,
    })),
    raw: row,
  };
}

async function dailyRequest<T>(
  apiKey: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${DAILY_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      timeoutMs: PROVIDER_TIMEOUTS.daily,
      provider: "daily",
    });
  } catch (e) {
    if (e instanceof FetchTimeoutError) {
      return {
        ok: false,
        status: 0,
        error: `[daily] timeout ${e.timeoutMs}ms em ${path}`,
      };
    }
    return { ok: false, status: 0, error: `[daily] network: ${String(e)}` };
  }

  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, error: text || res.statusText };
  }

  try {
    return { ok: true, data: JSON.parse(text) as T };
  } catch {
    return { ok: false, status: res.status, error: `[daily] resposta não-JSON: ${text.slice(0, 200)}` };
  }
}

class DailyProvider implements VideoProvider {
  readonly name: VideoProviderName = "daily";

  async createRoom(input: CreateRoomInput): Promise<CreatedRoom> {
    const cfg = loadDailyConfig();
    const nbf =
      Math.floor(Date.now() / 1000) -
      Math.max(0, input.notBeforeMinutes ?? 30) * 60;

    const properties: Record<string, unknown> = {
      exp: input.expiresAt,
      nbf,
      max_participants: 2,
      eject_at_room_exp: true,
      enable_prejoin_ui: true,
      enable_chat: false,
      enable_screenshare: true,
      start_video_off: false,
      start_audio_off: false,
      enable_recording: input.enableRecording ? "local" : undefined,
    };

    Object.keys(properties).forEach((k) => {
      if (properties[k] === undefined) delete properties[k];
    });

    const result = await dailyRequest<DailyRoomResponse>(cfg.apiKey, "POST", "/rooms", {
      name: input.name,
      privacy: "public",
      properties,
    });

    if (!result.ok) {
      // Idempotência: se já existe (409 ou mensagem específica), tenta deletar+criar
      if (result.status === 400 && /already exists/i.test(result.error)) {
        const del = await dailyRequest(cfg.apiKey, "DELETE", `/rooms/${input.name}`);
        if (!del.ok && del.status !== 404) {
          throw new Error(`[daily] falha ao recriar sala "${input.name}": ${del.error}`);
        }
        const retry = await dailyRequest<DailyRoomResponse>(cfg.apiKey, "POST", "/rooms", {
          name: input.name,
          privacy: "public",
          properties,
        });
        if (!retry.ok) {
          throw new Error(`[daily] createRoom retry falhou: ${retry.error}`);
        }
        return mapRoom(retry.data, input.expiresAt);
      }
      throw new Error(`[daily] createRoom falhou (${result.status}): ${result.error}`);
    }

    return mapRoom(result.data, input.expiresAt);
  }

  async getJoinTokens(input: JoinTokensInput): Promise<JoinTokens> {
    const cfg = loadDailyConfig();

    const baseProps = {
      room_name: input.roomName,
      exp: input.expiresAt,
      eject_at_token_exp: true,
      enable_screenshare: true,
    };

    const doctor = await dailyRequest<DailyMeetingTokenResponse>(cfg.apiKey, "POST", "/meeting-tokens", {
      properties: {
        ...baseProps,
        user_name: input.doctorName,
        is_owner: true,
        enable_recording: input.enableRecording ? "local" : undefined,
        start_cloud_recording: false,
      },
    });
    if (!doctor.ok) {
      throw new Error(`[daily] meeting-token (médica) falhou: ${doctor.error}`);
    }

    const patient = await dailyRequest<DailyMeetingTokenResponse>(cfg.apiKey, "POST", "/meeting-tokens", {
      properties: {
        ...baseProps,
        user_name: input.patientName,
        is_owner: false,
      },
    });
    if (!patient.ok) {
      throw new Error(`[daily] meeting-token (paciente) falhou: ${patient.error}`);
    }

    const baseUrl = `https://${cfg.domain}.daily.co/${input.roomName}`;
    return {
      doctorToken: doctor.data.token,
      patientToken: patient.data.token,
      doctorUrl: `${baseUrl}?t=${doctor.data.token}`,
      patientUrl: `${baseUrl}?t=${patient.data.token}`,
    };
  }

  async deleteRoom(roomName: string): Promise<DeleteRoomResult> {
    const cfg = loadDailyConfig();
    const result = await dailyRequest(cfg.apiKey, "DELETE", `/rooms/${roomName}`);
    if (result.ok) return { ok: true };
    if (result.status === 404) return { ok: true, notFound: true };
    return { ok: false, error: result.error };
  }

  async listMeetingsForRoom(
    input: ListMeetingsInput
  ): Promise<MeetingSummary[]> {
    const cfg = loadDailyConfig();
    const params = new URLSearchParams({ room: input.roomName });
    if (input.timeframeStart != null) {
      params.set("timeframe_start", String(input.timeframeStart));
    }
    if (input.timeframeEnd != null) {
      params.set("timeframe_end", String(input.timeframeEnd));
    }
    // Limite alto — um appointment típico tem 1-2 sessões no histórico.
    // Se a sala foi reutilizada, pode ter mais; cortamos aqui pra não
    // explodir a resposta.
    params.set("limit", "20");

    const result = await dailyRequest<DailyMeetingsResponse>(
      cfg.apiKey,
      "GET",
      `/meetings?${params.toString()}`
    );

    if (!result.ok) {
      // 404 = sala não existe mais no Daily (já foi deletada ou
      // nunca existiu). Tratamos como "sem sessões" pra o reconciler
      // decidir — geralmente "cancelled_by_admin/expired".
      if (result.status === 404) return [];
      throw new Error(
        `[daily] listMeetingsForRoom falhou (${result.status}): ${result.error}`
      );
    }

    const rows = result.data.data ?? [];
    return rows.map(normalizeDailyMeeting);
  }

  async validateWebhook(req: Request): Promise<WebhookValidation> {
    // Daily assina cada webhook com HMAC-SHA256 do body usando o
    // `hmac` (secret) que aparece no payload de criação do webhook.
    // Header oficial: `X-Webhook-Signature` (timestamp + assinatura).
    //
    // Spec: https://docs.daily.co/reference/rest-api/webhooks/verify-webhook-signature
    //   X-Webhook-Timestamp: <unix-seconds>
    //   X-Webhook-Signature: <base64 HMAC-SHA256 de "timestamp.body">
    //
    // Compatibilidade: se o painel for configurado com header bruto
    // `x-daily-webhook-secret` (forma antiga / proxy), ainda aceitamos
    // pra não quebrar setups existentes.
    const cfg = loadDailyConfig();
    const rawBody = await req.text();

    const sigHeader = req.headers.get("x-webhook-signature");
    const tsHeader = req.headers.get("x-webhook-timestamp");
    const secretHeader = req.headers.get("x-daily-webhook-secret");

    // Caminho 1: HMAC oficial (timestamp + body)
    if (sigHeader && tsHeader && cfg.webhookSecret) {
      const tsRaw = Number(tsHeader);
      if (!Number.isFinite(tsRaw)) return { ok: false, reason: "timestamp inválido" };
      // Daily manda timestamp em milissegundos (13 dígitos). Alguns providers
      // futuros podem mandar em segundos (10 dígitos). Normalizamos pra segundos.
      const tsSec = tsRaw > 1e11 ? Math.floor(tsRaw / 1000) : tsRaw;
      // Anti-replay: aceita janela de 5 min
      if (Math.abs(Math.floor(Date.now() / 1000) - tsSec) > 5 * 60) {
        return { ok: false, reason: "timestamp fora da janela (replay?)" };
      }
      try {
        const cryptoMod = await import("node:crypto");
        // Daily calcula HMAC sobre `${timestamp_raw}.${body}` — sem alterar
        // a string do header (mesmo que seja em ms). Usamos o header como está.
        const h = cryptoMod.createHmac("sha256", cfg.webhookSecret);
        h.update(`${tsHeader}.${rawBody}`);
        const expected = h.digest("base64");
        if (!constantTimeEqual(sigHeader, expected)) {
          return { ok: false, reason: "assinatura HMAC inválida" };
        }
        return { ok: true, rawBody };
      } catch (e) {
        return { ok: false, reason: `falha ao validar HMAC: ${String(e)}` };
      }
    }

    // Caminho 2: secret bruto (legado / proxy)
    if (cfg.webhookSecret && secretHeader) {
      if (!constantTimeEqual(secretHeader, cfg.webhookSecret)) {
        return { ok: false, reason: "secret inválido" };
      }
      return { ok: true, rawBody };
    }

    // Caminho 3: dev sem secret configurado (libera, loga)
    if (!cfg.webhookSecret) {
      log.warn("webhook sem DAILY_WEBHOOK_SECRET — aceitando em modo dev");
      return { ok: true, rawBody };
    }

    // Caminho 4: verification ping do Daily.
    // Ao criar um webhook (POST /webhooks), o Daily envia um request de teste
    // SEM headers de assinatura e espera 200 em poucos segundos. Se o body não
    // tem o formato de um evento real (nenhum `type` de webhook reconhecido),
    // aceitamos como ping — retornamos 200 mas marcamos `testPing` pra que o
    // handler NÃO persista nada em `daily_events`.
    try {
      const parsed = JSON.parse(rawBody) as { type?: unknown };
      const t = typeof parsed?.type === "string" ? parsed.type : "";
      const isRealEvent = t.startsWith("meeting.") || t.startsWith("participant.") || t.startsWith("recording.");
      if (!isRealEvent) {
        log.warn("webhook sem assinatura — tratando como verification ping");
        return { ok: true, rawBody, testPing: true };
      }
    } catch {
      log.warn("webhook sem assinatura e body inválido — tratando como verification ping");
      return { ok: true, rawBody, testPing: true };
    }

    return { ok: false, reason: "headers de autenticação ausentes" };
  }
}

function mapRoom(d: DailyRoomResponse, expiresAt: number): CreatedRoom {
  return {
    providerId: d.id,
    name: d.name,
    url: d.url,
    expiresAt,
    raw: d,
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ────────────────────────────────────────────────────────────────────────
// Singleton + helpers
// ────────────────────────────────────────────────────────────────────────

let cached: VideoProvider | null = null;

/**
 * Retorna o provider configurado pela env `VIDEO_PROVIDER` (default: 'daily').
 * No futuro, basta criar `JitsiProvider` e adicionar caso aqui.
 */
export function getVideoProvider(): VideoProvider {
  if (cached) return cached;
  const name = (process.env.VIDEO_PROVIDER ?? "daily") as VideoProviderName;
  switch (name) {
    case "daily":
      cached = new DailyProvider();
      return cached;
    default:
      throw new Error(`[video] provider não suportado: ${name}`);
  }
}

/**
 * Helper de alto nível: cria sala + tokens em uma só chamada,
 * comum no fluxo "agendar consulta".
 *
 * Retorna tudo o que precisamos persistir em `appointments`:
 * room_name, room_url, doctor_token, patient_token.
 */
export async function provisionConsultationRoom(opts: {
  appointmentId: string;
  scheduledAt: Date;
  durationMinutes: number;
  patientName: string;
  doctorName: string;
  recordingConsent: boolean;
}): Promise<{
  room: CreatedRoom;
  tokens: JoinTokens;
}> {
  const provider = getVideoProvider();

  // Sala expira 30min após o horário marcado (folga pra atrasos)
  const endTs =
    Math.floor(opts.scheduledAt.getTime() / 1000) + (opts.durationMinutes + 30) * 60;

  // Nome curto e identificável: c-12345678 (8 primeiros chars do appointmentId)
  const name = `c-${opts.appointmentId.replace(/-/g, "").slice(0, 8)}`;

  const room = await provider.createRoom({
    name,
    expiresAt: endTs,
    enableRecording: opts.recordingConsent,
    notBeforeMinutes: 30,
  });

  const tokens = await provider.getJoinTokens({
    roomName: name,
    patientName: opts.patientName,
    doctorName: opts.doctorName,
    enableRecording: opts.recordingConsent,
    expiresAt: endTs,
  });

  return { room, tokens };
}

// ────────────────────────────────────────────────────────────────────────
// Parser de eventos Daily → forma normalizada
// ────────────────────────────────────────────────────────────────────────

type DailyEventRaw = {
  version?: string;
  type?: string;
  event_ts?: number;
  id?: string;
  payload?: {
    meeting_id?: string;
    room?: string;
    start_ts?: number;
    end_ts?: number;
    duration?: number; // em segundos (meeting.ended)
    user_name?: string;
    user_id?: string;
    is_owner?: boolean;
    joined_at?: number;
    left_at?: number;
    [k: string]: unknown;
  };
};

const KNOWN_EVENT_TYPES: Record<string, VideoEventType> = {
  "meeting.started": "meeting.started",
  "meeting.ended": "meeting.ended",
  "participant.joined": "participant.joined",
  "participant.left": "participant.left",
  "recording.ready-to-download": "recording.ready",
  "recording.ready": "recording.ready",
};

function tsToDate(ts: unknown): Date | null {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
  // Daily envia em segundos (com fração); aceita ms também por defesa.
  const ms = ts > 1e12 ? ts : ts * 1000;
  return new Date(ms);
}

/**
 * Converte payload bruto do Daily em `NormalizedVideoEvent`. Tolerante:
 * campos faltantes viram null. Tipo desconhecido vira `unknown`.
 */
export function parseDailyEvent(raw: unknown): NormalizedVideoEvent {
  const ev = (raw ?? {}) as DailyEventRaw;
  const payload = ev.payload ?? {};
  const type = KNOWN_EVENT_TYPES[ev.type ?? ""] ?? "unknown";

  // Daily reporta duração só em meeting.ended; calculamos um fallback
  // se start_ts + end_ts vierem soltos.
  let durationSeconds: number | null = null;
  if (typeof payload.duration === "number") {
    durationSeconds = Math.round(payload.duration);
  } else if (
    typeof payload.start_ts === "number" &&
    typeof payload.end_ts === "number" &&
    payload.end_ts >= payload.start_ts
  ) {
    durationSeconds = Math.round(payload.end_ts - payload.start_ts);
  }

  return {
    eventId: typeof ev.id === "string" ? ev.id : null,
    type,
    occurredAt: tsToDate(ev.event_ts) ?? tsToDate(payload.start_ts) ?? tsToDate(payload.joined_at),
    roomName: typeof payload.room === "string" ? payload.room : null,
    meetingId: typeof payload.meeting_id === "string" ? payload.meeting_id : null,
    participantName: typeof payload.user_name === "string" ? payload.user_name : null,
    participantIsOwner:
      typeof payload.is_owner === "boolean" ? payload.is_owner : null,
    durationSeconds,
    raw,
  };
}
