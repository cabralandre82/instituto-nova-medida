import type { Metadata } from "next";
import { Logo } from "@/components/Logo";
import { PatientLoginForm } from "./PatientLoginForm";

export const metadata: Metadata = {
  title: "Entrar · Seu tratamento · Instituto Nova Medida",
  robots: { index: false, follow: false },
};

type SearchParams = Promise<{
  next?: string;
  error?: string;
  sent?: string;
}>;

export default async function PatientLoginPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const errorKey = sp.error;
  const nextPath = sp.next ?? "/paciente";
  const sentEmail = sp.sent;

  const errorMessage = (() => {
    switch (errorKey) {
      case "forbidden":
        return "Esta conta não é de paciente. Se você é médica, entre em /medico/login.";
      case "no_profile":
        return "Seu cadastro ainda não foi finalizado. Se já fez uma consulta, o vínculo será feito no próximo login.";
      case "expired":
        return "Seu link expirou. Solicite um novo abaixo.";
      case "invalid":
        return "Link inválido. Solicite um novo abaixo.";
      case "callback":
        return "Erro ao processar o login. Tente novamente.";
      default:
        return null;
    }
  })();

  return (
    <main className="min-h-screen bg-cream-100 flex flex-col">
      <header className="bg-cream-100/85 backdrop-blur-md border-b border-ink-100/60">
        <div className="mx-auto max-w-7xl px-5 sm:px-8 h-16 flex items-center">
          <Logo href="/" />
        </div>
      </header>

      <section className="flex-1 flex items-center justify-center px-5 sm:px-8 py-12">
        <div className="w-full max-w-md">
          <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-3 text-center">
            Seu tratamento
          </p>
          <h1 className="font-serif text-[2rem] leading-[1.1] tracking-tight text-ink-800 text-center mb-3">
            Entrar
          </h1>
          <p className="text-ink-500 text-center mb-8">
            Use o mesmo e-mail que você cadastrou na compra. Receberá um
            link mágico — sem senha, sem cadastro.
          </p>

          {errorMessage && (
            <div
              role="alert"
              className="mb-6 rounded-xl bg-terracotta-50 border border-terracotta-200 px-5 py-4 text-[0.95rem] text-terracotta-800"
            >
              {errorMessage}
            </div>
          )}

          {sentEmail ? (
            <div className="rounded-2xl bg-sage-50 border border-sage-200 px-6 py-7 text-center">
              <div
                className="mx-auto h-12 w-12 rounded-full bg-sage-100 text-sage-700 flex items-center justify-center mb-4"
                aria-hidden="true"
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M3 7l9 6 9-6M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <h2 className="font-serif text-[1.3rem] text-ink-800 mb-2">
                Link enviado!
              </h2>
              <p className="text-ink-600 text-[0.98rem] leading-relaxed">
                Verifique <strong className="text-ink-800">{sentEmail}</strong>.
                O link vale por 1 hora.
              </p>
              <p className="mt-3 text-xs text-ink-500">
                Se não aparecer em 2 minutos, confira a caixa de spam.
              </p>
              <a
                href="/paciente/login"
                className="mt-5 inline-block text-sage-700 hover:text-sage-800 underline-offset-4 hover:underline text-sm"
              >
                Tentar com outro e-mail
              </a>
            </div>
          ) : (
            <PatientLoginForm nextPath={nextPath} />
          )}

          <p className="mt-8 text-center text-xs text-ink-400">
            Primeiro acesso? Usamos o e-mail da sua última consulta
            para identificar você.
          </p>
        </div>
      </section>
    </main>
  );
}
