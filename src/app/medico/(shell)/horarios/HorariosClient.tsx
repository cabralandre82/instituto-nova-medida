"use client";

/**
 * Cliente de /medico/horarios. Estado local espelha resposta da API
 * (mesma forma de `AvailabilityRow`). Otimismo zero — refetch após
 * cada mutação. PR-076 · D-088.
 *
 * Heartbeat: enquanto status = "online" || "busy", dispara
 * `presence/heartbeat` a cada 30s (PRESENCE_HEARTBEAT_INTERVAL).
 * Toggle envia `presence/status`.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  TYPE_LABELS_PT,
  WEEKDAY_LABELS_PT,
  type AvailabilityRow,
  type AvailabilityType,
} from "@/lib/doctor-availability";
import { PRESENCE_HEARTBEAT_INTERVAL_SECONDS } from "@/lib/doctor-presence";

type Status = "online" | "busy" | "offline";

const ERROR_HUMAN: Record<string, string> = {
  weekday_invalid: "Dia da semana inválido.",
  start_time_invalid: "Horário inicial inválido.",
  end_time_invalid: "Horário final inválido.",
  end_before_start: "O horário final precisa ser maior que o inicial.",
  type_invalid: "Tipo de bloco inválido.",
  overlap: "Esse horário se sobrepõe a outro bloco já cadastrado.",
  not_found: "Bloco não encontrado.",
  unsupported_change: "Edição completa não é suportada — apague e crie de novo.",
  internal: "Erro interno. Tente novamente.",
  payload_invalid: "Dados inválidos.",
  id_invalid: "Identificador inválido.",
};

function humanError(code: string | undefined): string {
  if (!code) return "Erro desconhecido.";
  return ERROR_HUMAN[code] ?? code;
}

export function HorariosClient({
  initialBlocks,
  initialPresenceStatus,
}: {
  initialBlocks: AvailabilityRow[];
  initialPresenceStatus: Status;
}) {
  const [blocks, setBlocks] = useState<AvailabilityRow[]>(initialBlocks);
  const [presence, setPresence] = useState<Status>(initialPresenceStatus);
  const [presenceBusy, setPresenceBusy] = useState(false);
  const [presenceError, setPresenceError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/medico/availability", {
        cache: "no-store",
      });
      if (!r.ok) return;
      const j = await r.json();
      if (j?.ok && Array.isArray(j.blocks)) setBlocks(j.blocks);
    } catch {
      /* silencioso */
    }
  }, []);

  // Heartbeat enquanto online/busy
  useEffect(() => {
    if (presence === "offline") return;
    const send = async () => {
      try {
        await fetch("/api/medico/presence/heartbeat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
      } catch {
        /* ignora; cron vai marcar offline se ficar stale */
      }
    };
    send();
    const id = setInterval(send, PRESENCE_HEARTBEAT_INTERVAL_SECONDS * 1000);
    return () => clearInterval(id);
  }, [presence]);

  const togglePresence = useCallback(
    async (next: Status) => {
      setPresenceBusy(true);
      setPresenceError(null);
      try {
        const r = await fetch("/api/medico/presence/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: next }),
        });
        const j = await r.json();
        if (!r.ok || !j?.ok) {
          setPresenceError(humanError(j?.error));
        } else {
          setPresence(next);
        }
      } catch {
        setPresenceError("Falha de rede.");
      } finally {
        setPresenceBusy(false);
      }
    },
    []
  );

  return (
    <div className="space-y-6">
      <PresenceCard
        status={presence}
        busy={presenceBusy}
        error={presenceError}
        onToggle={togglePresence}
      />

      <BlocksCard blocks={blocks} onChanged={refresh} />
    </div>
  );
}

