import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase clients para o Instituto Nova Medida.
 *
 * - `getSupabaseAdmin()` → usa SERVICE ROLE KEY. Server-only. Bypassa RLS.
 *   Usado em API routes para escrever leads, etc. NUNCA importar em
 *   client components.
 * - `getSupabaseAnon()` → usa ANON KEY. Pode rodar no client. Respeita RLS.
 *   Usado quando o usuário autenticado precisa ler/escrever os próprios dados.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let _admin: SupabaseClient | null = null;
let _anon: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (typeof window !== "undefined") {
    throw new Error(
      "[supabase] getSupabaseAdmin() não pode ser usado no client. Use getSupabaseAnon()."
    );
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "[supabase] Variáveis NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórias."
    );
  }
  if (!_admin) {
    _admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _admin;
}

export function getSupabaseAnon(): SupabaseClient {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error(
      "[supabase] Variáveis NEXT_PUBLIC_SUPABASE_URL e NEXT_PUBLIC_SUPABASE_ANON_KEY são obrigatórias."
    );
  }
  if (!_anon) {
    _anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return _anon;
}
