/**
 * /paciente/consultas — lista completa (agendadas + histórico) — D-043
 */

import Link from "next/link";
import { requirePatient } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  getUpcomingAppointment,
  labelForAppointmentStatus,
  listPastAppointments,
} from "@/lib/patient-treatment";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "America/Sao_Paulo",
  });
}
function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Sao_Paulo",
  });
}

export default async function ConsultasPage() {
  const { customerId } = await requirePatient();
  const supabase = getSupabaseAdmin();

  const now = new Date();
  const [upcoming, history] = await Promise.all([
    getUpcomingAppointment(supabase, customerId, now),
    listPastAppointments(supabase, customerId, 50),
  ]);

  return (
    <div>
      <header className="mb-8">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Minhas consultas
        </p>
        <h1 className="font-serif text-[2rem] sm:text-[2.4rem] leading-tight text-ink-800">
          Agenda e histórico
        </h1>
        <p className="mt-2 text-ink-500 max-w-2xl">
          Tudo que você já fez e o que está por vir. Clique em qualquer
          consulta para abrir a sala (quando a janela estiver liberada)
          ou rever detalhes.
        </p>
      </header>

      <section className="rounded-2xl border border-ink-100 bg-white p-6 sm:p-7 mb-6">
        <h2 className="font-serif text-[1.2rem] text-ink-800 mb-4">
          Próxima
        </h2>
        {upcoming ? (
          <Link
            href={`/paciente/consultas/${upcoming.id}`}
            className="block rounded-xl border border-sage-200 bg-sage-50 hover:border-sage-300 transition-colors p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-ink-800 font-medium capitalize">
                  {fmtDateTime(upcoming.scheduledAt)} · {fmtTime(upcoming.scheduledAt)}
                </div>
                <div className="text-xs text-ink-500 mt-1">
                  {upcoming.doctorName} · {upcoming.durationMinutes} min ·{" "}
                  {labelForAppointmentStatus(upcoming.status)}
                </div>
              </div>
              <span className="text-sm text-sage-700">Abrir →</span>
            </div>
          </Link>
        ) : (
          <p className="text-sm text-ink-500">
            Nenhuma consulta agendada no momento.
          </p>
        )}
      </section>

      <section className="rounded-2xl border border-ink-100 bg-white p-6 sm:p-7">
        <h2 className="font-serif text-[1.2rem] text-ink-800 mb-4">
          Histórico
        </h2>
        {history.length === 0 ? (
          <p className="text-sm text-ink-500">
            Seu histórico fica aqui quando você tiver consultas concluídas
            ou canceladas.
          </p>
        ) : (
          <ul className="divide-y divide-ink-100">
            {history.map((h) => (
              <li key={h.id}>
                <Link
                  href={`/paciente/consultas/${h.id}`}
                  className="flex flex-wrap items-start justify-between gap-3 py-3 hover:bg-cream-50 -mx-3 px-3 rounded-lg transition-colors"
                >
                  <div>
                    <div className="text-ink-800 capitalize">
                      {fmtDateTime(h.scheduledAt)} ·{" "}
                      <span className="font-mono text-sm">
                        {fmtTime(h.scheduledAt)}
                      </span>
                    </div>
                    <div className="text-xs text-ink-500 mt-0.5">
                      {h.doctorName} · {labelForAppointmentStatus(h.status)}
                    </div>
                  </div>
                  <span className="text-sm text-ink-500">Detalhes →</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
