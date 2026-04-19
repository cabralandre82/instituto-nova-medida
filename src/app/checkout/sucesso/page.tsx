import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/Logo";
import { Footer } from "@/components/Footer";

export const metadata: Metadata = {
  title: "Pagamento confirmado · Instituto Nova Medida",
  robots: { index: false, follow: false },
};

export default function CheckoutSucessoPage() {
  return (
    <>
      <header className="sticky top-0 z-40 bg-cream-100/85 backdrop-blur-md border-b border-ink-100/60">
        <div className="mx-auto max-w-7xl px-5 sm:px-8 h-16 flex items-center">
          <Logo href="/" />
        </div>
      </header>

      <main className="bg-cream-100">
        <section className="mx-auto max-w-2xl px-5 sm:px-8 pt-16 pb-20 sm:pt-24 sm:pb-28 text-center">
          <div
            className="mx-auto h-16 w-16 rounded-full bg-sage-100 text-sage-700 flex items-center justify-center mb-7"
            aria-hidden="true"
          >
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
              <path
                d="M6 14.5L12 20L22 9"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>

          <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-4">
            Tudo certo
          </p>
          <h1 className="font-serif text-[2.2rem] sm:text-[2.8rem] leading-[1.05] tracking-tight text-ink-800 text-balance">
            Pagamento confirmado.
            <br />
            Bem-vinda ao Instituto.
          </h1>
          <p className="mt-6 text-[1.05rem] sm:text-[1.12rem] leading-relaxed text-ink-500">
            Seu plano foi contratado com sucesso. Em alguns minutos você
            receberá um WhatsApp da nossa equipe com o link da sua avaliação
            médica e os próximos passos do tratamento.
          </p>

          <div className="mt-10 grid sm:grid-cols-3 gap-3 text-left">
            {[
              {
                step: "01",
                title: "Confirmação no WhatsApp",
                body:
                  "Em até 10 minutos, nossa equipe envia uma mensagem confirmando seu cadastro.",
              },
              {
                step: "02",
                title: "Agendamento com a médica",
                body:
                  "Você escolhe horário ou entra na fila pra falar com a próxima médica disponível.",
              },
              {
                step: "03",
                title: "Avaliação online + plano",
                body:
                  "Após a consulta, sua medicação manipulada é despachada pra entrega refrigerada.",
              },
            ].map((item) => (
              <div
                key={item.step}
                className="rounded-2xl bg-cream-50 border border-ink-100 px-5 py-5"
              >
                <span className="text-[0.78rem] uppercase tracking-[0.16em] text-sage-700 font-medium">
                  Passo {item.step}
                </span>
                <h3 className="mt-2 font-serif text-[1.1rem] text-ink-800 leading-snug">
                  {item.title}
                </h3>
                <p className="mt-1.5 text-[0.9rem] leading-[1.55] text-ink-500">
                  {item.body}
                </p>
              </div>
            ))}
          </div>

          <div className="mt-10 flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              href="/"
              className="inline-flex items-center justify-center gap-2 rounded-full bg-sage-700 hover:bg-sage-800 text-cream-100 px-6 py-3.5 text-[0.95rem] font-medium transition-colors"
            >
              Voltar para o site
            </Link>
            <a
              href="mailto:contato@institutonovamedida.com.br"
              className="inline-flex items-center justify-center gap-2 rounded-full border border-ink-200 hover:border-ink-300 text-ink-700 px-6 py-3.5 text-[0.95rem] font-medium transition-colors"
            >
              Falar com a equipe
            </a>
          </div>

          <p className="mt-12 text-[0.85rem] text-ink-400">
            Em caso de qualquer dúvida sobre o pagamento, escreva pra{" "}
            <a
              href="mailto:financeiro@institutonovamedida.com.br"
              className="text-sage-700 hover:text-sage-800 underline underline-offset-2"
            >
              financeiro@institutonovamedida.com.br
            </a>
            .
          </p>
        </section>
      </main>

      <Footer />
    </>
  );
}
