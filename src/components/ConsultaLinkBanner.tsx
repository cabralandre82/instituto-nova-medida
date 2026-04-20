"use client";

import { useEffect, useState } from "react";

/**
 * Banner exibido nas páginas de pós-checkout (`/checkout/sucesso` e
 * `/checkout/aguardando`) quando o paciente acabou de reservar um
 * horário. Lê do localStorage (gravado pelo CheckoutForm em modo
 * "reserve") e mostra um CTA pro link permanente da consulta.
 *
 * Não falha silenciosamente se localStorage não está disponível
 * (incógnito antigo, etc) — só não renderiza nada.
 */
export function ConsultaLinkBanner({
  variant = "primary",
}: {
  variant?: "primary" | "subtle";
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    try {
      const stored = localStorage.getItem("inm_last_consulta_url");
      if (stored && /^\/?consulta\/[0-9a-f-]+\?t=|^https?:\/\//i.test(stored)) {
        setUrl(stored);
      }
    } catch {
      // ok
    }
  }, []);

  if (!url) return null;

  if (variant === "subtle") {
    return (
      <p className="text-sm text-ink-600 mt-4">
        <a
          href={url}
          className="text-sage-700 hover:text-sage-800 underline underline-offset-2 font-medium"
        >
          Acessar minha consulta →
        </a>
      </p>
    );
  }

  return (
    <div className="mt-8 rounded-2xl border border-sage-200 bg-sage-50 px-5 py-4 sm:px-6 sm:py-5 text-left">
      <p className="text-[0.78rem] uppercase tracking-[0.16em] text-sage-700 font-medium mb-1.5">
        Sua consulta
      </p>
      <p className="text-sm text-ink-700 leading-relaxed">
        Guarde este link — ele leva direto pra sala da sua consulta. A gente
        também vai te mandar por WhatsApp.
      </p>
      <a
        href={url}
        className="mt-3 inline-flex items-center gap-2 rounded-full bg-sage-700 hover:bg-sage-800 text-cream-100 px-5 py-2.5 text-[0.92rem] font-medium transition-colors"
      >
        Acessar minha consulta →
      </a>
    </div>
  );
}
