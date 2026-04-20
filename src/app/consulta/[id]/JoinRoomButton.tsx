"use client";

import { useEffect, useState } from "react";

const ENTRY_BEFORE_MIN = 30;
const ENTRY_AFTER_MIN = 30;

type Props = {
  appointmentId: string;
  token: string;
  scheduledAtIso: string;
  durationMinutes: number;
};

function fmtCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}d ${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}min`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}min`;
  if (minutes > 0) return `${minutes}min ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

export function JoinRoomButton({
  appointmentId,
  token,
  scheduledAtIso,
  durationMinutes,
}: Props) {
  const scheduledMs = new Date(scheduledAtIso).getTime();
  const opensAtMs = scheduledMs - ENTRY_BEFORE_MIN * 60_000;
  const closesAtMs = scheduledMs + (durationMinutes + ENTRY_AFTER_MIN) * 60_000;

  const [now, setNow] = useState<number>(Date.now());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const isOpen = now >= opensAtMs && now <= closesAtMs;
  const isClosed = now > closesAtMs;
  const untilOpen = opensAtMs - now;

  async function handleClick() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/paciente/appointments/${appointmentId}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        url?: string;
        error?: string;
        message?: string;
      };
      if (!res.ok || !data.ok || !data.url) {
        throw new Error(data.message || data.error || `HTTP ${res.status}`);
      }
      window.location.href = data.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro");
      setSubmitting(false);
    }
  }

  if (isClosed) {
    return (
      <p className="text-sm text-ink-600">
        Janela de entrada encerrada. Se a consulta não aconteceu, fale com a equipe.
      </p>
    );
  }

  if (!isOpen) {
    return (
      <div>
        <button
          type="button"
          disabled
          className="w-full sm:w-auto rounded-full bg-ink-200 text-ink-500 cursor-not-allowed font-medium px-6 py-3.5 text-[0.95rem]"
        >
          Entrar na sala
        </button>
        <p className="mt-3 text-sm text-ink-500" aria-live="polite">
          A sala abre em <strong className="font-mono">{fmtCountdown(untilOpen)}</strong>{" "}
          (30 minutos antes do horário marcado).
        </p>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        disabled={submitting}
        className="w-full sm:w-auto rounded-full bg-sage-700 hover:bg-sage-800 disabled:opacity-50 text-cream-100 font-medium px-7 py-3.5 text-[0.95rem] transition-colors"
      >
        {submitting ? "Abrindo sala…" : "Entrar na sala →"}
      </button>
      <p className="mt-3 text-xs text-ink-400">
        A janela de entrada está aberta. Se cair, basta voltar aqui e clicar de
        novo.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-terracotta-700">
          {error}
        </p>
      )}
    </div>
  );
}
