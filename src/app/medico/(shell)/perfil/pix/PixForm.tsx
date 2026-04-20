"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PIX_KEY_TYPES, type PixKeyType } from "@/lib/doctor-payment-methods";

type Initial = {
  pix_key_type: PixKeyType;
  pix_key: string;
  account_holder_name: string;
  account_holder_cpf_or_cnpj: string;
};

const TYPE_OPTIONS: { value: PixKeyType; label: string; hint: string }[] = [
  { value: "cpf", label: "CPF", hint: "Somente dígitos (11)" },
  { value: "cnpj", label: "CNPJ", hint: "Somente dígitos (14)" },
  { value: "email", label: "E-mail", hint: "email@exemplo.com" },
  { value: "phone", label: "Telefone", hint: "+55DDDNÚMERO" },
  { value: "random", label: "Chave aleatória", hint: "EVP UUID gerada pelo banco" },
];

export function PixForm({ initial }: { initial: Initial | null }) {
  const router = useRouter();
  const [type, setType] = useState<PixKeyType>(initial?.pix_key_type ?? "cpf");
  const [key, setKey] = useState(initial?.pix_key ?? "");
  const [holderName, setHolderName] = useState(initial?.account_holder_name ?? "");
  const [holderDoc, setHolderDoc] = useState(
    initial?.account_holder_cpf_or_cnpj ?? "",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSuccess(false);

    const confirmed = window.confirm(
      initial
        ? "Você vai trocar sua chave PIX. Os próximos repasses vão para a chave nova. Confirma?"
        : "Você vai cadastrar uma nova chave PIX. Confirma?",
    );
    if (!confirmed) return;

    setSubmitting(true);
    try {
      const res = await fetch("/api/medico/payment-methods", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pix_key_type: type,
          pix_key: key,
          account_holder_name: holderName,
          account_holder_cpf_or_cnpj: holderDoc,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        field?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Falha ao salvar.");
      }
      setSuccess(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro inesperado.");
    } finally {
      setSubmitting(false);
    }
  }

  const typeHint = TYPE_OPTIONS.find((o) => o.value === type)?.hint ?? "";

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="grid sm:grid-cols-[200px_1fr] gap-5">
        <div>
          <label
            htmlFor="pix_key_type"
            className="block text-[0.85rem] font-medium text-ink-700 mb-2"
          >
            Tipo de chave
          </label>
          <select
            id="pix_key_type"
            value={type}
            disabled={submitting}
            onChange={(e) => setType(e.target.value as PixKeyType)}
            className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 focus:outline-none focus:ring-2 focus:ring-sage-500 disabled:opacity-50"
          >
            {TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            htmlFor="pix_key"
            className="block text-[0.85rem] font-medium text-ink-700 mb-2"
          >
            Chave
          </label>
          <input
            id="pix_key"
            type="text"
            autoComplete="off"
            disabled={submitting}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={typeHint}
            className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 font-mono placeholder:text-ink-300 focus:outline-none focus:ring-2 focus:ring-sage-500 disabled:opacity-50"
          />
          <p className="mt-1.5 text-xs text-ink-500">{typeHint}</p>
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-5">
        <div>
          <label
            htmlFor="holder_name"
            className="block text-[0.85rem] font-medium text-ink-700 mb-2"
          >
            Titular (nome)
          </label>
          <input
            id="holder_name"
            type="text"
            disabled={submitting}
            value={holderName}
            onChange={(e) => setHolderName(e.target.value)}
            maxLength={120}
            placeholder="Nome completo do titular da chave"
            className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 focus:outline-none focus:ring-2 focus:ring-sage-500 disabled:opacity-50"
          />
        </div>
        <div>
          <label
            htmlFor="holder_doc"
            className="block text-[0.85rem] font-medium text-ink-700 mb-2"
          >
            CPF ou CNPJ do titular
          </label>
          <input
            id="holder_doc"
            type="text"
            inputMode="numeric"
            disabled={submitting}
            value={holderDoc}
            onChange={(e) =>
              setHolderDoc(e.target.value.replace(/\D/g, "").slice(0, 14))
            }
            placeholder="Somente dígitos"
            className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 font-mono focus:outline-none focus:ring-2 focus:ring-sage-500 disabled:opacity-50"
          />
          <p className="mt-1.5 text-xs text-ink-500">
            {holderDoc.length === 11
              ? "CPF"
              : holderDoc.length === 14
                ? "CNPJ"
                : `${holderDoc.length} / 11 ou 14 dígitos`}
          </p>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-[0.92rem] text-terracotta-700">
          {error}
        </p>
      )}
      {success && (
        <p className="text-[0.92rem] text-sage-700">
          Chave salva. Os próximos repasses usam o novo PIX.
        </p>
      )}

      <div className="flex items-center gap-4 pt-2">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-xl bg-ink-800 hover:bg-ink-900 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium py-3 px-6 transition-colors"
        >
          {submitting ? "Salvando..." : initial ? "Trocar chave" : "Cadastrar PIX"}
        </button>
      </div>
    </form>
  );
}
