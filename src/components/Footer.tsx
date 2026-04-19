"use client";

import { Logo } from "./Logo";
import { useState } from "react";

export function Footer() {
  const [copied, setCopied] = useState(false);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText("https://institutonovamedida.com.br");
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  return (
    <footer className="relative bg-ink-900 text-cream-100 pt-20 pb-10">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <div className="grid lg:grid-cols-12 gap-12 pb-16 border-b border-cream-100/10">
          <div className="lg:col-span-5">
            <div className="text-cream-50">
              <Logo className="text-cream-50" />
            </div>
            <p className="mt-5 font-serif-display text-[1.5rem] leading-tight text-cream-50/95 max-w-md">
              Prefere ver isso com alguém de confiança?
            </p>
            <p className="mt-3 text-[0.95rem] text-cream-100/60 max-w-md">
              Você pode compartilhar o link da avaliação. Muita gente prefere
              ver isso no privado.
            </p>
            <button
              onClick={copyLink}
              className="mt-5 inline-flex items-center gap-2 rounded-full border border-cream-100/25 hover:border-cream-100/50 hover:bg-cream-100/5 text-cream-50 text-[0.9rem] px-5 py-2.5 transition-colors"
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

          <div className="lg:col-span-7 grid sm:grid-cols-3 gap-8">
            <Col title="Plataforma">
              <FLink href="#como-funciona">Como funciona</FLink>
              <FLink href="#duvidas">Dúvidas</FLink>
              <FLink href="#seguranca">Segurança</FLink>
            </Col>
            <Col title="Legal">
              <FLink href="/termos">Termos de uso</FLink>
              <FLink href="/privacidade">Política de privacidade</FLink>
              <FLink href="/lgpd">Encarregado de dados (LGPD)</FLink>
              <FLink href="/cookies">Política de cookies</FLink>
            </Col>
            <Col title="Suporte">
              <FLink href="mailto:contato@institutonovamedida.com.br">
                contato@institutonovamedida.com.br
              </FLink>
              <FLink href="/imprensa">Imprensa</FLink>
              <FLink href="/medicas">Para médicas</FLink>
            </Col>
          </div>
        </div>

        <div className="pt-10 grid lg:grid-cols-12 gap-6 text-[0.78rem] text-cream-100/55 leading-relaxed">
          <div className="lg:col-span-8 space-y-3">
            <p>
              <span className="text-cream-100/80 font-medium">
                Instituto Nova Medida Saúde Ltda.
              </span>{" "}
              · CNPJ [a preencher] · Responsável Técnico Médico: Dra.
              [Nome], CRM/[UF] [número] · Encarregado de Dados (DPO):{" "}
              <a
                href="mailto:dpo@institutonovamedida.com.br"
                className="underline underline-offset-2 hover:text-cream-50"
              >
                dpo@institutonovamedida.com.br
              </a>
              .
            </p>
            <p>
              Plataforma de telessaúde em conformidade com a Lei nº
              14.510/2022, Resolução CFM nº 2.314/2022 e Lei Geral de Proteção
              de Dados (LGPD — Lei nº 13.709/2018). Os medicamentos
              eventualmente indicados são prescritos individualmente, conforme
              avaliação clínica, e dispensados por farmácias parceiras
              licenciadas pela Anvisa, observando a Nota Técnica nº 200/2025.
            </p>
            <p className="italic">
              Resultados clínicos variam entre indivíduos. As informações neste
              site não substituem a consulta médica. Em caso de emergência,
              ligue 192 (SAMU).
            </p>
          </div>
          <div className="lg:col-span-4 lg:text-right text-cream-100/40">
            © {new Date().getFullYear()} Instituto Nova Medida. Todos os
            direitos reservados.
          </div>
        </div>
      </div>
    </footer>
  );
}

function Col({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-[0.78rem] uppercase tracking-[0.18em] text-cream-100/45 font-medium">
        {title}
      </p>
      <ul className="mt-4 space-y-2.5">{children}</ul>
    </div>
  );
}

function FLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <li>
      <a
        href={href}
        className="text-[0.95rem] text-cream-100/75 hover:text-cream-50 transition-colors"
      >
        {children}
      </a>
    </li>
  );
}
