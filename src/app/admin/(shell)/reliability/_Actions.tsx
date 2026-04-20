"use client";

/**
 * Ações inline da página /admin/reliability (D-036):
 *
 *   - kind="pause"    → pausa manual de uma médica (prompt pede motivo)
 *   - kind="unpause"  → reativa médica pausada (prompt pede notas, opcionais)
 *   - kind="dismiss"  → dispensa um evento específico (prompt pede motivo)
 *
 * Uso de window.prompt() a-propósito: o volume dessas ações é baixo
 * (~1-2/mês), o texto é curto, e dá feedback imediato sem precisar de
 * modal dedicado. Se virar recorrente, refatorar pra modal com
 * textarea maior e preview.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

type Kind = "pause" | "unpause" | "dismiss";

type Props =
  | { kind: "pause"; doctorId: string; doctorName: string }
  | { kind: "unpause"; doctorId: string; doctorName: string }
  | { kind: "dismiss"; eventId: string };

export function ReliabilityActions(props: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (busy) return;
    setErr(null);

    let url: string;
    let body: Record<string, unknown>;
    let confirmMsg: string;

    if (props.kind === "pause") {
      const reason = window.prompt(
        `Pausar ${props.doctorName}?\n\nMotivo (mín. 4 caracteres):`,
        ""
      );
      if (!reason || reason.trim().length < 4) {
        if (reason !== null) setErr("Motivo muito curto.");
        return;
      }
      url = `/api/admin/doctors/${props.doctorId}/reliability/pause`;
      body = { reason: reason.trim(), until_reviewed: true };
      confirmMsg = "";
    } else if (props.kind === "unpause") {
      const notes = window.prompt(
        `Reativar ${props.doctorName}?\n\nNotas sobre a reativação (opcional, mas recomendado):`,
        ""
      );
      if (notes === null) return; // cancelou
      url = `/api/admin/doctors/${props.doctorId}/reliability/unpause`;
      body = notes.trim() ? { notes: notes.trim() } : {};
      confirmMsg = "";
    } else {
      const reason = window.prompt(
        "Dispensar este evento?\n\nMotivo (mín. 4 caracteres):",
        ""
      );
      if (!reason || reason.trim().length < 4) {
        if (reason !== null) setErr("Motivo muito curto.");
        return;
      }
      url = `/api/admin/reliability/events/${props.eventId}/dismiss`;
      body = { reason: reason.trim() };
      confirmMsg = "";
    }

    if (confirmMsg && !window.confirm(confirmMsg)) return;

    setBusy(true);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.ok) {
        setErr(json?.error ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const label =
    props.kind === "pause"
      ? "Pausar"
      : props.kind === "unpause"
      ? "Reativar"
      : "Dispensar";

  const classes =
    props.kind === "unpause"
      ? "bg-sage-700 hover:bg-sage-800 text-white"
      : props.kind === "pause"
      ? "bg-terracotta-700 hover:bg-terracotta-800 text-white"
      : "border border-ink-200 text-ink-700 hover:bg-cream-100";

  return (
    <div className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className={`rounded-lg ${classes} disabled:opacity-50 px-3 py-1.5 text-xs font-medium transition-colors`}
      >
        {busy ? "..." : label}
      </button>
      {err && (
        <p className="text-[0.7rem] text-terracotta-700 max-w-[180px] text-right">
          {err}
        </p>
      )}
    </div>
  );
}