function PresenceCard({
  status,
  busy,
  error,
  onToggle,
}: {
  status: Status;
  busy: boolean;
  error: string | null;
  onToggle: (next: Status) => void;
}) {
  const isOnline = status !== "offline";
  return (
    <section className="bg-white rounded-2xl border border-cream-200 shadow-soft p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="space-y-1 min-w-0">
          <h2 className="text-lg font-semibold text-ink-800">
            Plantão online agora
          </h2>
          <p className="text-[0.9rem] text-ink-600 max-w-md">
            Quando ligado, pacientes podem solicitar consulta imediata.
            Enquanto estiver em consulta, troque para &ldquo;Em atendimento&rdquo;
            para pausar novas solicitações sem ficar offline.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={status} />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onToggle("online")}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
            status === "online"
              ? "bg-emerald-600 text-white"
              : "bg-cream-100 text-ink-700 hover:bg-cream-200"
          } disabled:opacity-50`}
        >
          Online
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onToggle("busy")}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
            status === "busy"
              ? "bg-amber-500 text-white"
              : "bg-cream-100 text-ink-700 hover:bg-cream-200"
          } disabled:opacity-50`}
        >
          Em atendimento
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onToggle("offline")}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
            status === "offline"
              ? "bg-ink-700 text-white"
              : "bg-cream-100 text-ink-700 hover:bg-cream-200"
          } disabled:opacity-50`}
        >
          Offline
        </button>
      </div>

      {error ? (
        <p className="mt-3 text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}

      {isOnline ? (
        <p className="mt-3 text-xs text-ink-500">
          Heartbeat automático a cada {PRESENCE_HEARTBEAT_INTERVAL_SECONDS}s
          enquanto esta tela estiver aberta. Se você fechar, a plataforma
          marca offline em até 2 minutos.
        </p>
      ) : null}
    </section>
  );
}

function StatusBadge({ status }: { status: Status }) {
  const map: Record<Status, { bg: string; label: string }> = {
    online: { bg: "bg-emerald-100 text-emerald-700", label: "Online" },
    busy: { bg: "bg-amber-100 text-amber-700", label: "Em atendimento" },
    offline: { bg: "bg-cream-100 text-ink-600", label: "Offline" },
  };
  const m = map[status];
  return (
    <span
      className={`inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-xs font-medium ${m.bg}`}
    >
      <span
        className={`w-2 h-2 rounded-full ${
          status === "online"
            ? "bg-emerald-500"
            : status === "busy"
            ? "bg-amber-500"
            : "bg-ink-400"
        }`}
      />
      {m.label}
    </span>
  );
}

function BlocksCard({
  blocks,
  onChanged,
}: {
  blocks: AvailabilityRow[];
  onChanged: () => Promise<void>;
}) {
  const grouped = useMemo(() => {
    const m = new Map<number, AvailabilityRow[]>();
    for (const b of blocks) {
      if (!m.has(b.weekday)) m.set(b.weekday, []);
      m.get(b.weekday)!.push(b);
    }
    for (const list of m.values()) {
      list.sort((a, b) => a.start_time.localeCompare(b.start_time));
    }
    return m;
  }, [blocks]);

  return (
    <section className="bg-white rounded-2xl border border-cream-200 shadow-soft p-5 sm:p-6 space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-ink-800">
            Agenda recorrente semanal
          </h2>
          <p className="text-[0.9rem] text-ink-600 max-w-md">
            Adicione blocos por dia da semana. Tipo &ldquo;Consulta agendada&rdquo;
            abre slots no agendamento; &ldquo;Plantão&rdquo; reserva um período
            onde você pretende ficar online para pacientes urgentes.
          </p>
        </div>
      </div>

      <NewBlockForm onCreated={onChanged} />

      <div className="space-y-3">
        {[0, 1, 2, 3, 4, 5, 6].map((wd) => {
          const list = grouped.get(wd) ?? [];
          return (
            <div
              key={wd}
              className="border border-cream-200 rounded-xl p-3 sm:p-4"
            >
              <div className="flex items-center justify-between">
                <h3 className="font-medium text-ink-800">
                  {WEEKDAY_LABELS_PT[wd]}
                </h3>
                <span className="text-xs text-ink-500">
                  {list.filter((b) => b.active).length} ativo(s)
                </span>
              </div>
              {list.length === 0 ? (
                <p className="text-[0.9rem] text-ink-500 mt-2">
                  Nenhum bloco neste dia.
                </p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {list.map((b) => (
                    <BlockRow key={b.id} block={b} onChanged={onChanged} />
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function NewBlockForm({ onCreated }: { onCreated: () => Promise<void> }) {
  const [weekday, setWeekday] = useState<number>(1);
  const [start, setStart] = useState<string>("09:00");
  const [end, setEnd] = useState<string>("12:00");
  const [type, setType] = useState<AvailabilityType>("scheduled");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const r = await fetch("/api/medico/availability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          weekday,
          start_time: start,
          end_time: end,
          type,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j?.ok) {
        setError(humanError(j?.error));
        return;
      }
      setSuccess("Bloco criado.");
      await onCreated();
    } catch {
      setError("Falha de rede.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="bg-cream-50 border border-cream-200 rounded-xl p-3 sm:p-4 space-y-3"
    >
      <div className="grid sm:grid-cols-4 gap-3">
        <label className="text-sm">
          <span className="text-ink-700 font-medium block mb-1">Dia</span>
          <select
            value={weekday}
            onChange={(e) => setWeekday(Number(e.target.value))}
            className="w-full border border-cream-300 rounded-lg px-3 py-2 bg-white"
          >
            {[0, 1, 2, 3, 4, 5, 6].map((d) => (
              <option key={d} value={d}>
                {WEEKDAY_LABELS_PT[d]}
              </option>
            ))}
          </select>
        </label>

        <label className="text-sm">
          <span className="text-ink-700 font-medium block mb-1">Início</span>
          <input
            type="time"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="w-full border border-cream-300 rounded-lg px-3 py-2 bg-white"
            required
          />
        </label>

        <label className="text-sm">
          <span className="text-ink-700 font-medium block mb-1">Fim</span>
          <input
            type="time"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className="w-full border border-cream-300 rounded-lg px-3 py-2 bg-white"
            required
          />
        </label>

        <label className="text-sm">
          <span className="text-ink-700 font-medium block mb-1">Tipo</span>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as AvailabilityType)}
            className="w-full border border-cream-300 rounded-lg px-3 py-2 bg-white"
          >
            <option value="scheduled">{TYPE_LABELS_PT.scheduled}</option>
            <option value="on_call">{TYPE_LABELS_PT.on_call}</option>
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="px-4 py-2 rounded-lg bg-ink-800 text-white text-sm font-medium hover:bg-ink-700 disabled:opacity-50"
        >
          {submitting ? "Adicionando…" : "Adicionar bloco"}
        </button>
        {error ? (
          <span className="text-sm text-red-600" role="alert">
            {error}
          </span>
        ) : null}
        {success ? (
          <span className="text-sm text-emerald-700">{success}</span>
        ) : null}
      </div>
    </form>
  );
}

function BlockRow({
  block,
  onChanged,
}: {
  block: AvailabilityRow;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trim = (t: string) => t.slice(0, 5);

  const action = async (kind: "deactivate" | "reactivate") => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/medico/availability/${block.id}`, {
        method: kind === "deactivate" ? "DELETE" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: kind === "reactivate" ? JSON.stringify({ active: true }) : undefined,
      });
      const j = await r.json();
      if (!r.ok || !j?.ok) {
        setError(humanError(j?.error));
        return;
      }
      await onChanged();
    } catch {
      setError("Falha de rede.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex items-center justify-between gap-3 flex-wrap p-2 rounded-lg bg-cream-50">
      <div className="flex items-center gap-3 min-w-0">
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
            block.type === "on_call"
              ? "bg-violet-100 text-violet-700"
              : "bg-sky-100 text-sky-700"
          }`}
        >
          {TYPE_LABELS_PT[block.type]}
        </span>
        <span className="font-mono text-sm text-ink-700">
          {trim(block.start_time)} – {trim(block.end_time)}
        </span>
        {!block.active ? (
          <span className="text-xs text-ink-500 italic">(inativo)</span>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        {error ? (
          <span className="text-xs text-red-600" role="alert">
            {error}
          </span>
        ) : null}
        {block.active ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => action("deactivate")}
            className="px-3 py-1.5 rounded-lg text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            Desativar
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => action("reactivate")}
            className="px-3 py-1.5 rounded-lg text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
          >
            Reativar
          </button>
        )}
      </div>
    </li>
  );
}
