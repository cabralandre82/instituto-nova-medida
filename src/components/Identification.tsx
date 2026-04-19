"use client";

import { motion } from "framer-motion";

const items = [
  {
    title: "fazer dieta",
    detail: "e não conseguir manter por muito tempo",
  },
  {
    title: "controlar a fome",
    detail: "e perceber que ela sempre volta mais forte",
  },
  {
    title: "emagrecer",
    detail: "e em pouco tempo voltar ao mesmo ponto",
  },
];

export function Identification() {
  return (
    <section className="relative py-24 sm:py-32">
      <div className="mx-auto max-w-5xl px-5 sm:px-8">
        <motion.p
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-[0.82rem] uppercase tracking-[0.18em] text-sage-600 font-medium"
        >
          Você já tentou
        </motion.p>

        <motion.h2
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.7, delay: 0.05 }}
          className="font-serif-display mt-4 text-[2rem] sm:text-[2.8rem] lg:text-[3.2rem] leading-[1.05] text-ink-900 text-balance max-w-3xl"
        >
          E provavelmente já percebeu —{" "}
          <span className="italic text-sage-700">não é só esforço</span>.
          O metabolismo também conta. Muito.
        </motion.h2>

        <div className="mt-14 grid sm:grid-cols-3 gap-px bg-ink-100 rounded-2xl overflow-hidden border border-ink-100">
          {items.map((item, i) => (
            <motion.div
              key={item.title}
              initial={{ opacity: 0, y: 14 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{ duration: 0.6, delay: i * 0.1 }}
              className="bg-cream-50 p-7 sm:p-8"
            >
              <p className="text-[0.78rem] uppercase tracking-wider text-ink-400 font-medium">
                Tentou
              </p>
              <p className="font-serif-display mt-3 text-[1.6rem] text-ink-900 leading-tight">
                {item.title}
              </p>
              <p className="mt-3 text-[0.95rem] text-ink-500 leading-relaxed">
                {item.detail}
              </p>
            </motion.div>
          ))}
        </div>

        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.4 }}
          className="mt-12 text-[1.05rem] text-ink-500 max-w-2xl leading-relaxed"
        >
          Provavelmente você conhece alguém passando por isso.
          <br />
          <span className="text-ink-700">Pode ser você. Pode ser alguém próximo.</span>
        </motion.p>
      </div>
    </section>
  );
}
