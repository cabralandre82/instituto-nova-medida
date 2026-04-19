import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/Logo";
import { Footer } from "@/components/Footer";

export const metadata: Metadata = {
  title: "Aguardando confirmação do pagamento · Instituto Nova Medida",
  robots: { index: false, follow: false },
};

export default function CheckoutAguardandoPage() {
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
            className="mx-auto h-16 w-16 rounded-full bg-terracotta-50 text-terracotta-700 flex items-center justify-center mb-7"
            aria-hidden="true"
          >
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
              <circle
                cx="14"
                cy="14"
                r="10"
                stroke="currentColor"
                strokeWidth="2"
              />
              <path
                d="M14 8V14L18 16.5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </div>

          <p className="text-[0.78rem] uppercase tracking-[0.18em] text-terracotta-700 font-medium mb-4">
            Aguardando pagamento
          </p>
          <h1 className="font-serif text-[2.2rem] sm:text-[2.8rem] leading-[1.05] tracking-tight text-ink-800 text-balance">
            Estamos esperando a confirmação do seu pagamento.
          </h1>
          <p className="mt-6 text-[1.05rem] sm:text-[1.12rem] leading-relaxed text-ink-500">
            Se você escolheu <strong>PIX</strong>, basta abrir a fatura e
            escanear o QR Code com o app do seu banco — a confirmação é
            quase imediata.
          </p>
          <p className="mt-3 text-[1.05rem] sm:text-[1.12rem] leading-relaxed text-ink-500">
            Se você escolheu <strong>boleto</strong>, o pagamento pode levar
            até <strong>1 dia útil</strong> para ser compensado pelo seu
            banco.
          </p>

          <div className="mt-10 rounded-3xl bg-cream-50 border border-ink-100 px-6 py-6 text-left">
            <h2 className="font-serif text-[1.15rem] text-ink-800">
              Próximos passos
            </h2>
            <ul className="mt-4 space-y-3 text-[0.95rem] leading-[1.6] text-ink-600">
              <li className="flex gap-3 items-start">
                <Bullet>1</Bullet>
                <span>
                  Assim que recebermos a confirmação, nossa equipe envia uma
                  mensagem no <strong>WhatsApp</strong> com o link da sua
                  avaliação médica.
                </span>
              </li>
              <li className="flex gap-3 items-start">
                <Bullet>2</Bullet>
                <span>
                  Não precisa fazer nada agora. Pode fechar essa janela
                  tranquila — sua reserva está garantida.
                </span>
              </li>
              <li className="flex gap-3 items-start">
                <Bullet>3</Bullet>
                <span>
                  Se você fechou a fatura sem pagar, pode acessar de novo
                  pelo email de confirmação que a Asaas enviou.
                </span>
              </li>
            </ul>
          </div>

          <div className="mt-10 flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              href="/"
              className="inline-flex items-center justify-center gap-2 rounded-full bg-sage-700 hover:bg-sage-800 text-cream-100 px-6 py-3.5 text-[0.95rem] font-medium transition-colors"
            >
              Voltar para o site
            </Link>
            <a
              href="mailto:financeiro@institutonovamedida.com.br"
              className="inline-flex items-center justify-center gap-2 rounded-full border border-ink-200 hover:border-ink-300 text-ink-700 px-6 py-3.5 text-[0.95rem] font-medium transition-colors"
            >
              Tive um problema com o pagamento
            </a>
          </div>
        </section>
      </main>

      <Footer />
    </>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full bg-sage-100 text-sage-700 text-[0.78rem] font-medium">
      {children}
    </span>
  );
}
