/**
 * /consulta/[id]?t=<patientToken>
 *
 * Página pública (sem login) que o paciente recebe após pagar. Mostra:
 *   - Estado da consulta (aguardando confirmação / agendada / encerrada).
 *   - Contagem regressiva pra abertura da sala.
 *   - Botão "Entrar na sala" quando dentro da janela.
 *
 * Autenticação:
 *   - 100% pelo token HMAC na query string. Sem token válido → 410-like
 *     view com instruções pra contatar a equipe.
 *
 * Server Component carrega dados básicos do appointment e delega o botão
 * (que depende de timestamps live) para um Client Component.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Logo } from "@/components/Logo";
import { Footer } from "@/components/Footer";
import { getSupabaseAdmin } from "@/lib/supabase";
import { verifyPatientToken } from "@/lib/patient-tokens";
import { JoinRoomButton } from "./JoinRoomButton";

export const metadata: Metadata = {
  title: "Sua consulta · Instituto Nova Medida",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type SearchParams = Record<string, string | string[] | undefined>;

type LoadResult =
  | { kind: "invalid"; reason: string }
  | { kind: "not_found" }
  | {
      kind: "ok";
      appointmentId: string;
      token: string;
      status: string;
      scheduledAt: string;
      durationMinutes: number;
      doctorName: string;
      patientName: string;
      hasRoom: boolean;
    };

async function load(appointmentId: string, sp: SearchParams): Promise<LoadResult> {
  const tokenRaw = sp.t;
  const token = Array.isArray(tokenRaw) ? tokenRaw[0] : tokenRaw;

  const v = verifyPatientToken(token);
  if (!v.ok) return { kind: "invalid", reason: v.reason };
  if (v.appointmentId !== appointmentId)
    return { kind: "invalid", reason: "token_mismatch" };

  const supabase = getSupabaseAdmin();
  const { data: appt, error } = await supabase
    .from("appointments")
    .select(
      "id, status, scheduled_at, video_room_url, doctors ( full_name, display_name, consultation_minutes ), customers ( name )"
    )
    .eq("id", appointmentId)
    .maybeSingle();

  if (error) {
    console.error("[consulta] load:", error);
    return { kind: "not_found" };
  }
  if (!appt) return { kind: "not_found" };

  const doctor = (appt as { doctors?: { full_name?: string; display_name?: string | null; consultation_minutes?: number } })
    .doctors;
  const customer = (appt as { customers?: { name?: string } }).customers;

  return {
    kind: "ok",
    appointmentId,
    token: token!,
    status: appt.status as string,
    scheduledAt: appt.scheduled_at as string,
    durationMinutes: doctor?.consultation_minutes ?? 30,
    doctorName: doctor?.display_name || doctor?.full_name || "Médica",
    patientName: customer?.name ?? "Paciente",
    hasRoom: Boolean(appt.video_room_url),
  };
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

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  pending_payment: {
    label: "Aguardando confirmação do pagamento",
    cls: "bg-cream-100 text-ink-700 border-ink-200",
  },
  scheduled: {
    label: "Consulta agendada",
    cls: "bg-sage-50 text-sage-800 border-sage-200",
  },
  confirmed: {
    label: "Consulta confirmada",
    cls: "bg-sage-50 text-sage-800 border-sage-200",
  },
  in_progress: {
    label: "Consulta em andamento",
    cls: "bg-blue-50 text-blue-800 border-blue-200",
  },
  completed: {
    label: "Consulta encerrada",
    cls: "bg-ink-100 text-ink-600 border-ink-200",
  },
  no_show_patient: {
    label: "Você não compareceu",
    cls: "bg-terracotta-100 text-terracotta-800 border-terracotta-300",
  },
  no_show_doctor: {
    label: "A médica não compareceu",
    cls: "bg-terracotta-100 text-terracotta-800 border-terracotta-300",
  },
  cancelled_by_patient: {
    label: "Consulta cancelada por você",
    cls: "bg-ink-100 text-ink-500 border-ink-200",
  },
  cancelled_by_doctor: {
    label: "Consulta cancelada pela médica",
    cls: "bg-ink-100 text-ink-500 border-ink-200",
  },
  cancelled_by_admin: {
    label: "Consulta cancelada",
    cls: "bg-ink-100 text-ink-500 border-ink-200",
  },
};

export default async function ConsultaPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const result = await load(id, sp);

  if (result.kind === "not_found") notFound();

  if (result.kind === "invalid") {
    const reasonText: Record<string, string> = {
      malformed: "O link é inválido ou foi truncado pelo cliente de e-mail.",
      invalid_uuid: "O link é inválido.",
      bad_sig: "O link foi adulterado ou está incompleto.",
      expired: "Este link expirou. Peça um novo à equipe.",
      token_mismatch: "Este link não corresponde a esta consulta.",
    };
    return (
      <PublicShell>
        <div className="text-center max-w-xl mx-auto">
          <h1 className="font-serif text-[2rem] text-ink-800">Link inválido</h1>
          <p className="mt-4 text-ink-600">
            {reasonText[result.reason] ?? "Não foi possível abrir esta consulta."}
          </p>
          <p className="mt-6 text-sm text-ink-500">
            Procure no seu WhatsApp/email pela última mensagem do Instituto Nova
            Medida ou{" "}
            <a
              href="mailto:contato@institutonovamedida.com.br"
              className="text-sage-700 hover:text-sage-800 underline"
            >
              fale com a equipe
            </a>
            .
          </p>
        </div>
      </PublicShell>
    );
  }

  const { date, time } = fmtDateTime(result.scheduledAt);
  const status = STATUS_LABELS[result.status] ?? {
    label: result.status,
    cls: "bg-cream-100 text-ink-700 border-ink-200",
  };

  const isClosed =
    result.status === "completed" ||
    result.status.startsWith("no_show") ||
    result.status.startsWith("cancelled");
  const isPendingPayment = result.status === "pending_payment";

  return (
    <PublicShell>
      <div className="max-w-xl mx-auto">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-3">
          Sua consulta
        </p>
        <h1 className="font-serif text-[2.2rem] sm:text-[2.6rem] leading-[1.05] tracking-tight text-ink-800">
          {result.doctorName}
        </h1>
        <p className="mt-3 text-ink-500">Para {result.patientName}</p>

        <div className="mt-8 rounded-2xl bg-white border border-ink-100 p-6 sm:p-7">
          <span
            className={`inline-flex items-center text-sm font-medium px-3 py-1.5 rounded-full border ${status.cls}`}
          >
            {status.label}
          </span>
          <dl className="mt-5 grid sm:grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-400">Data</dt>
              <dd className="mt-1 text-ink-800 capitalize">{date}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-400">Horário</dt>
              <dd className="mt-1 text-ink-800 font-mono">
                {time} · {result.durationMinutes} min
              </dd>
            </div>
          </dl>

          {isPendingPayment && (
            <p className="mt-6 text-sm text-ink-600 leading-relaxed">
              Estamos esperando a confirmação do seu pagamento.
              Quando for confirmado (geralmente em poucos minutos no PIX),
              esta página vai liberar o botão pra entrar na sala.
              Você também receberá um WhatsApp avisando.
            </p>
          )}

          {isClosed && (
            <p className="mt-6 text-sm text-ink-600 leading-relaxed">
              Essa consulta foi encerrada. Se ainda precisar de algo,{" "}
              <a
                href="mailto:contato@institutonovamedida.com.br"
                className="text-sage-700 hover:text-sage-800 underline"
              >
                fale com a equipe
              </a>
              .
            </p>
          )}

          {!isPendingPayment && !isClosed && (
            <div className="mt-6">
              <JoinRoomButton
                appointmentId={result.appointmentId}
                token={result.token}
                scheduledAtIso={result.scheduledAt}
                durationMinutes={result.durationMinutes}
              />
            </div>
          )}
        </div>

        <div className="mt-10 text-sm text-ink-500 space-y-3">
          <h2 className="text-xs uppercase tracking-[0.16em] font-medium text-ink-700">
            Como se preparar
          </h2>
          <ul className="space-y-2 list-disc pl-5">
            <li>Use Chrome ou Safari atualizados, num lugar silencioso.</li>
            <li>Teste seu microfone e câmera antes de entrar.</li>
            <li>Tenha exames recentes em mãos, se tiver.</li>
            <li>
              Se cair a internet, basta voltar nesta página e clicar em
              &ldquo;Entrar na sala&rdquo; de novo.
            </li>
          </ul>
        </div>
      </div>
    </PublicShell>
  );
}

function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="sticky top-0 z-40 bg-cream-100/85 backdrop-blur-md border-b border-ink-100/60">
        <div className="mx-auto max-w-7xl px-5 sm:px-8 h-16 flex items-center justify-between">
          <Logo href="/" />
          <Link
            href="/"
            className="hidden sm:inline-flex items-center gap-2 text-[0.88rem] text-ink-500 hover:text-ink-800 transition-colors"
          >
            ← Voltar
          </Link>
        </div>
      </header>

      <main className="bg-cream-100">
        <section className="mx-auto max-w-3xl px-5 sm:px-8 pt-12 pb-20 sm:pt-16 sm:pb-28">
          {children}
        </section>
      </main>

      <Footer />
    </>
  );
}
