/**
 * POST /api/lead — captura de leads do quiz da landing page.
 *
 * Endurecido em PR-036 · D-054 contra audit [9.1 + 9.3 + 22.2]:
 *   - **Body size guard** (8 KB pré-parse) pra DoS.
 *   - **Rate-limit por IP** (10 leads / 15min) pra atacante spam.
 *   - **`validateLead`** sanitiza charset, tamanho e shape de
 *     `name`/`phone`/`answers`/`utm`/`referrer`/`landingPath` antes
 *     do INSERT. Qualquer prompt-injection em `answers` (campo que
 *     alimentará LLMs no futuro) é rejeitado na borda.
 *
 * UX: erros retornam 400/413/429 com mensagem amigável. Erros
 * internos (WhatsApp, Supabase) não derrubam a resposta de sucesso:
 * o lead é o que importa pra captura.
 */

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { sendBoasVindas } from "@/lib/whatsapp";
import { isBodyTooLarge, validateLead } from "@/lib/lead-validate";

export const runtime = "nodejs";

const CONSENT_TEXT =
  "Pode me chamar por aqui. Concordo com a Política de Privacidade e o uso dos meus dados conforme a LGPD.";

// ────────────────────────────────────────────────────────────────────────
// Rate-limit in-memory (mesmo pattern do magic-link e /api/cep).
// Leads são mais "caros" (disparam WhatsApp outbound = custo Meta),
// então o bucket é mais agressivo: 10 por IP / 15min.
// ────────────────────────────────────────────────────────────────────────

const MAX_LEADS_PER_WINDOW = 10;
const LEAD_RATE_WINDOW_MS = 15 * 60 * 1000;
const leadHits = new Map<string, { count: number; resetAt: number }>();

function leadRateLimitOk(ip: string): boolean {
  const now = Date.now();
  const cur = leadHits.get(ip);
  if (!cur || cur.resetAt < now) {
    leadHits.set(ip, { count: 1, resetAt: now + LEAD_RATE_WINDOW_MS });
    return true;
  }
  if (cur.count >= MAX_LEADS_PER_WINDOW) return false;
  cur.count += 1;
  return true;
}

function getClientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

export async function POST(req: Request) {
  // 1. Body-size guard ANTES de parsear JSON.
  //    Lemos como texto primeiro pra medir bytes UTF-8.
  let rawText: string;
  try {
    rawText = await req.text();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Falha ao ler body" },
      { status: 400 }
    );
  }
  if (isBodyTooLarge(rawText)) {
    return NextResponse.json(
      { ok: false, error: "Payload muito grande" },
      { status: 413 }
    );
  }

  // 2. Parse + rate-limit.
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return NextResponse.json(
      { ok: false, error: "JSON inválido" },
      { status: 400 }
    );
  }

  const ip = getClientIp(req);
  if (!leadRateLimitOk(ip)) {
    return NextResponse.json(
      {
        ok: false,
        error: "Muitas tentativas. Aguarde alguns minutos e tente novamente.",
      },
      { status: 429, headers: { "Retry-After": "900" } }
    );
  }

  // 3. Valida + sanitiza.
  const result = validateLead(parsed);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.message, code: result.code },
      { status: 400 }
    );
  }
  const lead = result.lead;

  const userAgent = req.headers.get("user-agent") || null;
  const referrer = lead.referrer || req.headers.get("referer") || null;

  // 4. Persistência.
  const row = {
    name: lead.name,
    phone: lead.phone,
    answers: lead.answers,
    consent: lead.consent,
    consent_text: CONSENT_TEXT,
    consent_at: new Date().toISOString(),
    utm: lead.utm,
    referrer,
    landing_path: lead.landingPath,
    ip,
    user_agent: userAgent,
    status: "novo" as const,
  };

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("leads")
      .insert(row)
      .select("id")
      .single();

    if (error) {
      console.error("[instituto-nova-medida][lead] supabase error:", error);
      return NextResponse.json(
        { ok: false, error: "Falha ao registrar" },
        { status: 500 }
      );
    }

    console.log("[instituto-nova-medida][lead] inserted:", data?.id);

    // 5. Disparar MSG 1 (boas-vindas) via WhatsApp Cloud API.
    //
    // Importante: em runtime serverless (Vercel), promises "fire-and-forget"
    // após `return` são abortadas pela plataforma. Por isso fazemos `await`
    // antes de responder. Custo: ~300-800ms a mais na resposta. Benefício:
    // disparo confiável e status registrado no mesmo ciclo.
    //
    // Falha do WhatsApp não derruba a resposta de sucesso do lead — a
    // persistência é o que importa pra captura. O erro fica gravado pra
    // retry posterior.
    try {
      const wa = await sendBoasVindas({
        to: lead.phone,
        firstName: lead.name,
      });

      if (!wa.ok) {
        console.error(
          "[instituto-nova-medida][lead][whatsapp] falha ao enviar MSG 1:",
          { leadId: data?.id, code: wa.code, message: wa.message, details: wa.details }
        );
        await supabase
          .from("leads")
          .update({
            whatsapp_msg1_status: "failed",
            whatsapp_msg1_error: `${wa.code ?? "?"}: ${wa.message}${
              wa.details ? ` | ${wa.details}` : ""
            }`,
          })
          .eq("id", data?.id);
      } else {
        console.log("[instituto-nova-medida][lead][whatsapp] MSG 1 enviada:", {
          leadId: data?.id,
          messageId: wa.messageId,
          waId: wa.waId,
        });
        await supabase
          .from("leads")
          .update({
            whatsapp_msg1_status: "sent",
            whatsapp_msg1_message_id: wa.messageId,
            whatsapp_msg1_sent_at: new Date().toISOString(),
          })
          .eq("id", data?.id);
      }
    } catch (waErr) {
      console.error(
        "[instituto-nova-medida][lead][whatsapp] exception:",
        waErr
      );
      await supabase
        .from("leads")
        .update({
          whatsapp_msg1_status: "failed",
          whatsapp_msg1_error: `exception: ${
            waErr instanceof Error ? waErr.message : String(waErr)
          }`,
        })
        .eq("id", data?.id);
    }

    return NextResponse.json({ ok: true, id: data?.id });
  } catch (err) {
    console.error("[instituto-nova-medida][lead] internal error:", err);
    return NextResponse.json(
      { ok: false, error: "Erro interno" },
      { status: 500 }
    );
  }
}
