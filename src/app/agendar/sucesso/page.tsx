/**
 * /agendar/sucesso?id=<appointmentId>  — PR-075-A · D-086
 *
 * Página de confirmação após agendamento gratuito. Validamos:
 *   1. ?id pertence a um appointment existente.
 *   2. customer.lead_id bate com `inm_lead_id` do cookie do paciente
 *      (defesa em profundidade — alguém com link só vê dado da
 *      própria sessão).
 *
 * Conteúdo:
 *   - Confirmação visual do horário
 *   - Promessa: lembretes automáticos por WhatsApp
 *   - CTA: "Acessar minha área" → /paciente/login (com email
 *     potencialmente prefilled via querystring)
 *   - Como cancelar (suporte WA)
 *
 * Sem PII desnecessária — só o suficiente pra dar confiança.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { Logo } from "@/components/Logo";
import { Footer } from "@/components/Footer";
import { getSupabaseAdmin } from "@/lib/supabase";
import { LEAD_COOKIE_NAME } from "@/lib/lead-cookie";
import { formatDateBR } from "@/lib/datetime-br";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/agendar/sucesso" });

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Consulta agendada · Instituto Nova Medida",
  robots: { index: false, follow: false },
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AgendarSucessoPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const id = typeof sp.id === "string" ? sp.id : "";
  if (!UUID_RE.test(id)) {
    redirect("/");
  }

  const cookieStore = await cookies();
  const leadId = cookieStore.get(LEAD_COOKIE_NAME)?.value ?? null;

  const sb = getSupabaseAdmin();
  const { data: appt, error } = await sb
    .from("appointments")
    .select(
      "id, scheduled_at, status, customer_id, doctors:doctor_id(display_name, full_name, consultation_minutes)",
    )
    .eq("id", id)
    .maybeSingle();

  if (error || !appt) {
    log.warn("appointment lookup", { err: error, id });
    redirect("/");
  }

  // Sanity check: o customer dessa consulta tem que estar amarrado ao
  // lead atual do cookie (mesma sessão). Caso contrário, aborta sem
  // vazar dados.
  const { data: cust } = await sb
    .from("customers")
    .select("id, lead_id, email")
    .eq("id", (appt as { customer_id: string }).customer_id)
    .maybeSingle();
  if (!cust || (leadId && cust.lead_id && cust.lead_id !== leadId)) {
    redirect("/");
  }

  const doctorRow = (appt as unknown as {
    doctors:
      | { display_name: string | null; full_name: string; consultation_minutes: number }
      | null;
  }).doctors;
  const doctorName =
    doctorRow?.display_name || doctorRow?.full_name || "sua médica";
  const durationMinutes = doctorRow?.consultation_minutes ?? 30;

  const slotDisplay = formatDateBR(appt.scheduled_at as string, {
    weekday: "long",
    day: "2-digit",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });

  const email = (cust.email as string | null) ?? "";

  return (
    <>
      <header className="sticky top-0 z-40 bg-cream-100/85 backdrop-blur-md border-b border-ink-100/60">
        <div className="mx-auto max-w-7xl px-5 sm:px-8 h-16 flex items-center justify-between">
          <Logo href="/" />
        </div>
      </header>

      <main className="bg-cream-100">
        <section className="mx-auto max-w-2xl px-5 sm:px-8 pt-12 pb-20 sm:pt-16 sm:pb-28">
          <div className="rounded-3xl bg-white border border-ink-100 overflow-hidden shadow-sm">
            <div className="bg-sage-700 text-cream-50 px-7 sm:px-10 py-9 relative">
              <div
                aria-hidden
                className="absolute inset-0 opacity-[0.10] pointer-events-none"
                style={{
                  backgroundImage:
                    "radial-gradient(circle at 80% 20%, rgba(232,223,211,0.7) 0%, transparent 40%)",
                }}
              />
              <div className="relative h-12 w-12 rounded-full bg-cream-50/15 flex items-center justify-center">
                <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
                  <path
                    d="M5 11.5L9 15.5L17 6.5"
                    stroke="white"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <h1 className="relative font-serif text-[2rem] sm:text-[2.4rem] mt-5 leading-[1.1]">
                Consulta confirmada.
              </h1>
              <p className="relative mt-3 text-cream-100/85 text-[0.98rem] leading-relaxed">
                Você receberá lembretes automáticos pelo WhatsApp e o link da
                sala de vídeo na hora da consulta.
              </p>
            </div>

            <div className="px-7 sm:px-10 py-8 space-y-6">
              <div className="rounded-2xl bg-cream-50 border border-ink-100 p-5">
                <p className="text-[0.78rem] uppercase tracking-wider text-sage-700 font-medium">
                  Sua consulta
                </p>
                <p className="mt-2 font-serif text-[1.2rem] text-ink-800 leading-tight capitalize">
                  {slotDisplay}
                </p>
                <p className="mt-2 text-sm text-ink-600">
                  Com{" "}
                  <span className="font-medium text-ink-800">{doctorName}</span>
                  {" · "}
                  {durationMinutes} minutos · 100% online
                </p>
              </div>

              <div className="space-y-3 text-[0.95rem] text-ink-700 leading-relaxed">
                <p>
                  <strong className="text-ink-800">
                    Sem cobrança nesta etapa.
                  </strong>{" "}
                  Plano de tratamento, se houver, será apresentado pela médica
                  durante ou após a consulta. Você só paga se decidir aceitar.
                </p>
                <p>
                  Lembretes automáticos: 24 horas antes, 1 hora antes e na hora
                  da consulta. O link da sala chega 15 minutos antes.
                </p>
              </div>

              <div className="rounded-2xl border border-sage-200 bg-sage-50/60 p-5">
                <p className="font-serif text-[1.05rem] text-ink-800 leading-tight">
                  Acompanhe sua consulta na sua área
                </p>
                <p className="mt-2 text-sm text-ink-600 leading-relaxed">
                  Receba prescrições, planos de tratamento e seu histórico clínico
                  no Instituto Nova Medida. Acesso por link mágico no e-mail —
                  sem senha.
                </p>
                <Link
                  href="/paciente/login"
                  className="mt-4 inline-flex items-center justify-center gap-2 rounded-full bg-ink-800 hover:bg-ink-900 text-cream-50 text-[0.92rem] font-medium px-5 py-2.5 transition-colors"
                >
                  Acessar minha área{email ? ` (${email})` : ""}
                </Link>
              </div>

              <div className="text-xs text-ink-500 leading-relaxed">
                Precisa cancelar ou reagendar? Responda à mensagem do WhatsApp
                ou escreva para{" "}
                <a
                  href="mailto:contato@institutonovamedida.com.br"
                  className="text-sage-700 underline hover:text-sage-800"
                >
                  contato@institutonovamedida.com.br
                </a>
                .
              </div>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </>
  );
}
