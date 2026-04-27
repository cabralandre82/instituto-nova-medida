"use client";

/**
 * PendingRequestsClient — PR-080 · D-092
 *
 * Lista polled da fila on-demand. Cada item tem:
 *   - chiefComplaintShort (≤120 chars já truncado pelo server)
 *   - pacienteFirstName
 *   - tempo de espera (idade do request)
 *   - countdown pra expiração
 *   - botão "Aceitar" → POST /api/medico/on-demand/<id>/accept
 *
 * Polling: 3s. Se nenhum request pending, mostra estado vazio
 * neutro ("Sem solicitações pendentes agora").
 *
 * Race-handling: se médica clicar "Aceitar" mas outra ganhou primeiro,
 * mostra toast "outra médica aceitou" e remove o item da lista.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const POLL_INTERVAL_MS = 3_000;

type RequestItem = {
  id: string;
  pacienteFirstName: string;
  chiefComplaintShort: string;
  createdAt: string;
  expiresAt: string;
  secondsUntilExpiry: number;
  dispatchedToMe: boolean;
};

type ListResponse =
  | { ok: true; requests: RequestItem[] }
  | { ok: false; error: string };

type AcceptResponse =
  | { ok: true; appointmentId: string; salaUrl: string }
  | { ok: false; error: string };

export function PendingRequestsClient() {
  const router = useRouter();
  const [items, setItems] = useState<RequestItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [accepting, setAccepting] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch("/api/medico/on-demand/list", {
          cache: "no-store",
        });
        const data = (await res.json().catch(() => null)) as ListResponse | null;
        if (cancelled) return;
        if (!data || data.ok === false) {
          setLoaded(true);
          return;
        }
        setItems(data.requests);
        setLoaded(true);
      } catch {
        // Ignora — próximo tick.
      }
    }
    poll();
    pollTimer.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, []);

  async function handleAccept(id: string) {
    if (accepting) return;
    setAccepting(id);
    setToast(null);
    try {
      const res = await fetch(
        `/api/medico/on-demand/${encodeURIComponent(id)}/accept`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ durationMinutes: 30 }),
        }
      );
      const data = (await res.json().catch(() => null)) as AcceptResponse | null;
      if (!res.ok || !data || !data.ok) {
        const code = (data as { error?: string } | null)?.error ?? "internal";
        if (code === "already_accepted") {
          setToast("Outra médica acabou de aceitar este paciente.");
        } else if (code === "expired") {
          setToast("Este pedido acabou de expirar.");
        } else if (code === "already_cancelled") {
          setToast("O paciente cancelou enquanto você clicava.");
        } else {
          setToast("Não foi possível aceitar agora. Tente o próximo da lista.");
        }
        // remove o item localmente; próximo poll confirma
        setItems((arr) => arr.filter((it) => it.id !== id));
        return;
      }
      // Sucesso — vai pra sala da consulta.
      router.push(data.salaUrl);
    } catch {
      setToast("Falha de rede. Tente de novo.");
    } finally {
      setAccepting(null);
    }
  }

  return (
    <section className="rounded-2xl bg-white border border-ink-100 p-5 sm:p-6 min-h-[260px]">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="font-serif text-[1.2rem] text-ink-800">
          Fila on-demand{" "}
          {items.length > 0 && (
            <span className="text-ink-400 text-sm font-sans">
              ({items.length})
            </span>
          )}
        </h2>
        <p className="text-xs text-ink-400">Atualiza a cada 3s</p>
      </div>

      {toast && (
        <div
          role="status"
          className="mb-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900"
        >
          {toast}
        </div>
      )}

      {!loaded ? (
        <p className="text-sm text-ink-400">Carregando…</p>
      ) : items.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-ink-500">Sem solicitações no momento.</p>
          <p className="mt-2 text-xs text-ink-400 leading-relaxed max-w-sm mx-auto">
            Quando algum paciente solicitar atendimento agora, aparecerá
            aqui — você também recebe um WhatsApp avisando.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((it) => (
            <RequestCard
              key={it.id}
              item={it}
              onAccept={() => handleAccept(it.id)}
              busy={accepting !== null}
              accepting={accepting === it.id}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function RequestCard({
  item,
  onAccept,
  busy,
  accepting,
}: {
  item: RequestItem;
  onAccept: () => void;
  busy: boolean;
  accepting: boolean;
}) {
  const [secondsLeft, setSecondsLeft] = useState(item.secondsUntilExpiry);

  useEffect(() => {
    setSecondsLeft(item.secondsUntilExpiry);
  }, [item.secondsUntilExpiry]);

  useEffect(() => {
    const t = setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1));
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const ageSec = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(item.createdAt)) / 1000)
  );
  const ageStr = formatAge(ageSec);
  const ttlStr = formatTtl(secondsLeft);

  return (
    <li className="rounded-xl border border-ink-100 bg-cream-50 px-4 py-3.5 flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-[0.95rem] font-medium text-ink-800">
            {item.pacienteFirstName}
          </p>
          {item.dispatchedToMe && (
            <span className="text-[0.7rem] uppercase tracking-wider text-sage-700 bg-sage-50 border border-sage-200 px-1.5 py-0.5 rounded">
              Te avisei
            </span>
          )}
          <span className="text-xs text-ink-400">há {ageStr}</span>
        </div>
        <p className="mt-1 text-sm text-ink-700 leading-snug break-words">
          {item.chiefComplaintShort}
        </p>
        <p className="mt-1 text-xs text-ink-400">expira em {ttlStr}</p>
      </div>

      <button
        type="button"
        onClick={onAccept}
        disabled={busy}
        className="shrink-0 inline-flex items-center justify-center gap-2 rounded-full bg-sage-700 hover:bg-sage-800 text-cream-50 text-sm font-medium px-4 py-2 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {accepting ? "Abrindo…" : "Aceitar"}
      </button>
    </li>
  );
}

function formatAge(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${s > 0 ? ` ${s}s` : ""}`;
}

function formatTtl(sec: number): string {
  if (sec <= 0) return "agora";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
