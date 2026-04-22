/**
 * POST /api/paciente/auth/magic-link — D-043
 *
 * Fluxo dedicado pro paciente. Diferente do /api/auth/magic-link (que
 * atende admin/médica e exige conta pré-existente), aqui o paciente
 * pode se auto-provisionar:
 *
 *   - Se o email bate um `customers` (cliente que comprou) e ainda
 *     não existe auth.user → cria auth.user com role=patient,
 *     vincula customers.user_id, envia magic-link.
 *   - Se já existe auth.user com role=patient (ou role NULL +
 *     customer que bate) → upgrade + envia magic-link.
 *   - Se nada bate → 200 OK silencioso (anti-enumeração).
 *
 * Rate limit em memória: 5 por IP / 15 min. Para produção escalada,
 * trocar por Upstash/Redis.
 */

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import {
  buildMagicLinkContext,
  logMagicLinkEvent,
} from "@/lib/magic-link-log";

const log = logger.with({ route: "/api/paciente/auth/magic-link" });
const ROUTE = "/api/paciente/auth/magic-link";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { email?: string; next?: string };

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
    void logMagicLinkEvent(supabase, {
      email,
      action: "rate_limited",
      context,
    });
    return NextResponse.json(
      { ok: false, error: "Muitas tentativas. Aguarde 15 minutos." },
      { status: 429 },
    );
  }

  const rawNext = body.next ?? "/paciente";
  const safeNext =
    rawNext.startsWith("/paciente") && !rawNext.startsWith("//")
      ? rawNext
      : "/paciente";

  // 1. Procura customer pelo email (fonte da verdade do "paciente")
  const { data: customer } = await supabase
    .from("customers")
    .select("id, user_id, email")
    .ilike("email", email)
    .maybeSingle();

  // Se não é customer, silêncio (anti-enumeração + anti-abuso de magic-link)
  if (!customer) {
    void logMagicLinkEvent(supabase, {
      email,
      action: "silenced_no_customer",
      context,
      nextPath: safeNext,
    });
    return NextResponse.json({ ok: true });
  }

  // 2. Procura auth.user com esse email
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
  let target = list.users.find((u) => u.email?.toLowerCase() === email);
  let autoProvisioned = false;

  // 3. Não existe auth.user → cria com role=patient
  if (!target) {
    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
      email,
      email_confirm: true,
      app_metadata: { role: "patient" },
    });
    if (createErr || !created.user) {
      log.error("createUser", { err: createErr });
      void logMagicLinkEvent(supabase, {
        email,
        action: "provider_error",
        reason: `createUser: ${createErr?.message ?? "unknown"}`,
        context,
      });
      return NextResponse.json({ ok: true });
    }
    target = created.user;
    autoProvisioned = true;
    void logMagicLinkEvent(supabase, {
      email,
      action: "auto_provisioned",
      role: "patient",
      context,
      nextPath: safeNext,
      metadata: { customer_id: customer.id },
    });
    // Trigger SQL já vincula customers.user_id, mas garantimos aqui
    // (caso a migration 018 ainda não tenha rodado).
    if (!customer.user_id) {
      await supabase
        .from("customers")
        .update({ user_id: created.user.id })
        .eq("id", customer.id);
    }
  } else {
    // 4. Existe auth.user — valida/upgrade role e vínculo
    const meta = (target.app_metadata ?? {}) as { role?: string };
    if (meta.role !== "patient") {
      // Só promove se não tem role conflitante (admin/doctor)
      if (meta.role === "admin" || meta.role === "doctor") {
        // Conta com role específica — não deixa login como paciente
        // pra não mesclar escopos
        void logMagicLinkEvent(supabase, {
          email,
          action: "silenced_wrong_scope",
          reason: `role=${meta.role} tentou fluxo de paciente`,
          role: meta.role,
          context,
          nextPath: safeNext,
        });
        return NextResponse.json({ ok: true });
      }
      const { error: upErr } = await supabase.auth.admin.updateUserById(
        target.id,
        {
          app_metadata: { ...target.app_metadata, role: "patient" },
        },
      );
      if (upErr) {
        log.error("upgrade role", { err: upErr });
        void logMagicLinkEvent(supabase, {
          email,
          action: "provider_error",
          reason: `updateUserById: ${upErr.message ?? "unknown"}`,
          context,
        });
        return NextResponse.json({ ok: true });
      }
    }
    if (!customer.user_id) {
      await supabase
        .from("customers")
        .update({ user_id: target.id })
        .eq("id", customer.id);
    }
  }

  // 5. Dispara o link de fato
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
      role: "patient",
      context,
      nextPath: safeNext,
      metadata: { auto_provisioned: autoProvisioned },
    });
  } else {
    void logMagicLinkEvent(supabase, {
      email,
      action: "issued",
      role: "patient",
      context,
      nextPath: safeNext,
      metadata: { auto_provisioned: autoProvisioned },
    });
  }

  return NextResponse.json({ ok: true });
}
