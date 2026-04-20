"use client";

/**
 * OfferForm — D-044 · 2.C.2
 *
 * Form do aceite formal + endereço + checkbox legal. Envia ao
 * endpoint `POST /api/paciente/fulfillments/[id]/accept` e, no
 * sucesso, redireciona pra invoice URL retornada.
 *
 * UX:
 *   - Endereço é pré-preenchido com o último endereço salvo do
 *     paciente (vindo de `customers.address_*`) — paciente só
 *     confirma. Se não tiver histórico, mostra form em branco.
 *   - CEP dispara busca ViaCEP automática quando chega a 8 dígitos.
 *   - Termo fica visível em <article> com scroll próprio; checkbox
 *     só libera o botão depois que o paciente marcar.
 *   - `acceptanceText` é PASSADO exatamente como o server renderizou
 *     — o mesmo texto que vai virar hash. Jamais re-renderizar no
 *     client.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AddressInput } from "@/lib/patient-address";

type Props = {
  fulfillmentId: string;
  acceptanceText: string;
  acceptanceTermsVersion: string;
  patientName: string;
  initialAddress: AddressInput | null;
  priceFormatted: string;
};

type FormState = {
  recipient_name: string;
  zipcode: string;
  street: string;
  number: string;
  complement: string;
  district: string;
  city: string;
  state: string;
};

type FieldErrors = Partial<Record<keyof AddressInput, string>>;

const INITIAL: FormState = {
  recipient_name: "",
  zipcode: "",
  street: "",
  number: "",
  complement: "",
  district: "",
  city: "",
  state: "",
};

function maskZipcode(v: string): string {
  const d = v.replace(/\D/g, "").slice(0, 8);
  return d.replace(/(\d{5})(\d{0,3}).*/, "$1-$2").replace(/-$/, "");
}

const BR_STATES = [
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA",
  "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN",
  "RS", "RO", "RR", "SC", "SP", "SE", "TO",
];

