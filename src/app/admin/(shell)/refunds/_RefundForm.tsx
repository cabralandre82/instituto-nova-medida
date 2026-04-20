"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type ApiError = {
  code?: string;
  error?: string;
  asaas_status?: number | null;
  asaas_code?: string | null;
};

type ApiOk = {
  ok: true;
  appointment_id: string;
  processed_at: string;
  method: "manual" | "asaas_api";
  already_processed: boolean;
  external_ref: string | null;
};

/**
 * Formulário de processamento de refund pra um appointment pendente.
 *
 * Dois modos controlados por `asaasEnabled`:
 *
 *   - OFF → botão único "Registrar manualmente" (comportamento D-033).
 *
 *   - ON → botão primário "Estornar no Asaas" + seção secundária
 *     colapsada "Registrar manualmente (fallback)" pra casos onde o
 *     admin já fez no painel Asaas ou prefere anotar só.
 *     Se a tentativa Asaas falhar, a seção manual é AUTO-EXPANDIDA e
 *     pré-preenchida com as informações da falha.
 */
export function RefundForm({
  appointmentId,
  defaultNotes = "",
  asaasEnabled,
  hasAsaasPayment,
}: {
  appointmentId: string;
  defaultNotes?: string;
  asaasEnabled: boolean;
  hasAsaasPayment: boolean;
}) {
  const router = useRouter();
  const [externalRef, setExternalRef] = useState("");
  const [notes, setNotes] = useState(defaultNotes);
  const [busy, setBusy] = useState<null | "asaas" | "manual">(null);
  const [showManual, setShowManual] = useState(!asaasEnabled);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null
  );

  async function postRefund(
    method: "manual" | "asaas_api"
  ): Promise<{ ok: true; data: ApiOk } | { ok: false; data: ApiError; status: number }> {
    const bodyPayload: Record<string, unknown> = { method };
    if (method === "manual") {
      if (externalRef.trim()) bodyPayload.external_ref = externalRef.trim();
      if (notes.trim()) bodyPayload.notes = notes.trim();
    }

    const res = await fetch(
      `/api/admin/appointments/${appointmentId}/refund`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyPayload),
      }
    );
    const json = (await res.json().catch(() => ({}))) as ApiOk | ApiError;
    if (!res.ok || !("ok" in json && json.ok)) {
      return { ok: false, data: json as ApiError, status: res.status };
    }
    return { ok: true, data: json as ApiOk };
  }

  async function handleAsaas() {
    if (busy) return;
    setBusy("asaas");
    setMsg(null);
    const result = await postRefund("asaas_api");
    setBusy(null);

    if (result.ok) {
      setMsg({
        kind: "ok",
        text: result.data.already_processed
          ? "Já havia sido registrado."
          : "Estornado via Asaas e registrado.",
      });
      router.refresh();
      return;
    }

    // Falha do Asaas: abre o fallback manual com contexto
    const err = result.data;
    const friendly = friendlyErrorMessage(err, result.status);
    setMsg({
      kind: "err",
      text: `Asaas falhou: ${friendly}. Você pode registrar manualmente abaixo.`,
    });
    setShowManual(true);
    // Pre-fill manual form com algum contexto
    if (!notes.trim()) {
      setNotes(
        `Tentativa automática falhou: ${friendly}${
          err.asaas_code ? ` (asaas_code=${err.asaas_code})` : ""
        }. Processado manualmente.`
      );
    }
  }

  async function handleManual(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy("manual");
    setMsg(null);
    const result = await postRefund("manual");
    setBusy(null);

    if (result.ok) {
      setMsg({
        kind: "ok",
        text: result.data.already_processed
          ? "Já havia sido registrado."
          : "Registrado manualmente.",
      });
      router.refresh();
      return;
    }

    setMsg({
      kind: "err",
      text: friendlyErrorMessage(result.data, result.status),
    });
  }

  return (
    <div className="space-y-3">
      {asaasEnabled && (
        <div className="space-y-2">
          <button
            type="button"
            disabled={busy !== null || !hasAsaasPayment}
            onClick={handleAsaas}
            className="w-full rounded-xl bg-sage-700 hover:bg-sage-800 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium py-2.5 px-4 text-sm transition-colors"
          >
            {busy === "asaas"
              ? "Estornando via Asaas..."
              : "Estornar no Asaas"}
          </button>
          {!hasAsaasPayment && (
            <p className="text-xs text-terracotta-700">
              Sem payment Asaas vinculado. Só o fallback manual abaixo.
            </p>
          )}
          {hasAsaasPayment && (
            <p className="text-[0.7rem] text-ink-500">
              Full refund · descrição já preenchida com o id do appointment.
            </p>
          )}
          <button
            type="button"
            onClick={() => setShowManual((v) => !v)}
            className="text-xs text-ink-500 hover:text-ink-800 underline"
          >
            {showManual ? "ocultar" : "ou registrar manualmente (fallback)"}
          </button>
        </div>
      )}

      {showManual && (
        <form
          onSubmit={handleManual}
          className="space-y-3 rounded-xl border border-ink-100 p-3 bg-cream-50"
        >
          {asaasEnabled && (
            <p className="text-[0.7rem] uppercase tracking-[0.12em] text-ink-500 font-medium">
              Fallback manual
            </p>
          )}
          <div>
            <label className="block text-[0.7rem] uppercase tracking-[0.12em] text-ink-500 font-medium mb-1">
              Referência externa
            </label>
            <input
              type="text"
              value={externalRef}
              onChange={(e) => setExternalRef(e.target.value)}
              placeholder="rf_xxx ou end-to-end PIX"
              className="w-full rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-sage-500"
            />
            <p className="mt-1 text-[0.7rem] text-ink-400">
              Opcional, mas recomendado pra auditoria.
            </p>
          </div>
          <div>
            <label className="block text-[0.7rem] uppercase tracking-[0.12em] text-ink-500 font-medium mb-1">
              Notas
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="ex: paciente aceitou crédito pra reagendar"
              className="w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sage-500"
            />
          </div>
          <button
            type="submit"
            disabled={busy !== null}
            className={`w-full rounded-xl ${
              asaasEnabled
                ? "bg-ink-800 hover:bg-ink-900"
                : "bg-sage-700 hover:bg-sage-800"
            } disabled:opacity-50 text-white font-medium py-2 px-4 text-sm transition-colors`}
          >
            {busy === "manual"
              ? "Registrando..."
              : "Registrar manualmente"}
          </button>
        </form>
      )}

      {msg && (
        <p
          className={`text-sm ${
            msg.kind === "ok" ? "text-sage-700" : "text-terracotta-700"
          }`}
        >
          {msg.text}
        </p>
      )}
    </div>
  );
}

function friendlyErrorMessage(err: ApiError, httpStatus: number): string {
  if (err?.error) return err.error;
  if (err?.code) return `${err.code} (HTTP ${httpStatus})`;
  return `HTTP ${httpStatus}`;
}
