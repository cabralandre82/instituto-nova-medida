"use client";

import { motion } from "framer-motion";
import Image from "next/image";
import Link from "next/link";

export function Hero({ onCta }: { onCta: () => void }) {
  return (
    <section
      id="top"
      className="relative pt-28 sm:pt-36 pb-16 sm:pb-24 overflow-hidden grain"
    >
      {/* Soft background ornaments */}
      <div
        aria-hidden
        className="absolute -top-40 -right-32 w-[42rem] h-[42rem] rounded-full bg-gradient-to-br from-sage-100/70 via-cream-200/50 to-transparent blur-3xl pointer-events-none"
      />
      <div
        aria-hidden
        className="absolute -bottom-32 -left-32 w-[36rem] h-[36rem] rounded-full bg-gradient-to-tr from-terracotta-100/60 via-cream-200/40 to-transparent blur-3xl pointer-events-none"
      />

      <div className="relative mx-auto max-w-7xl px-5 sm:px-8 grid lg:grid-cols-12 gap-10 lg:gap-16 items-center">
        <div className="lg:col-span-7">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
            className="inline-flex items-center gap-2 rounded-full border border-ink-100 bg-cream-50/80 backdrop-blur px-3 py-1.5 text-[0.78rem] text-ink-500"
          >
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inset-0 rounded-full bg-sage-500 animate-ping opacity-60" />
              <span className="relative h-1.5 w-1.5 rounded-full bg-sage-500" />
            </span>
            Avaliações abertas hoje na sua região
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.05, ease: [0.22, 1, 0.36, 1] }}
            className="font-serif-display mt-6 text-[2.6rem] sm:text-[3.8rem] lg:text-[4.6rem] leading-[1.02] text-ink-900 text-balance"
          >
            Se fosse só{" "}
            <span className="italic text-sage-700">disciplina</span>,
            <br className="hidden sm:block" /> você já teria conseguido.
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.18 }}
            className="mt-7 text-[1.05rem] sm:text-[1.18rem] leading-[1.6] text-ink-500 max-w-2xl"
          >
            Hoje existem formas mais modernas de tratar o emagrecimento — atuando
            direto no apetite e no metabolismo. E o que pouca gente sabe é que,
            em alguns casos,{" "}
            <span className="text-ink-800">
              essa tecnologia pode ser mais acessível do que parece.
            </span>
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.32 }}
            className="mt-9 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4"
          >
            <button
              onClick={onCta}
              className="group inline-flex items-center justify-center gap-2 rounded-full bg-ink-800 hover:bg-ink-900 text-cream-50 text-[0.98rem] font-medium px-7 py-4 shadow-[0_10px_30px_-12px_rgba(28,26,22,0.45)] transition-all hover:shadow-[0_16px_40px_-14px_rgba(28,26,22,0.55)] hover:-translate-y-0.5"
            >
              Veja o que faz sentido no seu caso
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                className="transition-transform group-hover:translate-x-0.5"
              >
                <path
                  d="M3 8H13M13 8L8.5 3.5M13 8L8.5 12.5"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <Link
              href="/planos"
              className="group inline-flex items-center justify-center gap-2 rounded-full border border-ink-200 hover:border-ink-300 hover:bg-cream-50 text-ink-700 text-[0.94rem] font-medium px-6 py-[0.95rem] transition-colors"
            >
              Ver planos de tratamento
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                className="transition-transform group-hover:translate-x-0.5"
              >
                <path
                  d="M3 7H11M11 7L7 3M11 7L7 11"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </Link>
          </motion.div>

          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.7, delay: 0.45 }}
            className="mt-3 text-[0.82rem] text-ink-400 leading-snug"
          >
            Avaliação médica online · sem compromisso · você só segue se fizer sentido
          </motion.p>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.8, delay: 0.5 }}
            className="mt-10 grid sm:grid-cols-3 gap-4 sm:gap-6 max-w-2xl"
          >
            <Trust label="Sem compromisso inicial" />
            <Trust label="Avaliação individual com médica" />
            <Trust label="Você só segue se fizer sentido" />
          </motion.div>

          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.8, delay: 0.7 }}
            className="mt-8 text-[0.82rem] text-ink-400 max-w-xl leading-relaxed border-l-2 border-cream-300 pl-4"
          >
            O sistema libera um número limitado de avaliações por dia para
            garantir análise individual.
          </motion.p>
        </div>

        {/* Visual */}
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.9, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
          className="lg:col-span-5 relative"
        >
          <div className="relative aspect-[4/5] rounded-[1.8rem] overflow-hidden bg-cream-200">
            <Image
              src="/hero-paciente.jpg"
              alt="Paciente em consulta médica online"
              fill
              priority
              sizes="(max-width: 1024px) 100vw, 40vw"
              className="object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-ink-900/30 via-transparent to-transparent" />
          </div>

          {/* Floating card */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.6 }}
            className="absolute -bottom-6 -left-4 sm:left-auto sm:-right-6 max-w-[18rem] bg-cream-50 border border-ink-100 rounded-2xl p-5 shadow-[0_24px_60px_-20px_rgba(28,26,22,0.25)]"
          >
            <div className="flex items-start gap-3">
              <div className="h-9 w-9 shrink-0 rounded-full bg-sage-100 flex items-center justify-center">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M2 8.5L6 12.5L14 4"
                    stroke="#3B4F44"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <div>
                <p className="text-[0.78rem] uppercase tracking-wider text-ink-400 font-medium">
                  Avaliação concluída
                </p>
                <p className="text-[0.92rem] text-ink-700 leading-snug mt-1">
                  &ldquo;A análise individual é o que muda tudo. É outro
                  caminho.&rdquo;
                </p>
                <p className="text-[0.78rem] text-ink-400 mt-2">
                  Carolina, 38 — paciente do Instituto
                </p>
              </div>
            </div>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}

function Trust({ label }: { label: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <svg
        width="18"
        height="18"
        viewBox="0 0 18 18"
        fill="none"
        className="mt-0.5 shrink-0"
      >
        <circle cx="9" cy="9" r="8.25" stroke="#869C8E" strokeWidth="1.2" />
        <path
          d="M5.5 9.2L7.7 11.4L12.5 6.6"
          stroke="#5C7A6A"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="text-[0.88rem] text-ink-600 leading-snug">{label}</span>
    </div>
  );
}
