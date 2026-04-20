/**
 * Layout do shell administrativo. Aplica em todas as páginas /admin/*
 * EXCETO /admin/login (que está fora do route group e usa root layout).
 *
 * Hard-gate em role 'admin' via requireAdmin() — server-side.
 * Middleware já garantiu que tem sessão; aqui validamos role.
 */

import type { Metadata } from "next";
import { Logo } from "@/components/Logo";
import { requireAdmin } from "@/lib/auth";
import { AdminNav } from "./_components/AdminNav";
import { PatientSearchBar } from "./_components/PatientSearchBar";

export const metadata: Metadata = {
  title: "Painel · Instituto Nova Medida",
  robots: { index: false, follow: false },
};

export default async function AdminShellLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireAdmin();

  return (
    <div className="min-h-screen bg-cream-50">
      <header className="sticky top-0 z-30 bg-white border-b border-ink-100">
        <div className="mx-auto max-w-[1400px] px-5 sm:px-8 h-14 flex items-center gap-6">
          <div className="flex items-center gap-6 flex-shrink-0">
            <Logo href="/admin" />
            <span className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium hidden xl:inline">
              Painel admin
            </span>
          </div>
          <PatientSearchBar />
          <div className="flex items-center gap-4 flex-shrink-0 ml-auto">
            <span className="text-sm text-ink-500 hidden sm:inline">
              {user.email}
            </span>
            <form action="/api/auth/signout" method="post">
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
          <AdminNav />
        </aside>
        <main className="min-w-0">{children}</main>
      </div>
    </div>
  );
}
