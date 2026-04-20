import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/Logo";
import { Footer } from "@/components/Footer";
import { getSupabaseAnon } from "@/lib/supabase";

export const metadata: Metadata = {
  title: "Planos de tratamento · Instituto Nova Medida",
  description:
    "Planos de tratamento para acompanhamento clínico com a equipe do Instituto Nova Medida.",
  // /planos não é mais porta de entrada pública: paciente só chega aqui
  // via link enviado pela equipe após a médica prescrever o tratamento.
  robots: { index: false, follow: false },
};

export const revalidate = 60;

type Plan = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  medication: string | null;
  cycle_days: number;
  price_cents: number;
  price_pix_cents: number;
  features: string[];
  highlight: boolean;
  sort_order: number;
};

async function loadPlans(): Promise<Plan[]> {
  try {
    const sb = getSupabaseAnon();
    const { data, error } = await sb
      .from("plans")
      .select(
        "id, slug, name, description, medication, cycle_days, price_cents, price_pix_cents, features, highlight, sort_order"
      )
      .eq("active", true)
      .order("sort_order", { ascending: true });

    if (error) {
      console.error("[planos] supabase error:", error);
      return [];
    }
    return (data ?? []) as Plan[];
  } catch (err) {
    console.error("[planos] load exception:", err);
    return [];
  }
}

const BRL = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

function formatBRL(cents: number) {
  return BRL.format(cents / 100);
}

function installmentValue(cents: number, n: number) {
  const v = cents / 100 / n;
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(v);
}

