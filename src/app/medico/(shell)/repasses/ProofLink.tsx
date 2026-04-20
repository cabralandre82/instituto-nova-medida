"use client";

import { useState } from "react";

export function ProofLink({ payoutId }: { payoutId: string }) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setOpening(true);
    setError(null);
    try {
      const res = await fetch(`/api/medico/payouts/${payoutId}/proof`);
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        url?: string;
        error?: string;
        message?: string;
      };
      if (!res.ok || !data.ok || !data.url) {
        throw new Error(data.message || data.error || "Falha ao abrir comprovante.");
      }
      window.open(data.url, "_blank", "noopener");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro");
    } finally {
      setOpening(false);
    }
  }

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={handleClick}
        disabled={opening}
        className="inline-flex items-center gap-2 text-sm font-medium text-sage-700 hover:text-sage-800 hover:underline disabled:opacity-50"
      >
        {opening ? "Abrindo…" : "Ver comprovante →"}
      </button>
      {error && (
        <p role="alert" className="mt-1 text-xs text-terracotta-700">
          {error}
        </p>
      )}
    </div>
  );
}
