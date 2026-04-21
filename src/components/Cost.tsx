"use client";

import { motion } from "framer-motion";

export function Cost({ onCta }: { onCta: () => void }) {
  return (
    <section
      id="seguranca"
      className="relative py-24 sm:py-32 bg-sage-700 text-cream-50 overflow-hidden"
    >
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.08] pointer-events-none"
        style={{
          backgroundImage:
            "radial-gradient(circle at 80% 20%, rgba(232,223,211,0.6) 0%, transparent 40%)",
        }}
      />

      <div className="relative mx-auto max-w-5xl px-5 sm:px-8">
        <motion.p
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-[0.82rem] uppercase tracking-[0.18em] text-cream-200/80 font-medium"
        >
          Sem risco
        </motion.p>

        <motion.h2
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.8, delay: 0.05 }}
          className="font-serif-display mt-5 text-[2.2rem] sm:text-[3.2rem] lg:text-[3.6rem] leading-[1.05] text-balance"
        >
          Você só segue se{" "}
          <span className="italic text-terracotta-200">fizer sentido</span>.
        </motion.h2>

        <motion.p
          initial={{ opacity: 0, y: 14 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.7, delay: 0.18 }}
          className="mt-7 text-[1.15rem] sm:text-[1.3rem] leading-[1.55] text-cream-100/90 max-w-2xl"
        >
          A avaliação médica é{" "}
          <span className="text-cream-50 font-medium">gratuita</span>. Você só
          paga se a médica indicar o tratamento e você decidir seguir. Sem
          cobrança antes. Sem assinatura escondida.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.7, delay: 0.32 }}
          className="mt-12 flex flex-col sm:flex-row items-start sm:items-center gap-6"
        >
          <button
            onClick={onCta}
            className="group inline-flex items-center justify-center gap-2 rounded-full bg-cream-50 hover:bg-white text-ink-800 text-[1rem] font-medium px-7 py-4 transition-all hover:-translate-y-0.5 shadow-[0_14px_40px_-12px_rgba(0,0,0,0.4)]"
          >
            Começar minha avaliação
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
        </motion.div>
      </div>
    </section>
  );
}
