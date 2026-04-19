"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";

const faqs = [
  {
    q: "Como é a consulta?",
    a: "É uma consulta médica online com uma médica brasileira inscrita no CRM. Acontece em ambiente seguro, com criptografia ponta-a-ponta, e atende a Resolução CFM nº 2.314/2022. Após a consulta, o acompanhamento contínuo é feito pelo WhatsApp.",
  },
  {
    q: "E se a médica não indicar nenhum tratamento para mim?",
    a: "Se não houver indicação, você não paga nada — a consulta é gratuita. A nossa proposta é só seguir quando faz sentido clinicamente para você.",
  },
  {
    q: "Os medicamentos são originais ou manipulados?",
    a: "Trabalhamos com farmácias de manipulação licenciadas e auditadas, conforme Nota Técnica nº 200/2025 da Anvisa, RDC 67/2007 e demais normas vigentes. A médica define, no seu caso, qual a melhor opção.",
  },
  {
    q: "Tudo bem fazer pelo WhatsApp?",
    a: "A consulta médica formal acontece dentro da nossa plataforma segura (compliant com CFM e LGPD). O WhatsApp é usado para o acompanhamento do dia-a-dia: lembretes, dúvidas rápidas, ajustes leves, envio de exames. É o melhor dos dois mundos.",
  },
  {
    q: "Como funciona o pagamento?",
    a: "Você só paga depois da avaliação, e somente se a médica indicar tratamento. O ciclo padrão é de 90 dias e pode ser pago à vista via PIX ou boleto, ou parcelado em até 3x sem juros no cartão de crédito.",
  },
  {
    q: "Quem está por trás do Instituto Nova Medida?",
    a: "Somos um instituto de telessaúde com responsável técnico médico (RT) registrado no CRM e médicas brasileiras filiadas, atuando dentro das normas do Conselho Federal de Medicina, da Anvisa e da LGPD.",
  },
];

export function Faq() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <section id="duvidas" className="relative py-24 sm:py-32 bg-cream-200/40">
      <div className="mx-auto max-w-4xl px-5 sm:px-8">
        <motion.p
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-[0.82rem] uppercase tracking-[0.18em] text-sage-600 font-medium"
        >
          Dúvidas frequentes
        </motion.p>
        <motion.h2
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.7, delay: 0.05 }}
          className="font-serif-display mt-4 text-[2rem] sm:text-[2.6rem] leading-[1.06] text-ink-900 text-balance"
        >
          O que normalmente perguntam antes de começar.
        </motion.h2>

        <div className="mt-12 divide-y divide-ink-100 border-t border-b border-ink-100">
          {faqs.map((f, i) => {
            const isOpen = open === i;
            return (
              <div key={f.q}>
                <button
                  onClick={() => setOpen(isOpen ? null : i)}
                  aria-expanded={isOpen}
                  className="w-full flex items-start justify-between gap-6 py-6 text-left group"
                >
                  <span
                    className={cn(
                      "font-serif-display text-[1.15rem] sm:text-[1.3rem] leading-snug transition-colors",
                      isOpen ? "text-ink-900" : "text-ink-700 group-hover:text-ink-900"
                    )}
                  >
                    {f.q}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 mt-1 h-7 w-7 rounded-full border flex items-center justify-center transition-all",
                      isOpen
                        ? "border-sage-600 bg-sage-600 rotate-45"
                        : "border-ink-200 bg-cream-50"
                    )}
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 12 12"
                      fill="none"
                      className={cn(isOpen ? "text-cream-50" : "text-ink-500")}
                    >
                      <path
                        d="M6 2V10M2 6H10"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                      />
                    </svg>
                  </span>
                </button>
                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
                      className="overflow-hidden"
                    >
                      <p className="pb-7 pr-14 text-[1rem] text-ink-500 leading-[1.65]">
                        {f.a}
                      </p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
