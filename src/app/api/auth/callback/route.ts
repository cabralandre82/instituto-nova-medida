/**
 * GET /api/auth/callback?code=...&next=...
 *
 * Endpoint que o magic link aponta. Troca o `code` (PKCE) por uma
 * sessão (cookie) e redireciona pro `next`.
 *
 * Doc: https://supabase.com/docs/guides/auth/server-side/nextjs
 */

import { NextResponse } from "next/server";
import { getSupabaseRouteHandler } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const rawNext = url.searchParams.get("next") ?? "/admin";
  const safeNext =
    rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/admin";

  // Determina qual login receberia o erro com base no `next`.
  // /medico/*  → /medico/login
  // /paciente/* → /paciente/login
  // qualquer outro (incl. /admin/*) → /admin/login
  const loginBase = safeNext.startsWith("/medico")
    ? "/medico/login"
    : safeNext.startsWith("/paciente")
      ? "/paciente/login"
      : "/admin/login";

  if (!code) {
    return NextResponse.redirect(new URL(`${loginBase}?error=invalid`, req.url));
  }

  const supabase = getSupabaseRouteHandler();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error("[auth/callback] exchangeCodeForSession:", error);
    const reason = error.message?.toLowerCase().includes("expired")
      ? "expired"
      : "callback";
    return NextResponse.redirect(new URL(`${loginBase}?error=${reason}`, req.url));
  }

  return NextResponse.redirect(new URL(safeNext, req.url));
}
