"use client";

/**
 * OnDemandWaitingClient — PR-080 · D-092
 *
 * Estado de "esperando médica aceitar". Polling a cada 3s em
 * /api/agendar/agora/status?id=...
 *
 * Estados terminais:
 *   - accepted  → window.location = consultaUrl
 *   - cancelled → recarrega página (server vai mostrar form de novo)
 *   - expired   → mostra estado vazio + opção "tentar de novo" / agendar
 *
 * Cancel:
 *   POST /api/agendar/agora/cancel { requestId }
 *
 * Importante: não usamos Server-Sent Events / WebSocket por agora —
 * polling de 3s é simples, não precisa cookie de sessão dedicado, e
 * latência de 3s é aceitável pra UX. Se virar problema operacional,
 * trocar por SSE em PR-082.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type StatusResponse =
  | {
      ok: true;
      status: "pending" | "cancelled" | "expired";
      expiresAt: string;
      secondsUntilExpiry: number;
      cancelledReason: string | null;
    }
  | {
      ok: true;
      status: "accepted";
      appointmentId: string;
      consultaUrl: string;
      acceptedAt: string;
    }
  | { ok: false; error: string };

const POLL_INTERVAL_MS = 3000;

export function OnDemandWaitingClient({
  requestId,
  expiresAt,
}: {
  requestId: string;
  expiresAt: string;
}) {
  const router = useRouter();
  const [secondsLeft, setSecondsLeft] = useState<number>(() =>
    secondsUntil(expiresAt)
  );
  const [terminal, setTerminal] = useState<
    null | "expired" | "cancelled" | "accepted" | "error"
  >(null);
  const [accepted, setAccepted] = useState<{
    consultaUrl: string;
    appointmentId: string;
  } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Tick local pra countdown (1s).
  useEffect(() => {
    if (terminal) return;
    tickTimer.current = setInterval(() => {
      const left = secondsUntil(expiresAt);
      setSecondsLeft(left);
      if (left <= 0) setTerminal("expired");
    }, 1000);
    return () => {
      if (tickTimer.current) clearInterval(tickTimer.current);
    };
  }, [expiresAt, terminal]);

  // Polling do servidor (3s).
  useEffect(() => {
    if (terminal) return;
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch(
          `/api/agendar/agora/status?id=${encodeURIComponent(requestId)}`,
          { cache: "no-store" }
        );
        const data = (await res.json().catch(() => null)) as StatusResponse | null;
        if (cancelled) return;
        if (!data || data.ok === false) {
          // 404 quando request não pertence ao lead — improvável, mas
          // recarrega pra recuperar consistência.
          router.refresh();
          return;
        }
        if (data.status === "accepted") {
          setAccepted({
            consultaUrl: data.consultaUrl,
            appointmentId: data.appointmentId,
          });
          setTerminal("accepted");
          // Redireciona depois de 1.5s pra usuário ver "aceito!" mensagem.
          setTimeout(() => {
            window.location.href = data.consultaUrl;
          }, 1500);
        } else if (data.status === "cancelled") {
          setTerminal("cancelled");
          setTimeout(() => router.refresh(), 1500);
        } else if (data.status === "expired") {
          setTerminal("expired");
        } else {
          // pending — atualiza countdown server-side
          setSecondsLeft(data.secondsUntilExpiry);
        }
      } catch {
        // Ignora — próximo tick tenta de novo.
      }
    }
    pollTimer.current = setInterval(poll, POLL_INTERVAL_MS);
    poll();
    return () => {
      cancelled = true;
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [requestId, router, terminal]);

  async function handleCancel() {
    if (cancelling) return;
    setCancelling(true);
    try {
      await fetch("/api/agendar/agora/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId }),
      });
    } finally {
      setCancelling(false);
      router.refresh();
    }
  }

  if (terminal === "accepted" && accepted) {
    return (
      <div className="rounded-2xl bg-sage-50 border border-sage-200 p-8 text-center">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-3">
          Aceito!
        </p>
        <h1 className="font-serif text-[1.8rem] text-ink-800 leading-tight">
          Uma médica acabou de aceitar.
        </h1>
        <p className="mt-3 text-ink-600 leading-relaxed">
          Estamos te direcionando para a sala da consulta…
        </p>
        <a
          href={accepted.consultaUrl}
          className="mt-6 inline-flex items-center justify-center gap-2 rounded-full bg-sage-700 hover:bg-sage-800 text-cream-50 font-medium px-7 py-3 text-[0.96rem] transition-colors"
        >
          Entrar na sala agora →
        </a>
      </div>
    );
  }

  if (terminal === "cancelled") {
    return (
      <div className="rounded-2xl bg-cream-50 border border-ink-200 p-8 text-center">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-ink-500 font-medium mb-3">
          Cancelado
        </p>
        <h1 className="font-serif text-[1.6rem] text-ink-800 leading-tight">
          Solicitação cancelada.
        </h1>
        <p className="mt-3 text-ink-600 leading-relaxed">Recarregando…</p>
      </div>
    );
  }

  if (terminal === "expired") {
    return (
      <div className="rounded-2xl bg-cream-50 border border-amber-200 p-8 text-center space-y-4">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-amber-700 font-medium">
          Sem médica disponível agora
        </p>
        <h1 className="font-serif text-[1.6rem] text-ink-800 leading-tight">
          Nenhuma médica conseguiu te atender desta vez.
        </h1>
        <p className="text-ink-600 leading-relaxed">
          Sem problema — você pode tentar novamente em alguns minutos
          ou agendar uma consulta para o melhor horário.
        </p>
        <div className="flex flex-wrap gap-3 justify-center pt-2">
          <button
            type="button"
            onClick={() => router.refresh()}
            className="inline-flex items-center justify-center gap-2 rounded-full bg-terracotta-700 hover:bg-terracotta-800 text-cream-50 font-medium px-6 py-2.5 text-[0.95rem] transition-colors"
          >
            Tentar novamente
          </button>
          <Link
            href="/agendar"
            className="inline-flex items-center justify-center gap-2 rounded-full border border-ink-300 hover:bg-cream-100 text-ink-700 font-medium px-6 py-2.5 text-[0.95rem] transition-colors"
          >
            Agendar para depois
          </Link>
        </div>
      </div>
    );
  }

  // Estado pending — countdown + cancel.
  const mm = Math.max(0, Math.floor(secondsLeft / 60));
  const ss = Math.max(0, secondsLeft % 60);
  const display = `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;

  return (
    <div className="space-y-6">
      <header>
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-terracotta-700 font-medium mb-3">
          Aguardando médica
        </p>
        <h1 className="font-serif text-[2rem] sm:text-[2.4rem] leading-[1.05] tracking-tight text-ink-800">
          Sua solicitação foi enviada.
        </h1>
        <p className="mt-3 text-ink-600 leading-relaxed">
          Estamos avisando todas as médicas online no momento. A primeira
          que aceitar abre a sala da sua consulta — você pode deixar esta
          aba aberta enquanto isso.
        </p>
      </header>

      <div className="rounded-2xl border border-terracotta-200 bg-terracotta-50/60 p-6 sm:p-8 text-center">
        <p className="text-[0.78rem] uppercase tracking-wider text-terracotta-700 font-medium">
          Tempo restante
        </p>
        <p className="mt-2 font-serif text-[3.2rem] leading-none tabular-nums text-ink-800">
          {display}
        </p>
        <p className="mt-3 text-sm text-ink-600">
          Buscando atendimento. Não feche esta janela.
        </p>
      </div>

      <div className="rounded-2xl border border-ink-100 bg-cream-50 p-5 space-y-3 text-sm text-ink-600 leading-relaxed">
        <p>
          <strong className="text-ink-800">
            E se ninguém aceitar dentro do tempo?
          </strong>{" "}
          Você pode tentar de novo em alguns minutos ou agendar uma
          consulta para o melhor horário.
        </p>
        <p className="text-ink-500">
          Se quiser desistir agora, pode cancelar abaixo a qualquer momento.
        </p>
      </div>

      <button
        type="button"
        onClick={handleCancel}
        disabled={cancelling}
        className="w-full inline-flex items-center justify-center gap-2 rounded-full border border-ink-300 hover:bg-cream-50 text-ink-700 font-medium px-6 py-3 text-[0.95rem] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {cancelling ? "Cancelando…" : "Cancelar solicitação"}
      </button>
    </div>
  );
}

function secondsUntil(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((t - Date.now()) / 1000));
}
