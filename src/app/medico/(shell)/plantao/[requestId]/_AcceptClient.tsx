"use client";

/**
 * AcceptClient — PR-080 · D-092
 *
 * Botão "Aceitar atendimento" + countdown da expiração. Faz POST em
 * /api/medico/on-demand/[id]/accept e redireciona pra sala da
 * consulta.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type AcceptResponse =
  | { ok: true; appointmentId: string; salaUrl: string }
  | { ok: false; error: string };

export function AcceptClient({
  requestId,
  initialSecondsUntilExpiry,
}: {
  requestId: string;
  initialSecondsUntilExpiry: number;
}) {
  const router = useRouter();
  const [secondsLeft, setSecondsLeft] = useState(initialSecondsUntilExpiry);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [terminal, setTerminal] = useState<
    null | "expired" | "already_accepted" | "already_cancelled"
  >(null);

  useEffect(() => {
    const t = setInterval(() => {
      setSecondsLeft((s) => {
        const next = Math.max(0, s - 1);
        if (next <= 0) setTerminal((cur) => cur ?? "expired");
        return next;
      });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  async function handleAccept() {
    if (submitting || terminal) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/medico/on-demand/${encodeURIComponent(requestId)}/accept`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ durationMinutes: 30 }),
        }
      );
      const data = (await res.json().catch(() => null)) as AcceptResponse | null;
      if (!res.ok || !data || !data.ok) {
        const code = (data as { error?: string } | null)?.error ?? "internal";
        if (code === "already_accepted") setTerminal("already_accepted");
        else if (code === "already_cancelled") setTerminal("already_cancelled");
        else if (code === "expired") setTerminal("expired");
        else setError("Não foi possível aceitar agora. Tente em instantes.");
        return;
      }
      router.push(data.salaUrl);
    } catch {
      setError("Falha de rede.");
    } finally {
      setSubmitting(false);
    }
  }

  if (terminal === "already_accepted") {
    return (
      <div className="rounded-xl border border-ink-200 bg-cream-50 px-4 py-3 text-sm text-ink-700">
        Outra médica acabou de aceitar este paciente.
      </div>
    );
  }
  if (terminal === "already_cancelled") {
    return (
      <div className="rounded-xl border border-ink-200 bg-cream-50 px-4 py-3 text-sm text-ink-700">
        O paciente cancelou enquanto você confirmava.
      </div>
    );
  }
  if (terminal === "expired") {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        Esta solicitação expirou. O paciente já não está mais aguardando.
      </div>
    );
  }

  const mm = Math.floor(secondsLeft / 60);
  const ss = secondsLeft % 60;
  const display = `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-terracotta-200 bg-terracotta-50/60 px-4 py-3 flex items-center justify-between gap-3">
        <p className="text-sm text-terracotta-800">
          Tempo restante pra aceitar
        </p>
        <p className="font-serif text-[1.4rem] tabular-nums text-ink-800">
          {display}
        </p>
      </div>

      <button
        type="button"
        onClick={handleAccept}
        disabled={submitting}
        className="w-full inline-flex items-center justify-center gap-2 rounded-full bg-sage-700 hover:bg-sage-800 text-cream-50 font-medium px-7 py-3 text-[1rem] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {submitting ? "Abrindo sala…" : "Aceitar e abrir sala"}
      </button>

      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      <p className="text-xs text-ink-500 leading-relaxed">
        Ao aceitar, criamos um atendimento on-demand (gratuito nesta
        etapa) e te direcionamos para a sala. Sua presença muda
        automaticamente para &ldquo;em consulta&rdquo;.
      </p>
    </div>
  );
}
