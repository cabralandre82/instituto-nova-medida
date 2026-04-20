/**
 * POST /api/auth/signout
 *
 * Encerra a sessão do usuário (limpa cookies) e redireciona pro login
 * apropriado. O parâmetro opcional `to` (form field ou query string)
 * permite escolher /medico/login vs /admin/login. Default: /admin/login.
 */

import { NextResponse } from "next/server";
import { getSupabaseRouteHandler } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function readTo(req: Request): Promise<string> {
  const url = new URL(req.url);
  const queryTo = url.searchParams.get("to");
  if (queryTo) return queryTo;

  // Aceita form-urlencoded também (botão Sair em <form>)
  const ctype = req.headers.get("content-type") ?? "";
  if (ctype.includes("application/x-www-form-urlencoded")) {
    try {
      const fd = await req.formData();
      const v = fd.get("to");
      if (typeof v === "string" && v.length > 0) return v;
    } catch {
      // ignora
    }
  }
  return "/admin/login";
}

export async function POST(req: Request) {
  const supabase = getSupabaseRouteHandler();
  await supabase.auth.signOut();

  const rawTo = await readTo(req);
  const safeTo =
    rawTo.startsWith("/") && !rawTo.startsWith("//") ? rawTo : "/admin/login";

  return NextResponse.redirect(new URL(safeTo, req.url), { status: 303 });
}
