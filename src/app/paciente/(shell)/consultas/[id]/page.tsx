/**
 * /paciente/consultas/[id] — detalhe da consulta — D-043
 *
 * Confere ownership (customer da consulta = paciente logado), gera
 * token HMAC server-side e reutiliza o JoinRoomButton já endurecido
 * de /consulta/[id]. Não duplica lógica de janela de entrada (isso
 * vive no /api/paciente/.../join).
 */

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requirePatient } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { signPatientToken } from "@/lib/patient-tokens";
import { labelForAppointmentStatus } from "@/lib/patient-treatment";
import { JoinRoomButton } from "@/app/consulta/[id]/JoinRoomButton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type AppointmentRecord = {
  id: string;
  customer_id: string;
  status: string;
  scheduled_at: string;
  scheduled_until: string | null;
  completed_at: string | null;
  cancel_reason: string | null;
  recording_consent: boolean | null;
  doctors:
    | { full_name: string; display_name: string | null; consultation_minutes: number }
    | { full_name: string; display_name: string | null; consultation_minutes: number }[]
    | null;
};

function pickSingle<T>(v: T | T[] | null): T | null {
  if (!v) return null;
  return Array.isArray(v) ? v[0] ?? null : v;
}

function fmtDateTime(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString("pt-BR", {
      weekday: "long",
      day: "2-digit",
      month: "long",
      year: "numeric",
      timeZone: "America/Sao_Paulo",
    }),
    time: d.toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/Sao_Paulo",
    }),
  };
}

export default async function AppointmentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { customerId } = await requirePatient();
  const { id: appointmentId } = await params;

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("appointments")
    .select(
      "id, customer_id, status, scheduled_at, scheduled_until, completed_at, cancel_reason, recording_consent, doctors ( full_name, display_name, consultation_minutes )",
    )
    .eq("id", appointmentId)
    .maybeSingle();

  if (error || !data) {
    notFound();
  }

  const appt = data as unknown as AppointmentRecord;
  if (appt.customer_id !== customerId) {
    // Consulta de outro paciente — para o próprio bem, redireciona
    // pra lista sem vazar existência.
    redirect("/paciente/consultas");
  }

  const doctor = pickSingle(appt.doctors);
  const doctorName = doctor?.display_name || doctor?.full_name || "Médica";
  const durationMinutes = doctor?.consultation_minutes ?? 30;

  const { date, time } = fmtDateTime(appt.scheduled_at);

  const isClosed =
    appt.status === "completed" ||
    appt.status.startsWith("no_show") ||
    appt.status.startsWith("cancelled");
  const isPendingPayment = appt.status === "pending_payment";

  let token: string | null = null;
  if (!isClosed && !isPendingPayment) {
    try {
      token = signPatientToken(appointmentId, { ttlSeconds: 60 * 60 * 4 });
    } catch {
      token = null;
    }
  }

  return (
    <div>
      <header className="mb-6">
        <Link
          href="/paciente/consultas"
          className="text-sm text-ink-500 hover:text-ink-800 mb-3 inline-flex items-center gap-1"
        >
          ← Voltar às consultas
        </Link>
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Consulta
        </p>
        <h1 className="font-serif text-[2rem] leading-tight text-ink-800">
          {doctorName}
        </h1>
      </header>

      <div className="grid lg:grid-cols-[1fr_320px] gap-8">
        <section className="rounded-2xl border border-ink-100 bg-white p-6 sm:p-8">
          <span
            className={`inline-flex items-center text-sm font-medium px-3 py-1.5 rounded-full border ${statusToneClass(appt.status)}`}
          >
            {labelForAppointmentStatus(appt.status)}
          </span>

          <dl className="mt-5 grid sm:grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-400">
                Data
              </dt>
              <dd className="mt-1 text-ink-800 capitalize">{date}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-400">
                Horário
              </dt>
              <dd className="mt-1 text-ink-800 font-mono">
                {time} · {durationMinutes} min
              </dd>
            </div>
          </dl>

          {isPendingPayment && (
            <p className="mt-6 text-sm text-ink-600 leading-relaxed">
              Estamos esperando a confirmação do seu pagamento. Quando for
              confirmado (geralmente em poucos minutos no PIX), esta página
              libera o botão para entrar na sala.
            </p>
          )}

          {isClosed && (
            <div className="mt-6">
              <p className="text-sm text-ink-600 leading-relaxed">
                Esta consulta foi encerrada.
              </p>
              {appt.cancel_reason && (
                <p className="mt-2 text-xs text-ink-500">
                  Motivo registrado: {appt.cancel_reason}
                </p>
              )}
              {appt.completed_at && (
                <p className="mt-2 text-xs text-ink-500">
                  Concluída em{" "}
                  {new Date(appt.completed_at).toLocaleString("pt-BR", {
                    dateStyle: "short",
                    timeStyle: "short",
                  })}
                </p>
              )}
            </div>
          )}

          {!isClosed && !isPendingPayment && token && (
            <div className="mt-6">
              <JoinRoomButton
                appointmentId={appointmentId}
                token={token}
                scheduledAtIso={appt.scheduled_at}
                durationMinutes={durationMinutes}
              />
            </div>
          )}
        </section>

        <aside className="space-y-5">
          <div className="rounded-2xl border border-ink-100 bg-cream-50 p-5">
            <h3 className="font-serif text-[1.05rem] text-ink-800 mb-2">
              Como se preparar
            </h3>
            <ul className="space-y-1.5 text-sm text-ink-600 list-disc pl-5">
              <li>Chrome ou Safari atualizados.</li>
              <li>Lugar silencioso, com boa luz.</li>
              <li>Teste microfone e câmera antes de entrar.</li>
              <li>Tenha exames recentes em mãos, se tiver.</li>
            </ul>
          </div>

          <div className="rounded-2xl border border-ink-100 bg-white p-5 text-sm text-ink-600">
            <h3 className="font-serif text-[1.05rem] text-ink-800 mb-2">
              Janela de entrada
            </h3>
            <p>
              A sala libera <strong>30 minutos antes</strong> do horário e
              fecha <strong>30 minutos depois</strong>. Se cair a internet,
              volte aqui e clique em &ldquo;Entrar na sala&rdquo; de novo.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

function statusToneClass(status: string): string {
  switch (status) {
    case "scheduled":
    case "confirmed":
    case "in_progress":
      return "bg-sage-50 text-sage-800 border-sage-200";
    case "completed":
      return "bg-ink-100 text-ink-700 border-ink-200";
    case "pending_payment":
      return "bg-cream-100 text-ink-700 border-ink-200";
    case "no_show_patient":
    case "no_show_doctor":
      return "bg-terracotta-100 text-terracotta-800 border-terracotta-300";
    default:
      return "bg-ink-100 text-ink-500 border-ink-200";
  }
}
