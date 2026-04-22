/**
 * /paciente/renovar — D-044 · 2.G
 *
 * Mostra o status do ciclo atual do paciente e explica o processo
 * de renovação. No novo modelo (D-044), renovação NÃO é recompra
 * direta — exige reavaliação médica: a mesma médica olha evolução,
 * exames, tolerância e decide se mantém, ajusta ou descontinua.
 *
 * Por que não deixar "renovar → /checkout/[slug]":
 *   - Violaria o pacto sanitário do novo fluxo (consulta → prescrição
 *     → aceite → pagamento).
 *   - O preço exibido pode mudar conforme a médica ajuste a dose ou
 *     troque de plano.
 *   - Tirzepatida/semaglutida não são produtos de catálogo; são
 *     tratamentos com acompanhamento obrigatório.
 *
 * O CTA principal é "Agendar reconsulta" (contato via WhatsApp/equipe
 * por ora; no futuro vira página de agendamento). Os cards dos planos
 * continuam visíveis como referência informativa, sem botão de compra.
 */

import Link from "next/link";
import { requirePatient } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getRenewalInfo, labelForRenewalStatus } from "@/lib/patient-treatment";
import { formatCurrencyBRL, formatDateBR } from "@/lib/datetime-br";
import { whatsappSupportUrl } from "@/lib/contact";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function brl(cents: number): string {
  return formatCurrencyBRL(cents);
}

const RENOVAR_WHATSAPP_HREF = whatsappSupportUrl(
  "Oi! Quero agendar a reconsulta pra renovar meu tratamento."
);

