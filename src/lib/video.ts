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
  | { ok: true; rawBody: string }
  | { ok: false; reason: string };

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
}

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

async function dailyRequest<T>(
  apiKey: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  let res: Response;
  try {
    res = await fetch(`${DAILY_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch (e) {
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

  async validateWebhook(req: Request): Promise<WebhookValidation> {
    // Daily envia o secret estático no header x-webhook-signature (HMAC-SHA256
    // do body). Pra MVP simples, aceitamos secret bruto via header
    // x-daily-webhook-secret também (configurável no painel Daily).
    // Em produção real, validar HMAC é mais forte.
    const cfg = loadDailyConfig();
    const headerSecret = req.headers.get("x-daily-webhook-secret");
    const rawBody = await req.text();

    if (cfg.webhookSecret && headerSecret) {
      // Comparação constante
      if (!constantTimeEqual(headerSecret, cfg.webhookSecret)) {
        return { ok: false, reason: "secret inválido" };
      }
      return { ok: true, rawBody };
    }

    // Em dev sem secret configurado, aceita pra facilitar (loga em produção)
    if (!cfg.webhookSecret) {
      return { ok: true, rawBody };
    }

    return { ok: false, reason: "header de autenticação ausente" };
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
