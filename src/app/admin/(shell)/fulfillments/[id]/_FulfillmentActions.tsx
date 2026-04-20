"use client";

/**
 * FulfillmentActions — client component (D-044 · 2.E)
 *
 * Mostra os botões apropriados ao status atual do fulfillment e
 * gerencia os modais de cada transição:
 *
 *   - `paid` → "Enviar receita à farmácia"
 *     Modal mostra prescrição + paciente (SEM endereço — compromisso
 *     legal do termo de aceite).
 *
 *   - `pharmacy_requested` → "Marcar como despachado"
 *     Modal exige `tracking_note` e mostra o endereço de entrega.
 *
 *   - `shipped` → "Marcar como entregue"
 *     Confirma (admin force; paciente pode confirmar direto em /paciente).
 *
 *   - qualquer não-terminal → "Cancelar"
 *     Modal exige motivo livre.
 *
 * Todas as ações batem em `POST /api/admin/fulfillments/[id]/transition`.
 * Após sucesso, `router.refresh()` recarrega o server component.
 */

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import type { FulfillmentStatus } from "@/lib/fulfillments";

type Props = {
  fulfillmentId: string;
  status: FulfillmentStatus;
  prescriptionUrl: string | null;
  patientName: string;
  patientCpf: string;
  shippingAddress: {
    recipient_name: string | null;
    zipcode: string | null;
    street: string | null;
    number: string | null;
    complement: string | null;
    district: string | null;
    city: string | null;
    state: string | null;
  };
};

type ModalKind = null | "pharmacy_requested" | "shipped" | "delivered" | "cancelled";

function formatCep(d: string | null): string {
  if (!d) return "—";
  const only = d.replace(/\D/g, "");
  if (only.length !== 8) return d;
  return `${only.slice(0, 5)}-${only.slice(5)}`;
}

function formatCpf(d: string): string {
  const only = d.replace(/\D/g, "");
  if (only.length !== 11) return d;
  return `${only.slice(0, 3)}.${only.slice(3, 6)}.${only.slice(6, 9)}-${only.slice(9)}`;
}

