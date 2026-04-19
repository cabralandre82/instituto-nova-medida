"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Logo } from "./Logo";
import { cn } from "@/lib/utils";

export function Header({ onCta }: { onCta: () => void }) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        "fixed top-0 inset-x-0 z-50 transition-all duration-500",
        scrolled
          ? "bg-cream-100/80 backdrop-blur-md border-b border-ink-100/60"
          : "bg-transparent"
      )}
    >
      <div className="mx-auto max-w-7xl px-5 sm:px-8 h-16 flex items-center justify-between">
        <Logo />
        <nav className="hidden md:flex items-center gap-8 text-[0.92rem] text-ink-500">
          <a href="#como-funciona" className="hover:text-ink-800 transition-colors">
            Como funciona
          </a>
          <Link href="/planos" className="hover:text-ink-800 transition-colors">
            Planos
          </Link>
          <a href="#duvidas" className="hover:text-ink-800 transition-colors">
            Dúvidas
          </a>
          <a href="#seguranca" className="hover:text-ink-800 transition-colors">
            Segurança
          </a>
        </nav>
        <button
          onClick={onCta}
          className="inline-flex items-center gap-2 rounded-full bg-ink-800 hover:bg-ink-900 text-cream-50 text-[0.88rem] font-medium px-4 sm:px-5 py-2.5 transition-colors"
        >
          Começar agora
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
      </div>
    </header>
  );
}
