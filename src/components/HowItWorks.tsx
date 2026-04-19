"use client";

import { motion } from "framer-motion";
import Image from "next/image";

const steps = [
  {
    n: "01",
    title: "Você responde algumas perguntas",
    text: "Um quiz curto e direto, sem rodeios. Leva menos de 2 minutos.",
  },
  {
    n: "02",
    title: "Uma médica avalia o seu caso",
    text: "Análise individual, com histórico e contexto. Sem fórmula pronta.",
  },
  {
    n: "03",
    title: "Você entende o que faz sentido",
    text: "Se houver indicação, recebe a prescrição. Se não houver, você não paga nada.",
  },
  {
    n: "04",
    title: "Acompanhamento contínuo pelo WhatsApp",
    text: "Sua médica acompanha cada etapa, ajusta dose e responde dúvidas.",
  },
];

export function HowItWorks({ onCta }: { onCta: () => void }) {
  return (
    <section
      id="como-funciona"
      className="relative py-24 sm:py-32 bg-cream-200/60"
    >
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <div className="max-w-3xl">
          <motion.p
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.6 }}
            className="text-[0.82rem] uppercase tracking-[0.18em] text-sage-600 font-medium"
          >
            Como funciona
          </motion.p>
          <motion.h2
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.7, delay: 0.05 }}
            className="font-serif-display mt-4 text-[2rem] sm:text-[2.8rem] lg:text-[3.2rem] leading-[1.05] text-ink-900 text-balance"
          >
            Direto. Sem complicação.
          </motion.h2>
          <motion.p
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.18 }}
            className="mt-5 text-[1.05rem] text-ink-500 leading-relaxed max-w-xl"
          >
            Quatro passos simples — do primeiro contato até o acompanhamento
            contínuo com sua médica.
          </motion.p>
        </div>

        <div className="mt-16 grid lg:grid-cols-12 gap-10 lg:gap-14 items-start">
          <div className="lg:col-span-7 space-y-3">
            {steps.map((s, i) => (
              <motion.div
                key={s.n}
                initial={{ opacity: 0, y: 14 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-80px" }}
                transition={{ duration: 0.6, delay: i * 0.08 }}
                className="group relative flex gap-5 sm:gap-7 p-6 sm:p-7 rounded-2xl bg-cream-50 border border-ink-100 hover:border-sage-200 transition-all"
              >
                <div className="shrink-0">
                  <span className="font-serif-display text-[2.2rem] text-sage-600 leading-none">
                    {s.n}
                  </span>
                </div>
                <div>
                  <h3 className="font-serif-display text-[1.45rem] text-ink-900 leading-tight">
                    {s.title}
                  </h3>
                  <p className="mt-2 text-[1rem] text-ink-500 leading-relaxed">
                    {s.text}
                  </p>
                </div>
              </motion.div>
            ))}
          </div>

          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.8 }}
            className="lg:col-span-5 lg:sticky lg:top-24"
          >
            <div className="relative aspect-[4/5] rounded-[1.8rem] overflow-hidden bg-cream-300">
              <Image
                src="/consulta-online.jpg"
                alt="Médica em consulta de telemedicina"
                fill
                sizes="(max-width: 1024px) 100vw, 40vw"
                className="object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-ink-900/40 via-transparent to-transparent" />
              <div className="absolute bottom-6 left-6 right-6 text-cream-50">
                <p className="text-[0.78rem] uppercase tracking-wider opacity-80">
                  Avaliação online
                </p>
                <p className="font-serif-display text-[1.35rem] mt-1 leading-tight">
                  &ldquo;Cada paciente tem um caminho. Esse é o nosso ponto de
                  partida.&rdquo;
                </p>
              </div>
            </div>

            <button
              onClick={onCta}
              className="mt-6 w-full inline-flex items-center justify-center gap-2 rounded-full bg-ink-800 hover:bg-ink-900 text-cream-50 text-[0.95rem] font-medium px-6 py-4 transition-colors"
            >
              Começar minha avaliação
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path
                  d="M3 7H11M11 7L7 3M11 7L7 11"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
