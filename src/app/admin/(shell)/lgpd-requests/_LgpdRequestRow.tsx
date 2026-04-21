"use client";

/**
 * LgpdRequestRow — PR-017 · Onda 2A · D-051
 *
 * Row individual de solicitação de anonimização pendente. Expõe dois
 * CTAs: aceitar (modal com confirmação "anonimizar") ou recusar (modal
 * com razão obrigatória).
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Props = {
  requestId: string;
  customerId: string;
  requestedAt: string;
  patientName: string;
  patientEmail: string | null;
  patientPhone: string | null;
  requesterIp: string | null;
  requesterUserAgent: string | null;
  overSla: boolean;
  alreadyAnonymized: boolean;
};

type ModalKind = "fulfill" | "reject" | null;

export function LgpdRequestRow(props: Props) {
  const router = useRouter();
  const [modal, setModal] = useState<ModalKind>(null);
  const [reason, setReason] = useState("");
  const [force, setForce] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function handleFulfill() {
    setSubmitting(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/admin/lgpd-requests/${props.requestId}/fulfill`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            confirm: "anonimizar",
            force,
            reason: reason.trim() || null,
          }),
        }
      );
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setErr(json?.message ?? "Falha ao anonimizar.");
        return;
      }
      setModal(null);
      startTransition(() => router.refresh());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Erro de conexão.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReject() {
    if (!reason.trim()) {
      setErr("Motivo obrigatório.");
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/admin/lgpd-requests/${props.requestId}/reject`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: reason.trim() }),
        }
      );
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setErr(json?.message ?? "Falha ao recusar.");
        return;
      }
      setModal(null);
      startTransition(() => router.refresh());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Erro de conexão.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className={`rounded-lg border bg-white p-4 space-y-3 ${
        props.overSla ? "border-terracotta-300" : "border-ink-100"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-ink-800 font-medium">{props.patientName}</p>
          <p className="text-xs text-ink-500">
            {props.patientEmail ?? "sem email"}
            {props.patientPhone ? ` · ${props.patientPhone}` : ""}
          </p>
          <p className="text-xs text-ink-500 mt-1">
            Solicitado em {props.requestedAt}
          </p>
          <p className="text-[11px] text-ink-400 font-mono">
            IP: {props.requesterIp ?? "—"} · UA:{" "}
            {props.requesterUserAgent
              ? props.requesterUserAgent.slice(0, 60) +
                (props.requesterUserAgent.length > 60 ? "…" : "")
              : "—"}
          </p>
          {props.overSla && (
            <p className="text-xs text-terracotta-800 font-medium mt-1">
              SLA de 15 dias excedido — atender com prioridade.
            </p>
          )}
          {props.alreadyAnonymized && (
            <p className="text-xs text-sage-800 font-medium mt-1">
              Paciente já anonimizado — basta marcar a solicitação como
              atendida.
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              setErr(null);
              setReason("");
              setForce(false);
              setModal("fulfill");
            }}
            className="px-3 py-1.5 rounded-lg bg-terracotta-700 text-white text-sm font-medium hover:bg-terracotta-800"
          >
            Anonimizar
          </button>
          <button
            type="button"
            onClick={() => {
              setErr(null);
              setReason("");
              setModal("reject");
            }}
            className="px-3 py-1.5 rounded-lg border border-ink-300 text-ink-700 text-sm font-medium hover:bg-cream-50"
          >
            Recusar
          </button>
        </div>
      </div>

      {modal !== null && (
        <div
          className="fixed inset-0 z-50 bg-ink-900/60 flex items-center justify-center p-4"
          onClick={() => !submitting && setModal(null)}
        >
          <div
            className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-serif text-[1.3rem] text-ink-800 mb-2">
              {modal === "fulfill"
                ? "Executar anonimização"
                : "Recusar solicitação"}
            </h3>
            <p className="text-sm text-ink-700 mb-3">
              Paciente: <strong>{props.patientName}</strong>
            </p>
            {modal === "fulfill" ? (
              <>
                <p className="text-sm text-ink-700 mb-4">
                  Substituímos todos os dados pessoais deste paciente por
                  placeholders anônimos. Prontuário, pagamentos e aceites
                  permanecem por obrigação legal.{" "}
                  <strong>Ação irreversível.</strong>
                </p>
                <label className="block text-sm mb-3">
                  <span className="text-ink-700">Notas (opcional)</span>
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Ex.: paciente confirmou por e-mail"
                    className="mt-1 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
                    rows={2}
                  />
                </label>
                <label className="flex items-start gap-2 text-sm mb-4">
                  <input
                    type="checkbox"
                    checked={force}
                    onChange={(e) => setForce(e.target.checked)}
                    className="mt-1"
                  />
                  <span className="text-ink-700">
                    <strong>Forçar</strong> mesmo com fulfillment ativo
                    (paid/pharmacy_requested/shipped). Só use com acordo
                    expresso do paciente por escrito.
                  </span>
                </label>
              </>
            ) : (
              <label className="block text-sm mb-4">
                <span className="text-ink-700">
                  Motivo da recusa <span className="text-terracotta-700">*</span>
                </span>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Ex.: paciente tem chargeback ativo; aguardar resolução"
                  className="mt-1 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
                  rows={3}
                  required
                />
              </label>
            )}

            {err && (
              <p className="text-sm text-terracotta-800 mb-3">{err}</p>
            )}

            <div className="flex gap-3 justify-end">
              <button
                type="button"
                onClick={() => setModal(null)}
                disabled={submitting}
                className="px-4 py-2 rounded-lg border border-ink-300 text-ink-700 text-sm font-medium hover:bg-cream-50 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={modal === "fulfill" ? handleFulfill : handleReject}
                disabled={submitting}
                className={`px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50 ${
                  modal === "fulfill"
                    ? "bg-terracotta-700 hover:bg-terracotta-800"
                    : "bg-ink-800 hover:bg-ink-900"
                }`}
              >
                {submitting
                  ? "Processando..."
                  : modal === "fulfill"
                  ? "Confirmar anonimização"
                  : "Confirmar recusa"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
