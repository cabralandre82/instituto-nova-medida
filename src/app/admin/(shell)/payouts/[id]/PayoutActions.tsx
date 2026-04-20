"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Status = "draft" | "approved" | "pix_sent" | "confirmed" | "cancelled" | "failed";

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
  const [proofUrl, setProofUrl] = useState("");
  const [txId, setTxId] = useState("");
  const [notes, setNotes] = useState("");

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
            Anexe link do comprovante se quiser.
          </p>
          <input
            type="url"
            value={proofUrl}
            onChange={(e) => setProofUrl(e.target.value)}
            placeholder="URL do comprovante (opcional)"
            className="w-full rounded-xl border border-ink-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sage-500"
          />
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notas (opcional)"
            rows={2}
            className="w-full rounded-xl border border-ink-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sage-500"
          />
          <button
            type="button"
            onClick={() =>
              call("confirm", {
                pix_proof_url: proofUrl.trim() || undefined,
                notes: notes.trim() || undefined,
              })
            }
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
