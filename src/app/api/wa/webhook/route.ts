import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Webhook da Meta WhatsApp Cloud API — Instituto Nova Medida.
 *
 * Eventos suportados:
 * - `messages.statuses[]` → status da mensagem que enviamos
 *   (sent | delivered | read | failed) → atualiza coluna em `leads`
 * - `messages.messages[]` → mensagem recebida (paciente respondeu)
 *
 * Tudo é gravado bruto em `whatsapp_events` antes de qualquer
 * processamento, então o handler nunca perde evento — mesmo que tenha bug
 * downstream, o payload original fica disponível pra reprocessar.
 */

// =============================================================================
// GET — handshake de verificação da Meta
// =============================================================================
// Quando configuramos o webhook no painel da Meta, ela faz GET com 3 params:
// hub.mode=subscribe, hub.verify_token=<o que setamos>, hub.challenge=<rand>
// Nós precisamos retornar o challenge tal qual em texto puro.
export function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  const expected = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

  if (mode === "subscribe" && token && challenge && token === expected) {
    console.log("[wa-webhook] verified OK");
    return new Response(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  console.warn("[wa-webhook] verify failed", {
    mode,
    tokenMatch: token === expected,
    hasChallenge: !!challenge,
  });
  return new Response("forbidden", { status: 403 });
}

// =============================================================================
// POST — recebe eventos da Meta
// =============================================================================

type MetaWebhookStatus = {
  id: string; // wamid.*
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: string;
  recipient_id: string;
  errors?: Array<{
    code: number;
    title: string;
    message?: string;
    error_data?: { details?: string };
  }>;
};

type MetaWebhookMessage = {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
};

type MetaWebhookValue = {
  messaging_product: "whatsapp";
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  statuses?: MetaWebhookStatus[];
  messages?: MetaWebhookMessage[];
};

type MetaWebhookEntry = {
  id: string;
  changes: Array<{ field: string; value: MetaWebhookValue }>;
};

type MetaWebhookBody = {
  object: string;
  entry: MetaWebhookEntry[];
};

export async function POST(req: Request) {
  let body: MetaWebhookBody;
  try {
    body = (await req.json()) as MetaWebhookBody;
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  // Sempre respondemos 200 rápido pra Meta não fazer retry. Processamento é
  // idempotente do nosso lado.
  const supabase = getSupabaseAdmin();

  try {
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value || value.messaging_product !== "whatsapp") continue;

        const phoneNumberId = value.metadata?.phone_number_id ?? null;

        // -- statuses (delivery report) -------------------------------------
        for (const s of value.statuses ?? []) {
          const err = s.errors?.[0];
          await supabase.from("whatsapp_events").insert({
            event_type: "message_status",
            message_id: s.id,
            status: s.status,
            recipient_id: s.recipient_id,
            phone_number_id: phoneNumberId,
            payload: s as unknown as Record<string, unknown>,
            error_code: err?.code ?? null,
            error_title: err?.title ?? null,
            error_message:
              err?.message ?? err?.error_data?.details ?? null,
          });

          // Atualiza o lead correspondente. Idempotente: vamos só "subir" o
          // status (sent < delivered < read). Failed sobrescreve qualquer
          // estado.
          await applyStatusToLead(s);

          console.log("[wa-webhook] status:", {
            id: s.id,
            status: s.status,
            recipient: s.recipient_id,
            err: err?.code,
          });
        }

        // -- messages (paciente respondeu) -----------------------------------
        for (const m of value.messages ?? []) {
          await supabase.from("whatsapp_events").insert({
            event_type: "message",
            message_id: m.id,
            recipient_id: m.from,
            phone_number_id: phoneNumberId,
            payload: m as unknown as Record<string, unknown>,
          });
          console.log("[wa-webhook] inbound message:", {
            id: m.id,
            from: m.from,
            type: m.type,
            text: m.text?.body,
          });
        }
      }
    }
  } catch (err) {
    console.error("[wa-webhook] internal error:", err);
    // Mesmo assim respondemos 200 pra Meta não ficar martelando — temos o
    // payload bruto persistido (na ordem do for) e podemos reprocessar.
  }

  return NextResponse.json({ ok: true });
}

// Ordem de "subida" do status: failed encerra; senão read > delivered > sent.
const STATUS_RANK: Record<string, number> = {
  sent: 1,
  delivered: 2,
  read: 3,
};

async function applyStatusToLead(s: MetaWebhookStatus) {
  const supabase = getSupabaseAdmin();
  const { data: lead } = await supabase
    .from("leads")
    .select("id, whatsapp_msg1_status")
    .eq("whatsapp_msg1_message_id", s.id)
    .maybeSingle();

  if (!lead) return; // mensagem que enviamos mas não temos lead correspondente (debug curl, p.ex.)

  if (s.status === "failed") {
    const err = s.errors?.[0];
    await supabase
      .from("leads")
      .update({
        whatsapp_msg1_status: "failed",
        whatsapp_msg1_error: err
          ? `${err.code}: ${err.title}${
              err.message ? ` | ${err.message}` : ""
            }`
          : "failed (sem detalhes)",
      })
      .eq("id", lead.id);
    return;
  }

  const currentRank = STATUS_RANK[lead.whatsapp_msg1_status ?? ""] ?? 0;
  const newRank = STATUS_RANK[s.status] ?? 0;
  if (newRank > currentRank) {
    await supabase
      .from("leads")
      .update({ whatsapp_msg1_status: s.status })
      .eq("id", lead.id);
  }
}
