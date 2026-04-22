"use client";

/**
 * _AtualizarForm — PR-056 · D-067
 *
 * Client component isolado (o parent é server component) que
 * encapsula o form de atualização de PII. Padrão herdado do
 * `_EditShippingDrawer` (ViaCEP via proxy `/api/cep/[cep]`,
 * estado local, fieldErrors vindo do server).
 *
 * Contrato:
 *   - Defaults chegam do server component (zero flash).
 *   - Submit vai pra POST /api/paciente/meus-dados/atualizar.
 *   - Em sucesso: mostra feedback + router.refresh() pra atualizar o
 *     resumo no /paciente/meus-dados.
 *   - Em erro 409 (`anonymized`): mostra mensagem e trava form
 *     (cenário não deve acontecer — a page já renderizou readonly
 *     nesse caso — mas defendemos ainda assim).
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type FieldErrors = Partial<
  Record<
    | "name"
    | "email"
    | "phone"
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

export type AtualizarFormDefaults = {
  name: string;
  email: string;
  phone: string;
  address: {
    zipcode: string;
    street: string;
    number: string;
    complement: string;
    district: string;
    city: string;
    state: string;
  };
};

function maskZipcode(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 5) return digits;
  return `${digits.slice(0, 5)}-${digits.slice(5)}`;
}

function maskPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 11);
  if (digits.length <= 2) return digits;
  if (digits.length <= 6) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  if (digits.length <= 10) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  }
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
}

export function AtualizarForm({
  defaults,
}: {
  defaults: AtualizarFormDefaults;
}) {
  const router = useRouter();
  const [form, setForm] = useState({
    name: defaults.name,
    email: defaults.email,
    phone: defaults.phone ? maskPhone(defaults.phone) : "",
    zipcode: defaults.address.zipcode
      ? maskZipcode(defaults.address.zipcode)
      : "",
    street: defaults.address.street,
    number: defaults.address.number,
    complement: defaults.address.complement,
    district: defaults.address.district,
    city: defaults.address.city,
    state: defaults.address.state,
  });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [lookingUpCep, setLookingUpCep] = useState(false);
  const [, startTransition] = useTransition();

  function updateField<K extends keyof typeof form>(
    key: K,
    value: string
  ): void {
    setForm((f) => ({ ...f, [key]: value }));
    setSuccessMsg(null);
    if (fieldErrors[key as keyof FieldErrors]) {
      setFieldErrors((fe) => ({ ...fe, [key]: undefined }));
    }
  }

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
      // ignora — paciente pode digitar manualmente
    } finally {
      setLookingUpCep(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setGlobalError(null);
    setSuccessMsg(null);
    setFieldErrors({});

    try {
      const res = await fetch("/api/paciente/meus-dados/atualizar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          email: form.email,
          phone: form.phone,
          address: {
            zipcode: form.zipcode,
            street: form.street,
            number: form.number,
            complement: form.complement,
            district: form.district,
            city: form.city,
            state: form.state,
          },
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        ok: boolean;
        error?: string;
        fieldErrors?: FieldErrors;
        updated?: boolean;
        changedFields?: string[];
      } | null;

      if (!res.ok || !data?.ok) {
        if (data?.fieldErrors) setFieldErrors(data.fieldErrors);
        if (data?.error === "anonymized") {
          setGlobalError(
            "Sua conta foi anonimizada — não é possível editar."
          );
        } else {
          setGlobalError(
            data?.error === "validation_failed"
              ? "Revise os campos destacados."
              : "Não conseguimos salvar agora. Tente de novo em instantes."
          );
        }
        return;
      }
      setSuccessMsg(
        data.updated
          ? "Dados atualizados com sucesso."
          : "Nada para atualizar — seus dados já estavam em dia."
      );
      startTransition(() => router.refresh());
    } catch (err) {
      setGlobalError(
        err instanceof Error ? err.message : "Falha de rede."
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-2xl border border-ink-100 bg-white p-6 space-y-5"
    >
      <h2 className="font-serif text-[1.25rem] text-ink-800">
        Dados de contato
      </h2>

      <div>
        <label className="block text-xs text-ink-600">
          Nome completo
          <input
            type="text"
            value={form.name}
            onChange={(e) => updateField("name", e.target.value)}
            className="mt-1 block w-full rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-800 focus:outline-none focus:ring-2 focus:ring-ink-400"
            disabled={submitting}
            maxLength={120}
          />
        </label>
        {fieldErrors.name && (
          <p className="mt-1 text-xs text-terracotta-700">
            {fieldErrors.name}
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-ink-600">
            E-mail
            <input
              type="email"
              value={form.email}
              onChange={(e) => updateField("email", e.target.value)}
              className="mt-1 block w-full rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-800 focus:outline-none focus:ring-2 focus:ring-ink-400"
              disabled={submitting}
              maxLength={254}
              autoComplete="email"
            />
          </label>
          {fieldErrors.email && (
            <p className="mt-1 text-xs text-terracotta-700">
              {fieldErrors.email}
            </p>
          )}
        </div>
        <div>
          <label className="block text-xs text-ink-600">
            Telefone
            <input
              type="tel"
              value={form.phone}
              onChange={(e) =>
                updateField("phone", maskPhone(e.target.value))
              }
              className="mt-1 block w-full rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-800 focus:outline-none focus:ring-2 focus:ring-ink-400"
              disabled={submitting}
              placeholder="(11) 99999-0000"
              autoComplete="tel"
            />
          </label>
          {fieldErrors.phone && (
            <p className="mt-1 text-xs text-terracotta-700">
              {fieldErrors.phone}
            </p>
          )}
        </div>
      </div>

      <hr className="border-ink-100" />

      <h2 className="font-serif text-[1.25rem] text-ink-800">
        Endereço de entrega
      </h2>
      <p className="text-xs text-ink-500 -mt-3">
        Para onde enviamos a medicação manipulada.
      </p>

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
              autoComplete="postal-code"
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
              autoComplete="address-line1"
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
              autoComplete="address-line2"
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
              autoComplete="address-level2"
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
              autoComplete="address-level1"
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
        Atualizações ficam registradas no seu histórico de acesso
        (LGPD Art. 37). Prescrições médicas e aceites já emitidos
        continuam intactos — esta edição afeta apenas o cadastro e
        os próximos envios/comunicações.
      </p>

      {globalError && (
        <p className="text-sm text-terracotta-700">{globalError}</p>
      )}
      {successMsg && (
        <p className="text-sm text-sage-800 font-medium">{successMsg}</p>
      )}

      <div className="flex gap-2 justify-end pt-1">
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex items-center rounded-xl bg-ink-900 hover:bg-ink-800 disabled:bg-ink-300 disabled:cursor-not-allowed text-white text-sm font-semibold px-5 py-2 transition-colors shadow-sm"
        >
          {submitting ? "Salvando…" : "Salvar alterações"}
        </button>
      </div>
    </form>
  );
}