export function FulfillmentActions({
  fulfillmentId,
  status,
  prescriptionUrl,
  patientName,
  patientCpf,
  shippingAddress,
}: Props) {
  const router = useRouter();
  const [modal, setModal] = useState<ModalKind>(null);
  const [trackingNote, setTrackingNote] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = useCallback(() => {
    if (submitting) return;
    setModal(null);
    setError(null);
    setTrackingNote("");
    setCancelReason("");
  }, [submitting]);

  async function submit(to: FulfillmentStatus) {
    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { to };
      if (to === "shipped") body.tracking_note = trackingNote;
      if (to === "cancelled") body.cancelled_reason = cancelReason;

      const res = await fetch(
        `/api/admin/fulfillments/${fulfillmentId}/transition`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      const data = (await res.json().catch(() => null)) as {
        ok: boolean;
        message?: string;
      } | null;

      if (!res.ok || !data?.ok) {
        setError(data?.message ?? "Falha na operação. Tente novamente.");
        return;
      }
      close();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha de rede.");
    } finally {
      setSubmitting(false);
    }
  }

  const canGoPharmacy = status === "paid";
  const canGoShipped = status === "pharmacy_requested";
  const canGoDelivered = status === "shipped";
  const canCancel =
    status === "paid" ||
    status === "pharmacy_requested" ||
    status === "shipped";

  if (
    status === "delivered" ||
    status === "cancelled" ||
    status === "pending_acceptance" ||
    status === "pending_payment"
  ) {
    return (
      <div className="rounded-xl border border-ink-100 bg-cream-50 px-5 py-4 text-sm text-ink-500">
        {status === "delivered" && "Entrega confirmada. Ciclo concluído."}
        {status === "cancelled" && "Fulfillment cancelado."}
        {status === "pending_acceptance" &&
          "Aguardando aceite formal do paciente. Nenhuma ação admin."}
        {status === "pending_payment" &&
          "Aguardando pagamento. A promoção pra `paid` acontece automática via webhook Asaas."}
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-wrap gap-3">
        {canGoPharmacy && (
          <button
            type="button"
            onClick={() => setModal("pharmacy_requested")}
            className="inline-flex items-center rounded-xl bg-ink-900 hover:bg-ink-800 text-white text-sm font-semibold px-5 py-2.5 transition-colors shadow-sm"
          >
            Enviar receita à farmácia →
          </button>
        )}
        {canGoShipped && (
          <button
            type="button"
            onClick={() => setModal("shipped")}
            className="inline-flex items-center rounded-xl bg-ink-900 hover:bg-ink-800 text-white text-sm font-semibold px-5 py-2.5 transition-colors shadow-sm"
          >
            Marcar como despachado →
          </button>
        )}
        {canGoDelivered && (
          <button
            type="button"
            onClick={() => setModal("delivered")}
            className="inline-flex items-center rounded-xl bg-sage-700 hover:bg-sage-800 text-white text-sm font-semibold px-5 py-2.5 transition-colors shadow-sm"
          >
            Forçar entrega confirmada
          </button>
        )}
        {canCancel && (
          <button
            type="button"
            onClick={() => setModal("cancelled")}
            className="inline-flex items-center rounded-lg border border-terracotta-300 bg-white hover:bg-terracotta-50 text-terracotta-700 text-sm font-medium px-4 py-2 transition-colors"
          >
            Cancelar fulfillment
          </button>
        )}
      </div>

      {modal === "pharmacy_requested" && (
        <Modal title="Enviar receita à farmácia" onClose={close}>
          <p className="text-sm text-ink-600 mb-4">
            Confirme os dados antes de acionar a farmácia de manipulação.
            Lembre: <strong>o endereço do paciente não é compartilhado</strong> —
            a farmácia entrega o medicamento ao Instituto; o Instituto é quem
            despacha ao paciente.
          </p>

          <div className="rounded-xl bg-cream-50 border border-cream-200 p-4 mb-4 text-sm space-y-2">
            <Kv k="Paciente" v={patientName} />
            <Kv k="CPF" v={formatCpf(patientCpf)} />
            <div>
              <p className="text-[0.72rem] uppercase tracking-wide text-ink-500">
                Prescrição (Memed)
              </p>
              {prescriptionUrl ? (
                <a
                  href={prescriptionUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-sage-700 hover:text-sage-800 underline"
                >
                  Abrir receita em nova aba
                </a>
              ) : (
                <span className="text-sm text-ink-400">indisponível</span>
              )}
            </div>
          </div>

          <ErrorBlock message={error} />
          <ModalActions onCancel={close} disabled={submitting}>
            <button
              type="button"
              onClick={() => submit("pharmacy_requested")}
              disabled={submitting}
              className="inline-flex items-center rounded-xl bg-ink-900 hover:bg-ink-800 disabled:bg-ink-300 text-white text-sm font-semibold px-5 py-2.5 transition-colors"
            >
              {submitting ? "Enviando…" : "Confirmar envio à farmácia"}
            </button>
          </ModalActions>
        </Modal>
      )}

      {modal === "shipped" && (
        <Modal title="Marcar como despachado" onClose={close}>
          <p className="text-sm text-ink-600 mb-4">
            Registre a transportadora e o código de rastreio. Esta informação
            vai pro paciente via WhatsApp.
          </p>

          <div className="rounded-xl bg-cream-50 border border-cream-200 p-4 mb-4 text-sm space-y-2">
            <p className="text-[0.72rem] uppercase tracking-wide text-ink-500">
              Endereço de entrega
            </p>
            <p className="text-ink-700">
              {shippingAddress.recipient_name ?? patientName}
            </p>
            <p className="text-ink-600">
              {shippingAddress.street ?? "—"}, {shippingAddress.number ?? "—"}
              {shippingAddress.complement ? ` · ${shippingAddress.complement}` : ""}
            </p>
            <p className="text-ink-600">
              {shippingAddress.district ?? "—"} · {shippingAddress.city ?? "—"}/
              {shippingAddress.state ?? "—"} · CEP {formatCep(shippingAddress.zipcode)}
            </p>
          </div>

          <label className="block mb-4">
            <span className="block text-[0.78rem] uppercase tracking-wide text-ink-500 mb-1.5">
              Transportadora + código de rastreio
            </span>
            <input
              type="text"
              value={trackingNote}
              onChange={(e) => setTrackingNote(e.target.value)}
              placeholder="Ex: Correios BR123456789BR"
              className="w-full rounded-lg border border-ink-200 bg-white px-3.5 py-2.5 focus:outline-none focus:ring-2 focus:ring-sage-400"
              autoFocus
            />
          </label>

          <ErrorBlock message={error} />
          <ModalActions onCancel={close} disabled={submitting}>
            <button
              type="button"
              onClick={() => submit("shipped")}
              disabled={submitting || trackingNote.trim().length < 3}
              className="inline-flex items-center rounded-xl bg-ink-900 hover:bg-ink-800 disabled:bg-ink-300 disabled:cursor-not-allowed text-white text-sm font-semibold px-5 py-2.5 transition-colors"
            >
              {submitting ? "Registrando…" : "Marcar como despachado"}
            </button>
          </ModalActions>
        </Modal>
      )}

      {modal === "delivered" && (
        <Modal title="Forçar entrega confirmada" onClose={close}>
          <p className="text-sm text-ink-600 mb-4">
            Use este botão apenas se o paciente já tiver recebido mas não
            confirmou no app. O ciclo do fulfillment é fechado.
          </p>
          <ErrorBlock message={error} />
          <ModalActions onCancel={close} disabled={submitting}>
            <button
              type="button"
              onClick={() => submit("delivered")}
              disabled={submitting}
              className="inline-flex items-center rounded-xl bg-sage-700 hover:bg-sage-800 disabled:bg-sage-300 text-white text-sm font-semibold px-5 py-2.5 transition-colors"
            >
              {submitting ? "Confirmando…" : "Confirmar entrega"}
            </button>
          </ModalActions>
        </Modal>
      )}

      {modal === "cancelled" && (
        <Modal title="Cancelar fulfillment" onClose={close}>
          <p className="text-sm text-ink-600 mb-4">
            Cancelamento é registrado e enviado ao paciente via WhatsApp.
            Descreva o motivo claramente — fica em auditoria.
          </p>
          <label className="block mb-4">
            <span className="block text-[0.78rem] uppercase tracking-wide text-ink-500 mb-1.5">
              Motivo do cancelamento
            </span>
            <textarea
              rows={3}
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Ex: Farmácia parceira indicou indisponibilidade do insumo; estorno combinado no suporte."
              className="w-full rounded-lg border border-ink-200 bg-white px-3.5 py-2.5 focus:outline-none focus:ring-2 focus:ring-terracotta-400"
              autoFocus
            />
          </label>
          <ErrorBlock message={error} />
          <ModalActions onCancel={close} disabled={submitting}>
            <button
              type="button"
              onClick={() => submit("cancelled")}
              disabled={submitting || cancelReason.trim().length < 3}
              className="inline-flex items-center rounded-xl bg-terracotta-700 hover:bg-terracotta-800 disabled:bg-terracotta-300 disabled:cursor-not-allowed text-white text-sm font-semibold px-5 py-2.5 transition-colors"
            >
              {submitting ? "Cancelando…" : "Cancelar fulfillment"}
            </button>
          </ModalActions>
        </Modal>
      )}
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Subcomponentes
// ────────────────────────────────────────────────────────────────────────

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink-900/40">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-ink-100 flex items-center justify-between">
          <h3 className="font-serif text-[1.2rem] text-ink-800">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-400 hover:text-ink-700 text-xl leading-none"
            aria-label="Fechar"
          >
            ×
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

function ModalActions({
  onCancel,
  disabled,
  children,
}: {
  onCancel: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
      <button
        type="button"
        onClick={onCancel}
        disabled={disabled}
        className="inline-flex items-center rounded-lg border border-ink-200 bg-white hover:bg-ink-50 text-ink-700 text-sm font-medium px-4 py-2 disabled:opacity-50"
      >
        Voltar
      </button>
      {children}
    </div>
  );
}

function ErrorBlock({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="mb-4 rounded-lg border border-terracotta-300 bg-terracotta-50 px-4 py-3 text-sm text-terracotta-800">
      {message}
    </div>
  );
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <p className="text-[0.72rem] uppercase tracking-wide text-ink-500">{k}</p>
      <p className="text-ink-700">{v}</p>
    </div>
  );
}
