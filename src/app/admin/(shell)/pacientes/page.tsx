/**
 * /admin/pacientes — D-045 · 3.B
 *
 * Lista de pacientes com busca server-side. Na ausência de query,
 * mostra os últimos 30 cadastrados. Com query, delega pra
 * `searchCustomers` (a mesma lib usada pelo endpoint de autocomplete).
 *
 * A busca global fica no header do shell (PatientSearchBar). Esta
 * página é pro operador que quer navegar — scan linear, filtro
 * explícito, link pra ficha.
 */

import Link from "next/link";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  classifyQuery,
  normalizeQuery,
  searchCustomers,
  type PatientSearchHit,
} from "@/lib/patient-search";

export const dynamic = "force-dynamic";

type SearchParams = { q?: string };

async function loadListing(
  rawQuery: string | undefined
): Promise<{
  hits: PatientSearchHit[];
  isSearch: boolean;
  totalRecent: number;
}> {
  const supabase = getSupabaseAdmin();
  const q = normalizeQuery(rawQuery);
  const strategy = classifyQuery(q);

  if (strategy !== "empty") {
    const hits = await searchCustomers(supabase, q, { limit: 50 });
    const { count } = await supabase
      .from("customers")
      .select("id", { head: true, count: "exact" });
    return {
      hits,
      isSearch: true,
      totalRecent: count ?? 0,
    };
  }

  const { data, error, count } = await supabase
    .from("customers")
    .select("id, name, email, phone, cpf, created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) {
    throw new Error(`pacientes list: ${error.message}`);
  }

  return {
    hits: (data ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      phone: r.phone,
      cpf: r.cpf,
      createdAt: r.created_at,
    })),
    isSearch: false,
    totalRecent: count ?? 0,
  };
}

export default async function AdminPacientesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const { hits, isSearch, totalRecent } = await loadListing(params.q);
  const q = normalizeQuery(params.q);

  return (
    <div>
      <header className="mb-6">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Pacientes
        </p>
        <h1 className="font-serif text-[2rem] sm:text-[2.4rem] leading-tight text-ink-800">
          {isSearch ? `Resultados para "${q}"` : "Todos os pacientes"}
        </h1>
        <p className="mt-2 text-ink-500">
          {isSearch
            ? `${hits.length} resultado${hits.length === 1 ? "" : "s"} encontrado${hits.length === 1 ? "" : "s"}.`
            : `${totalRecent} paciente${totalRecent === 1 ? "" : "s"} cadastrado${totalRecent === 1 ? "" : "s"} no total. Mostrando os 30 mais recentes.`}
        </p>
      </header>

      <form method="get" action="/admin/pacientes" className="mb-6">
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Buscar por nome, email, telefone ou CPF"
            className="flex-1 h-11 px-4 rounded-lg border border-ink-200 bg-white text-sm text-ink-800 focus:outline-none focus:border-sage-500"
          />
          <div className="flex gap-2">
            <button
              type="submit"
              className="h-11 px-5 rounded-lg bg-ink-800 text-white text-sm font-medium hover:bg-ink-700 transition-colors"
            >
              Buscar
            </button>
            {isSearch && (
              <Link
                href="/admin/pacientes"
                className="h-11 px-5 flex items-center rounded-lg border border-ink-200 text-sm text-ink-600 hover:bg-cream-100 transition-colors"
              >
                Limpar
              </Link>
            )}
          </div>
        </div>
      </form>

      {hits.length === 0 ? (
        <div className="rounded-2xl border border-ink-100 bg-white p-10 text-center">
          {isSearch ? (
            <>
              <p className="font-serif text-[1.2rem] text-ink-800 mb-1">
                Sem resultados para essa busca.
              </p>
              <p className="text-sm text-ink-500">
                Tente outro termo, ou confira se o paciente já tem cadastro.
              </p>
            </>
          ) : (
            <p className="text-ink-500">
              Nenhum paciente cadastrado ainda.
            </p>
          )}
        </div>
      ) : (
        <div className="rounded-2xl border border-ink-100 bg-white overflow-hidden">
          <table className="w-full">
            <thead className="bg-cream-50 border-b border-ink-100">
              <tr className="text-left text-[0.72rem] uppercase tracking-[0.14em] text-ink-500">
                <th className="px-4 py-3 font-medium">Nome</th>
                <th className="px-4 py-3 font-medium">Contato</th>
                <th className="px-4 py-3 font-medium hidden md:table-cell">
                  CPF
                </th>
                <th className="px-4 py-3 font-medium hidden lg:table-cell">
                  Cadastro
                </th>
              </tr>
            </thead>
            <tbody>
              {hits.map((h) => (
                <tr
                  key={h.id}
                  className="border-b border-ink-100 last:border-0 hover:bg-cream-50 transition-colors"
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/pacientes/${h.id}`}
                      className="block text-ink-800 hover:text-sage-700 transition-colors"
                    >
                      <div className="font-medium">{h.name}</div>
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-sm text-ink-600">
                    <div className="truncate">{h.email}</div>
                    <div className="text-ink-500">{h.phone}</div>
                  </td>
                  <td className="px-4 py-3 text-sm text-ink-600 font-mono hidden md:table-cell">
                    {maskCpf(h.cpf)}
                  </td>
                  <td className="px-4 py-3 text-sm text-ink-500 hidden lg:table-cell">
                    {new Date(h.createdAt).toLocaleDateString("pt-BR")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function maskCpf(cpf: string): string {
  const d = cpf.replace(/\D/g, "");
  if (d.length !== 11) return cpf;
  return `${d.slice(0, 3)}.***.***-${d.slice(-2)}`;
}
