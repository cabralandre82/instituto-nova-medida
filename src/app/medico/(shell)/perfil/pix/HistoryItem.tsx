"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { labelForPixType, type PixKeyType } from "@/lib/doctor-payment-methods";

type Method = {
  id: string;
  pix_key_type: PixKeyType;
  pix_key_masked: string;
  account_holder_name: string;
  created_at: string;
  replaced_at: string;
};

export function HistoryItem({ method }: { method: Method }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (submitting) return;
    const confirmed = window.confirm(
      "Remover esta chave do histórico? Isso não afeta pagamentos já enviados.",
    );
    if (!confirmed) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/medico/payment-methods/${method.id}`, {
        method: "DELETE",
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Falha ao remover.");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro inesperado.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <li className="py-4 flex flex-wrap items-start justify-between gap-4">
      <div>
        <div className="text-[0.8rem] uppercase tracking-wide text-ink-500 font-medium">
          {labelForPixType(method.pix_key_type)}
        </div>
        <div className="text-ink-800 font-mono mt-0.5 break-all">
          {method.pix_key_masked}
        </div>
        <div className="text-xs text-ink-500 mt-1">
          Titular: {method.account_holder_name} · Cadastrada em {method.created_at}
          {method.replaced_at !== "—" && ` · Substituída em ${method.replaced_at}`}
        </div>
        {error && (
          <div className="mt-2 text-sm text-terracotta-700" role="alert">
            {error}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={remove}
        disabled={submitting}
        className="text-sm text-terracotta-700 hover:text-terracotta-800 disabled:opacity-50 underline underline-offset-2"
      >
        {submitting ? "Removendo..." : "Remover"}
      </button>
    </li>
  );
}
