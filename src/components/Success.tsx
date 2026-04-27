"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";

const SHARE_TEXT =
  "Vi isso aqui e achei a sua cara — parece que finalmente esse tipo de tratamento ficou mais viável.";
const SHARE_URL = "https://institutonovamedida.com.br";

// PR-075-A · D-086: depois do lead, oferta principal é o agendamento
// gratuito imediato — não mais "espere o WhatsApp". O share continua
// como ação secundária pra quem quer indicar antes de marcar.
const SCHEDULE_HREF = "/agendar";

export function Success({
  open,
  onClose,
  name,
}: {
  open: boolean;
  onClose: () => void;
  name: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  if (!open) return null;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(SHARE_URL);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  const shareWa = () => {
    const txt = encodeURIComponent(`${SHARE_TEXT}\n\n${SHARE_URL}`);
    window.open(`https://wa.me/?text=${txt}`, "_blank");
  };

  const firstName = name.split(" ")[0] || "";

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
    >
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="absolute inset-0 bg-ink-900/70 backdrop-blur-sm"
        onClick={onClose}
      />
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="relative w-full max-w-lg bg-cream-50 rounded-[1.5rem] shadow-2xl overflow-hidden"
      >
        <div className="bg-sage-700 text-cream-50 px-7 sm:px-9 py-9 relative overflow-hidden">
          <div
            aria-hidden
            className="absolute inset-0 opacity-[0.10] pointer-events-none"
            style={{
              backgroundImage:
                "radial-gradient(circle at 80% 20%, rgba(232,223,211,0.7) 0%, transparent 40%)",
            }}
          />
          <motion.div
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="relative h-12 w-12 rounded-full bg-cream-50/15 flex items-center justify-center"
          >
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
              <path
                d="M5 11.5L9 15.5L17 6.5"
                stroke="white"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </motion.div>
          <h2 className="relative font-serif-display text-[1.7rem] sm:text-[2rem] mt-5 leading-[1.1]">
            Pronto{firstName ? `, ${firstName}` : ""}.
          </h2>
          <p className="relative mt-3 text-cream-100/85 text-[0.98rem] leading-relaxed">
            Sua avaliação foi recebida. Agora é só escolher o melhor horário
            pra conversar com nossa médica — sem cobrança nesta etapa.
          </p>
        </div>

        <div className="px-7 sm:px-9 py-8">
          <div className="rounded-2xl border border-sage-200 bg-sage-50/60 p-5">
            <p className="text-[0.82rem] uppercase tracking-wider text-sage-700 font-medium">
              Próximo passo
            </p>
            <p className="mt-2 font-serif-display text-[1.2rem] text-ink-800 leading-tight">
              Agende sua consulta gratuita.
            </p>
            <p className="mt-2 text-[0.9rem] text-ink-600 leading-relaxed">
              30 minutos online por vídeo. Você só paga se decidir aceitar um
              plano de tratamento depois da consulta.
            </p>
            <a
              href={SCHEDULE_HREF}
              className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-full bg-sage-700 hover:bg-sage-800 text-cream-50 text-[0.95rem] font-medium px-6 py-3 transition-colors"
            >
              Escolher horário
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path
                  d="M5 3l4 4-4 4"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </a>
          </div>

          <div className="mt-5 flex items-start gap-3 rounded-2xl bg-cream-100 border border-ink-100 p-4">
            <div className="h-9 w-9 rounded-full bg-cream-50 border border-ink-100 flex items-center justify-center shrink-0">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M8 1.5C4.41 1.5 1.5 4.41 1.5 8C1.5 9.13 1.79 10.2 2.31 11.13L1.5 14.5L4.97 13.71C5.87 14.21 6.91 14.5 8 14.5C11.59 14.5 14.5 11.59 14.5 8C14.5 4.41 11.59 1.5 8 1.5Z"
                  stroke="#3B4F44"
                  strokeWidth="1.3"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <div className="text-[0.88rem] text-ink-600 leading-relaxed">
              Se preferir, também pode aguardar — se você não agendar agora,
              entraremos em contato pelo WhatsApp para apoiar o agendamento.
            </div>
          </div>

          <div className="mt-5 rounded-2xl border border-cream-300 bg-cream-100/40 p-5">
            <p className="font-serif-display text-[1.15rem] text-ink-800 leading-tight">
              Quem chega até aqui, normalmente conhece alguém na mesma situação.
            </p>
            <p className="mt-2 text-[0.9rem] text-ink-500 leading-relaxed">
              Se lembrou de alguém agora, pode enviar a avaliação pra essa
              pessoa.
            </p>

            <div className="mt-5 grid sm:grid-cols-2 gap-2.5">
              <button
                onClick={shareWa}
                className="inline-flex items-center justify-center gap-2 rounded-full bg-ink-800 hover:bg-ink-900 text-cream-50 text-[0.92rem] font-medium px-5 py-3 transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path
                    d="M7 1.5C3.96 1.5 1.5 3.96 1.5 7C1.5 7.99 1.76 8.92 2.21 9.74L1.5 12.5L4.34 11.81C5.13 12.24 6.04 12.5 7 12.5C10.04 12.5 12.5 10.04 12.5 7C12.5 3.96 10.04 1.5 7 1.5Z"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinejoin="round"
                  />
                </svg>
                Enviar pelo WhatsApp
              </button>
              <button
                onClick={copyLink}
                className="inline-flex items-center justify-center gap-2 rounded-full bg-cream-50 hover:bg-cream-200 text-ink-800 border border-ink-100 text-[0.92rem] font-medium px-5 py-3 transition-colors"
              >
                {copied ? (
                  <>
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path
                        d="M3 7L6 10L11 4"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    Link copiado
                  </>
                ) : (
                  <>
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <rect
                        x="3"
                        y="3"
                        width="8"
                        height="8"
                        rx="1.5"
                        stroke="currentColor"
                        strokeWidth="1.3"
                      />
                      <path
                        d="M5.5 1.5H10.5C11.6 1.5 12.5 2.4 12.5 3.5V8.5"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinecap="round"
                      />
                    </svg>
                    Copiar link
                  </>
                )}
              </button>
            </div>
          </div>

          <button
            onClick={onClose}
            className="mt-6 w-full text-[0.88rem] text-ink-400 hover:text-ink-700 transition-colors"
          >
            Fechar
          </button>
        </div>
      </motion.div>
    </div>
  );
}
