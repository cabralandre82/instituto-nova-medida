import { NextResponse } from "next/server";
import { createHash } from "node:crypto";

// TEMPORÁRIO — endpoint de debug para diagnosticar o token no runtime do Vercel.
// REMOVER após o problema 131005 estar resolvido.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // Trava simples: só responde se vier o secret correto na query
  const url = new URL(req.url);
  const secret = url.searchParams.get("k");
  if (secret !== process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    return new Response("nope", { status: 404 });
  }

  const token = process.env.WHATSAPP_ACCESS_TOKEN ?? "";
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID ?? "";
  const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? "";

  // Hash do token (sem expor o token em si)
  const tokenSha = createHash("sha256").update(token).digest("hex").slice(0, 16);

  let probeGet: Record<string, unknown> = { skipped: true };
  try {
    const probeRes = await fetch(
      `https://graph.facebook.com/v21.0/${phoneId}?fields=display_phone_number,status`,
      {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      }
    );
    probeGet = (await probeRes.json()) as Record<string, unknown>;
    probeGet._http_status = probeRes.status;
  } catch (e) {
    probeGet = { fetch_error: e instanceof Error ? e.message : String(e) };
  }

  let probePost: Record<string, unknown> = { skipped: true };
  try {
    const body = JSON.stringify({
      messaging_product: "whatsapp",
      to: "5521998851851",
      type: "template",
      template: { name: "hello_world", language: { code: "en_US" } },
    });
    const postRes = await fetch(
      `https://graph.facebook.com/v21.0/${phoneId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body,
        cache: "no-store",
      }
    );
    const txt = await postRes.text();
    let parsed: unknown = txt;
    try {
      parsed = JSON.parse(txt);
    } catch {}
    probePost = {
      _http_status: postRes.status,
      _body_sent_length: body.length,
      _auth_header_length: `Bearer ${token}`.length,
      response: parsed,
    };
  } catch (e) {
    probePost = { fetch_error: e instanceof Error ? e.message : String(e) };
  }

  return NextResponse.json({
    token: {
      length: token.length,
      sha256_first16: tokenSha,
      starts_with: token.slice(0, 12),
      ends_with: token.slice(-12),
      has_leading_whitespace: /^\s/.test(token),
      has_trailing_whitespace: /\s$/.test(token),
      has_quotes: token.includes('"') || token.includes("'"),
    },
    phone_number_id: phoneId,
    waba_id: wabaId,
    probe_get: probeGet,
    probe_post: probePost,
  });
}
