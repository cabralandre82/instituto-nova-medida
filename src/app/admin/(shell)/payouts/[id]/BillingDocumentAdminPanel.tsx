"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatCurrencyBRL, formatDateBR } from "@/lib/datetime-br";

type Document = {
  uploadedAt: string | null;
  validatedAt: string | null;
  documentNumber: string | null;
  documentAmountCents: number | null;
  validationNotes: string | null;
};

type Props = {
  payoutId: string;
  amountCents: number;
  document: Document | null;
};

function brl(cents: number): string {
  return formatCurrencyBRL(cents);
}

function fmtDate(iso: string | null): string | null {
  if (!iso) return null;
  return formatDateBR(iso, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function BillingDocumentAdminPanel({
  payoutId,
  amountCents,
  document: doc,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "view" | "validate" | "unvalidate" | "delete">(null);
  const [error, setError] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState<string>(doc?.validationNotes ?? "");

  async function handleView() {
    setBusy("view");
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/payouts/${payoutId}/billing-document`
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
      setBusy(null);
    }
  }

  async function handleValidate(unvalidate: boolean) {
    setBusy(unvalidate ? "unvalidate" : "validate");
    setError(null);
    try {
      const qs = unvalidate ? "?unvalidate=1" : "";
      const res = await fetch(
        `/api/admin/payouts/${payoutId}/billing-document/validate${qs}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            validation_notes: notesDraft.trim() || null,
          }),
        }
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        message?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.message || data.error || "Falha.");
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro");
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete() {
    if (
      !window.confirm(
        "Remover a NF anexada? Médica terá que reenviar."
      )
    ) {
      return;
    }
    setBusy("delete");
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/payouts/${payoutId}/billing-document`,
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
      setBusy(null);
    }
  }

  if (!doc) {
    return (
      <section className="rounded-2xl bg-white border border-ink-100 p-5">
        <h3 className="font-serif text-[1rem] text-ink-800 mb-2">NF-e</h3>
        <p className="text-sm text-ink-500">
          Médica ainda não enviou a nota fiscal deste repasse.
        </p>
      </section>
    );
  }

  const amountMismatch =
    doc.documentAmountCents != null && doc.documentAmountCents !== amountCents;

  return (
    <section className="rounded-2xl bg-white border border-ink-100 p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <h3 className="font-serif text-[1rem] text-ink-800">NF-e</h3>
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${
            doc.validatedAt
              ? "bg-sage-50 text-sage-800 border-sage-200"
              : "bg-terracotta-50 text-terracotta-800 border-terracotta-200"
          }`}
        >
          {doc.validatedAt ? "Validada" : "Aguardando"}
        </span>
      </div>

      <dl className="space-y-1.5 text-sm">
        {doc.documentNumber && (
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-400">
              Número
            </dt>
            <dd className="text-ink-800 font-mono">{doc.documentNumber}</dd>
          </div>
        )}
        {doc.documentAmountCents != null && (
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-400">
              Valor NF
            </dt>
            <dd
              className={`font-mono ${
                amountMismatch ? "text-terracotta-700" : "text-ink-800"
              }`}
              title={
                amountMismatch
                  ? `Repasse é ${brl(amountCents)} — diverge`
                  : undefined
              }
            >
              {brl(doc.documentAmountCents)}
              {amountMismatch && (
                <span className="ml-2 text-xs">(diverge)</span>
              )}
            </dd>
          </div>
        )}
        <div>
          <dt className="text-xs uppercase tracking-wide text-ink-400">
            Enviada em
          </dt>
          <dd className="text-ink-800">{fmtDate(doc.uploadedAt)}</dd>
        </div>
        {doc.validatedAt && (
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-400">
              Validada em
            </dt>
            <dd className="text-ink-800">{fmtDate(doc.validatedAt)}</dd>
          </div>
        )}
      </dl>

      <button
        type="button"
        onClick={handleView}
        disabled={busy === "view"}
        className="mt-3 text-sm font-medium text-sage-700 hover:text-sage-800 hover:underline disabled:opacity-50"
      >
        {busy === "view" ? "Abrindo…" : "Ver NF →"}
      </button>

      <div className="mt-4 pt-4 border-t border-ink-100">
        <label className="block text-xs font-medium text-ink-600 mb-1">
          Observação de validação (opcional)
        </label>
        <textarea
          value={notesDraft}
          onChange={(e) => setNotesDraft(e.target.value)}
          rows={2}
          placeholder="Ex.: valor bate com repasse, CNPJ correto."
          className="w-full rounded-md border border-ink-200 bg-white px-3 py-1.5 text-sm"
        />
        <div className="flex flex-wrap gap-2 mt-3">
          {!doc.validatedAt ? (
            <button
              type="button"
              onClick={() => handleValidate(false)}
              disabled={busy !== null}
              className="inline-flex items-center px-3 py-1.5 rounded-lg bg-sage-700 text-white text-sm font-medium hover:bg-sage-800 disabled:opacity-50"
            >
              {busy === "validate" ? "Validando…" : "Validar NF"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => handleValidate(true)}
              disabled={busy !== null}
              className="inline-flex items-center px-3 py-1.5 rounded-lg bg-cream-100 text-ink-800 border border-ink-200 text-sm font-medium hover:bg-cream-200 disabled:opacity-50"
            >
              {busy === "unvalidate" ? "…" : "Desvalidar"}
            </button>
          )}
          <button
            type="button"
            onClick={handleDelete}
            disabled={busy !== null}
            className="inline-flex items-center px-3 py-1.5 rounded-lg bg-white text-terracotta-700 border border-terracotta-200 text-sm font-medium hover:bg-terracotta-50 disabled:opacity-50"
          >
            {busy === "delete" ? "…" : "Remover"}
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-3 text-xs text-terracotta-700">
          {error}
        </p>
      )}
    </section>
  );
}
