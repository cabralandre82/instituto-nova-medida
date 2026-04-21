"use client";

/**
 * MeusDadosActions — PR-017 · Onda 2A · D-051
 *
 * Bloco interativo com:
 *   - Botão de download JSON (abre /api/paciente/meus-dados/export em
 *     nova aba — o browser baixa direto via Content-Disposition).
 *   - Botão "Solicitar anonimização" com modal de confirmação exibindo
 *     o disclaimer CFM/fiscal.
 *   - Botão "Cancelar solicitação" se já existe pendência.
 *
 * Preferimos `window.location` / form submit pra download ao invés de
 * fetch+blob: simplifica o fluxo e aproveita o Content-Disposition sem
 * precisar manipular File API no client.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Props = {
  pendingAnonymizeRequestId: string | null;
  alreadyAnonymized: boolean;
};

export function MeusDadosActions({
  pendingAnonymizeRequestId,
  alreadyAnonymized,
}: Props) {
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  async function handleAnonymize() {
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const res = await fetch(
        "/api/paciente/meus-dados/anonymize-request",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirm: "solicito" }),
        }
      );
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setErrorMsg(
          json?.message ||
            "Não foi possível enviar sua solicitação. Tente novamente."
        );
        return;
      }
      setModalOpen(false);
      startTransition(() => router.refresh());
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : "Erro de conexão."
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancel() {
    if (!pendingAnonymizeRequestId) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const res = await fetch(
        `/api/paciente/meus-dados/anonymize-request/${pendingAnonymizeRequestId}/cancel`,
        { method: "POST" }
      );
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        setErrorMsg(
          json?.message ||
            "Não foi possível cancelar. Tente novamente em instantes."
        );
        return;
      }
      startTransition(() => router.refresh());
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : "Erro de conexão."
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      {/* Download */}
      <section className="rounded-2xl border border-ink-100 bg-white p-6 mb-4">
        <h2 className="font-serif text-[1.25rem] text-ink-800 mb-1">
          Baixar meus dados
        </h2>
        <p className="text-sm text-ink-500 mb-4">
          Você recebe um arquivo <code>.json</code> com tudo que o
          Instituto tem sobre você: cadastro, consultas, prescrições,
          pagamentos e aceites. Base legal: LGPD Art. 18, V.
        </p>
        <a
          href="/api/paciente/meus-dados/export"
          className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-ink-800 text-white text-sm font-medium hover:bg-ink-900 transition-colors"
        >
          Baixar arquivo JSON
        </a>
      </section>

      {/* Anonimização */}
      <section className="rounded-2xl border border-ink-100 bg-white p-6">
        <h2 className="font-serif text-[1.25rem] text-ink-800 mb-1">
          Solicitar anonimização
        </h2>
        <p className="text-sm text-ink-500 mb-4">
          Substituímos seu nome, e-mail, CPF, telefone e endereço por
          valores anônimos. <strong>Ação irreversível.</strong> Base legal:
          LGPD Art. 18, IV e VI.
        </p>

        <details className="mb-4 rounded-lg bg-cream-50 border border-cream-200 p-3 text-sm text-ink-700 open:pb-4">
          <summary className="cursor-pointer font-medium">
            O que continua guardado mesmo assim?
          </summary>
          <ul className="mt-2 pl-4 list-disc space-y-1">
            <li>
              <strong>Prontuário médico</strong> (anamnese, hipótese,
              conduta, prescrições): 20 anos — Res. CFM 1.821/2007.
            </li>
            <li>
              <strong>Registros financeiros</strong> (pagamentos, recibos):
              5 anos — Decreto 6.022/2007 (SPED).
            </li>
            <li>
              <strong>Aceites legais de plano</strong>: retidos como prova
              do consentimento.
            </li>
          </ul>
          <p className="mt-2 text-xs">
            LGPD Art. 16, I permite a retenção por cumprimento de obrigação
            legal ou regulatória. Após anonimização seu nome deixa de
            aparecer, mas esses registros ficam vinculados a um ID
            anônimo — apenas para auditorias legais.
          </p>
        </details>

        {alreadyAnonymized ? (
          <p className="text-sm text-sage-800 font-medium">
            Sua conta já foi anonimizada.
          </p>
        ) : pendingAnonymizeRequestId ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-ink-700">
              <strong>Solicitação em análise.</strong> Você receberá
              confirmação em até 15 dias.
            </p>
            <button
              type="button"
              onClick={handleCancel}
              disabled={submitting || isPending}
              className="inline-flex items-center px-3 py-1.5 rounded-lg border border-ink-300 text-ink-700 text-sm font-medium hover:bg-cream-50 disabled:opacity-50"
            >
              {submitting ? "Cancelando..." : "Cancelar solicitação"}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setErrorMsg(null);
              setModalOpen(true);
            }}
            className="inline-flex items-center px-4 py-2 rounded-lg border border-terracotta-300 text-terracotta-800 text-sm font-medium hover:bg-terracotta-50"
          >
            Solicitar anonimização
          </button>
        )}

        {errorMsg && (
          <p className="mt-3 text-sm text-terracotta-800">{errorMsg}</p>
        )}
      </section>

      {/* Modal */}
      {modalOpen && (
        <div
          className="fixed inset-0 z-50 bg-ink-900/60 flex items-center justify-center p-4"
          onClick={() => !submitting && setModalOpen(false)}
        >
          <div
            className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-serif text-[1.3rem] text-ink-800 mb-2">
              Confirmar solicitação
            </h3>
            <p className="text-sm text-ink-700 mb-4">
              Ao confirmar, enviamos seu pedido à equipe do Instituto.
              Dentro de 15 dias, seus dados pessoais serão substituídos
              por valores anônimos. <strong>Não há como reverter.</strong>
            </p>
            <p className="text-sm text-ink-700 mb-6">
              Prontuários médicos e registros financeiros permanecem
              retidos por obrigação legal — leia os detalhes acima.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                disabled={submitting}
                className="px-4 py-2 rounded-lg border border-ink-300 text-ink-700 text-sm font-medium hover:bg-cream-50 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleAnonymize}
                disabled={submitting}
                className="px-4 py-2 rounded-lg bg-terracotta-700 text-white text-sm font-medium hover:bg-terracotta-800 disabled:opacity-50"
              >
                {submitting ? "Enviando..." : "Confirmar solicitação"}
              </button>
            </div>
            {errorMsg && (
              <p className="mt-3 text-sm text-terracotta-800">{errorMsg}</p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
