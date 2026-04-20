/**
 * Webhook do Daily.co — Pages Router.
 *
 * Por que Pages Router e não App Router?
 *   O superagent antigo usado pelo Daily.co (versão 3.8.3) parseia
 *   respostas HTTP de forma frágil. Quando o endpoint responde via
 *   App Router do Next 14, ele inclui `Vary: RSC, Next-Router-State-Tree,
 *   Next-Router-Prefetch` na resposta e o superagent trava com
 *   "recvd undefined" no check de verification do `POST /webhooks`.
 *   Pages Router serve a resposta "crua", sem esses headers RSC.
 *
 * Rota pública: `/api/daily-webhook` (sem barra entre daily e webhook).
 *
 * Tudo mais é idêntico ao handler principal em App Router — inclusive
 * a mesma lógica de HMAC, idempotência, resolução de appointment e
 * transições de status. Mantemos o App Router handler em
 * `/api/daily/webhook` por ora (aceita os mesmos requests); em produção
 * o Daily aponta só pra URL Pages Router.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { getSupabaseAdmin } from "@/lib/supabase";
import { parseDailyEvent, type NormalizedVideoEvent } from "@/lib/video";
import crypto from "node:crypto";

export const config = {
  api: {
    bodyParser: false, // precisamos do raw body pra validar HMAC
  },
};

async function readRawBody(req: NextApiRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

type ValidationResult =
  | { ok: true; rawBody: string; testPing?: boolean }
  | { ok: false; reason: string };

function validate(req: NextApiRequest, rawBody: string): ValidationResult {
  const secret = process.env.DAILY_WEBHOOK_SECRET;

  const sigHeader = (req.headers["x-webhook-signature"] as string | undefined) ?? null;
  const tsHeader = (req.headers["x-webhook-timestamp"] as string | undefined) ?? null;
  const secretHeader = (req.headers["x-daily-webhook-secret"] as string | undefined) ?? null;

  // Caminho 1: HMAC oficial (timestamp + body)
  if (sigHeader && tsHeader && secret) {
    const tsRaw = Number(tsHeader);
    if (!Number.isFinite(tsRaw)) return { ok: false, reason: "timestamp inválido" };
    const tsSec = tsRaw > 1e11 ? Math.floor(tsRaw / 1000) : tsRaw;
    if (Math.abs(Math.floor(Date.now() / 1000) - tsSec) > 5 * 60) {
      return { ok: false, reason: "timestamp fora da janela (replay?)" };
    }
    const h = crypto.createHmac("sha256", secret);
    h.update(`${tsHeader}.${rawBody}`);
    const expected = h.digest("base64");
    if (!constantTimeEqual(sigHeader, expected)) {
      return { ok: false, reason: "assinatura HMAC inválida" };
    }
    return { ok: true, rawBody };
  }

  // Caminho 2: secret bruto (legado)
  if (secret && secretHeader) {
    if (!constantTimeEqual(secretHeader, secret)) {
      return { ok: false, reason: "secret inválido" };
    }
    return { ok: true, rawBody };
  }

  // Caminho 3: dev sem secret
  if (!secret) {
    return { ok: true, rawBody };
  }

  // Caminho 4: verification ping sem assinatura — aceita se não é evento real
  try {
    const parsed = JSON.parse(rawBody) as { type?: unknown };
    const t = typeof parsed?.type === "string" ? parsed.type : "";
    const isRealEvent = t.startsWith("meeting.") || t.startsWith("participant.") || t.startsWith("recording.");
    if (!isRealEvent) return { ok: true, rawBody, testPing: true };
  } catch {
    return { ok: true, rawBody, testPing: true };
  }

  return { ok: false, reason: "headers de autenticação ausentes" };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // CORS headers abertos (Daily bate de servidor remoto; o endpoint
  // não é público pra browsers, mas o superagent antigo pode fazer
  // preflight em alguns cenários).
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Webhook-Signature, X-Webhook-Timestamp, X-Daily-Webhook-Secret"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, provider: "daily", path: "daily-webhook" });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  let rawBody = "";
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    console.error("[daily-webhook-pages] erro ao ler body:", e);
    return res.status(400).json({ ok: false, error: "read_error" });
  }

  const validation = validate(req, rawBody);
  if (!validation.ok) {
    console.warn("[daily-webhook-pages] validação falhou:", validation.reason);
    return res.status(401).json({ ok: false, error: "unauthorized", reason: validation.reason });
  }

  if (validation.testPing) {
    return res.status(200).json({ ok: true, pong: true });
  }

  let body: unknown;
  try {
    body = JSON.parse(validation.rawBody);
  } catch {
    return res.status(400).json({ ok: false, error: "json_invalid" });
  }

  const bodyType = (body as { type?: unknown })?.type;
  const bodyTest = (body as { test?: unknown })?.test;
  const isRealEvent = typeof bodyType === "string" && (
    bodyType.startsWith("meeting.") ||
    bodyType.startsWith("participant.") ||
    bodyType.startsWith("recording.")
  );
  if (!isRealEvent || bodyTest === "test") {
    console.log("[daily-webhook-pages] verification ping", { bodyType, bodyTest });
    return res.status(200).json({ ok: true, pong: true });
  }

  const event = parseDailyEvent(body);

  const supabase = getSupabaseAdmin();

  let appointmentId: string | null = null;
  if (event.roomName) {
    const { data: appt } = await supabase
      .from("appointments")
      .select("id")
      .eq("video_room_name", event.roomName)
      .maybeSingle();
    appointmentId = (appt?.id as string | undefined) ?? null;
  }

  // Persiste raw + idempotência
  let storedEventId: string | null = null;
  let duplicate = false;
  try {
    const { data: stored, error: storeErr } = await supabase
      .from("daily_events")
      .insert({
        event_id: event.eventId,
        event_type: (body as { type?: string })?.type ?? "unknown",
        event_ts: event.occurredAt?.toISOString() ?? null,
        daily_room_name: event.roomName,
        daily_meeting_id: event.meetingId,
        appointment_id: appointmentId,
        signature: (req.headers["x-webhook-signature"] as string | undefined) ?? null,
        signature_valid: true,
        payload: body as Record<string, unknown>,
      })
      .select("id")
      .single();
    if (storeErr) {
      if (storeErr.code === "23505") {
        duplicate = true;
      } else {
        throw storeErr;
      }
    } else {
      storedEventId = stored?.id as string | null;
    }
  } catch (e) {
    console.error("[daily-webhook-pages] falha ao persistir raw:", e);
    return res.status(200).json({ ok: true, ingested: false });
  }

  if (duplicate) {
    return res.status(200).json({ ok: true, duplicate: true });
  }

  if (!appointmentId) {
    return res.status(200).json({ ok: true, orphan: true, eventId: storedEventId });
  }

  try {
    await processEvent(supabase, appointmentId, event);
    await supabase
      .from("daily_events")
      .update({ processed_at: new Date().toISOString() })
      .eq("id", storedEventId!);
  } catch (e) {
    console.error("[daily-webhook-pages] falha ao processar:", e);
    await supabase
      .from("daily_events")
      .update({
        processed_at: new Date().toISOString(),
        processing_error: String(e),
      })
      .eq("id", storedEventId!);
  }

  return res.status(200).json({ ok: true, processed: true });
}

type Supabase = ReturnType<typeof getSupabaseAdmin>;

async function processEvent(
  supabase: Supabase,
  appointmentId: string,
  event: NormalizedVideoEvent
) {
  switch (event.type) {
    case "meeting.started": {
      const { data: appt } = await supabase
        .from("appointments")
        .select("status, started_at")
        .eq("id", appointmentId)
        .single();
      const updates: Record<string, unknown> = {};
      if (!appt?.started_at && event.occurredAt) {
        updates.started_at = event.occurredAt.toISOString();
      }
      if (appt?.status === "scheduled" || appt?.status === "confirmed") {
        updates.status = "in_progress";
      }
      if (Object.keys(updates).length > 0) {
        await supabase.from("appointments").update(updates).eq("id", appointmentId);
      }
      return;
    }
    case "meeting.ended": {
      const { data: appt } = await supabase
        .from("appointments")
        .select("status, started_at")
        .eq("id", appointmentId)
        .single();
      if (!appt) return;
      if (appt.status === "completed" || appt.status === "cancelled") return;

      const updates: Record<string, unknown> = {};
      if (event.occurredAt) updates.ended_at = event.occurredAt.toISOString();
      if (typeof event.durationSeconds === "number") {
        updates.duration_seconds = event.durationSeconds;
      }

      const { data: joins } = await supabase
        .from("daily_events")
        .select("payload")
        .eq("appointment_id", appointmentId)
        .eq("event_type", "participant.joined");
      const joinedOwners = (joins ?? []).filter(
        (j) => ((j.payload as Record<string, unknown> | null)?.is_owner) === true
      ).length;
      const joinedNonOwners = (joins ?? []).filter(
        (j) => ((j.payload as Record<string, unknown> | null)?.is_owner) !== true
      ).length;

      const hasStarted = !!appt.started_at || !!updates.started_at;
      const durOk = typeof updates.duration_seconds === "number" && (updates.duration_seconds as number) >= 180;

      if (hasStarted && durOk) {
        updates.status = "completed";
      } else if (joinedNonOwners === 0 && joinedOwners === 0) {
        updates.status = "cancelled_by_admin";
      } else if (joinedNonOwners === 0) {
        updates.status = "no_show_patient";
      } else if (joinedOwners === 0) {
        updates.status = "no_show_doctor";
      } else {
        updates.status = "completed";
      }

      await supabase.from("appointments").update(updates).eq("id", appointmentId);
      return;
    }
    case "participant.joined":
    case "participant.left":
    case "recording.ready":
    case "unknown":
    default:
      return;
  }
}
