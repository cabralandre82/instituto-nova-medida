"use client";

/**
 * PresencePanel — PR-080 · D-092
 *
 * Toggle de presença + heartbeat automático (30s) pra UI da médica em
 * /medico/plantao. Reusa endpoints PR-075-B:
 *
 *   - POST /api/medico/presence/heartbeat (30s)
 *   - POST /api/medico/presence/status     (mudança manual)
 *
 * Estados visíveis:
 *   - online → "Estou de plantão" (verde)
 *   - busy   → "Em consulta agora" (âmbar)
 *   - offline → "Fora do plantão" (cinza)
 */

import { useEffect, useRef, useState } from "react";

type PresenceStatus = "online" | "busy" | "offline";

const HEARTBEAT_INTERVAL_MS = 30_000;

type Initial = {
  status: PresenceStatus;
  last_heartbeat_at: string;
  online_since: string | null;
} | null;

export function PresencePanel({ initial }: { initial: Initial }) {
  const [status, setStatus] = useState<PresenceStatus>(
    initial?.status ?? "offline"
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heartbeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (status === "offline") {
      if (heartbeatTimer.current) {
        clearInterval(heartbeatTimer.current);
        heartbeatTimer.current = null;
      }
      return;
    }
    async function ping() {
      try {
        await fetch("/api/medico/presence/heartbeat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
          cache: "no-store",
        });
      } catch {
        /* silencioso — próximo tick tenta */
      }
    }
    ping();
    heartbeatTimer.current = setInterval(ping, HEARTBEAT_INTERVAL_MS);
    return () => {
      if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
    };
  }, [status]);

  async function changeStatus(target: PresenceStatus) {
    if (pending || target === status) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/medico/presence/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: target }),
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        presence?: { status: PresenceStatus };
      } | null;
      if (!res.ok || !data?.ok) {
        setError("Não foi possível mudar o status. Tente novamente.");
        return;
      }
      setStatus(data.presence?.status ?? target);
    } catch {
      setError("Falha de rede.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="rounded-2xl border border-ink-100 bg-white p-5">
      <p className="text-[0.78rem] uppercase tracking-wider text-ink-500 font-medium">
        Sua presença
      </p>

      <div className="mt-3 flex items-center gap-2">
        <Dot status={status} />
        <p className="text-sm text-ink-800 font-medium">{labelFor(status)}</p>
      </div>

      <p className="mt-2 text-xs text-ink-500 leading-relaxed">
        {status === "online"
          ? "Você está visível pra solicitações de atendimento agora."
          : status === "busy"
            ? "Em consulta — pacientes em fila não recebem aviso até você voltar."
            : "Você não recebe solicitações on-demand."}
      </p>

      <div className="mt-4 flex flex-col gap-2">
        {status === "offline" ? (
          <button
            type="button"
            onClick={() => changeStatus("online")}
            disabled={pending}
            className="w-full rounded-full bg-sage-700 hover:bg-sage-800 text-cream-50 text-sm font-medium px-5 py-2.5 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {pending ? "…" : "Entrar no plantão"}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => changeStatus("offline")}
            disabled={pending}
            className="w-full rounded-full border border-ink-300 hover:bg-cream-50 text-ink-700 text-sm font-medium px-5 py-2.5 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {pending ? "…" : "Sair do plantão"}
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-3 text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

function Dot({ status }: { status: PresenceStatus }) {
  const cls =
    status === "online"
      ? "bg-sage-600"
      : status === "busy"
        ? "bg-amber-500"
        : "bg-ink-300";
  return (
    <span
      className={`inline-block w-2.5 h-2.5 rounded-full ${cls}`}
      aria-hidden="true"
    />
  );
}

function labelFor(s: PresenceStatus): string {
  if (s === "online") return "De plantão";
  if (s === "busy") return "Em consulta agora";
  return "Fora do plantão";
}
