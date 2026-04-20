"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  payoutId: string;
  /** Valor cru de `doctor_payouts.pix_proof_url` (storage path OU URL externa OU null). */
  rawValue: string | null;
};

function describe(rawValue: string): string {
  if (rawValue.startsWith("payouts/")) {
    const tail = rawValue.split("/").pop() ?? rawValue;
    // remove o prefixo de timestamp (15 chars + hífen)
    return tail.replace(/^\d{8}T\d{6}-/, "");
  }
  // URL externa
  try {
    return new URL(rawValue).hostname;
  } catch {
    return "comprovante externo";
  }
}

export function ProofPanel({ payoutId, rawValue }: Props) {
  const router = useRouter();
  const [opening, setOpening] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!rawValue) {
    return (
      <section className="rounded-2xl bg-white border border-ink-100 p-5">
        <h3 className="font-serif text-[1rem] text-ink-800 mb-2">Comprovante</h3>
        <p className="text-sm text-ink-500">
          Nenhum comprovante anexado. Envie no momento de confirmar o recebimento.
        </p>
      </section>
    );
  }

  async function handleOpen() {
    setOpening(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/payouts/${payoutId}/proof`, { method: "GET" });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        url?: string;
        error?: string;
        message?: string;
      };
      if (!res.ok || !data.ok || !data.url) {
        throw new Error(data.message || data.error || "Falha ao abrir");
      }
      window.open(data.url, "_blank", "noopener");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro");
    } finally {
      setOpening(false);
    }
  }

  async function handleRemove() {
    if (!confirm("Remover este comprovante? A operação não é reversível.")) return;
    setRemoving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/payouts/${payoutId}/proof`, { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro");
    } finally {
      setRemoving(false);
    }
  }

  const isStorage = rawValue.startsWith("payouts/");

  return (
    <section className="rounded-2xl bg-white border border-ink-100 p-5">
      <h3 className="font-serif text-[1rem] text-ink-800 mb-3">Comprovante</h3>
      <p className="text-sm text-ink-700 mb-3 break-all">
        <span className="text-ink-400 mr-1">{isStorage ? "Arquivo:" : "URL externa:"}</span>
        {describe(rawValue)}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleOpen}
          disabled={opening || removing}
          className="rounded-xl bg-ink-800 hover:bg-ink-900 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 transition-colors"
        >
          {opening ? "Abrindo…" : "Abrir comprovante"}
        </button>
        <button
          type="button"
          onClick={handleRemove}
          disabled={opening || removing}
          className="rounded-xl border border-terracotta-300 text-terracotta-700 hover:bg-terracotta-50 disabled:opacity-50 text-sm font-medium px-4 py-2 transition-colors"
        >
          {removing ? "Removendo…" : "Remover"}
        </button>
      </div>
      {isStorage && (
        <p className="mt-3 text-xs text-ink-400">
          Link gerado sob demanda, expira em 60 segundos.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-terracotta-700">
          {error}
        </p>
      )}
    </section>
  );
}
