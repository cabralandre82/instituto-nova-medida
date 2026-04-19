"use client";

import { motion } from "framer-motion";

export function Shift() {
  return (
    <section className="relative py-24 sm:py-32 bg-ink-900 text-cream-100 overflow-hidden">
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.07] pointer-events-none"
        style={{
          backgroundImage:
            "radial-gradient(circle at 30% 20%, rgba(201,123,94,0.6) 0%, transparent 40%), radial-gradient(circle at 70% 80%, rgba(134,156,142,0.7) 0%, transparent 45%)",
        }}
      />

      <div className="relative mx-auto max-w-5xl px-5 sm:px-8">
        <motion.p
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-[0.82rem] uppercase tracking-[0.18em] text-terracotta-300 font-medium"
        >
          O que mudou
        </motion.p>

        <motion.h2
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.8, delay: 0.05 }}
          className="font-serif-display mt-5 text-[2.2rem] sm:text-[3.2rem] lg:text-[3.8rem] leading-[1.04] text-balance"
        >
          Nos últimos anos, a forma de tratar isso mudou{" "}
          <span className="italic text-terracotta-300">muito</span>.
        </motion.h2>

        <motion.p
          initial={{ opacity: 0, y: 14 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.7, delay: 0.18 }}
          className="mt-8 text-[1.1rem] sm:text-[1.25rem] leading-[1.6] text-cream-200/85 max-w-3xl"
        >
          Hoje existem estratégias que atuam direto no apetite e na forma como o
          corpo responde aos alimentos. Não é mais só{" "}
          <span className="line-through text-cream-200/50">força de vontade</span>{" "}
          — é ciência aplicada, individualizada para o seu caso.
        </motion.p>
      </div>
    </section>
  );
}
