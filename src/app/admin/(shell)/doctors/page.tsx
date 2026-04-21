/**
 * /admin/doctors — Lista de médicas com filtros simples.
 */

import Link from "next/link";
import { getSupabaseAdmin } from "@/lib/supabase";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/admin/doctors" });

export const dynamic = "force-dynamic";

type Doctor = {
  id: string;
  full_name: string;
  display_name: string | null;
  crm_number: string;
  crm_uf: string;
  email: string;
  phone: string;
  status: "invited" | "pending" | "active" | "suspended" | "archived";
  consultation_minutes: number;
  created_at: string;
};

const STATUS_LABELS: Record<Doctor["status"], { label: string; cls: string }> = {
  invited: { label: "Convidada", cls: "bg-cream-100 text-ink-600 border-ink-200" },
  pending: { label: "Pendente", cls: "bg-terracotta-50 text-terracotta-700 border-terracotta-200" },
  active: { label: "Ativa", cls: "bg-sage-50 text-sage-800 border-sage-200" },
  suspended: { label: "Suspensa", cls: "bg-terracotta-100 text-terracotta-800 border-terracotta-300" },
  archived: { label: "Arquivada", cls: "bg-ink-100 text-ink-500 border-ink-200" },
};

async function loadDoctors(): Promise<Doctor[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("doctors")
    .select(
      "id, full_name, display_name, crm_number, crm_uf, email, phone, status, consultation_minutes, created_at"
    )
    .order("status", { ascending: true })
    .order("full_name", { ascending: true });

  if (error) {
    log.error("load", { err: error });
    return [];
  }
  return (data ?? []) as Doctor[];
}

export default async function DoctorsPage() {
  const doctors = await loadDoctors();

  return (
    <div>
      <header className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div>
          <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
            Equipe clínica
          </p>
          <h1 className="font-serif text-[1.85rem] sm:text-[2.2rem] leading-tight text-ink-800">
            Médicas
          </h1>
          <p className="mt-1 text-ink-500">
            {doctors.length === 0
              ? "Nenhuma médica cadastrada ainda."
              : `${doctors.length} cadastrada${doctors.length === 1 ? "" : "s"}.`}
          </p>
        </div>
        <Link
          href="/admin/doctors/new"
          className="rounded-xl bg-ink-800 hover:bg-ink-900 text-white font-medium px-5 py-3 transition-colors"
        >
          + Nova médica
        </Link>
      </header>

      {doctors.length === 0 ? (
        <div className="rounded-2xl bg-white border border-ink-100 p-10 text-center">
          <h2 className="font-serif text-[1.3rem] text-ink-800 mb-2">
            Vamos cadastrar a primeira
          </h2>
          <p className="text-ink-500 mb-6 max-w-md mx-auto">
            Cada médica entra como PJ com sua agenda própria, regra de
            remuneração e PIX. Você convida via e-mail; ela completa o
            perfil.
          </p>
          <Link
            href="/admin/doctors/new"
            className="inline-block rounded-xl bg-ink-800 hover:bg-ink-900 text-white font-medium px-6 py-3 transition-colors"
          >
            + Nova médica
          </Link>
        </div>
      ) : (
        <div className="rounded-2xl bg-white border border-ink-100 overflow-hidden">
          <table className="w-full">
            <thead className="bg-cream-50 border-b border-ink-100">
              <tr className="text-left text-[0.78rem] uppercase tracking-[0.12em] text-ink-500 font-medium">
                <th className="px-5 py-3">Nome</th>
                <th className="px-5 py-3">CRM</th>
                <th className="px-5 py-3 hidden md:table-cell">Contato</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3 text-right" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {doctors.map((d) => {
                const st = STATUS_LABELS[d.status];
                return (
                  <tr key={d.id} className="hover:bg-cream-50 transition-colors">
                    <td className="px-5 py-4">
                      <div className="font-medium text-ink-800">
                        {d.display_name || d.full_name}
                      </div>
                      {d.display_name && (
                        <div className="text-xs text-ink-400 mt-0.5">{d.full_name}</div>
                      )}
                    </td>
                    <td className="px-5 py-4 text-ink-600 font-mono text-sm">
                      CRM-{d.crm_uf} {d.crm_number}
                    </td>
                    <td className="px-5 py-4 hidden md:table-cell text-sm text-ink-600">
                      <div>{d.email}</div>
                      <div className="text-xs text-ink-400">{d.phone}</div>
                    </td>
                    <td className="px-5 py-4">
                      <span
                        className={`inline-flex items-center text-xs font-medium px-2.5 py-1 rounded-full border ${st.cls}`}
                      >
                        {st.label}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-right">
                      <Link
                        href={`/admin/doctors/${d.id}`}
                        className="text-sage-700 hover:text-sage-800 hover:underline text-sm font-medium"
                      >
                        Gerenciar →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
