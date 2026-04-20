"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

const KIND_OPTIONS = [
  { value: "", label: "Todos os tipos" },
  { value: "confirmacao", label: "Confirmação" },
  { value: "t_minus_24h", label: "Lembrete T-24h" },
  { value: "t_minus_1h", label: "Lembrete T-1h" },
  { value: "t_minus_15min", label: "Link da sala (T-15min)" },
  { value: "t_plus_10min", label: "Pós-consulta (T+10min)" },
  { value: "pos_consulta", label: "Pós-consulta" },
  { value: "reserva_expirada", label: "Reserva expirada" },
  { value: "on_demand_call", label: "Fila on-demand" },
  { value: "no_show_patient", label: "No-show paciente" },
  { value: "no_show_doctor", label: "No-show médica" },
];

const STATUS_OPTIONS = [
  { value: "all", label: "Todos os status" },
  { value: "failed", label: "Falhou" },
  { value: "pending", label: "Pendente" },
  { value: "sent", label: "Enviada" },
  { value: "delivered", label: "Entregue" },
  { value: "read", label: "Lida" },
];

export function NotificationFilters({
  status,
  kind,
  appointment,
}: {
  status: string;
  kind: string;
  appointment: string;
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const [localAppt, setLocalAppt] = useState(appointment);

  function push(next: { status?: string; kind?: string; appointment?: string }) {
    const qs = new URLSearchParams(sp?.toString() ?? "");
    qs.delete("page");
    if (next.status !== undefined) {
      if (next.status === "all" || !next.status) qs.delete("status");
      else qs.set("status", next.status);
    }
    if (next.kind !== undefined) {
      if (!next.kind) qs.delete("kind");
      else qs.set("kind", next.kind);
    }
    if (next.appointment !== undefined) {
      if (!next.appointment) qs.delete("appointment");
      else qs.set("appointment", next.appointment);
    }
    router.push(`/admin/notifications?${qs.toString()}`);
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        push({ appointment: localAppt.trim() });
      }}
      className="mb-6 flex flex-wrap gap-3 items-end"
    >
      <div>
        <label className="block text-[0.7rem] uppercase tracking-[0.12em] text-ink-500 font-medium mb-1">
          Status
        </label>
        <select
          value={status}
          onChange={(e) => push({ status: e.target.value })}
          className="rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-sage-500"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-[0.7rem] uppercase tracking-[0.12em] text-ink-500 font-medium mb-1">
          Tipo
        </label>
        <select
          value={kind}
          onChange={(e) => push({ kind: e.target.value })}
          className="rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-sage-500"
        >
          {KIND_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex-1 min-w-[220px]">
        <label className="block text-[0.7rem] uppercase tracking-[0.12em] text-ink-500 font-medium mb-1">
          Appointment (UUID parcial)
        </label>
        <input
          type="text"
          value={localAppt}
          onChange={(e) => setLocalAppt(e.target.value)}
          placeholder="ex: 9e4d2b2"
          className="w-full rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-sage-500"
        />
      </div>
      <button
        type="submit"
        className="rounded-lg bg-ink-800 hover:bg-ink-900 text-white font-medium px-4 py-1.5 text-sm transition-colors"
      >
        Filtrar
      </button>
      {(status !== "all" || kind || appointment) && (
        <button
          type="button"
          onClick={() => {
            setLocalAppt("");
            router.push("/admin/notifications");
          }}
          className="text-sm text-ink-500 hover:text-ink-800 underline"
        >
          limpar
        </button>
      )}
    </form>
  );
}
