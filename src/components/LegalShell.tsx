import Link from "next/link";
import { Logo } from "./Logo";
import { Footer } from "./Footer";
import { cn } from "@/lib/utils";

/**
 * Wrapper compartilhado pras páginas legais e institucionais.
 *
 * Responsabilidades:
 * - Header simples (logo clicável → home + botão "Voltar ao site")
 * - Container tipográfico com hierarquia rica e respiro generoso
 * - Footer institucional reutilizado da home
 *
 * As páginas filhas só precisam preencher o conteúdo principal,
 * tipicamente usando os componentes <H1>, <H2>, <Lead>, <P>, <Aside>
 * exportados aqui pra manter consistência visual.
 */
export function LegalShell({
  title,
  intro,
  updatedAt,
  children,
}: {
  title: string;
  intro?: string;
  updatedAt?: string;
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
        <section className="mx-auto max-w-3xl px-5 sm:px-8 pt-16 pb-12 sm:pt-24 sm:pb-16">
          {updatedAt && (
            <p className="text-[0.78rem] uppercase tracking-[0.18em] text-ink-400 font-medium mb-5">
              Atualizado em {updatedAt}
            </p>
          )}
          <h1 className="font-serif text-[2.4rem] sm:text-[3rem] leading-[1.05] tracking-tight text-ink-800">
            {title}
          </h1>
          {intro && (
            <p className="mt-6 text-[1.15rem] sm:text-[1.25rem] leading-relaxed text-ink-500 max-w-2xl">
              {intro}
            </p>
          )}
        </section>

        <article className="mx-auto max-w-3xl px-5 sm:px-8 pb-24 sm:pb-32 space-y-10 sm:space-y-12">
          {children}
        </article>
      </main>

      <Footer />
    </>
  );
}

export function H2({
  id,
  children,
  className,
}: {
  id?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <h2
      id={id}
      className={cn(
        "scroll-mt-24 font-serif text-[1.6rem] sm:text-[1.85rem] leading-[1.15] tracking-tight text-ink-800 mb-5",
        className
      )}
    >
      {children}
    </h2>
  );
}

export function H3({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <h3
      className={cn(
        "font-serif text-[1.2rem] sm:text-[1.3rem] leading-snug text-ink-800 mt-6 mb-3",
        className
      )}
    >
      {children}
    </h3>
  );
}

export function P({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "text-[1.02rem] leading-[1.7] text-ink-600 [&+p]:mt-4",
        className
      )}
    >
      {children}
    </p>
  );
}

export function UL({ children }: { children: React.ReactNode }) {
  return (
    <ul className="space-y-2.5 text-[1.02rem] leading-[1.65] text-ink-600 mt-3">
      {children}
    </ul>
  );
}

export function LI({ children }: { children: React.ReactNode }) {
  return (
    <li className="relative pl-6">
      <span
        className="absolute left-0 top-[0.7rem] inline-block w-2 h-px bg-sage-500"
        aria-hidden="true"
      />
      {children}
    </li>
  );
}

export function Aside({
  variant = "info",
  children,
}: {
  variant?: "info" | "warning";
  children: React.ReactNode;
}) {
  const styles =
    variant === "warning"
      ? "bg-terracotta-50 border-terracotta-200 text-terracotta-800"
      : "bg-sage-50 border-sage-200 text-sage-700";
  return (
    <aside
      className={cn(
        "rounded-2xl border px-5 py-4 sm:px-6 sm:py-5 text-[0.97rem] leading-[1.65]",
        styles
      )}
    >
      {children}
    </aside>
  );
}

export function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      <H2 id={id}>{title}</H2>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

export function TOC({
  items,
}: {
  items: Array<{ id: string; label: string }>;
}) {
  return (
    <nav
      aria-label="Sumário"
      className="rounded-2xl border border-ink-100 bg-cream-50 px-5 py-5 sm:px-6 sm:py-6"
    >
      <p className="text-[0.78rem] uppercase tracking-[0.18em] text-ink-400 font-medium mb-3">
        Sumário
      </p>
      <ol className="space-y-2 text-[0.95rem]">
        {items.map((item, idx) => (
          <li key={item.id} className="flex gap-3">
            <span className="text-ink-300 tabular-nums">
              {String(idx + 1).padStart(2, "0")}
            </span>
            <a
              href={`#${item.id}`}
              className="text-ink-600 hover:text-ink-800 transition-colors"
            >
              {item.label}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
