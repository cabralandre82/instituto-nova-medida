/**
 * Layout do shell da área do paciente — D-043.
 *
 * Aplica em todas as páginas /paciente/* EXCETO /paciente/login (fora
 * do route group). Hard-gate via requirePatient() — exige sessão +
 * role=patient + customer vinculado.
 */

import type { Metadata } from "next";
import { Logo } from "@/components/Logo";
import { requirePatient } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { PatientNav } from "./_components/PatientNav";

export const metadata: Metadata = {
  title: "Seu tratamento · Instituto Nova Medida",
  robots: { index: false, follow: false },
};

export default async function PatientShellLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, customerId } = await requirePatient();

  const supabase = getSupabaseAdmin();
  const { data: customer } = await supabase
    .from("customers")
    .select("name")
    .eq("id", customerId)
    .maybeSingle();

  const firstName = (customer?.name ?? "").split(" ")[0];
  const greeting = firstName || user.email || "Você";

  return (
    <div className="min-h-screen bg-cream-50">
      <header className="sticky top-0 z-30 bg-white border-b border-ink-100">
        <div className="mx-auto max-w-[1400px] px-5 sm:px-8 h-14 flex items-center justify-between gap-6">
          <div className="flex items-center gap-8">
            <Logo href="/paciente" />
            <span className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium hidden md:inline">
              Seu tratamento
            </span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-ink-500 hidden sm:inline">Olá, {greeting}</span>
            <form action="/api/auth/signout" method="post">
              <input type="hidden" name="to" value="/paciente/login" />
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
          <PatientNav />
        </aside>
        <main className="min-w-0">{children}</main>
      </div>
    </div>
  );
}
