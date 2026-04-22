/**
 * POST /api/auth/magic-link
 *
 * Dispara o envio de magic link pra um e-mail. Antes, verifica se o
 * usuário existe e tem role ('admin' ou 'doctor') — não criamos contas
 * via signup público (operacionalmente, admins criam admins, e admins
 * criam médicas via /admin/doctors/new).
 *
 * Resposta sempre 200 (mesmo se e-mail desconhecido) pra evitar
 * enumeração de e-mails. O usuário só recebe o link se for cadastrado.
 *
 * Rate limit: por IP, 5 chamadas / 15 min (em memória — substituir
 * por Upstash em produção com tráfego real).
 */

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import {
  buildMagicLinkContext,
  logMagicLinkEvent,
} from "@/lib/magic-link-log";

const log = logger.with({ route: "/api/auth/magic-link" });
const ROUTE = "/api/auth/magic-link";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  email?: string;
  next?: string;
};

const MAX_PER_WINDOW = 5;
const WINDOW_MS = 15 * 60 * 1000;
const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimitOk(ip: string): boolean {
  const now = Date.now();
  const cur = hits.get(ip);
  if (!cur || cur.resetAt < now) {
    hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (cur.count >= MAX_PER_WINDOW) return false;
  cur.count += 1;
  return true;
}

function siteUrl(req: Request): string {
  const env = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "");
  if (env) return env;
  // Fallback: usa o origin da request
  return new URL(req.url).origin;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }

  const email = (body.email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ ok: false, error: "E-mail inválido" }, { status: 400 });
  }

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";

  const supabase = getSupabaseAdmin();
  const context = buildMagicLinkContext(req, ROUTE);

  if (!rateLimitOk(ip)) {
    // Logar primeiro (fail-soft, não bloqueia resposta)
    void logMagicLinkEvent(supabase, {
      email,
      action: "rate_limited",
      context,
    });
    return NextResponse.json(
      { ok: false, error: "Muitas tentativas. Aguarde 15 minutos." },
      { status: 429 }
    );
  }

  // Sanitiza next: só path interno, nunca URL externa
  const rawNext = body.next ?? "/admin";
  const safeNext = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/admin";

  // Busca usuário pelo e-mail. Se não existe, retorna ok=true sem
  // mandar nada (anti-enumeração).
  const { data: list, error: listErr } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  });
  if (listErr) {
    log.error("listUsers", { err: listErr });
    void logMagicLinkEvent(supabase, {
      email,
      action: "provider_error",
      reason: `listUsers: ${listErr.message ?? "unknown"}`,
      context,
    });
    return NextResponse.json({ ok: true });
  }

  const target = list.users.find((u) => u.email?.toLowerCase() === email);
  if (!target) {
    // Não revela ausência
    void logMagicLinkEvent(supabase, {
      email,
      action: "silenced_no_account",
      context,
      nextPath: safeNext,
    });
    return NextResponse.json({ ok: true });
  }

  const role = (target.app_metadata as { role?: string } | null)?.role;
  if (role !== "admin" && role !== "doctor") {
    // Usuário existe mas sem role autorizado — mesmo silêncio
    void logMagicLinkEvent(supabase, {
      email,
      action: "silenced_no_role",
      reason: role ? `role=${role}` : "role=null",
      context,
      nextPath: safeNext,
    });
    return NextResponse.json({ ok: true });
  }

  const redirectTo = `${siteUrl(req)}/api/auth/callback?next=${encodeURIComponent(safeNext)}`;

  const { error: linkErr } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: redirectTo,
      shouldCreateUser: false,
    },
  });

  if (linkErr) {
    log.error("signInWithOtp", { err: linkErr });
    void logMagicLinkEvent(supabase, {
      email,
      action: "provider_error",
      reason: `signInWithOtp: ${linkErr.message ?? "unknown"}`,
      role: role as "admin" | "doctor",
      context,
      nextPath: safeNext,
    });
    // Mesmo assim retorna ok=true pra UI mostrar a tela de "verifique caixa"
    return NextResponse.json({ ok: true });
  }

  void logMagicLinkEvent(supabase, {
    email,
    action: "issued",
    role: role as "admin" | "doctor",
    context,
    nextPath: safeNext,
  });

  return NextResponse.json({ ok: true });
}
