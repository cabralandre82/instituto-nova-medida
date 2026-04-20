/**
 * Layout do shell da médica. Aplica em todas as páginas /medico/*
 * EXCETO /medico/login (fora do route group, usa root layout).
 *
 * Hard-gate em role 'doctor' via requireDoctor() — server-side.
 * Middleware já garantiu sessão; aqui validamos role + perfil de médica
 * existente em public.doctors.
 */

import type { Metadata } from "next";
import { Logo } from "@/components/Logo";
import { requireDoctor } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { DoctorNav } from "./_components/DoctorNav";

export const metadata: Metadata = {
  title: "Área da médica · Instituto Nova Medida",
  robots: { index: false, follow: false },
};

export default async function DoctorShellLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, doctorId } = await requireDoctor();

  // Carrega só o nome de exibição pra header — barato, mas centralizado aqui
  // pra não repetir em cada página.
  const supabase = getSupabaseAdmin();
  const { data: doctor } = await supabase
    .from("doctors")
    .select("display_name, full_name")
    .eq("id", doctorId)
    .maybeSingle();

  const greeting = doctor?.display_name ?? doctor?.full_name ?? user.email ?? "Médica";

  return (
    <div className="min-h-screen bg-cream-50">
      <header className="sticky top-0 z-30 bg-white border-b border-ink-100">
        <div className="mx-auto max-w-[1400px] px-5 sm:px-8 h-14 flex items-center justify-between gap-6">
          <div className="flex items-center gap-8">
            <Logo href="/medico" />
            <span className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium hidden md:inline">
              Área da médica
            </span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-ink-500 hidden sm:inline">{greeting}</span>
            <form action="/api/auth/signout" method="post">
              <input type="hidden" name="to" value="/medico/login" />
              <button
                type="submit"
                className="text-sm text-ink-500 hover:text-ink-800 transition-colors"
              >
                Sair
              </button>
            </form>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1400px] px-5 sm:px-8 py-8 grid lg:grid-cols-[220px_1fr] gap-8">
        <aside className="lg:sticky lg:top-20 lg:self-start">
          <DoctorNav />
        </aside>
        <main className="min-w-0">{children}</main>
      </div>
    </div>
  );
}
