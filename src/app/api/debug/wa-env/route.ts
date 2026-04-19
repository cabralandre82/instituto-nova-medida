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

  const appSecret = process.env.META_APP_SECRET ?? "";
  const proof = createHash("sha256")
    .update("dummy")
    .digest("hex");
  void proof;

  // gera app secret proof real
  const appsecretProof = require("node:crypto")
    .createHmac("sha256", appSecret)
    .update(token)
    .digest("hex");

  const body = JSON.stringify({
    messaging_product: "whatsapp",
    to: "5521998851851",
    type: "template",
    template: { name: "hello_world", language: { code: "en_US" } },
  });

  // Probe POST sem appsecret_proof (jeito atual)
  let probePost: Record<string, unknown> = { skipped: true };
  try {
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
    try { parsed = JSON.parse(txt); } catch {}
    probePost = {
      _http_status: postRes.status,
      response: parsed,
    };
  } catch (e) {
    probePost = { fetch_error: e instanceof Error ? e.message : String(e) };
  }

  // Probe POST com appsecret_proof
  let probePostWithProof: Record<string, unknown> = { skipped: true };
  try {
    const postRes = await fetch(
      `https://graph.facebook.com/v21.0/${phoneId}/messages?appsecret_proof=${appsecretProof}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "curl/8.4.0",
        },
        body,
        cache: "no-store",
      }
    );
    const txt = await postRes.text();
    let parsed: unknown = txt;
    try { parsed = JSON.parse(txt); } catch {}
    probePostWithProof = {
      _http_status: postRes.status,
      response: parsed,
    };
  } catch (e) {
    probePostWithProof = { fetch_error: e instanceof Error ? e.message : String(e) };
  }

  // Probe: outbound IP (qual IP a Meta vê)
  let outboundIp: unknown = "unknown";
  try {
    const ipRes = await fetch("https://api.ipify.org?format=json", { cache: "no-store" });
    outboundIp = await ipRes.json();
  } catch (e) {
    outboundIp = { error: e instanceof Error ? e.message : String(e) };
  }

  return NextResponse.json({
    runtime_region: process.env.VERCEL_REGION ?? "unknown",
    outbound_ip: outboundIp,
    appsecret_proof_first16: appsecretProof.slice(0, 16),
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
    probe_post_with_appsecret_proof: probePostWithProof,
  });
}
