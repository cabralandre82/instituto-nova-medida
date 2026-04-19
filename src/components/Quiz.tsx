"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";

type Question = {
  id: string;
  title: string;
  helper?: string;
  options: { value: string; label: string }[];
};

const questions: Question[] = [
  {
    id: "incomodo",
    title: "O que mais te incomoda hoje?",
    helper: "Escolha o que mais se aproxima da sua rotina.",
    options: [
      { value: "fome", label: "Fome constante, mesmo depois de comer" },
      { value: "manter", label: "Não conseguir manter dieta por muito tempo" },
      { value: "voltar", label: "Emagrecer e logo voltar tudo" },
    ],
  },
  {
    id: "tentou",
    title: "Você já tentou emagrecer?",
    options: [
      { value: "varias", label: "Várias vezes — já perdi a conta" },
      { value: "algumas", label: "Algumas vezes, com resultados parciais" },
      { value: "nao", label: "Ainda não tentei direito" },
    ],
  },
  {
    id: "intencao",
    title: "Se existisse um jeito melhor, você:",
    options: [
      { value: "entender", label: "Quero entender como funciona" },
      { value: "faria", label: "Provavelmente faria, se fizer sentido" },
      { value: "avaliando", label: "Estou só avaliando, sem pressa" },
    ],
  },
  {
    id: "abertura",
    title: "Você toparia avaliar outras formas de tratamento?",
    helper: "Não tem resposta certa. É só pra entender o seu momento.",
    options: [
      { value: "sim", label: "Sim, quero conhecer" },
      { value: "talvez", label: "Talvez, depende do caso" },
      { value: "nao-sei", label: "Ainda não sei" },
    ],
  },
];

export type QuizAnswers = Record<string, string>;

export function Quiz({
  open,
  onClose,
  onComplete,
}: {
  open: boolean;
  onClose: () => void;
  onComplete: (answers: QuizAnswers) => void;
}) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<QuizAnswers>({});
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (open) {
      setStep(0);
      setAnswers({});
    }
  }, [open]);

  const total = questions.length;
  const current = questions[step];
  const progress = ((step + 1) / total) * 100;

  const select = (val: string) => {
    const next = { ...answers, [current.id]: val };
    setAnswers(next);
    setTimeout(() => {
      if (step < total - 1) {
        setStep(step + 1);
      } else {
        onComplete(next);
      }
    }, 220);
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="quiz-title"
    >
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.25 }}
        className="absolute inset-0 bg-ink-900/65 backdrop-blur-sm"
        onClick={onClose}
      />

      <motion.div
        ref={dialogRef}
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 12, scale: 0.98 }}
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        className="relative w-full max-w-2xl bg-cream-50 rounded-[1.5rem] shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="px-6 sm:px-8 pt-6 pb-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-7 w-7 rounded-full bg-sage-100 flex items-center justify-center">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path
                  d="M7 1.5C7 1.5 2 4.5 2 8.5C2 11.2614 4.23858 13 7 13C9.76142 13 12 11.2614 12 8.5C12 4.5 7 1.5 7 1.5Z"
                  stroke="#3B4F44"
                  strokeWidth="1.3"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <div>
              <p className="text-[0.78rem] uppercase tracking-wider text-ink-400 font-medium">
                Instituto Nova Medida
              </p>
              <p className="text-[0.95rem] text-ink-700 font-medium">
                Pergunta {step + 1} de {total}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Fechar"
            className="h-9 w-9 rounded-full text-ink-400 hover:text-ink-700 hover:bg-cream-200 transition-colors flex items-center justify-center"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M4 4L12 12M12 4L4 12"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* Progress bar */}
        <div className="px-6 sm:px-8">
          <div className="h-1.5 w-full rounded-full bg-cream-200 overflow-hidden">
            <motion.div
              className="h-full rounded-full bg-sage-600"
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
            />
          </div>
        </div>

        {/* Body */}
        <div className="px-6 sm:px-10 py-8 sm:py-10 min-h-[24rem]">
          <AnimatePresence mode="wait">
            <motion.div
              key={current.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.32 }}
            >
              <h2
                id="quiz-title"
                className="font-serif-display text-[1.7rem] sm:text-[2.1rem] leading-[1.1] text-ink-900"
              >
                {current.title}
              </h2>
              {current.helper && (
                <p className="mt-3 text-[0.95rem] text-ink-400">
                  {current.helper}
                </p>
              )}

              <div className="mt-7 space-y-2.5">
                {current.options.map((opt) => {
                  const isSelected = answers[current.id] === opt.value;
                  return (
                    <button
                      key={opt.value}
                      onClick={() => select(opt.value)}
                      className={cn(
                        "group w-full flex items-center justify-between gap-4 text-left rounded-2xl border px-5 py-4 transition-all",
                        isSelected
                          ? "border-sage-500 bg-sage-50"
                          : "border-ink-100 bg-cream-50 hover:border-sage-300 hover:bg-cream-100"
                      )}
                    >
                      <span className="text-[1rem] sm:text-[1.05rem] text-ink-800 leading-snug">
                        {opt.label}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 h-7 w-7 rounded-full border flex items-center justify-center transition-all",
                          isSelected
                            ? "border-sage-600 bg-sage-600"
                            : "border-ink-200 bg-cream-50 group-hover:border-sage-400"
                        )}
                      >
                        {isSelected ? (
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                            <path
                              d="M2.5 6.5L5 9L9.5 3.5"
                              stroke="white"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        ) : (
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 12 12"
                            fill="none"
                            className="opacity-0 group-hover:opacity-60 transition-opacity"
                          >
                            <path
                              d="M3 6H9M9 6L6 3M9 6L6 9"
                              stroke="#5C7A6A"
                              strokeWidth="1.4"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Footer */}
        <div className="px-6 sm:px-10 pb-6 pt-2 flex items-center justify-between">
          <button
            onClick={() => setStep(Math.max(0, step - 1))}
            disabled={step === 0}
            className="text-[0.9rem] text-ink-400 hover:text-ink-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            ← Voltar
          </button>
          <p className="text-[0.78rem] text-ink-400">
            Suas respostas são privadas e individuais.
          </p>
        </div>
      </motion.div>
    </div>
  );
}
