"use client";

/**
 * EditShippingDrawer — D-045 · 3.E
 *
 * Drawer inline pra paciente editar o endereço operacional do
 * fulfillment quando status=`paid` (após aceite, antes da farmácia
 * ser acionada). Reaproveita `ViaCEP` pra preenchimento automático.
 *
 * Notas:
 *   - NÃO altera o snapshot de `plan_acceptances` (legal, imutável).
 *     Mostra um aviso discreto explicando isso.
 *   - Envia PUT `/api/paciente/fulfillments/[id]/shipping` com o
 *     objeto `shipping`. Server valida, audita e devolve status.
 *   - Em caso de erro 409 (`invalid_status`), a probabilidade é de
 *     que a clínica acabou de acionar a farmácia. Orientamos contato.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

type FieldErrors = Partial<
  Record<
    | "recipient_name"
    | "zipcode"
    | "street"
    | "number"
    | "complement"
    | "district"
    | "city"
    | "state",
    string
  >
>;

type Props = {
  fulfillmentId: string;
  defaultAddress?: {
    recipient_name?: string | null;
    zipcode?: string | null;
    street?: string | null;
    number?: string | null;
    complement?: string | null;
    district?: string | null;
    city?: string | null;
    state?: string | null;
  } | null;
  onClose: () => void;
};

function maskZipcode(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 5) return digits;
  return `${digits.slice(0, 5)}-${digits.slice(5)}`;
}

export function EditShippingDrawer({
  fulfillmentId,
  defaultAddress,
  onClose,
}: Props) {
  const router = useRouter();
  const [form, setForm] = useState({
    recipient_name: defaultAddress?.recipient_name ?? "",
    zipcode: defaultAddress?.zipcode
      ? maskZipcode(defaultAddress.zipcode)
      : "",
    street: defaultAddress?.street ?? "",
    number: defaultAddress?.number ?? "",
    complement: defaultAddress?.complement ?? "",
    district: defaultAddress?.district ?? "",
    city: defaultAddress?.city ?? "",
    state: defaultAddress?.state ?? "",
  });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [lookingUpCep, setLookingUpCep] = useState(false);

  function updateField<K extends keyof typeof form>(
    key: K,
    value: string
  ): void {
    setForm((f) => ({ ...f, [key]: value }));
    if (fieldErrors[key as keyof FieldErrors]) {
      setFieldErrors((fe) => ({ ...fe, [key]: undefined }));
    }
  }

  // PR-035 · audit [22.1]: consulta passa pelo proxy server-side
  // `/api/cep/[cep]` (charset/length validados antes de voltar).
  async function lookupCep(raw: string) {
    const digits = raw.replace(/\D/g, "");
    if (digits.length !== 8) return;
    setLookingUpCep(true);
    try {
      const res = await fetch(`/api/cep/${digits}`);
      const data = (await res.json().catch(() => null)) as
        | {
            ok: boolean;
            street?: string;
            district?: string;
            city?: string;
            state?: string;
          }
        | null;
      if (!data || !res.ok || !data.ok) return;
      setForm((f) => ({
        ...f,
        street: data.street || f.street,
        district: data.district || f.district,
        city: data.city || f.city,
        state: data.state || f.state,
      }));
    } catch {
      // ignora — usuário pode digitar manualmente
    } finally {
      setLookingUpCep(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setGlobalError(null);
    setFieldErrors({});

    try {
      const res = await fetch(
        `/api/paciente/fulfillments/${fulfillmentId}/shipping`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shipping: form }),
        }
      );
      const data = (await res.json().catch(() => null)) as {
        ok: boolean;
        message?: string;
        fieldErrors?: FieldErrors;
      } | null;

      if (!res.ok || !data?.ok) {
        if (data?.fieldErrors) setFieldErrors(data.fieldErrors);
        setGlobalError(
          data?.message ??
            "Não conseguimos salvar agora. Tente de novo em um instante."
        );
        return;
      }
      router.refresh();
      onClose();
    } catch (e) {
      setGlobalError(e instanceof Error ? e.message : "Falha de rede.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-ink-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h4 className="text-sm font-medium text-ink-800">
            Editar endereço de entrega
          </h4>
          <p className="text-xs text-ink-500 mt-0.5">
            Só antes de enviarmos a prescrição pra farmácia. Depois disso,
            a gente ajusta manualmente — fala com a equipe.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-ink-500 hover:text-ink-800"
          aria-label="Fechar"
        >
          ✕
        </button>
      </div>

      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="block text-xs text-ink-600">
            Nome do destinatário
            <input
              type="text"
              value={form.recipient_name}
              onChange={(e) =>
                updateField("recipient_name", e.target.value)
              }
              className="mt-1 block w-full rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-800 focus:outline-none focus:ring-2 focus:ring-ink-400"
              disabled={submitting}
              placeholder="Deixe em branco pra usar seu nome"
            />
          </label>
          {fieldErrors.recipient_name && (
            <p className="mt-1 text-xs text-terracotta-700">
              {fieldErrors.recipient_name}
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-[1fr_2fr] gap-3">
          <div>
            <label className="block text-xs text-ink-600">
              CEP
              <input
                type="text"
                inputMode="numeric"
                value={form.zipcode}
                onChange={(e) => {
                  const v = maskZipcode(e.target.value);
                  updateField("zipcode", v);
                  if (v.replace(/\D/g, "").length === 8) void lookupCep(v);
                }}
                className="mt-1 block w-full rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-800 focus:outline-none focus:ring-2 focus:ring-ink-400"
                disabled={submitting}
                placeholder="00000-000"
                maxLength={9}
              />
            </label>
            {lookingUpCep && (
              <p className="mt-1 text-xs text-ink-500">Buscando CEP…</p>
            )}
            {fieldErrors.zipcode && (
              <p className="mt-1 text-xs text-terracotta-700">
                {fieldErrors.zipcode}
              </p>
            )}
          </div>

          <div>
            <label className="block text-xs text-ink-600">
              Rua / Avenida
              <input
                type="text"
                value={form.street}
                onChange={(e) => updateField("street", e.target.value)}
                className="mt-1 block w-full rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-800 focus:outline-none focus:ring-2 focus:ring-ink-400"
                disabled={submitting}
              />
            </label>
            {fieldErrors.street && (
              <p className="mt-1 text-xs text-terracotta-700">
                {fieldErrors.street}
              </p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-[1fr_2fr] gap-3">
          <div>
            <label className="block text-xs text-ink-600">
              Número
              <input
                type="text"
                value={form.number}
                onChange={(e) => updateField("number", e.target.value)}
                className="mt-1 block w-full rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-800 focus:outline-none focus:ring-2 focus:ring-ink-400"
                disabled={submitting}
                placeholder="S/N se não houver"
              />
            </label>
            {fieldErrors.number && (
              <p className="mt-1 text-xs text-terracotta-700">
                {fieldErrors.number}
              </p>
            )}
          </div>
          <div>
            <label className="block text-xs text-ink-600">
              Complemento (opcional)
              <input
                type="text"
                value={form.complement}
                onChange={(e) => updateField("complement", e.target.value)}
                className="mt-1 block w-full rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-800 focus:outline-none focus:ring-2 focus:ring-ink-400"
                disabled={submitting}
                placeholder="Apto, bloco, referência…"
              />
            </label>
          </div>
        </div>

        <div>
          <label className="block text-xs text-ink-600">
            Bairro
            <input
              type="text"
              value={form.district}
              onChange={(e) => updateField("district", e.target.value)}
              className="mt-1 block w-full rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-800 focus:outline-none focus:ring-2 focus:ring-ink-400"
              disabled={submitting}
            />
          </label>
          {fieldErrors.district && (
            <p className="mt-1 text-xs text-terracotta-700">
              {fieldErrors.district}
            </p>
          )}
        </div>

        <div className="grid grid-cols-[2fr_1fr] gap-3">
          <div>
            <label className="block text-xs text-ink-600">
              Cidade
              <input
                type="text"
                value={form.city}
                onChange={(e) => updateField("city", e.target.value)}
                className="mt-1 block w-full rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-800 focus:outline-none focus:ring-2 focus:ring-ink-400"
                disabled={submitting}
              />
            </label>
            {fieldErrors.city && (
              <p className="mt-1 text-xs text-terracotta-700">
                {fieldErrors.city}
              </p>
            )}
          </div>
          <div>
            <label className="block text-xs text-ink-600">
              UF
              <input
                type="text"
                value={form.state}
                onChange={(e) =>
                  updateField(
                    "state",
                    e.target.value.toUpperCase().slice(0, 2)
                  )
                }
                maxLength={2}
                className="mt-1 block w-full rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-800 focus:outline-none focus:ring-2 focus:ring-ink-400 uppercase"
                disabled={submitting}
                placeholder="SP"
              />
            </label>
            {fieldErrors.state && (
              <p className="mt-1 text-xs text-terracotta-700">
                {fieldErrors.state}
              </p>
            )}
          </div>
        </div>

        <p className="text-xs text-ink-500 leading-relaxed">
          O endereço que você aceitou nos termos continua registrado como
          prova legal. Esta edição afeta apenas o envio operacional.
        </p>

        {globalError && (
          <p className="text-sm text-terracotta-700">{globalError}</p>
        )}

        <div className="flex gap-2 justify-end pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="inline-flex items-center rounded-xl border border-ink-200 text-ink-700 hover:bg-cream-50 text-sm font-medium px-4 py-2 transition-colors"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center rounded-xl bg-ink-900 hover:bg-ink-800 disabled:bg-ink-300 disabled:cursor-not-allowed text-white text-sm font-semibold px-5 py-2 transition-colors shadow-sm"
          >
            {submitting ? "Salvando…" : "Salvar novo endereço"}
          </button>
        </div>
      </form>
    </div>
  );
}
