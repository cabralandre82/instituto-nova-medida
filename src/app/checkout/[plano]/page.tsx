/**
 * /checkout/[plano] — fluxo antigo, mantido como BACK-OFFICE.
 *
 * IMPORTANTE (D-044 · 2.G): esta rota NÃO é mais o CTA público
 * padrão de compra. O fluxo canônico hoje é:
 *
 *   1. Visitante → home/quiz → lead → agendamento de consulta (gratuita).
 *   2. Médica avalia → prescreve plano → paciente aceita
 *      em `/paciente/oferta/[appointment_id]` → paga via Asaas.
 *   3. Webhook Asaas promove fulfillment pra `paid` e o Instituto
 *      despacha o medicamento.
 *
 * Esta página fica viva para:
 *   - Casos pontuais em que a equipe envia um link manual (lead que
 *     veio por fora do funil, renovação excepcional aprovada, etc).
 *   - Compatibilidade com links antigos que possam estar circulando.
 *
 * Nenhum CTA público leva aqui. A rota é `noindex, nofollow` e não
 * está no sitemap. Se quiser desligar de vez, remova; mas preservamos
 * enquanto houver operação residual.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Logo } from "@/components/Logo";
import { Footer } from "@/components/Footer";
import { getSupabaseAnon } from "@/lib/supabase";
import { CheckoutForm, type CheckoutPlan } from "@/components/CheckoutForm";
import { isLegacyPurchaseEnabled } from "@/lib/legacy-purchase-gate";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/checkout/[plano]" });

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ plano: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { plano } = await params;
  return {
    title: `Checkout — ${plano} · Instituto Nova Medida`,
    description:
      "Finalize a contratação do seu plano de tratamento. Pagamento seguro via PIX, boleto ou cartão.",
    robots: { index: false, follow: false }, // checkout não indexa
  };
}

async function loadPlan(slug: string): Promise<CheckoutPlan | null> {
  try {
    const sb = getSupabaseAnon();
    const { data, error } = await sb
      .from("plans")
      .select(
        "id, slug, name, description, medication, cycle_days, price_cents, price_pix_cents"
      )
      .eq("slug", slug)
      .eq("active", true)
      .maybeSingle();

    if (error) {
      log.error("supabase error", { err: error });
      return null;
    }
    return (data as CheckoutPlan) ?? null;
  } catch (err) {
    log.error("load exception", { err });
    return null;
  }
}

export default async function CheckoutPage({ params }: PageProps) {
  // PR-020 / audit [1.1]: rota legada é gatekept — em produção o fluxo
  // canônico de compra é consulta grátis → aceite em /paciente/oferta →
  // pagamento (D-044). Permitir checkout direto deixa paciente comprar
  // medicação sem passar por médica, violando CFM 2.314/2022.
  if (!isLegacyPurchaseEnabled()) {
    redirect("/?aviso=consulta_primeiro");
  }

  const { plano } = await params;
  const plan = await loadPlan(plano);

  if (!plan) notFound();

  return (
    <>
      <header className="sticky top-0 z-40 bg-cream-100/85 backdrop-blur-md border-b border-ink-100/60">
        <div className="mx-auto max-w-7xl px-5 sm:px-8 h-16 flex items-center justify-between">
          <Logo href="/" />
          <Link
            href="/planos"
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
            Voltar aos planos
          </Link>
        </div>
      </header>

      <main className="bg-cream-100">
        <section className="mx-auto max-w-6xl px-5 sm:px-8 pt-12 sm:pt-16 pb-20">
          <div className="text-center max-w-2xl mx-auto mb-10 sm:mb-14">
            <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-4">
              Finalizar contratação
            </p>
            <h1 className="font-serif text-[2rem] sm:text-[2.6rem] leading-[1.1] tracking-tight text-ink-800 text-balance">
              Quase lá. Faltam só os dados pra começar seu tratamento.
            </h1>
            <p className="mt-4 text-[1rem] sm:text-[1.05rem] leading-relaxed text-ink-500">
              Suas informações são protegidas pela LGPD. O pagamento é
              processado em ambiente seguro pela Asaas.
            </p>
          </div>

          <CheckoutForm plan={plan} />
        </section>
      </main>

      <Footer />
    </>
  );
}
