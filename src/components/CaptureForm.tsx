"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import type { QuizAnswers } from "./Quiz";

function maskPhone(v: string) {
  const d = v.replace(/\D/g, "").slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 7) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

export function CaptureForm({
  open,
  onClose,
  answers,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  answers: QuizAnswers;
  onSuccess: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  if (!open) return null;

  const isValid =
    name.trim().length >= 2 && phone.replace(/\D/g, "").length >= 10 && consent;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          phone: phone.replace(/\D/g, ""),
          answers,
          consent,
        }),
      });
      if (!res.ok) throw new Error("Falha ao registrar");
      onSuccess(name.trim());
    } catch {
      setError(
        "Tivemos um problema ao registrar sua avaliação. Tente novamente em alguns segundos."
      );
    } finally {
      setLoading(false);
    }
  };

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
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
        className="relative w-full max-w-md bg-cream-50 rounded-[1.5rem] shadow-2xl overflow-hidden"
      >
        <div className="px-6 sm:px-8 pt-7 pb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-sage-500" />
            <p className="text-[0.78rem] uppercase tracking-wider text-sage-700 font-medium">
              Última etapa
            </p>
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

        <div className="px-6 sm:px-8 pb-8">
          <h2 className="font-serif-display text-[1.7rem] sm:text-[2rem] leading-[1.1] text-ink-900 text-balance">
            Pronto. A médica vai analisar o seu caso.
          </h2>
          <p className="mt-3 text-[0.95rem] text-ink-500 leading-relaxed">
            Deixe seus dados — vamos te chamar pelo WhatsApp para iniciar a
            avaliação individual.
          </p>

          <form onSubmit={submit} className="mt-7 space-y-4">
            <Field label="Seu nome">
              <input
                type="text"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Como você gosta de ser chamada(o)"
                className="w-full bg-cream-50 border border-ink-100 focus:border-sage-500 focus:ring-2 focus:ring-sage-500/15 rounded-xl px-4 py-3.5 text-ink-800 placeholder-ink-300 outline-none transition-all"
              />
            </Field>

            <Field label="Seu WhatsApp">
              <div className="relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-ink-400 text-[0.95rem]">
                  +55
                </span>
                <input
                  type="tel"
                  inputMode="numeric"
                  autoComplete="tel-national"
                  value={phone}
                  onChange={(e) => setPhone(maskPhone(e.target.value))}
                  placeholder="(11) 99999-9999"
                  className="w-full bg-cream-50 border border-ink-100 focus:border-sage-500 focus:ring-2 focus:ring-sage-500/15 rounded-xl pl-12 pr-4 py-3.5 text-ink-800 placeholder-ink-300 outline-none transition-all"
                />
              </div>
            </Field>

            <label className="flex items-start gap-3 cursor-pointer select-none pt-1">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-1 h-4 w-4 accent-sage-600"
              />
              <span className="text-[0.85rem] text-ink-500 leading-snug">
                Pode me chamar por aqui. Concordo com a{" "}
                <a
                  href="/privacidade"
                  className="underline underline-offset-2 hover:text-ink-700"
                >
                  Política de Privacidade
                </a>{" "}
                e o uso dos meus dados conforme a LGPD.
              </span>
            </label>

            {error && (
              <p className="text-[0.85rem] text-terracotta-700 bg-terracotta-50 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={!isValid || loading}
              className={cn(
                "w-full inline-flex items-center justify-center gap-2 rounded-full text-cream-50 text-[0.98rem] font-medium px-6 py-4 transition-all",
                isValid && !loading
                  ? "bg-ink-800 hover:bg-ink-900 hover:-translate-y-0.5"
                  : "bg-ink-300 cursor-not-allowed"
              )}
            >
              {loading ? (
                <>
                  <svg
                    className="animate-spin"
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="none"
                  >
                    <circle
                      cx="8"
                      cy="8"
                      r="6"
                      stroke="currentColor"
                      strokeOpacity="0.3"
                      strokeWidth="2"
                    />
                    <path
                      d="M14 8C14 4.68629 11.3137 2 8 2"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                  Registrando…
                </>
              ) : (
                <>
                  Receber meu retorno pelo WhatsApp
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path
                      d="M3 7H11M11 7L7 3M11 7L7 11"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </>
              )}
            </button>

            <p className="text-[0.75rem] text-ink-400 text-center pt-1">
              Seus dados são confidenciais e usados apenas para a sua avaliação
              médica.
            </p>
          </form>
        </div>
      </motion.div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-[0.82rem] font-medium text-ink-600 mb-1.5 block">
        {label}
      </span>
      {children}
    </label>
  );
}
