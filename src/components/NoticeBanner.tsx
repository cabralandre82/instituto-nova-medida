"use client";

/**
 * Banner de aviso na home, ativado por `?aviso=<codigo>`.
 *
 * Introduzido pelo PR-020 para comunicar ao visitante que tentou acessar
 * uma rota legada (`/checkout/[plano]` ou `/agendar/[plano]`) que o
 * fluxo correto hoje é passar por uma consulta gratuita primeiro.
 *
 * Lê `window.location.search` no cliente (evita prop-drilling e
 * Suspense boundary). Se precisarmos suportar mais códigos, é só
 * expandir o mapa `MESSAGES`.
 */

import { useEffect, useState } from "react";
import Link from "next/link";

const MESSAGES: Record<string, { title: string; body: string }> = {
  consulta_primeiro: {
    title: "Essa etapa é depois da consulta",
    body:
      "O tratamento só é oferecido após avaliação médica individual, que é gratuita e sem compromisso. Começa com o quiz aqui do lado.",
  },
};

export function NoticeBanner() {
  const [code, setCode] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const next = params.get("aviso");
    if (next && MESSAGES[next]) {
      setCode(next);
    }
  }, []);

  if (!code) return null;
  const message = MESSAGES[code];
  if (!message) return null;

  return (
    <div
      role="status"
      className="sticky top-16 z-30 bg-terracotta-50 border-b border-terracotta-200 text-ink-800"
    >
      <div className="mx-auto max-w-5xl px-5 sm:px-8 py-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
        <div className="flex-1">
          <p className="font-medium text-[0.95rem]">{message.title}</p>
          <p className="text-[0.88rem] text-ink-600 leading-snug">
            {message.body}
          </p>
        </div>
        <Link
          href="/"
          onClick={() => setCode(null)}
          className="inline-flex items-center justify-center self-start sm:self-auto text-[0.82rem] text-ink-500 hover:text-ink-700 underline underline-offset-2"
        >
          Fechar
        </Link>
      </div>
    </div>
  );
}
