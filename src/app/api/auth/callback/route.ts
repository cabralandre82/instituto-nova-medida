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
import { getSupabaseAdmin } from "@/lib/supabase";
import { getSupabaseRouteHandler } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import {
  buildMagicLinkContext,
  logMagicLinkEvent,
  type MagicLinkRole,
} from "@/lib/magic-link-log";

const log = logger.with({ route: "/api/auth/callback" });
const ROUTE = "/api/auth/callback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function resolveRole(appMetadata: unknown): MagicLinkRole {
  const role = (appMetadata as { role?: string } | null)?.role;
  if (role === "admin" || role === "doctor" || role === "patient") return role;
  return null;
}

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

  const supabase = await getSupabaseRouteHandler();
  // Cliente admin separado pro log (fail-soft; não reusa o session-
  // writing client pra não acoplar o log à criação da sessão).
  const admin = getSupabaseAdmin();
  const context = buildMagicLinkContext(req, ROUTE);

  const fail = (
    reason: "invalid" | "expired" | "callback",
    detail?: { email?: string | null; role?: MagicLinkRole; err?: string }
  ) => {
    void logMagicLinkEvent(admin, {
      email: detail?.email ?? null,
      action: "verify_failed",
      role: detail?.role,
      reason: detail?.err ?? reason,
      context,
      nextPath: safeNext,
      metadata: { reason_code: reason },
    });
    return NextResponse.redirect(new URL(`${loginBase}?error=${reason}`, req.url));
  };

  if (tokenHash && type) {
    if (!VALID_OTP_TYPES.has(type as EmailOtpType)) {
      return fail("invalid", { err: `type desconhecido: ${type}` });
    }
    const { data, error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: type as EmailOtpType,
    });
    if (error) {
      log.error("verifyOtp", { err: error });
      const reason = error.message?.toLowerCase().includes("expired")
        ? "expired"
        : "callback";
      return fail(reason, { err: error.message });
    }
    // Sucesso: extrai email + role do usuário autenticado pra trilha.
    const user = data.user;
    void logMagicLinkEvent(admin, {
      email: user?.email ?? null,
      action: "verified",
      role: resolveRole(user?.app_metadata),
      context,
      nextPath: safeNext,
      metadata: { otp_type: type },
    });
    return NextResponse.redirect(new URL(safeNext, req.url));
  }

  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      log.error("exchangeCodeForSession", { err: error });
      const reason = error.message?.toLowerCase().includes("expired")
        ? "expired"
        : "callback";
      return fail(reason, { err: error.message });
    }
    const user = data.user;
    void logMagicLinkEvent(admin, {
      email: user?.email ?? null,
      action: "verified",
      role: resolveRole(user?.app_metadata),
      context,
      nextPath: safeNext,
      metadata: { flow: "pkce" },
    });
    return NextResponse.redirect(new URL(safeNext, req.url));
  }

  return fail("invalid", { err: "sem token_hash nem code" });
}
