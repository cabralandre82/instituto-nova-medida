/**
 * Helpers de autenticação e autorização — Instituto Nova Medida.
 *
 * Server-only. Wrappers em torno do `getSupabaseServer()` que centralizam
 * a lógica de "quem é o usuário" e "qual o role dele".
 *
 * Roles atuais:
 *   - 'admin'   → operador (você). Acesso total ao /admin.
 *   - 'doctor'  → médica. Acesso ao /medico (próprios dados via RLS).
 *   - 'patient' → futuro (Sprint 5). Acesso ao /paciente.
 *
 * O role mora no `app_metadata.role` do auth.users (setado via
 * `supabase.auth.admin.updateUserById()` com service role). NUNCA em
 * `user_metadata`, que o usuário pode editar via API.
 */

import { redirect } from "next/navigation";
import { getSupabaseServer } from "@/lib/supabase-server";
import type { User } from "@supabase/supabase-js";

export type Role = "admin" | "doctor" | "patient";

export type SessionUser = {
  id: string;
  email: string | null;
  role: Role | null;
  raw: User;
};

/**
 * Lê a sessão atual via cookie. Retorna `null` se não há sessão.
 *
 * IMPORTANTE: usa `getUser()` (que valida JWT contra o servidor),
 * não `getSession()` (que confia no cookie). Mais lento mas seguro.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const supabase = getSupabaseServer();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) return null;

  const u = data.user;
  const role =
    (u.app_metadata?.role as Role | undefined) ??
    (u.user_metadata?.role as Role | undefined) ??
    null;

  return {
    id: u.id,
    email: u.email ?? null,
    role,
    raw: u,
  };
}

/**
 * Garante que há sessão válida. Se não, redireciona pra login.
 * Use no topo de Server Components/Route Handlers protegidos.
 */
export async function requireAuth(redirectTo = "/admin/login"): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect(redirectTo);
  return user;
}

/**
 * Garante que o usuário é admin. Se não autenticado → login.
 * Se autenticado mas sem role admin → /admin/login (com flag).
 */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireAuth("/admin/login");
  if (user.role !== "admin") {
    redirect("/admin/login?error=forbidden");
  }
  return user;
}

/**
 * Garante que o usuário é médica e retorna o doctor_id correspondente.
 * Se não autenticada → /medico/login. Se autenticada mas sem perfil
 * doctor → erro forbidden.
 */
export async function requireDoctor(): Promise<{
  user: SessionUser;
  doctorId: string;
}> {
  const user = await requireAuth("/medico/login");
  if (user.role !== "doctor") {
    redirect("/medico/login?error=forbidden");
  }

  const supabase = getSupabaseServer();
  const { data, error } = await supabase
    .from("doctors")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error || !data?.id) {
    redirect("/medico/login?error=no_profile");
  }
  return { user, doctorId: data.id as string };
}