export default async function RenovarPage() {
  const { customerId } = await requirePatient();
  const supabase = getSupabaseAdmin();
  const renewal = await getRenewalInfo(supabase, customerId);

  const { data: plansData } = await supabase
    .from("plans")
    .select("slug, name, description, medication, cycle_days, price_pix_cents, price_cents, highlight")
    .eq("active", true)
    .order("sort_order", { ascending: true });
  const plans = plansData ?? [];

  const active = renewal.active;

  return (
    <div>
      <header className="mb-8">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Renovar tratamento
        </p>
        <h1 className="font-serif text-[2rem] sm:text-[2.4rem] leading-tight text-ink-800">
          Continue seu cuidado
        </h1>
        <p className="mt-2 text-ink-500 max-w-2xl">
          A renovação começa por uma <strong>reconsulta gratuita</strong> com
          a mesma médica. Ela avalia a evolução até aqui e define se o plano
          continua igual, se ajusta a dose ou se troca de caminho.
        </p>
      </header>

      {active && (
        <section className="mb-8 rounded-2xl border border-ink-100 bg-white p-6 sm:p-7">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-[0.78rem] uppercase tracking-[0.18em] text-ink-500 mb-1">
                Ciclo atual
              </p>
              <h2 className="font-serif text-[1.4rem] text-ink-800">
                {active.planName}
              </h2>
              {active.planMedication && (
                <p className="text-sm text-ink-500 mt-1">
                  {active.planMedication}
                </p>
              )}
            </div>
            <span
              className={`inline-flex items-center text-sm font-medium px-3 py-1.5 rounded-full border ${renewalToneClass(renewal.status)}`}
            >
              {labelForRenewalStatus(renewal.status)}
            </span>
          </div>

          <dl className="mt-5 grid sm:grid-cols-3 gap-4 text-sm">
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-400">
                Iniciado em
              </dt>
              <dd className="mt-1 text-ink-800">
                {formatDateBR(active.paidAt)}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-400">
                Termina em
              </dt>
              <dd className="mt-1 text-ink-800">
                {formatDateBR(active.cycleEndsAt)}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-400">
                Dias restantes
              </dt>
              <dd className="mt-1 text-ink-800 font-mono">
                {Math.max(0, active.daysRemaining)} / {active.cycleDays}
              </dd>
            </div>
          </dl>
        </section>
      )}

      <section className="mb-10 rounded-2xl border border-sage-200 bg-sage-50 p-6 sm:p-7">
        <h2 className="font-serif text-[1.3rem] text-ink-800 mb-2">
          Agendar reconsulta
        </h2>
        <p className="text-sm text-ink-600 max-w-2xl">
          A reconsulta é online, gratuita e dura cerca de 30 minutos.
          {active
            ? " A equipe organiza um horário com a mesma médica que te acompanha."
            : " Fale com a equipe pra escolher a primeira consulta."}
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <a
            href={RENOVAR_WHATSAPP_HREF}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center rounded-xl bg-ink-900 hover:bg-ink-800 text-white text-sm font-semibold px-5 py-2.5 transition-colors shadow-sm"
          >
            Falar com a equipe no WhatsApp →
          </a>
          <Link
            href="/paciente/consultas"
            className="inline-flex items-center rounded-xl border border-ink-200 bg-white hover:bg-cream-50 text-ink-700 text-sm font-medium px-4 py-2.5 transition-colors"
          >
            Ver minhas consultas
          </Link>
        </div>
      </section>

      <section>
        <h2 className="font-serif text-[1.3rem] text-ink-800 mb-2">
          Para referência: planos disponíveis
        </h2>
        <p className="text-sm text-ink-500 mb-5 max-w-2xl">
          A contratação do plano novo é feita <strong>depois da
          reconsulta</strong>, a partir da indicação da médica. Você
          recebe um link pessoal para revisar a prescrição, aceitar e
          pagar — tudo aqui na sua área.
        </p>

        {plans.length === 0 ? (
          <p className="text-sm text-ink-500">
            Nenhum plano ativo no momento. Fale com a equipe.
          </p>
        ) : (
          <div className="grid md:grid-cols-2 gap-4">
            {plans.map((p) => {
              const isRecommended = renewal.recommendedPlanSlug === p.slug;
              return (
                <div
                  key={p.slug}
                  className={`rounded-2xl border p-6 ${
                    isRecommended
                      ? "border-sage-300 bg-sage-50"
                      : "border-ink-100 bg-white"
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
                    <h3 className="font-serif text-[1.2rem] text-ink-800">
                      {p.name}
                    </h3>
                    {isRecommended && (
                      <span className="text-[0.7rem] uppercase tracking-wide text-sage-700 font-semibold">
                        Seu plano atual
                      </span>
                    )}
                  </div>
                  {p.medication && (
                    <p className="text-sm text-ink-500">{p.medication}</p>
                  )}
                  {p.description && (
                    <p className="text-sm text-ink-600 mt-2">{p.description}</p>
                  )}
                  <div className="mt-4 flex items-baseline gap-2">
                    <span className="font-serif text-[1.6rem] text-ink-800">
                      {brl(p.price_pix_cents)}
                    </span>
                    <span className="text-xs text-ink-500">
                      · {p.cycle_days} dias · PIX
                    </span>
                  </div>
                  <p className="text-xs text-ink-500 mt-1">
                    ou {brl(p.price_cents)} em cartão
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="mt-10 rounded-2xl border border-ink-100 bg-cream-50 p-5 text-sm text-ink-600">
        <h3 className="font-serif text-[1.05rem] text-ink-800 mb-2">
          Como funciona a renovação
        </h3>
        <ol className="space-y-1.5 list-decimal pl-5">
          <li>Você agenda a reconsulta gratuita com a equipe.</li>
          <li>
            A médica reavalia sua evolução, exames e tolerância, e
            decide se mantém, ajusta ou troca de plano.
          </li>
          <li>
            Se houver indicação, você recebe na sua área um link pra
            revisar a prescrição, aceitar e pagar.
          </li>
          <li>
            O ciclo novo começa a contar a partir do pagamento
            confirmado e dura {active?.cycleDays ?? 90} dias.
          </li>
        </ol>
      </section>
    </div>
  );
}

function renewalToneClass(status: string): string {
  switch (status) {
    case "active":
      return "bg-sage-50 text-sage-800 border-sage-200";
    case "expiring_soon":
      return "bg-cream-100 text-ink-700 border-cream-300";
    case "expired":
      return "bg-terracotta-100 text-terracotta-800 border-terracotta-300";
    default:
      return "bg-ink-100 text-ink-500 border-ink-200";
  }
}
