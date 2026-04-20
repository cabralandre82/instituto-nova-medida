"use client";

import { useState } from "react";

type Props = {
  appointmentId: string;
  /**
   * "primary" para a próxima consulta (botão preto destacado),
   * "ghost" para os demais (link discreto).
   */
  variant?: "primary" | "ghost";
  disabled?: boolean;
  disabledReason?: string;
};

export function JoinButton({
  appointmentId,
  variant = "primary",
  disabled,
  disabledReason,
}: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    if (disabled) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/medico/appointments/${appointmentId}/join`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        url?: string;
        error?: string;
        message?: string;
      };
      if (!res.ok || !data.ok || !data.url) {
        throw new Error(data.message || data.error || "Falha ao abrir a sala.");
      }
      window.open(data.url, "_blank", "noopener");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro inesperado.");
    } finally {
      setSubmitting(false);
    }
  }

  if (disabled) {
    return (
      <span className="inline-flex items-center gap-2 text-sm text-ink-400" title={disabledReason}>
        {disabledReason ?? "Indisponível"}
      </span>
    );
  }

  if (variant === "ghost") {
    return (
      <div className="flex flex-col items-end gap-1">
        <button
          type="button"
          onClick={handleClick}
          disabled={submitting}
          className="text-sm font-medium text-sage-700 hover:text-sage-800 hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? "Abrindo…" : "Entrar na sala →"}
        </button>
        {error && (
          <span role="alert" className="text-xs text-terracotta-700">
            {error}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={submitting}
        className="inline-flex items-center gap-2 rounded-xl bg-ink-800 hover:bg-ink-900 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium px-5 py-2.5 transition-colors"
      >
        {submitting ? "Abrindo sala…" : "Entrar na sala"}
      </button>
      {error && (
        <span role="alert" className="text-sm text-terracotta-700">
          {error}
        </span>
      )}
    </div>
  );
}
