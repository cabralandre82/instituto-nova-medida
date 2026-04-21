"use client";

/**
 * PendingOfferCard — D-045 · 3.E
 *
 * Card de indicação pendente no dashboard do paciente. Em relação à
 * versão server-side anterior (inline em /paciente/page.tsx), este
 * client component adiciona:
 *
 *   - Botão "Cancelar" com confirmação de 2 passos e input de motivo.
 *   - Chamada POST `/api/paciente/fulfillments/[id]/cancel`.
 *   - Refresh do router após sucesso, pra sumir da lista.
 *
 * Confirmação em 2 passos: o paciente clica "Cancelar", aparece um
 * textarea "conta pra gente o motivo" + 2 botões "Sim, cancelar" /
 * "Mantém". Evita cancelamento acidental.
 */

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { PendingOffer } from "@/lib/patient-treatment";

type Props = {
  offer: PendingOffer;
};

function brl(cents: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(cents / 100);
}

export function PendingOfferCard({ offer }: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<"idle" | "confirming" | "submitting">(
    "idle"
  );
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const isAwaitingPayment = offer.status === "pending_payment";
  const tone = isAwaitingPayment
    ? "border-cream-300 bg-cream-100"
    : "border-sage-200 bg-sage-50";
  const eyebrow = isAwaitingPayment
    ? "Pagamento pendente"
    : "Nova indicação médica";
  const ctaLabel = isAwaitingPayment
    ? "Ir para pagamento →"
    : "Revisar e aceitar →";
  const ctaHref =
    isAwaitingPayment && offer.invoiceUrl
      ? offer.invoiceUrl
      : `/paciente/oferta/${offer.appointmentId}`;
  const isExternal = isAwaitingPayment && !!offer.invoiceUrl;

  async function submitCancel() {
    setError(null);
    setMode("submitting");
    try {
      const res = await fetch(
        `/api/paciente/fulfillments/${offer.fulfillmentId}/cancel`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: reason.trim() || null }),
        }
      );
      const data = (await res.json().catch(() => null)) as {
        ok: boolean;
        message?: string;
      } | null;

      if (!res.ok || !data?.ok) {
        setError(
          data?.message ??
            "Não conseguimos cancelar agora. Tente de novo em um instante."
        );
        setMode("confirming");
        return;
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha de rede.");
      setMode("confirming");
    }
  }

  return (
    <div
      className={`rounded-2xl border p-5 sm:p-6 ${tone}`}
      data-fulfillment-id={offer.fulfillmentId}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-1.5">
            {eyebrow}
          </p>
          <h3 className="font-serif text-[1.3rem] text-ink-800 leading-tight">
            {offer.planName}
          </h3>
          {offer.planMedication && (
            <p className="mt-0.5 text-sm text-ink-500">{offer.planMedication}</p>
          )}
          <p className="mt-2 text-sm text-ink-600">
            Indicado por {offer.doctorName} · {brl(offer.pricePixCents)} à vista
          </p>
          {isAwaitingPayment ? (
            <p className="mt-1 text-xs text-ink-500">
              Você já aceitou o plano. Finalize o pagamento pra liberar o envio.
            </p>
          ) : (
            <p className="mt-1 text-xs text-ink-500">
              Abra a indicação pra revisar a prescrição, aceitar e prosseguir.
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-2">
          {isExternal ? (
            <a
              href={ctaHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center rounded-xl bg-ink-900 hover:bg-ink-800 text-white text-sm font-semibold px-5 py-2.5 transition-colors shadow-sm whitespace-nowrap"
            >
              {ctaLabel}
            </a>
          ) : (
            <Link
              href={ctaHref}
              className="inline-flex items-center rounded-xl bg-ink-900 hover:bg-ink-800 text-white text-sm font-semibold px-5 py-2.5 transition-colors shadow-sm whitespace-nowrap"
            >
              {ctaLabel}
            </Link>
          )}
          {mode === "idle" && (
            <button
              type="button"
              onClick={() => {
                setMode("confirming");
                setError(null);
              }}
              className="text-xs text-ink-500 hover:text-terracotta-700 transition-colors underline underline-offset-2"
            >
              Cancelar indicação
            </button>
          )}
        </div>
      </div>

      {(mode === "confirming" || mode === "submitting") && (
        <div className="mt-5 rounded-xl border border-ink-200 bg-white p-4">
          <p className="text-sm font-medium text-ink-800">
            Tem certeza que quer cancelar esta indicação?
          </p>
          <p className="mt-1 text-xs text-ink-500">
            Se ainda não pagou, nenhuma cobrança será feita. Você pode pedir
            uma nova indicação agendando outra consulta.
          </p>
          <label className="block mt-3 text-xs text-ink-600">
            Motivo (opcional)
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, 280))}
              maxLength={280}
              rows={2}
              placeholder="Ex: Preciso pensar mais antes de começar."
              className="mt-1 block w-full rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-800 focus:outline-none focus:ring-2 focus:ring-ink-400"
              disabled={mode === "submitting"}
            />
          </label>
          {error && (
            <p className="mt-2 text-sm text-terracotta-700">{error}</p>
          )}
          <div className="mt-3 flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => {
                setMode("idle");
                setReason("");
                setError(null);
              }}
              disabled={mode === "submitting"}
              className="inline-flex items-center rounded-xl border border-ink-200 text-ink-700 hover:bg-cream-50 text-sm font-medium px-4 py-2 transition-colors"
            >
              Mantém
            </button>
            <button
              type="button"
              onClick={submitCancel}
              disabled={mode === "submitting"}
              className="inline-flex items-center rounded-xl bg-terracotta-600 hover:bg-terracotta-700 disabled:bg-ink-300 disabled:cursor-not-allowed text-white text-sm font-semibold px-5 py-2 transition-colors shadow-sm"
            >
              {mode === "submitting" ? "Cancelando…" : "Sim, cancelar"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
