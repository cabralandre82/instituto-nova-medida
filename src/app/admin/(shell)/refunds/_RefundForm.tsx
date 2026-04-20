"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function RefundForm({
  appointmentId,
  defaultNotes = "",
}: {
  appointmentId: string;
  defaultNotes?: string;
}) {
  const router = useRouter();
  const [externalRef, setExternalRef] = useState("");
  const [notes, setNotes] = useState(defaultNotes);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(
        `/api/admin/appointments/${appointmentId}/refund`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            external_ref: externalRef.trim() || undefined,
            notes: notes.trim() || undefined,
          }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      setMsg({
        kind: "ok",
        text: data.already_processed
          ? "Já havia sido registrado."
          : "Registrado.",
      });
      router.refresh();
    } catch (e) {
      setMsg({
        kind: "err",
        text: e instanceof Error ? e.message : "Erro",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <label className="block text-[0.7rem] uppercase tracking-[0.12em] text-ink-500 font-medium mb-1">
          Referência externa
        </label>
        <input
          type="text"
          value={externalRef}
          onChange={(e) => setExternalRef(e.target.value)}
          placeholder="rf_xxx ou end-to-end PIX"
          className="w-full rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-sage-500"
        />
        <p className="mt-1 text-[0.7rem] text-ink-400">
          Opcional, mas recomendado pra auditoria.
        </p>
      </div>
      <div>
        <label className="block text-[0.7rem] uppercase tracking-[0.12em] text-ink-500 font-medium mb-1">
          Notas
        </label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="ex: paciente aceitou crédito pra reagendar"
          className="w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sage-500"
        />
      </div>
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-xl bg-sage-700 hover:bg-sage-800 disabled:opacity-50 text-white font-medium py-2 px-4 text-sm transition-colors"
      >
        {busy ? "Registrando..." : "Registrar estorno processado"}
      </button>
      {msg && (
        <p
          className={`text-sm ${
            msg.kind === "ok" ? "text-sage-700" : "text-terracotta-700"
          }`}
        >
          {msg.text}
        </p>
      )}
    </form>
  );
}
