"use client";

/**
 * ActiveFulfillmentCard — D-044 · 2.F
 *
 * Card que aparece no dashboard do paciente pra cada fulfillment
 * em andamento (paid | pharmacy_requested | shipped). Mostra:
 *
 *   - Etapa atual com descrição amigável (sem jargão técnico).
 *   - Timeline visual compacta com 4 passos.
 *   - Número de rastreio quando `shipped`.
 *   - CTA "Já recebi o medicamento" só em `shipped`.
 *
 * Toda a mutação usa `POST /api/paciente/fulfillments/[id]/confirm-delivery`;
 * após sucesso, `router.refresh()` recarrega o server component.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ActiveFulfillment } from "@/lib/patient-treatment";

type Props = {
  fulfillment: ActiveFulfillment;
};

type StepKey = "paid" | "pharmacy_requested" | "shipped" | "delivered";

const STEPS: Array<{ key: StepKey; label: string; hint: string }> = [
  {
    key: "paid",
    label: "Pagamento confirmado",
    hint: "Recebemos sua aceitação e seu pagamento.",
  },
  {
    key: "pharmacy_requested",
    label: "Manipulação em andamento",
    hint: "Sua prescrição está na farmácia de manipulação parceira.",
  },
  {
    key: "shipped",
    label: "Medicamento a caminho",
    hint: "Despachamos pro seu endereço. Chega em alguns dias úteis.",
  },
  {
    key: "delivered",
    label: "Recebido",
    hint: "Ciclo fechado. Bom tratamento.",
  },
];

function stepIndex(status: ActiveFulfillment["status"]): number {
  if (status === "paid") return 0;
  if (status === "pharmacy_requested") return 1;
  if (status === "shipped") return 2;
  return 3;
}

function eyebrowFor(status: ActiveFulfillment["status"]): string {
  switch (status) {
    case "paid":
      return "Pedido em processamento";
    case "pharmacy_requested":
      return "Na farmácia";
    case "shipped":
      return "A caminho";
  }
}

function fmtDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function ActiveFulfillmentCard({ fulfillment: f }: Props) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentIdx = stepIndex(f.status);
  const canConfirm = f.status === "shipped";

  async function confirmDelivery() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/paciente/fulfillments/${f.fulfillmentId}/confirm-delivery`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }
      );
      const data = (await res.json().catch(() => null)) as {
        ok: boolean;
        message?: string;
      } | null;

      if (!res.ok || !data?.ok) {
        setError(
          data?.message ??
            "Não conseguimos registrar agora. Tente de novo em um instante."
        );
        return;
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha de rede.");
    } finally {
      setSubmitting(false);
    }
  }

  // Tom por etapa (acompanha a UX: cream = processando, sage = a caminho)
  const toneClass =
    f.status === "shipped"
      ? "border-sage-200 bg-sage-50"
      : "border-cream-300 bg-cream-100";

  return (
    <div
      className={`rounded-2xl border p-5 sm:p-6 ${toneClass}`}
      data-fulfillment-id={f.fulfillmentId}
    >
      <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
        <div className="min-w-0 flex-1">
          <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-1.5">
            {eyebrowFor(f.status)}
          </p>
          <h3 className="font-serif text-[1.3rem] text-ink-800 leading-tight">
            {f.planName}
          </h3>
          {f.planMedication && (
            <p className="mt-0.5 text-sm text-ink-500">{f.planMedication}</p>
          )}
          <p className="mt-2 text-sm text-ink-600">
            Prescrito por {f.doctorName}
          </p>
        </div>
      </div>

      <ol className="space-y-2.5 mb-4">
        {STEPS.map((step, idx) => {
          const done = idx < currentIdx;
          const active = idx === currentIdx;
          const dotClass = done
            ? "bg-sage-600"
            : active
              ? "bg-ink-800 ring-4 ring-ink-800/15"
              : "bg-ink-200";
          const textClass = done || active ? "text-ink-800" : "text-ink-400";
          return (
            <li key={step.key} className="flex items-start gap-3">
              <span
                className={`mt-1 inline-block w-2.5 h-2.5 rounded-full flex-shrink-0 ${dotClass}`}
              />
              <div className="flex-1">
                <p className={`text-sm font-medium ${textClass}`}>
                  {step.label}
                </p>
                <p
                  className={`text-xs mt-0.5 ${
                    active ? "text-ink-600" : "text-ink-500"
                  }`}
                >
                  {step.hint}
                </p>
              </div>
            </li>
          );
        })}
      </ol>

      {f.status === "shipped" && f.trackingNote && (
        <div className="rounded-xl bg-white/70 border border-sage-200 p-3 mb-4">
          <p className="text-[0.72rem] uppercase tracking-wide text-ink-500">
            Código de rastreio
          </p>
          <p className="mt-0.5 text-sm text-ink-800 font-mono break-all">
            {f.trackingNote}
          </p>
          {fmtDate(f.shippedAt) && (
            <p className="text-xs text-ink-500 mt-1">
              Despachado em {fmtDate(f.shippedAt)}
            </p>
          )}
        </div>
      )}

      {canConfirm && (
        <div>
          {error && (
            <p className="text-sm text-terracotta-700 mb-3">{error}</p>
          )}
          <button
            type="button"
            onClick={confirmDelivery}
            disabled={submitting}
            className="inline-flex items-center rounded-xl bg-ink-900 hover:bg-ink-800 disabled:bg-ink-300 disabled:cursor-not-allowed text-white text-sm font-semibold px-5 py-2.5 transition-colors shadow-sm"
          >
            {submitting ? "Registrando…" : "Já recebi o medicamento"}
          </button>
          <p className="text-xs text-ink-500 mt-2">
            Confirme o recebimento quando a caixa chegar — isso fecha o
            acompanhamento desta etapa.
          </p>
        </div>
      )}

      {!canConfirm && f.status === "pharmacy_requested" && (
        <p className="text-xs text-ink-500">
          A manipulação costuma levar 3 a 5 dias úteis. Quando despacharmos,
          você recebe o rastreio aqui e no WhatsApp.
        </p>
      )}

      {!canConfirm && f.status === "paid" && (
        <p className="text-xs text-ink-500">
          A gente vai acionar a farmácia nas próximas horas úteis.
        </p>
      )}
    </div>
  );
}
