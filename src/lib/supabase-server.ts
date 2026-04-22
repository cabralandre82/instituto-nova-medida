/**
 * Supabase clients para Server Components, Route Handlers e Server Actions.
 *
 * Por que separado de `supabase.ts`? Os clientes baseados em sessão
 * (que respeitam RLS via JWT do usuário logado) precisam ler/escrever
 * cookies do Next.js — o que só funciona em contextos server.
 *
 * Filosofia:
 *   - `getSupabaseServer()`     → cliente para Server Components / Route Handlers.
 *                                  Leitura de cookies; escrita ignorada (já é response).
 *   - `getSupabaseRouteHandler()` → cliente para Route Handlers que precisam
 *                                  setar/remover cookies (ex: callback OAuth/magic link).
 *   - `getSupabaseAdmin()`       → bypassa RLS via SERVICE_ROLE. Ver `supabase.ts`.
 *   - `getSupabaseAnon()`        → para clients/components passando JWT a mão.
 *
 * Doc: https://supabase.com/docs/guides/auth/server-side/nextjs
 *
 * Next 15: `cookies()` virou Promise. As factories aqui são `async` pra
 * resolver isso corretamente, sem `UnsafeUnwrappedCookies`.
 */

import { cookies } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function ensureEnv(): void {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error(
      "[supabase-server] NEXT_PUBLIC_SUPABASE_URL e NEXT_PUBLIC_SUPABASE_ANON_KEY são obrigatórias."
    );
  }
}

/**
 * Cliente Supabase para Server Components e Route Handlers de leitura.
 * Tentativas de set/remove cookies viram no-op (Next bloqueia mutação
 * de cookies fora de Server Action / Route Handler).
 */
export async function getSupabaseServer(): Promise<SupabaseClient> {
  ensureEnv();
  const cookieStore = await cookies();
  return createServerClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value;
      },
      set(_name: string, _value: string, _options: CookieOptions) {
        // no-op em Server Components puros
      },
      remove(_name: string, _options: CookieOptions) {
        // no-op em Server Components puros
      },
    },
  });
}

/**
 * Cliente Supabase para Route Handlers que **precisam mutar cookies**
 * (callback de magic link, signOut, refresh forçado).
 */
export async function getSupabaseRouteHandler(): Promise<SupabaseClient> {
  ensureEnv();
  const cookieStore = await cookies();
  return createServerClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value, ...options });
        } catch {
          // pode falhar em alguns ambientes; ignora
        }
      },
      remove(name: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value: "", ...options, maxAge: 0 });
        } catch {
          // ignora
        }
      },
    },
  });
}
