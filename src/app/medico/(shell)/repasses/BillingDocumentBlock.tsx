"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

type Document = {
  uploadedAt: string | null;
  validatedAt: string | null;
  documentNumber: string | null;
  documentAmountCents: number | null;
};

type Props = {
  payoutId: string;
  amountCents: number;
  canUpload: boolean;
  document: Document | null;
};

function brl(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function fmtDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function BillingDocumentBlock({
  payoutId,
  amountCents,
  canUpload,
  document: doc,
}: Props) {
  const router = useRouter();
  const [uploading, setUploading] = useState(false);
  const [viewing, setViewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const status: "validated" | "awaiting" | "missing" = doc?.validatedAt
    ? "validated"
    : doc
    ? "awaiting"
    : "missing";

  const statusBadge = {
    validated: {
      label: "NF validada",
      cls: "bg-sage-50 text-sage-800 border-sage-200",
    },
    awaiting: {
      label: "NF enviada — aguardando validação",
      cls: "bg-terracotta-50 text-terracotta-800 border-terracotta-200",
    },
    missing: {
      label: "NF pendente",
      cls: "bg-ink-50 text-ink-700 border-ink-200",
    },
  }[status];

  async function handleView() {
    setViewing(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/medico/payouts/${payoutId}/billing-document`
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        url?: string;
        error?: string;
        message?: string;
      };
      if (!res.ok || !data.ok || !data.url) {
        throw new Error(data.message || data.error || "Falha ao abrir NF.");
      }
      window.open(data.url, "_blank", "noopener");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro");
    } finally {
      setViewing(false);
    }
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!formRef.current) return;
    const formData = new FormData(formRef.current);
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      setError("Selecione um arquivo.");
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/medico/payouts/${payoutId}/billing-document`,
        { method: "POST", body: formData }
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        message?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.message || data.error || "Falha no upload.");
      }
      setShowForm(false);
      formRef.current.reset();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro");
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete() {
    if (
      !window.confirm(
        "Remover a NF enviada? Você poderá subir outra em seguida."
      )
    ) {
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/medico/payouts/${payoutId}/billing-document`,
        { method: "DELETE" }
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        message?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.message || data.error || "Falha ao remover.");
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro");
    } finally {
      setUploading(false);
    }
  }

  return (
    <section className="mt-4 pt-4 border-t border-ink-100">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div>
          <p className="text-[0.78rem] uppercase tracking-[0.14em] text-ink-500 font-medium">
            Nota Fiscal
          </p>
          <span
            className={`mt-2 inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border ${statusBadge.cls}`}
          >
            {statusBadge.label}
          </span>
        </div>
        {doc && (
          <button
            type="button"
            onClick={handleView}
            disabled={viewing}
            className="text-sm font-medium text-sage-700 hover:text-sage-800 hover:underline disabled:opacity-50"
          >
            {viewing ? "Abrindo…" : "Ver NF →"}
          </button>
        )}
      </div>

      {doc && (
        <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5 text-sm mb-3">
          {doc.documentNumber && (
            <div className="flex justify-between gap-3">
              <dt className="text-ink-500">Número</dt>
              <dd className="text-ink-800 font-mono">{doc.documentNumber}</dd>
            </div>
          )}
          {doc.documentAmountCents != null && (
            <div className="flex justify-between gap-3">
              <dt className="text-ink-500">Valor NF</dt>
              <dd
                className={`font-mono ${
                  doc.documentAmountCents !== amountCents
                    ? "text-terracotta-700"
                    : "text-ink-800"
                }`}
                title={
                  doc.documentAmountCents !== amountCents
                    ? "Diverge do valor do repasse"
                    : undefined
                }
              >
                {brl(doc.documentAmountCents)}
              </dd>
            </div>
          )}
          {doc.uploadedAt && (
            <div className="flex justify-between gap-3">
              <dt className="text-ink-500">Enviada em</dt>
              <dd className="text-ink-800">{fmtDate(doc.uploadedAt)}</dd>
            </div>
          )}
          {doc.validatedAt && (
            <div className="flex justify-between gap-3">
              <dt className="text-ink-500">Validada em</dt>
              <dd className="text-ink-800">{fmtDate(doc.validatedAt)}</dd>
            </div>
          )}
        </dl>
      )}

      {canUpload && !doc && !showForm && (
        <button
          type="button"
          onClick={() => setShowForm(true)}
          className="inline-flex items-center px-4 py-2 rounded-lg bg-ink-800 text-white text-sm font-medium hover:bg-ink-900 transition-colors"
        >
          Enviar NF-e
        </button>
      )}

      {doc && !doc.validatedAt && !showForm && canUpload && (
        <div className="flex gap-3 text-sm">
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="text-ink-700 hover:text-ink-900 hover:underline font-medium"
            disabled={uploading}
          >
            Substituir NF
          </button>
          <span className="text-ink-300">·</span>
          <button
            type="button"
            onClick={handleDelete}
            disabled={uploading}
            className="text-terracotta-700 hover:text-terracotta-800 hover:underline font-medium disabled:opacity-50"
          >
            Remover
          </button>
        </div>
      )}

      {showForm && (
        <form
          ref={formRef}
          onSubmit={handleSubmit}
          className="mt-3 rounded-xl bg-cream-50 border border-ink-100 p-4 space-y-3"
        >
          <div>
            <label className="block text-xs font-medium text-ink-600 mb-1">
              Arquivo (PDF, XML, PNG, JPG — até 5 MB)
            </label>
            <input
              name="file"
              type="file"
              accept="application/pdf,application/xml,text/xml,image/png,image/jpeg,image/webp"
              required
              className="block w-full text-sm text-ink-800 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:bg-ink-800 file:text-white file:text-sm file:font-medium hover:file:bg-ink-900"
            />
          </div>
          <div className="grid sm:grid-cols-3 gap-3">
            <label className="block">
              <span className="block text-xs font-medium text-ink-600 mb-1">
                Número (opcional)
              </span>
              <input
                name="document_number"
                type="text"
                placeholder="Ex.: 123/NFS"
                className="w-full rounded-md border border-ink-200 bg-white px-3 py-1.5 text-sm"
              />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-ink-600 mb-1">
                Emitida em (opcional)
              </span>
              <input
                name="issued_at"
                type="date"
                className="w-full rounded-md border border-ink-200 bg-white px-3 py-1.5 text-sm"
              />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-ink-600 mb-1">
                Valor da NF em centavos (opcional)
              </span>
              <input
                name="document_amount_cents"
                type="number"
                step="1"
                min="0"
                placeholder={String(amountCents)}
                className="w-full rounded-md border border-ink-200 bg-white px-3 py-1.5 text-sm font-mono"
              />
            </label>
          </div>
          <div className="flex gap-3 pt-1">
            <button
              type="submit"
              disabled={uploading}
              className="inline-flex items-center px-4 py-2 rounded-lg bg-ink-800 text-white text-sm font-medium hover:bg-ink-900 disabled:opacity-50"
            >
              {uploading ? "Enviando…" : "Enviar"}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowForm(false);
                setError(null);
              }}
              disabled={uploading}
              className="text-sm font-medium text-ink-600 hover:text-ink-800"
            >
              Cancelar
            </button>
          </div>
        </form>
      )}

      {error && (
        <p role="alert" className="mt-2 text-xs text-terracotta-700">
          {error}
        </p>
      )}
    </section>
  );
}
