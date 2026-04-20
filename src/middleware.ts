/**
 * Middleware Next.js — Instituto Nova Medida.
 *
 * Responsabilidades:
 *   1. Refresh de tokens Supabase em toda request (mantém sessão viva).
 *   2. Hard-gate de rotas /admin/* e /medico/* (sem sessão → /login).
 *
 * O check fino de role (admin vs doctor) acontece dentro de cada
 * Server Component via `requireAdmin()` / `requireDoctor()`. Aqui só
 * garantimos que tem usuário logado — performance no Edge.
 *
 * Doc: https://supabase.com/docs/guides/auth/server-side/nextjs#middleware
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({
    request: { headers: request.headers },
  });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return response;

  const supabase = createServerClient(url, anon, {
    cookies: {
      get(name: string) {
        return request.cookies.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        request.cookies.set({ name, value, ...options });
        response = NextResponse.next({ request: { headers: request.headers } });
        response.cookies.set({ name, value, ...options });
      },
      remove(name: string, options: CookieOptions) {
        request.cookies.set({ name, value: "", ...options });
        response = NextResponse.next({ request: { headers: request.headers } });
        response.cookies.set({ name, value: "", ...options });
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;

  // Hard-gate: /admin/*, /medico/* e /paciente/* exigem sessão
  // (exceto as rotas de login respectivas)
  const isProtectedAdmin = path.startsWith("/admin") && !path.startsWith("/admin/login");
  const isProtectedDoctor = path.startsWith("/medico") && !path.startsWith("/medico/login");
  const isProtectedPatient =
    path.startsWith("/paciente") && !path.startsWith("/paciente/login");

  if ((isProtectedAdmin || isProtectedDoctor || isProtectedPatient) && !user) {
    const loginPath = isProtectedAdmin
      ? "/admin/login"
      : isProtectedDoctor
        ? "/medico/login"
        : "/paciente/login";
    const redirectUrl = new URL(loginPath, request.url);
    redirectUrl.searchParams.set("next", path);
    return NextResponse.redirect(redirectUrl);
  }

  return response;
}

export const config = {
  matcher: [
    // Tudo, exceto assets estáticos e _next
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt|sitemap.xml|.*\\.(?:png|jpg|jpeg|svg|webp|ico|css|js)$).*)",
  ],
};
