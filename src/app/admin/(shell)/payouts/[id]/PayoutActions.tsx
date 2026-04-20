"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Status = "draft" | "approved" | "pix_sent" | "confirmed" | "cancelled" | "failed";

const ACCEPT_MIMES = "application/pdf,image/png,image/jpeg,image/webp";
const MAX_BYTES = 5 * 1024 * 1024;

export function PayoutActions({
  payoutId,
  status,
  hasPix,
  amountCents,
}: {
  payoutId: string;
  status: Status;
  hasPix: boolean;
  amountCents: number;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [txId, setTxId] = useState("");
  const [notes, setNotes] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function call(action: string, body?: Record<string, unknown>) {
    setSubmitting(action);
    setMsg(null);
    try {
      const res = await fetch(`/api/admin/payouts/${payoutId}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setMsg({ kind: "ok", text: "Atualizado." });
      router.refresh();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "Erro" });
    } finally {
      setSubmitting(null);
    }
  }

  async function uploadProof(file: File): Promise<boolean> {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`/api/admin/payouts/${payoutId}/proof`, {
      method: "POST",
      body: fd,
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      message?: string;
    };
    if (!res.ok || !data.ok) {
      throw new Error(data.message || data.error || `HTTP ${res.status}`);
    }
    return true;
  }

  async function handleConfirm() {
    setSubmitting("confirm");
    setMsg(null);
    try {
      if (proofFile) {
        if (proofFile.size > MAX_BYTES) {
          throw new Error("Arquivo maior que 5 MB.");
        }
        await uploadProof(proofFile);
      }
      const res = await fetch(`/api/admin/payouts/${payoutId}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notes: notes.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setMsg({ kind: "ok", text: "Recebimento confirmado." });
      setProofFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      router.refresh();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "Erro" });
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <section className="rounded-2xl bg-white border border-ink-100 p-5">
      <h3 className="font-serif text-[1rem] text-ink-800 mb-4">Ações</h3>

      {status === "draft" && (
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => call("approve")}
            disabled={submitting !== null}
            className="w-full rounded-xl bg-sage-700 hover:bg-sage-800 disabled:opacity-50 text-white font-medium py-2.5 px-4 transition-colors"
          >
            {submitting === "approve" ? "Aprovando..." : "Aprovar repasse"}
          </button>
          <button
            type="button"
            onClick={() => call("cancel", { reason: prompt("Motivo do cancelamento?") || undefined })}
            disabled={submitting !== null}
            className="w-full rounded-xl border border-terracotta-300 text-terracotta-700 hover:bg-terracotta-50 disabled:opacity-50 font-medium py-2.5 px-4 transition-colors"
          >
            Cancelar
          </button>
        </div>
      )}

      {status === "approved" && (
        <div className="space-y-3">
          {!hasPix ? (
            <p className="text-sm text-terracotta-700">
              Cadastre o PIX da médica antes de marcar o pagamento.
            </p>
          ) : (
            <>
              <p className="text-sm text-ink-600">
                Faça o PIX manualmente no seu banco. Depois cole o ID da
                transação aqui:
              </p>
              <input
                type="text"
                value={txId}
                onChange={(e) => setTxId(e.target.value)}
                placeholder="ID da transação PIX (opcional)"
                className="w-full rounded-xl border border-ink-200 bg-white px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-sage-500"
              />
              <button
                type="button"
                onClick={() => call("pay", { pix_transaction_id: txId.trim() || undefined })}
                disabled={submitting !== null}
                className="w-full rounded-xl bg-ink-800 hover:bg-ink-900 disabled:opacity-50 text-white font-medium py-2.5 px-4 transition-colors"
              >
                {submitting === "pay"
                  ? "Marcando..."
                  : `PIX enviado (${(amountCents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })})`}
              </button>
            </>
          )}
        </div>
      )}

      {status === "pix_sent" && (
        <div className="space-y-3">
          <p className="text-sm text-ink-600">
            Confirme quando a médica avisar que recebeu (ou bater no extrato).
            Anexe o comprovante do banco — fica privado, só você e a médica acessam.
          </p>

          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1.5">
              Comprovante (PDF, PNG, JPG ou WEBP — máx 5 MB)
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT_MIMES}
              onChange={(e) => setProofFile(e.target.files?.[0] ?? null)}
              className="w-full text-sm text-ink-700 file:mr-3 file:rounded-lg file:border-0 file:bg-ink-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink-800 hover:file:bg-ink-200"
            />
            {proofFile && (
              <p className="mt-1 text-xs text-ink-500">
                {proofFile.name} · {(proofFile.size / 1024).toFixed(0)} KB
              </p>
            )}
          </div>

          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notas (opcional)"
            rows={2}
            className="w-full rounded-xl border border-ink-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sage-500"
          />
          <button
            type="button"
            onClick={handleConfirm}
            disabled={submitting !== null}
            className="w-full rounded-xl bg-sage-700 hover:bg-sage-800 disabled:opacity-50 text-white font-medium py-2.5 px-4 transition-colors"
          >
            {submitting === "confirm" ? "Confirmando..." : "Confirmar recebimento"}
          </button>
        </div>
      )}

      {status === "confirmed" && (
        <p className="text-sm text-sage-700">
          ✓ Pagamento concluído. Earnings vinculados estão como{" "}
          <code className="font-mono">paid</code>.
        </p>
      )}

      {status === "cancelled" && (
        <p className="text-sm text-ink-500">
          Repasse cancelado. Os earnings voltaram pra <code>available</code>{" "}
          e entram no próximo lote.
        </p>
      )}

      {msg && (
        <p
          className={`mt-3 text-sm ${msg.kind === "ok" ? "text-sage-700" : "text-terracotta-700"}`}
        >
          {msg.text}
        </p>
      )}
    </section>
  );
}
