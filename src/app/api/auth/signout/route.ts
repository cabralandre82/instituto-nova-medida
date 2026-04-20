/**
 * POST /api/auth/signout
 *
 * Encerra a sessão do usuário (limpa cookies) e redireciona pro login.
 */

import { NextResponse } from "next/server";
import { getSupabaseRouteHandler } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const supabase = getSupabaseRouteHandler();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/admin/login", req.url), { status: 303 });
}
