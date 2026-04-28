/**
 * /agendar — PR-075-A · D-086 · PR-046 · D-095
 *
 * Rota canônica de agendamento da CONSULTA INICIAL GRATUITA (D-044).
 *
 * Fluxo:
 *   1. Sem cookie `inm_lead_id` → redireciona pra home com flag pra
 *      abrir o quiz (`?aviso=quiz_primeiro`).
 *   2. Com cookie inválido / lead expirado → mesma redireção, mas
 *      com motivo distinto (`?aviso=lead_expirado`).
 *   3. Sem `?slot=` → mostra slot picker (server carrega slots de
 *      TODAS as médicas ativas via `listAvailableSlotsForAllDoctors`,
 *      D-095). Quando há 2+ médicas, cada botão de slot mostra também
 *      o nome curto da médica.
 *   4. Com `?slot=<iso>` válido → mostra `FreeBookingForm`. Como
 *      múltiplas médicas podem ter slots no MESMO instante, o
 *      query-param `?doctorId=` desambigua quando presente. Se o
 *      paciente clicou num botão da grade, sempre vem com `doctorId`.
 *
 * Pra paciente já autenticado (`getOptionalPatient`), poderíamos
 * pré-preencher MAIS campos, mas — pragmaticamente — paciente
 * autenticado já passou pelo onboarding e raramente volta a essa
 * tela (ele tem `/paciente`). Deixamos o formulário simples e
 * confiável.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { Logo } from "@/components/Logo";
import { Footer } from "@/components/Footer";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  listAvailableSlotsForAllDoctors,
  type AvailableSlotWithDoctor,
} from "@/lib/scheduling";
import { LEAD_COOKIE_NAME } from "@/lib/lead-cookie";
import { logger } from "@/lib/logger";
import { FreeBookingForm } from "./FreeBookingForm";
import { SlotPickerClient } from "./SlotPickerClient";

const log = logger.with({ route: "/agendar" });

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Agendar consulta gratuita · Instituto Nova Medida",
  description:
    "Escolha o melhor horário para sua consulta inicial. Sem cobrança até o final.",
  robots: { index: false, follow: false },
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const LEAD_MAX_AGE_DAYS = 14;

export default async function AgendarPage({ searchParams }: PageProps) {
  const sp = await searchParams;

  // 1) Lead cookie obrigatório
  const cookieStore = await cookies();
  const leadId = cookieStore.get(LEAD_COOKIE_NAME)?.value ?? null;
  if (!leadId) {
    redirect("/?aviso=quiz_primeiro");
  }

  const sb = getSupabaseAdmin();
  const leadCutoff = new Date(
    Date.now() - LEAD_MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { data: lead, error: leadErr } = await sb
    .from("leads")
    .select("id, name, phone")
    .eq("id", leadId)
    .gte("created_at", leadCutoff)
    .maybeSingle();
  if (leadErr) {
    log.error("lead lookup", { err: leadErr });
  }
  if (!lead) {
    redirect("/?aviso=lead_expirado");
  }

  // 2) Carrega doctors + slots de TODAS médicas ativas (PR-046 · D-095)
  const { doctors, slots } = await listAvailableSlotsForAllDoctors({
    days: 7,
    minLeadMinutes: 60,
    maxPerDay: 6,
  });
  if (doctors.length === 0) {
    return (
      <Shell title="Estamos preparando a agenda">
        <p className="text-ink-600 leading-relaxed">
          Nenhuma médica está disponível para atendimento agora. Volte em
          alguns minutos ou{" "}
          <a
            href="mailto:contato@institutonovamedida.com.br"
            className="text-sage-700 hover:text-sage-800 underline"
          >
            fale com a equipe
          </a>
          .
        </p>
      </Shell>
    );
  }

  const isMultiDoctor = doctors.length > 1;

  // Resolve `?slot=` (ISO) + `?doctorId=` (desambigua quando 2 médicas
  // têm slots no mesmo instante). Se o paciente clicou na grade, ambos
  // vêm da URL. Se chegou só com `?slot=` (link compartilhado), pega o
  // PRIMEIRO match — coerente com `mergeAndSortDoctorSlots`.
  const requestedSlot = typeof sp.slot === "string" ? sp.slot : undefined;
  const requestedDoctorId =
    typeof sp.doctorId === "string" ? sp.doctorId : undefined;
  const matchSlot = (s: AvailableSlotWithDoctor): boolean => {
    if (s.startsAt !== requestedSlot) return false;
    if (requestedDoctorId && s.doctorId !== requestedDoctorId) return false;
    return true;
  };
  const chosenSlot: AvailableSlotWithDoctor | null = requestedSlot
    ? slots.find(matchSlot) ?? null
    : null;

  // 3) Fluxo 2 — slot escolhido → formulário
  if (chosenSlot) {
    return (
      <Shell title={null} fullWidth>
        <div className="mb-6 flex flex-wrap items-center gap-3 text-sm">
          <Link
            href="/agendar"
            className="text-ink-500 hover:text-ink-800 inline-flex items-center gap-1"
          >
            ← Trocar horário
          </Link>
        </div>
        <FreeBookingForm
          slot={{
            startsAt: chosenSlot.startsAt,
            doctorId: chosenSlot.doctorId,
            doctorName: chosenSlot.doctorDisplayName,
            durationMinutes: chosenSlot.doctorConsultationMinutes,
          }}
          leadHints={{
            name: (lead.name as string | null) ?? "",
            phone: (lead.phone as string | null) ?? "",
          }}
        />
      </Shell>
    );
  }

  // 4) Fluxo 1 — escolher slot
  // Copy adapta-se ao número de médicas ativas:
  //  - 1 médica: "Sua consulta com Dra X dura N minutos…"
  //  - 2+ médicas: "Mostre seu horário preferido — informamos a médica
  //    em cada opção. A consulta é 100% online…"
  const headerCopy = isMultiDoctor ? (
    <p className="text-ink-600 leading-relaxed mb-6">
      Escolha o horário que funciona pra você. Em cada opção informamos
      a médica que vai te atender. A consulta é 100% online e{" "}
      <strong className="text-ink-800">não tem cobrança nesta etapa</strong>.
    </p>
  ) : (
    <p className="text-ink-600 leading-relaxed mb-6">
      Sua consulta com{" "}
      <strong className="text-ink-800">
        {doctors[0].display_name || doctors[0].full_name}
      </strong>{" "}
      dura {doctors[0].consultation_minutes} minutos, é 100% online e{" "}
      <strong className="text-ink-800">não tem cobrança nesta etapa</strong>.
    </p>
  );
  return (
    <Shell title="Escolha o melhor horário">
      {headerCopy}

      <div className="mb-6 rounded-2xl border border-sage-200 bg-sage-50/60 p-5">
        <p className="text-[0.78rem] uppercase tracking-wider text-sage-700 font-medium">
          Como funciona o pagamento
        </p>
        <p className="mt-2 text-[0.95rem] text-ink-700 leading-relaxed">
          A consulta inicial é gratuita. Se a médica considerar adequado um
          plano de tratamento, você recebe a indicação para revisar com calma
          — só paga se decidir aceitar.
        </p>
      </div>

      <div className="mb-8 rounded-2xl border border-terracotta-200 bg-terracotta-50/40 p-5 flex items-start justify-between gap-4 flex-wrap">
        <div className="flex-1 min-w-[200px]">
          <p className="text-[0.78rem] uppercase tracking-wider text-terracotta-700 font-medium">
            Precisa agora?
          </p>
          <p className="mt-1.5 text-[0.95rem] text-ink-700 leading-relaxed">
            Solicite atendimento imediato — uma médica online assume
            sua consulta na hora.
          </p>
        </div>
        <Link
          href="/agendar/agora"
          className="shrink-0 inline-flex items-center justify-center gap-2 rounded-full bg-terracotta-700 hover:bg-terracotta-800 text-cream-50 text-[0.92rem] font-medium px-5 py-2.5 transition-colors"
        >
          Atendimento agora →
        </Link>
      </div>

      <SlotPickerClient slots={slots} showDoctorLabel={isMultiDoctor} />

      {slots.length === 0 && (
        <p className="mt-6 text-sm text-ink-500">
          Sem horários nos próximos dias. Volte em algumas horas ou{" "}
          <a
            href="mailto:contato@institutonovamedida.com.br"
            className="text-sage-700 hover:text-sage-800 underline"
          >
            fale com a equipe
          </a>{" "}
          para encaixe.
        </p>
      )}
    </Shell>
  );
}

function Shell({
  title,
  fullWidth = false,
  children,
}: {
  title: string | null;
  fullWidth?: boolean;
  children: React.ReactNode;
}) {
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
        <section
          className={`mx-auto px-5 sm:px-8 pt-12 pb-20 sm:pt-16 sm:pb-28 ${
            fullWidth ? "max-w-6xl" : "max-w-3xl"
          }`}
        >
          {title && (
            <header className="mb-8">
              <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-3">
                Consulta gratuita
              </p>
              <h1 className="font-serif text-[2.2rem] sm:text-[2.6rem] leading-[1.05] tracking-tight text-ink-800">
                {title}
              </h1>
            </header>
          )}
          {children}
        </section>
      </main>

      <Footer />
    </>
  );
}
