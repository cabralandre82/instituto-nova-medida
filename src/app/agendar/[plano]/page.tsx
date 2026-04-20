/**
 * /agendar/[plano]?slot=<iso>
 *
 * Fluxo de paciente:
 *   1. Sem `?slot=` → mostra slot picker (server-side carrega slots
 *      reais da agenda da médica).
 *   2. Com `?slot=` válido → mostra o CheckoutForm em modo "reserve",
 *      que vai chamar /api/agendar/reserve em vez de /api/checkout.
 *
 * É a porta de entrada do produto pra o paciente: escolhe quando quer
 * ser atendida e paga. Decisão D-027.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Logo } from "@/components/Logo";
import { Footer } from "@/components/Footer";
import { CheckoutForm, type CheckoutPlan } from "@/components/CheckoutForm";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getPrimaryDoctor, listAvailableSlots } from "@/lib/scheduling";
import { SlotPicker } from "./SlotPicker";

type PageProps = {
  params: Promise<{ plano: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { plano } = await params;
  return {
    title: `Agendar consulta — ${plano} · Instituto Nova Medida`,
    description:
      "Escolha o melhor horário para sua consulta com a médica do Instituto Nova Medida.",
    robots: { index: false, follow: false },
  };
}

async function loadPlan(slug: string): Promise<CheckoutPlan | null> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("plans")
    .select(
      "id, slug, name, description, medication, cycle_days, price_cents, price_pix_cents"
    )
    .eq("slug", slug)
    .eq("active", true)
    .maybeSingle();
  if (error) {
    console.error("[agendar/page] plan:", error);
    return null;
  }
  return (data as CheckoutPlan) ?? null;
}

export default async function AgendarPage({ params, searchParams }: PageProps) {
  const { plano } = await params;
  const sp = await searchParams;

  const plan = await loadPlan(plano);
  if (!plan) notFound();

  const doctor = await getPrimaryDoctor();
  if (!doctor) {
    return (
      <Shell title="Estamos preparando a agenda">
        <p className="text-ink-600">
          Nenhuma médica está disponível para atendimento agora. Volte em alguns
          minutos ou{" "}
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

  const requestedSlot = typeof sp.slot === "string" ? sp.slot : undefined;

  // Sempre carrega a lista pra (a) renderizar o picker, (b) validar o
  // slot da query string contra a agenda real (anti-tampering).
  const slots = await listAvailableSlots(doctor.id, doctor.consultation_minutes, {
    days: 7,
    minLeadMinutes: 60,
    maxPerDay: 6,
  });

  const validSlot =
    requestedSlot && slots.find((s) => s.startsAt === requestedSlot)
      ? requestedSlot
      : null;

  // ── Fluxo 2: slot válido → mostra o checkout ─────────────────────────
  if (validSlot) {
    return (
      <Shell title={null} fullWidth>
        <div className="mb-6 flex flex-wrap items-center gap-3 text-sm">
          <Link
            href={`/agendar/${plano}`}
            className="text-ink-500 hover:text-ink-800 inline-flex items-center gap-1"
          >
            ← Trocar horário
          </Link>
          <span className="text-ink-300">·</span>
          <Link href="/planos" className="text-ink-500 hover:text-ink-800">
            Trocar plano
          </Link>
        </div>
        <CheckoutForm
          plan={plan}
          slot={{
            startsAt: validSlot,
            doctorName: doctor.display_name || doctor.full_name,
          }}
        />
      </Shell>
    );
  }

  // ── Fluxo 1: precisa escolher slot ───────────────────────────────────
  return (
    <Shell title="Escolha o melhor horário">
      <p className="text-ink-600 leading-relaxed mb-8">
        Sua consulta com{" "}
        <strong className="text-ink-800">
          {doctor.display_name || doctor.full_name}
        </strong>{" "}
        dura {doctor.consultation_minutes} minutos, é 100% online e está incluída
        no plano <strong className="text-ink-800">{plan.name}</strong>.
        Reservamos o horário por 15 minutos enquanto você paga.
      </p>

      <SlotPicker plano={plano} slots={slots} />

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
            href="/planos"
            className="hidden sm:inline-flex items-center gap-2 text-[0.88rem] text-ink-500 hover:text-ink-800 transition-colors"
          >
            ← Trocar plano
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
                Agendar consulta
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
