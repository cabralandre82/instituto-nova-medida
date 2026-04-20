/**
 * PatientSearchBar — D-045 · 3.B
 *
 * Barra de busca global do admin, fixa no header do shell. Digita
 * qualquer coisa (nome, email, telefone, CPF com ou sem máscara) e
 * o endpoint `/api/admin/pacientes/search` devolve até 8 hits via
 * autocomplete. Enter abre o primeiro hit.
 *
 * UX:
 *   - Debounce de 180ms (rápido o suficiente pra não lagar, lento o
 *     suficiente pra não spamar a API por caractere).
 *   - Ctrl/Cmd+K foca no input (atalho universal).
 *   - Esc limpa/fecha o dropdown.
 *   - Setas pra cima/baixo navegam entre hits, Enter seleciona.
 *   - Loading state visível (o spinner da casa, terracotta).
 *   - Dropdown fecha ao clicar fora.
 */

"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

type Hit = {
  id: string;
  name: string;
  email: string;
  phone: string;
  cpfMasked: string;
  createdAt: string;
};

const DEBOUNCE_MS = 180;

export function PatientSearchBar() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Debounced search
  useEffect(() => {
    const trimmed = q.trim();
    if (trimmed.length === 0) {
      setHits(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/admin/pacientes/search?q=${encodeURIComponent(trimmed)}`,
          { cache: "no-store" }
        );
        const body = (await res.json()) as
          | { ok: true; hits: Hit[] }
          | { ok: false; error: string };
        if (!res.ok || !body.ok) {
          throw new Error(
            "error" in body ? body.error : `HTTP ${res.status}`
          );
        }
        setHits(body.hits);
        setActiveIdx(0);
      } catch (err) {
        setError(err instanceof Error ? err.message : "erro inesperado");
        setHits([]);
      } finally {
        setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [q]);

  // Cmd/Ctrl+K global shortcut
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Click outside
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, []);

  const selectHit = useCallback(
    (hit: Hit) => {
      setOpen(false);
      setQ("");
      router.push(`/admin/pacientes/${hit.id}`);
    },
    [router]
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setOpen(false);
      (e.target as HTMLInputElement).blur();
      return;
    }
    if (!hits || hits.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % hits.length);
      setOpen(true);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + hits.length) % hits.length);
      setOpen(true);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = hits[activeIdx] ?? hits[0];
      if (hit) selectHit(hit);
    }
  };

  const showDropdown = useMemo(
    () =>
      open &&
      q.trim().length > 0 &&
      (loading || (hits !== null && hits.length >= 0) || error !== null),
    [open, q, loading, hits, error]
  );

  return (
    <div ref={containerRef} className="relative flex-1 max-w-xl">
      <div className="relative">
        <span
          aria-hidden
          className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400"
        >
          <svg
            viewBox="0 0 20 20"
            width={16}
            height={16}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinecap="round"
          >
            <circle cx="9" cy="9" r="6" />
            <path d="M14 14l3 3" />
          </svg>
        </span>
        <input
          ref={inputRef}
          type="search"
          inputMode="search"
          autoComplete="off"
          spellCheck={false}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Buscar paciente (nome, email, WA, CPF)"
          aria-label="Buscar paciente"
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls={listboxId}
          aria-autocomplete="list"
          className="w-full pl-9 pr-12 h-10 rounded-lg border border-ink-200 bg-cream-50 text-sm text-ink-800 placeholder:text-ink-400 focus:outline-none focus:border-sage-500 focus:bg-white transition-colors"
        />
        <kbd
          aria-hidden
          className="hidden md:block absolute right-3 top-1/2 -translate-y-1/2 text-[0.68rem] text-ink-400 font-mono bg-ink-50 border border-ink-100 px-1.5 py-0.5 rounded"
        >
          ⌘K
        </kbd>
      </div>

      {showDropdown && (
        <div
          id={listboxId}
          role="listbox"
          className="absolute top-full left-0 right-0 mt-1 bg-white border border-ink-200 rounded-lg shadow-lg max-h-96 overflow-y-auto z-40"
        >
          {loading && (
            <div className="px-4 py-3 text-sm text-ink-500">
              Buscando…
            </div>
          )}
          {error && !loading && (
            <div className="px-4 py-3 text-sm text-terracotta-700">
              Erro na busca: {error}
            </div>
          )}
          {!loading && !error && hits && hits.length === 0 && (
            <div className="px-4 py-3 text-sm text-ink-500">
              Nenhum paciente encontrado.
            </div>
          )}
          {!loading && !error && hits && hits.length > 0 && (
            <ul>
              {hits.map((h, idx) => {
                const active = idx === activeIdx;
                return (
                  <li key={h.id} role="option" aria-selected={active}>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => selectHit(h)}
                      onMouseEnter={() => setActiveIdx(idx)}
                      className={
                        "w-full text-left px-4 py-2.5 flex items-start gap-3 border-b border-ink-100 last:border-0 transition-colors " +
                        (active ? "bg-sage-50" : "bg-white hover:bg-cream-100")
                      }
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-ink-800 truncate">
                          {h.name}
                        </div>
                        <div className="text-[0.78rem] text-ink-500 flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
                          <span className="truncate">{h.email}</span>
                          <span>{h.phone}</span>
                          <span className="font-mono">{h.cpfMasked}</span>
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
