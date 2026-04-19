import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { sendBoasVindas } from "@/lib/whatsapp";

export const runtime = "nodejs";

type Lead = {
  name: string;
  phone: string;
  consent: boolean;
  answers: Record<string, string>;
  utm?: Record<string, string>;
  referrer?: string;
  landingPath?: string;
};

const CONSENT_TEXT =
  "Pode me chamar por aqui. Concordo com a Política de Privacidade e o uso dos meus dados conforme a LGPD.";

function isValid(body: Partial<Lead>): body is Lead {
  if (!body || typeof body !== "object") return false;
  if (typeof body.name !== "string" || body.name.trim().length < 2) return false;
  if (
    typeof body.phone !== "string" ||
    body.phone.replace(/\D/g, "").length < 10
  )
    return false;
  if (body.consent !== true) return false;
  if (!body.answers || typeof body.answers !== "object") return false;
  return true;
}

export async function POST(req: Request) {
  let body: Partial<Lead>;
  try {
    body = (await req.json()) as Partial<Lead>;
  } catch {
    return NextResponse.json(
      { ok: false, error: "JSON inválido" },
      { status: 400 }
    );
  }

  if (!isValid(body)) {
    return NextResponse.json(
      { ok: false, error: "Dados inválidos" },
      { status: 400 }
    );
  }

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    null;
  const userAgent = req.headers.get("user-agent") || null;
  const referrer = body.referrer || req.headers.get("referer") || null;

  const lead = {
    name: body.name.trim(),
    phone: body.phone.replace(/\D/g, ""),
    answers: body.answers,
    consent: body.consent,
    consent_text: CONSENT_TEXT,
    consent_at: new Date().toISOString(),
    utm: body.utm ?? {},
    referrer,
    landing_path: body.landingPath ?? "/",
    ip,
    user_agent: userAgent,
    status: "novo" as const,
  };

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("leads")
      .insert(lead)
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

    // Disparar MSG 1 (boas-vindas) via WhatsApp Cloud API.
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

    // TODO Sprint 5: enviar evento de conversão para Meta CAPI

    return NextResponse.json({ ok: true, id: data?.id });
  } catch (err) {
    console.error("[instituto-nova-medida][lead] internal error:", err);
    return NextResponse.json(
      { ok: false, error: "Erro interno" },
      { status: 500 }
    );
  }
}
