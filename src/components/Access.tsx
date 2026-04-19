"use client";

import { motion } from "framer-motion";

const paths = [
  {
    label: "Personalizadas",
    text: "Versões ajustadas para o seu caso, com a dose que faz sentido para você",
  },
  {
    label: "Manipuladas",
    text: "Opções preparadas em farmácias autorizadas e auditadas pela Anvisa",
  },
  {
    label: "Viáveis",
    text: "Formas mais acessíveis de chegar ao mesmo resultado, quando indicado",
  },
];

export function Access() {
  return (
    <section className="relative py-24 sm:py-32">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <div className="grid lg:grid-cols-12 gap-10 lg:gap-16">
          <div className="lg:col-span-5">
            <motion.p
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-100px" }}
              transition={{ duration: 0.6 }}
              className="text-[0.82rem] uppercase tracking-[0.18em] text-sage-600 font-medium"
            >
              O que pouca gente sabe
            </motion.p>

            <motion.h2
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-100px" }}
              transition={{ duration: 0.7, delay: 0.05 }}
              className="font-serif-display mt-4 text-[2rem] sm:text-[2.6rem] lg:text-[2.9rem] leading-[1.05] text-ink-900 text-balance"
            >
              Por falta de informação, muita gente acha que só existem{" "}
              <span className="italic text-terracotta-600">versões caras</span>.
            </motion.h2>

            <motion.p
              initial={{ opacity: 0 }}
              whileInView={{ opacity: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.7, delay: 0.2 }}
              className="mt-6 text-[1.02rem] text-ink-500 leading-relaxed"
            >
              Mas em alguns casos, existem outros caminhos — quando faz sentido
              clinicamente para você.
            </motion.p>
          </div>

          <div className="lg:col-span-7 space-y-3">
            {paths.map((p, i) => (
              <motion.div
                key={p.label}
                initial={{ opacity: 0, x: 18 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true, margin: "-80px" }}
                transition={{ duration: 0.6, delay: i * 0.1 }}
                className="group flex items-start gap-5 sm:gap-6 p-6 sm:p-7 rounded-2xl border border-ink-100 bg-cream-50 hover:border-sage-200 transition-colors"
              >
                <div className="shrink-0 h-12 w-12 rounded-full bg-sage-50 flex items-center justify-center text-sage-700 font-serif text-[1.15rem]">
                  {String(i + 1).padStart(2, "0")}
                </div>
                <div>
                  <p className="font-serif-display text-[1.4rem] text-ink-900 leading-tight">
                    {p.label}
                  </p>
                  <p className="mt-2 text-[0.98rem] text-ink-500 leading-relaxed">
                    {p.text}
                  </p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
