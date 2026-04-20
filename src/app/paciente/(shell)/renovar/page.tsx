/**
 * /paciente/renovar — D-043
 *
 * Mostra o status do ciclo atual e redireciona o paciente ao
 * checkout do mesmo plano (fluxo já existente em /checkout/[slug]).
 * Sem pagamento recorrente — renovação é manual, 1 clique.
 */

import Link from "next/link";
import { requirePatient } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getRenewalInfo, labelForRenewalStatus } from "@/lib/patient-treatment";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function brl(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

export default async function RenovarPage() {
  const { customerId } = await requirePatient();
  const supabase = getSupabaseAdmin();
  const renewal = await getRenewalInfo(supabase, customerId);

  // Busca outros planos ativos para oferecer alternativa
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
          A renovação é manual, quando você quiser. Cada ciclo novo
          reinicia o acompanhamento com a médica e uma nova dose do
          medicamento.
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
                {new Date(active.paidAt).toLocaleDateString("pt-BR")}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-400">
                Termina em
              </dt>
              <dd className="mt-1 text-ink-800">
                {new Date(active.cycleEndsAt).toLocaleDateString("pt-BR")}
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

      <section>
        <h2 className="font-serif text-[1.3rem] text-ink-800 mb-4">
          {active ? "Renovar com o mesmo plano" : "Escolher um plano"}
        </h2>

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
                        Seu plano
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
                  <Link
                    href={`/checkout/${p.slug}`}
                    className={`mt-5 inline-flex items-center w-full justify-center rounded-xl font-medium px-5 py-3 transition-colors ${
                      isRecommended
                        ? "bg-ink-800 hover:bg-ink-900 text-white"
                        : "bg-white border border-ink-200 hover:border-ink-400 text-ink-800"
                    }`}
                  >
                    {isRecommended ? "Renovar →" : "Escolher este plano"}
                  </Link>
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
          <li>Você confirma o plano e paga (PIX ou cartão).</li>
          <li>
            Assim que o pagamento é confirmado, a equipe envia as próximas
            datas de consulta pelo WhatsApp.
          </li>
          <li>
            O ciclo novo começa na data do pagamento e dura{" "}
            {active?.cycleDays ?? 90} dias.
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
