"use client";

/**
 * _LgpdBlock.tsx — D-045 · 3.G
 *
 * Bloco na ficha do paciente com as duas operações LGPD:
 *   1. Exportar dados (portabilidade, Art. 18, V) — download direto.
 *   2. Anonimizar (eliminação, Art. 18, VI) — fluxo 2-step com
 *      confirmação literal + opção force pra casos extremos.
 *
 * Se o paciente já está anonimizado, mostra badge e oculta ação.
 *
 * Design:
 *   - Componente CLIENT. Faz fetch pro endpoint admin e trata erros
 *     inline. Recarrega a rota em caso de sucesso.
 *   - Nenhuma info sensível trafega via props — só o customerId.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatDateBR } from "@/lib/datetime-br";

type Props = {
  customerId: string;
  anonymizedAt: string | null;
  anonymizedRef: string | null;
};

type ErrorState = {
  title: string;
  detail: string;
};

export function LgpdBlock({
  customerId,
  anonymizedAt,
  anonymizedRef,
}: Props) {
  const router = useRouter();
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorState | null>(null);

  const isAnonymized = !!anonymizedAt;

  async function handleExport() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/pacientes/${customerId}/export`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `HTTP ${res.status}`
        );
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const cd = res.headers.get("content-disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(cd);
      a.download = match?.[1] ?? `lgpd-export-${customerId}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError({
        title: "Falha ao exportar",
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleAnonymize() {
    if (confirmText.trim().toLowerCase() !== "anonimizar") {
      setError({
        title: "Confirmação inválida",
        detail: 'Digite literalmente "anonimizar" pra prosseguir.',
      });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/pacientes/${customerId}/anonymize`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirm: "anonimizar", force }),
        }
      );
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        message?: string;
      };
      if (!res.ok || !body.ok) {
        throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (e) {
      setError({
        title: "Falha ao anonimizar",
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-ink-100 bg-white p-6 mb-8">
      <header className="flex items-start justify-between gap-4 flex-wrap mb-4">
        <div>
          <p className="text-[0.72rem] uppercase tracking-[0.14em] text-sage-700 font-medium mb-1">
            LGPD · Art. 18
          </p>
          <h2 className="font-serif text-[1.25rem] text-ink-800">
            Dados pessoais
          </h2>
        </div>
        {isAnonymized && (
          <span className="px-3 py-1 rounded-full bg-cream-200 border border-ink-200 text-xs text-ink-700 font-medium">
            Anonimizado em{" "}
            {formatDateBR(anonymizedAt!)}
            {anonymizedRef ? ` · ref ${anonymizedRef}` : ""}
          </span>
        )}
      </header>

      {isAnonymized ? (
        <p className="text-sm text-ink-600">
          Este paciente foi anonimizado por solicitação LGPD. Os dados
          clínicos e fiscais permanecem retidos por obrigação legal
          (CFM 1.821/2007, Decreto 6.022/2007) mas sem vínculo com
          identidade. O export abaixo ainda é possível e trará os
          placeholders pós-anonimização.
        </p>
      ) : (
        <p className="text-sm text-ink-600 mb-4">
          Exporte os dados a pedido do titular (portabilidade, Art. 18 V)
          ou anonimize a identidade (eliminação, Art. 18 VI). Ambas as
          ações ficam registradas em auditoria.
        </p>
      )}

      <div className="flex flex-wrap gap-3 mt-4">
        <button
          type="button"
          onClick={handleExport}
          disabled={busy}
          className="px-4 py-2 rounded-lg bg-ink-800 text-white text-sm hover:bg-ink-900 disabled:opacity-50 transition-colors"
        >
          Exportar dados (JSON)
        </button>

        {!isAnonymized && (
          <button
            type="button"
            onClick={() => {
              setShowConfirm((s) => !s);
              setError(null);
            }}
            disabled={busy}
            className="px-4 py-2 rounded-lg bg-white border border-terracotta-300 text-terracotta-800 text-sm hover:bg-terracotta-50 disabled:opacity-50 transition-colors"
          >
            Anonimizar…
          </button>
        )}
      </div>

      {showConfirm && !isAnonymized && (
        <div className="mt-5 rounded-xl border border-terracotta-200 bg-terracotta-50 p-4">
          <p className="text-sm text-terracotta-900 font-medium mb-2">
            Confirmação irreversível
          </p>
          <p className="text-sm text-terracotta-800 mb-3">
            Nome, e-mail, telefone, CPF e endereço serão substituídos por
            placeholders. Dados fiscais, receitas e histórico clínico são
            mantidos (retenção legal). Digite{" "}
            <code className="bg-white border border-terracotta-200 rounded px-1.5 py-0.5 text-xs font-mono">
              anonimizar
            </code>{" "}
            pra confirmar.
          </p>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="anonimizar"
            className="w-full rounded-lg border border-terracotta-300 bg-white px-3 py-2 text-sm mb-3"
          />
          <label className="flex items-center gap-2 text-xs text-terracotta-800 mb-3">
            <input
              type="checkbox"
              checked={force}
              onChange={(e) => setForce(e.target.checked)}
            />
            <span>
              Forçar anonimização mesmo com tratamento em curso (paid /
              pharmacy_requested / shipped). Use só se o paciente aceitou
              perder o tratamento.
            </span>
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleAnonymize}
              disabled={busy || confirmText.trim().toLowerCase() !== "anonimizar"}
              className="px-4 py-2 rounded-lg bg-terracotta-700 text-white text-sm hover:bg-terracotta-800 disabled:opacity-50 transition-colors"
            >
              {busy ? "Anonimizando…" : "Confirmar anonimização"}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowConfirm(false);
                setConfirmText("");
                setForce(false);
                setError(null);
              }}
              disabled={busy}
              className="px-4 py-2 rounded-lg bg-white border border-ink-200 text-ink-700 text-sm hover:bg-cream-100 disabled:opacity-50 transition-colors"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-xl border border-terracotta-200 bg-terracotta-50 p-3">
          <p className="text-sm font-medium text-terracotta-900">
            {error.title}
          </p>
          <p className="text-xs text-terracotta-800 font-mono mt-1">
            {error.detail}
          </p>
        </div>
      )}
    </section>
  );
}
