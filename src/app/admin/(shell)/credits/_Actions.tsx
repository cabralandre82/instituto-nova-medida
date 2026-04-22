"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type ConsumeOk = { ok: true; already_consumed: boolean };
type CancelOk = { ok: true; already_cancelled: boolean };
type ApiErr = { ok?: false; code?: string; error?: string };

/**
 * Ações pra um appointment_credit ativo:
 *   - "Marcar como consumido" (exige uuid do novo appointment).
 *   - "Cancelar crédito" (exige razão textual, 4..500 chars).
 *
 * Duas formas dentro do mesmo componente, uma ativa por vez. Mensagem
 * de resultado aparece inline. Em sucesso, `router.refresh()` recarrega
 * o server component pai e a row sai da lista de ativos.
 */
export function CreditActions({
  creditId,
  patientName,
}: {
  creditId: string;
  patientName: string;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"idle" | "consume" | "cancel">("idle");
  const [apptId, setApptId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  function reset() {
    setMode("idle");
    setApptId("");
    setReason("");
    setMsg(null);
  }

  async function handleConsume(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/admin/credits/${creditId}/consume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ consumed_appointment_id: apptId.trim() }),
      });
      const json = (await res.json().catch(() => ({}))) as
        | ConsumeOk
        | ApiErr;
      if (!res.ok || !("ok" in json && json.ok)) {
        const err = json as ApiErr;
        setMsg({
          kind: "err",
          text: err.error ?? `Falhou (HTTP ${res.status}).`,
        });
        setBusy(false);
        return;
      }
      const data = json as ConsumeOk;
      setMsg({
        kind: "ok",
        text: data.already_consumed
          ? "Já estava consumido."
          : "Marcado como consumido.",
      });
      setBusy(false);
      router.refresh();
    } catch (e) {
      setMsg({
        kind: "err",
        text: `Erro de rede: ${e instanceof Error ? e.message : String(e)}`,
      });
      setBusy(false);
    }
  }

  async function handleCancel(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/admin/credits/${creditId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const json = (await res.json().catch(() => ({}))) as
        | CancelOk
        | ApiErr;
      if (!res.ok || !("ok" in json && json.ok)) {
        const err = json as ApiErr;
        setMsg({
          kind: "err",
          text: err.error ?? `Falhou (HTTP ${res.status}).`,
        });
        setBusy(false);
        return;
      }
      const data = json as CancelOk;
      setMsg({
        kind: "ok",
        text: data.already_cancelled
          ? "Já estava cancelado."
          : "Crédito cancelado.",
      });
      setBusy(false);
      router.refresh();
    } catch (e) {
      setMsg({
        kind: "err",
        text: `Erro de rede: ${e instanceof Error ? e.message : String(e)}`,
      });
      setBusy(false);
    }
  }

  if (mode === "idle") {
    return (
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => {
            setMode("consume");
            setMsg(null);
          }}
          className="w-full rounded-xl bg-sage-700 hover:bg-sage-800 text-white font-medium py-2.5 px-4 text-sm transition-colors"
        >
          Marcar como consumido
        </button>
        <button
          type="button"
          onClick={() => {
            setMode("cancel");
            setMsg(null);
          }}
          className="w-full rounded-xl border border-ink-200 hover:bg-cream-50 text-ink-700 font-medium py-2 px-4 text-sm transition-colors"
        >
          Cancelar crédito
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
      </div>
    );
  }

  if (mode === "consume") {
    return (
      <form
        onSubmit={handleConsume}
        className="space-y-3 rounded-xl border border-ink-100 p-3 bg-cream-50"
      >
        <p className="text-[0.7rem] uppercase tracking-[0.12em] text-ink-500 font-medium">
          Consumir crédito
        </p>
        <p className="text-xs text-ink-600">
          Cole o UUID do novo appointment criado pra {patientName}. O crédito
          vira terminal (consumed) e some da lista de ativos.
        </p>
        <div>
          <label className="block text-[0.7rem] uppercase tracking-[0.12em] text-ink-500 font-medium mb-1">
            Appointment id (uuid)
          </label>
          <input
            type="text"
            value={apptId}
            onChange={(e) => setApptId(e.target.value)}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            pattern="^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
            required
            className="w-full rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-sage-500"
          />
        </div>
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={busy}
            className="flex-1 rounded-xl bg-sage-700 hover:bg-sage-800 disabled:opacity-50 text-white font-medium py-2 px-4 text-sm transition-colors"
          >
            {busy ? "Salvando..." : "Confirmar"}
          </button>
          <button
            type="button"
            onClick={reset}
            disabled={busy}
            className="rounded-xl border border-ink-200 hover:bg-cream-50 text-ink-700 text-sm py-2 px-3 transition-colors"
          >
            Voltar
          </button>
        </div>
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

  return (
    <form
      onSubmit={handleCancel}
      className="space-y-3 rounded-xl border border-ink-100 p-3 bg-cream-50"
    >
      <p className="text-[0.7rem] uppercase tracking-[0.12em] text-ink-500 font-medium">
        Cancelar crédito
      </p>
      <p className="text-xs text-ink-600">
        Descarta o direito a reagendamento gratuito pra {patientName}.
        Terminal — não pode voltar a ativar.
      </p>
      <div>
        <label className="block text-[0.7rem] uppercase tracking-[0.12em] text-ink-500 font-medium mb-1">
          Razão (4-500 chars)
        </label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          minLength={4}
          maxLength={500}
          required
          placeholder="ex: paciente avisou que mudou de cidade e não vai reagendar"
          className="w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sage-500"
        />
        <p className="mt-1 text-[0.7rem] text-ink-400">
          Fica registrado em `admin_audit_log` e na própria row pra
          auditoria.
        </p>
      </div>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="flex-1 rounded-xl bg-terracotta-700 hover:bg-terracotta-800 disabled:opacity-50 text-white font-medium py-2 px-4 text-sm transition-colors"
        >
          {busy ? "Cancelando..." : "Cancelar crédito"}
        </button>
        <button
          type="button"
          onClick={reset}
          disabled={busy}
          className="rounded-xl border border-ink-200 hover:bg-cream-50 text-ink-700 text-sm py-2 px-3 transition-colors"
        >
          Voltar
        </button>
      </div>
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
