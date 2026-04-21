/**
 * GET /api/auth/callback?token_hash=...&type=...&next=...
 *                        (fluxo preferencial — magic-link server-side)
 *
 * GET /api/auth/callback?code=...&next=...
 *                        (fluxo PKCE — OAuth, ou SDK client-side com PKCE)
 *
 * Valida a credencial do link de e-mail e troca por uma sessão (cookie),
 * depois redireciona pro `next`.
 *
 * Por que dois caminhos?
 *   - `token_hash` + `type`: nosso template de magic-link aponta pra cá.
 *     Funciona em qualquer browser (não precisa de code_verifier).
 *     Usado com `signInWithOtp` chamado pelo admin client.
 *   - `code`: fallback pra fluxos PKCE (OAuth providers, SDK JS com cookies
 *     próprios). Mantido por compatibilidade e pra casos futuros.
 *
 * Doc: https://supabase.com/docs/guides/auth/server-side/nextjs
 */

import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { getSupabaseRouteHandler } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/auth/callback" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_OTP_TYPES: ReadonlySet<EmailOtpType> = new Set<EmailOtpType>([
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
]);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");
  const code = url.searchParams.get("code");
  const rawNext = url.searchParams.get("next") ?? "/admin";
  const safeNext =
    rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/admin";

  // Determina qual login receberia o erro com base no `next`.
  // /medico/*   → /medico/login
  // /paciente/* → /paciente/login
  // qualquer outro (incl. /admin/*) → /admin/login
  const loginBase = safeNext.startsWith("/medico")
    ? "/medico/login"
    : safeNext.startsWith("/paciente")
      ? "/paciente/login"
      : "/admin/login";

  const fail = (reason: "invalid" | "expired" | "callback") =>
    NextResponse.redirect(new URL(`${loginBase}?error=${reason}`, req.url));

  const supabase = getSupabaseRouteHandler();

  if (tokenHash && type) {
    if (!VALID_OTP_TYPES.has(type as EmailOtpType)) {
      return fail("invalid");
    }
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: type as EmailOtpType,
    });
    if (error) {
      log.error("verifyOtp", { err: error });
      const reason = error.message?.toLowerCase().includes("expired")
        ? "expired"
        : "callback";
      return fail(reason);
    }
    return NextResponse.redirect(new URL(safeNext, req.url));
  }

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      log.error("exchangeCodeForSession", { err: error });
      const reason = error.message?.toLowerCase().includes("expired")
        ? "expired"
        : "callback";
      return fail(reason);
    }
    return NextResponse.redirect(new URL(safeNext, req.url));
  }

  return fail("invalid");
}