export default async function PlanosPage() {
  const plans = await loadPlans();

  return (
    <>
      <header className="sticky top-0 z-40 bg-cream-100/85 backdrop-blur-md border-b border-ink-100/60">
        <div className="mx-auto max-w-7xl px-5 sm:px-8 h-16 flex items-center justify-between">
          <Logo href="/" />
          <Link
            href="/"
            className="hidden sm:inline-flex items-center gap-2 text-[0.88rem] text-ink-500 hover:text-ink-800 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path
                d="M11 7H3M3 7L7 3M3 7L7 11"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Voltar ao site
          </Link>
        </div>
      </header>

      <main className="bg-cream-100">
        {/* Hero ───────────────────────────────────────────────────────── */}
        <section className="mx-auto max-w-5xl px-5 sm:px-8 pt-16 pb-10 sm:pt-24 sm:pb-12 text-center">
          <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-5">
            Planos de tratamento
          </p>
          <h1 className="font-serif text-[2.4rem] sm:text-[3.4rem] leading-[1.05] tracking-tight text-ink-800 text-balance">
            O cuidado certo, no ritmo que cabe em você.
          </h1>
          <p className="mt-6 text-[1.1rem] sm:text-[1.2rem] leading-relaxed text-ink-500 max-w-2xl mx-auto">
            Esta página é informativa. A contratação de qualquer plano
            acontece <strong className="text-ink-700">somente após a
            consulta gratuita</strong>, quando a médica avalia o seu caso
            e, se for o caso, prescreve o tratamento mais adequado.
          </p>
          <p className="mt-3 text-[0.95rem] text-ink-400">
            Ciclo de tratamento de 90 dias · sem assinatura recorrente ·
            reembolso integral se a médica não indicar tratamento.
          </p>

          <div className="mt-8">
            <Link
              href="/"
              className="inline-flex items-center gap-2 rounded-full bg-ink-900 hover:bg-ink-800 text-cream-100 px-6 py-3.5 text-[0.95rem] font-medium transition-colors"
            >
              Agendar minha consulta gratuita
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path
                  d="M3 7H11M11 7L7 3M11 7L7 11"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </Link>
            <p className="mt-3 text-[0.85rem] text-ink-400">
              A consulta é online, gratuita, e sem compromisso de compra.
            </p>
          </div>
        </section>

        {/* Cards de planos ─────────────────────────────────────────────── */}
        <section className="mx-auto max-w-7xl px-5 sm:px-8 pb-16 sm:pb-24">
          {plans.length === 0 ? (
            <div className="rounded-3xl border border-terracotta-200 bg-terracotta-50 px-6 py-8 text-center text-terracotta-800">
              <p className="font-medium">
                Não foi possível carregar os planos no momento.
              </p>
              <p className="mt-2 text-[0.95rem]">
                Tente recarregar a página em alguns instantes ou{" "}
                <Link
                  href="/"
                  className="underline underline-offset-2 hover:text-terracotta-700"
                >
                  voltar ao site
                </Link>
                .
              </p>
            </div>
          ) : (
            <div className="grid gap-6 lg:gap-7 md:grid-cols-3 items-stretch">
              {plans.map((plan) => (
                <PlanCard key={plan.id} plan={plan} />
              ))}
            </div>
          )}

          <p className="mt-8 text-center text-[0.88rem] text-ink-400">
            Pagamento seguro processado pela Asaas · PIX, boleto ou cartão em
            até 3x sem juros · Receita digital ICP-Brasil válida em todo o
            país.
          </p>
        </section>

        {/* O que está incluso em todos ─────────────────────────────────── */}
        <section className="bg-cream-200/60 border-y border-ink-100/60">
          <div className="mx-auto max-w-5xl px-5 sm:px-8 py-16 sm:py-24">
            <h2 className="font-serif text-[1.8rem] sm:text-[2.2rem] leading-[1.1] tracking-tight text-ink-800 text-center mb-12">
              Todos os planos incluem
            </h2>
            <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
              {[
                {
                  title: "Avaliação médica online",
                  body:
                    "Com endocrinologista, nutróloga ou clínica geral via vídeo. Revisão de exames, anamnese e plano clínico.",
                },
                {
                  title: "Receita digital ICP-Brasil",
                  body:
                    "Quando indicada, a prescrição é assinada digitalmente e válida em qualquer farmácia do país.",
                },
                {
                  title: "Entrega refrigerada",
                  body:
                    "Medicação manipulada por farmácia parceira licenciada pela Anvisa, entregue na sua casa em embalagem térmica.",
                },
                {
                  title: "Acompanhamento WhatsApp",
                  body:
                    "Conversa direta com a sua médica para tirar dúvidas, ajustar dose e acompanhar a evolução.",
                },
              ].map((item) => (
                <div key={item.title} className="space-y-2">
                  <div className="flex items-center gap-2.5">
                    <span
                      className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-sage-100 text-sage-700"
                      aria-hidden="true"
                    >
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                        <path
                          d="M3 7.5L5.5 10L11 4"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </span>
                    <h3 className="font-serif text-[1.1rem] text-ink-800">
                      {item.title}
                    </h3>
                  </div>
                  <p className="text-[0.95rem] leading-[1.6] text-ink-500">
                    {item.body}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* FAQ enxuto ───────────────────────────────────────────────────── */}
        <section className="mx-auto max-w-3xl px-5 sm:px-8 py-16 sm:py-24">
          <h2 className="font-serif text-[1.8rem] sm:text-[2.2rem] leading-[1.1] tracking-tight text-ink-800 text-center mb-10">
            Perguntas sobre os planos
          </h2>
          <div className="space-y-7 text-[1rem] leading-[1.65] text-ink-600">
            <div>
              <h3 className="font-serif text-[1.15rem] text-ink-800 mb-1.5">
                Posso parcelar no boleto ou PIX?
              </h3>
              <p>
                Não. PIX e boleto são à vista, com 10% de desconto sobre o
                preço cheio. O parcelamento em até 3x sem juros está
                disponível apenas no cartão de crédito.
              </p>
            </div>
            <div>
              <h3 className="font-serif text-[1.15rem] text-ink-800 mb-1.5">
                E se a médica não indicar o tratamento?
              </h3>
              <p>
                Você recebe reembolso integral em até 7 dias úteis. A
                avaliação médica fica gratuita — você só paga se houver
                indicação clínica e você decidir seguir.
              </p>
            </div>
            <div>
              <h3 className="font-serif text-[1.15rem] text-ink-800 mb-1.5">
                Como funciona a renovação ao fim dos 90 dias?
              </h3>
              <p>
                Antes do fim do ciclo, você faz uma reconsulta gratuita com a
                mesma médica. Se decidir renovar e confirmar até 7 dias antes
                do fim, ganha 10% de desconto de fidelidade — acumulável com
                o desconto do PIX.
              </p>
            </div>
            <div>
              <h3 className="font-serif text-[1.15rem] text-ink-800 mb-1.5">
                Posso cancelar depois que comprar?
              </h3>
              <p>
                Sim. Pelo Código de Defesa do Consumidor (art. 49), você tem
                até 7 dias após a contratação para se arrepender, sem
                qualquer multa, com reembolso integral. Após esse prazo,
                cancelamentos são analisados caso a caso.
              </p>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Card de plano
// ────────────────────────────────────────────────────────────────────────────

function PlanCard({ plan }: { plan: Plan }) {
  const isHighlight = plan.highlight;

  return (
    <article
      className={
        isHighlight
          ? "relative rounded-3xl bg-ink-800 text-cream-100 p-8 lg:p-9 shadow-xl shadow-ink-800/10 ring-1 ring-ink-900/20 flex flex-col"
          : "relative rounded-3xl bg-cream-50 border border-ink-100 p-8 lg:p-9 flex flex-col"
      }
    >
      {isHighlight && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 inline-flex items-center gap-1.5 rounded-full bg-terracotta-500 text-cream-100 px-3.5 py-1 text-[0.72rem] font-medium uppercase tracking-[0.14em]">
          Mais escolhido
        </span>
      )}

      <div>
        <h3
          className={
            "font-serif text-[1.5rem] leading-tight " +
            (isHighlight ? "text-cream-100" : "text-ink-800")
          }
        >
          {plan.name}
        </h3>
        {plan.medication && (
          <p
            className={
              "mt-1 text-[0.85rem] " +
              (isHighlight ? "text-cream-100/70" : "text-ink-400")
            }
          >
            {plan.medication}
          </p>
        )}
        {plan.description && (
          <p
            className={
              "mt-4 text-[0.97rem] leading-[1.6] " +
              (isHighlight ? "text-cream-100/80" : "text-ink-500")
            }
          >
            {plan.description}
          </p>
        )}
      </div>

      <div className="mt-7 mb-7">
        <div className="flex items-baseline gap-1.5">
          <span
            className={
              "font-serif text-[2.6rem] leading-none tracking-tight " +
              (isHighlight ? "text-cream-100" : "text-ink-800")
            }
          >
            {formatBRL(plan.price_cents)}
          </span>
          <span
            className={
              "text-[0.85rem] " +
              (isHighlight ? "text-cream-100/70" : "text-ink-400")
            }
          >
            no cartão
          </span>
        </div>
        <p
          className={
            "mt-1 text-[0.92rem] " +
            (isHighlight ? "text-cream-100/80" : "text-ink-500")
          }
        >
          ou 3x de {installmentValue(plan.price_cents, 3)} sem juros
        </p>
        <p
          className={
            "mt-3 text-[0.88rem] " +
            (isHighlight ? "text-terracotta-200" : "text-sage-700")
          }
        >
          {formatBRL(plan.price_pix_cents)} à vista no PIX ou boleto · –10%
        </p>
      </div>

      <ul
        className={
          "space-y-2.5 text-[0.95rem] leading-[1.55] mb-8 " +
          (isHighlight ? "text-cream-100/90" : "text-ink-600")
        }
      >
        {(plan.features ?? []).map((f) => (
          <li key={f} className="flex gap-2.5 items-start">
            <span
              className={
                "shrink-0 mt-[3px] inline-flex h-4 w-4 items-center justify-center rounded-full " +
                (isHighlight
                  ? "bg-terracotta-500/20 text-terracotta-200"
                  : "bg-sage-100 text-sage-700")
              }
              aria-hidden="true"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path
                  d="M2 5.5L4 7.5L8 3"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span>{f}</span>
          </li>
        ))}
      </ul>

      <div
        className={
          "mt-auto rounded-2xl px-5 py-4 text-[0.88rem] leading-[1.5] " +
          (isHighlight
            ? "bg-cream-100/10 text-cream-100/90 border border-cream-100/15"
            : "bg-ink-50 text-ink-600 border border-ink-100")
        }
      >
        A contratação deste plano ocorre somente após a consulta médica
        gratuita e indicação clínica.
      </div>
    </article>
  );
}
