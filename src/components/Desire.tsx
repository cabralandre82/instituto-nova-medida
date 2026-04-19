"use client";

import { motion } from "framer-motion";

const lines = [
  "não precisar lutar contra a fome o tempo todo",
  "não começar e parar — sempre",
  "não voltar pro mesmo ponto, mês depois de mês",
];

export function Desire() {
  return (
    <section className="relative py-24 sm:py-32">
      <div className="mx-auto max-w-4xl px-5 sm:px-8 text-center">
        <motion.p
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-[0.82rem] uppercase tracking-[0.18em] text-sage-600 font-medium"
        >
          Imagina
        </motion.p>

        <motion.h2
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.7, delay: 0.05 }}
          className="font-serif-display mt-5 text-[2rem] sm:text-[2.8rem] lg:text-[3.4rem] leading-[1.05] text-ink-900 text-balance"
        >
          Como seria a sua vida{" "}
          <span className="italic text-sage-700">sem essa luta diária</span>?
        </motion.h2>

        <ul className="mt-12 space-y-5 max-w-2xl mx-auto text-left">
          {lines.map((line, i) => (
            <motion.li
              key={line}
              initial={{ opacity: 0, x: -12 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{ duration: 0.5, delay: i * 0.12 }}
              className="flex items-start gap-4"
            >
              <svg
                width="22"
                height="22"
                viewBox="0 0 22 22"
                fill="none"
                className="mt-1 shrink-0"
              >
                <circle cx="11" cy="11" r="10" stroke="#869C8E" strokeWidth="1" />
                <path
                  d="M6.5 11.2L9.4 14.1L15.5 7.8"
                  stroke="#5C7A6A"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="text-[1.15rem] sm:text-[1.3rem] text-ink-700 leading-snug">
                {line}
              </span>
            </motion.li>
          ))}
        </ul>

        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.5 }}
          className="mt-14 text-[1rem] text-ink-500 leading-relaxed max-w-xl mx-auto"
        >
          É exatamente isso que a avaliação busca destravar — quando faz sentido
          clinicamente para o seu caso.
        </motion.p>
      </div>
    </section>
  );
}