export function OfferForm({
  fulfillmentId,
  acceptanceText,
  acceptanceTermsVersion,
  patientName,
  initialAddress,
  priceFormatted,
}: Props) {
  const [form, setForm] = useState<FormState>(() => {
    if (initialAddress) {
      return {
        recipient_name: initialAddress.recipient_name ?? patientName,
        zipcode: maskZipcode(initialAddress.zipcode),
        street: initialAddress.street,
        number: initialAddress.number,
        complement: initialAddress.complement ?? "",
        district: initialAddress.district,
        city: initialAddress.city,
        state: initialAddress.state,
      };
    }
    return { ...INITIAL, recipient_name: patientName };
  });
  const [accepted, setAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cepLoading, setCepLoading] = useState(false);
  const [cepError, setCepError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const numberRef = useRef<HTMLInputElement>(null);

  // ViaCEP auto-complete
  useEffect(() => {
    const cep = form.zipcode.replace(/\D/g, "");
    if (cep.length !== 8) return;

    let cancelled = false;
    setCepLoading(true);
    setCepError(null);

    (async () => {
      try {
        const res = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
        const data = (await res.json()) as {
          erro?: boolean;
          logradouro?: string;
          bairro?: string;
          localidade?: string;
          uf?: string;
        };
        if (cancelled) return;
        if (data.erro) {
          setCepError("CEP não encontrado");
          return;
        }
        setForm((f) => ({
          ...f,
          street: data.logradouro ?? f.street,
          district: data.bairro ?? f.district,
          city: data.localidade ?? f.city,
          state: (data.uf ?? f.state).toUpperCase(),
        }));
        setTimeout(() => numberRef.current?.focus(), 50);
      } catch {
        if (!cancelled) setCepError("Falha ao consultar CEP");
      } finally {
        if (!cancelled) setCepLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [form.zipcode]);

  const update = useCallback(
    <K extends keyof FormState>(key: K, value: FormState[K]) => {
      setForm((f) => ({ ...f, [key]: value }));
      setFieldErrors((e) => {
        if (!(key in e)) return e;
        const next = { ...e };
        delete next[key as keyof AddressInput];
        return next;
      });
    },
    []
  );

  const canSubmit = useMemo(() => accepted && !submitting, [accepted, submitting]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setServerError(null);
    setFieldErrors({});

    try {
      const res = await fetch(
        `/api/paciente/fulfillments/${fulfillmentId}/accept`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            acceptance_text: acceptanceText,
            address: {
              recipient_name: form.recipient_name,
              zipcode: form.zipcode,
              street: form.street,
              number: form.number,
              complement: form.complement,
              district: form.district,
              city: form.city,
              state: form.state,
            },
          }),
        }
      );

      const data = (await res.json().catch(() => null)) as
        | {
            ok: boolean;
            error?: string;
            message?: string;
            addressErrors?: FieldErrors;
            invoiceUrl?: string | null;
          }
        | null;

      if (!data || !res.ok || !data.ok) {
        if (data?.addressErrors) setFieldErrors(data.addressErrors);
        setServerError(
          data?.message ??
            "Não foi possível concluir o aceite. Tente novamente."
        );
        return;
      }

      if (data.invoiceUrl) {
        window.location.href = data.invoiceUrl;
      } else {
        window.location.href = "/paciente";
      }
    } catch (err) {
      setServerError(
        err instanceof Error
          ? err.message
          : "Falha de rede. Tente novamente em alguns segundos."
      );
    } finally {
      setSubmitting(false);
    }
  }

  const inputClass =
    "w-full rounded-lg border border-ink-200 bg-white px-3.5 py-2.5 text-ink-800 focus:outline-none focus:ring-2 focus:ring-sage-400 focus:border-sage-400 transition-colors";
  const labelClass =
    "block text-[0.78rem] uppercase tracking-wide text-ink-500 mb-1.5";

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Termo */}
      <section className="rounded-2xl bg-white border border-ink-100 p-6 sm:p-7">
        <div className="flex items-baseline justify-between mb-3 gap-4">
          <h2 className="font-serif text-[1.25rem] text-ink-800">
            Termo de consentimento e contratação
          </h2>
          <span className="text-[0.72rem] uppercase tracking-wide text-ink-400">
            {acceptanceTermsVersion}
          </span>
        </div>

        <article
          className="max-h-[420px] overflow-y-auto whitespace-pre-wrap rounded-xl bg-cream-50 border border-cream-200 px-5 py-4 text-[0.92rem] leading-relaxed text-ink-700"
          aria-label="Texto integral do termo de contratação"
        >
          {acceptanceText}
        </article>

        <label className="mt-5 flex items-start gap-3 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
            className="mt-1 h-4 w-4 accent-sage-600"
          />
          <span className="text-sm text-ink-700 leading-relaxed">
            Li integralmente o termo acima, compreendi seus efeitos
            jurídicos e, por este ato, manifesto de forma livre,
            informada e inequívoca minha concordância com todas as
            suas disposições.
          </span>
        </label>
      </section>

      {/* Endereço */}
      <section className="rounded-2xl bg-white border border-ink-100 p-6 sm:p-7">
        <h2 className="font-serif text-[1.25rem] text-ink-800 mb-2">
          Endereço de entrega
        </h2>
        <p className="text-sm text-ink-500 mb-5">
          Após o pagamento, a clínica envia o medicamento manipulado
          pra este endereço. Seu endereço <strong>não</strong> é
          compartilhado com a farmácia de manipulação.
        </p>

        <div className="grid gap-5">
          <div>
            <label htmlFor="recipient_name" className={labelClass}>
              Destinatário
            </label>
            <input
              id="recipient_name"
              type="text"
              value={form.recipient_name}
              onChange={(e) => update("recipient_name", e.target.value)}
              className={inputClass}
              autoComplete="name"
              required
            />
            {fieldErrors.recipient_name && (
              <p className="mt-1.5 text-[0.78rem] text-terracotta-700">
                {fieldErrors.recipient_name}
              </p>
            )}
          </div>

          <div className="grid sm:grid-cols-[180px_1fr] gap-5">
            <div>
              <label htmlFor="zipcode" className={labelClass}>
                CEP
              </label>
              <input
                id="zipcode"
                inputMode="numeric"
                autoComplete="postal-code"
                value={form.zipcode}
                onChange={(e) => update("zipcode", maskZipcode(e.target.value))}
                className={inputClass}
                placeholder="00000-000"
                required
              />
              {cepLoading && (
                <p className="mt-1.5 text-[0.78rem] text-ink-400">
                  Buscando endereço…
                </p>
              )}
              {cepError && (
                <p className="mt-1.5 text-[0.78rem] text-terracotta-700">
                  {cepError}
                </p>
              )}
              {fieldErrors.zipcode && !cepError && (
                <p className="mt-1.5 text-[0.78rem] text-terracotta-700">
                  {fieldErrors.zipcode}
                </p>
              )}
            </div>

            <div>
              <label htmlFor="street" className={labelClass}>
                Logradouro
              </label>
              <input
                id="street"
                type="text"
                value={form.street}
                onChange={(e) => update("street", e.target.value)}
                className={inputClass}
                autoComplete="address-line1"
                required
              />
              {fieldErrors.street && (
                <p className="mt-1.5 text-[0.78rem] text-terracotta-700">
                  {fieldErrors.street}
                </p>
              )}
            </div>
          </div>

          <div className="grid sm:grid-cols-[140px_1fr] gap-5">
            <div>
              <label htmlFor="number" className={labelClass}>
                Número
              </label>
              <input
                id="number"
                ref={numberRef}
                type="text"
                value={form.number}
                onChange={(e) => update("number", e.target.value)}
                className={inputClass}
                required
              />
              {fieldErrors.number && (
                <p className="mt-1.5 text-[0.78rem] text-terracotta-700">
                  {fieldErrors.number}
                </p>
              )}
            </div>

            <div>
              <label htmlFor="complement" className={labelClass}>
                Complemento <span className="text-ink-400">(opcional)</span>
              </label>
              <input
                id="complement"
                type="text"
                value={form.complement}
                onChange={(e) => update("complement", e.target.value)}
                className={inputClass}
                autoComplete="address-line2"
              />
            </div>
          </div>

          <div>
            <label htmlFor="district" className={labelClass}>
              Bairro
            </label>
            <input
              id="district"
              type="text"
              value={form.district}
              onChange={(e) => update("district", e.target.value)}
              className={inputClass}
              required
            />
            {fieldErrors.district && (
              <p className="mt-1.5 text-[0.78rem] text-terracotta-700">
                {fieldErrors.district}
              </p>
            )}
          </div>

          <div className="grid sm:grid-cols-[1fr_140px] gap-5">
            <div>
              <label htmlFor="city" className={labelClass}>
                Cidade
              </label>
              <input
                id="city"
                type="text"
                value={form.city}
                onChange={(e) => update("city", e.target.value)}
                className={inputClass}
                autoComplete="address-level2"
                required
              />
              {fieldErrors.city && (
                <p className="mt-1.5 text-[0.78rem] text-terracotta-700">
                  {fieldErrors.city}
                </p>
              )}
            </div>

            <div>
              <label htmlFor="state" className={labelClass}>
                UF
              </label>
              <select
                id="state"
                value={form.state}
                onChange={(e) => update("state", e.target.value)}
                className={inputClass}
                required
              >
                <option value="">—</option>
                {BR_STATES.map((uf) => (
                  <option key={uf} value={uf}>
                    {uf}
                  </option>
                ))}
              </select>
              {fieldErrors.state && (
                <p className="mt-1.5 text-[0.78rem] text-terracotta-700">
                  {fieldErrors.state}
                </p>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Submit */}
      <div className="rounded-2xl bg-white border border-ink-100 p-6 sm:p-7">
        <div className="flex flex-wrap items-baseline justify-between gap-3 mb-4">
          <p className="text-sm text-ink-500">Total à vista</p>
          <p className="font-serif text-[1.6rem] text-ink-800">
            {priceFormatted}
          </p>
        </div>

        {serverError && (
          <div className="mb-4 rounded-lg border border-terracotta-300 bg-terracotta-50 px-4 py-3 text-sm text-terracotta-800">
            {serverError}
          </div>
        )}

        <button
          type="submit"
          disabled={!canSubmit}
          className="w-full sm:w-auto inline-flex items-center justify-center rounded-xl bg-ink-900 hover:bg-ink-800 disabled:bg-ink-300 disabled:cursor-not-allowed text-white text-base font-semibold px-6 py-3 transition-colors shadow-sm"
        >
          {submitting ? "Processando…" : "Aceito e ir para pagamento →"}
        </button>
        <p className="mt-3 text-xs text-ink-500">
          Ao clicar, seu aceite fica registrado em nossos sistemas e
          você é redirecionada pro ambiente seguro de pagamento.
        </p>
      </div>
    </form>
  );
}
