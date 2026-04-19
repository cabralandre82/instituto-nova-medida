"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export type CheckoutPlan = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  medication: string | null;
  cycle_days: number;
  price_cents: number;
  price_pix_cents: number;
};

type PaymentMethod = "pix" | "boleto" | "cartao";

type FormState = {
  name: string;
  cpf: string;
  email: string;
  phone: string;
  zipcode: string;
  street: string;
  number: string;
  complement: string;
  district: string;
  city: string;
  state: string;
  consent: boolean;
  paymentMethod: PaymentMethod;
};

const INITIAL: FormState = {
  name: "",
  cpf: "",
  email: "",
  phone: "",
  zipcode: "",
  street: "",
  number: "",
  complement: "",
  district: "",
  city: "",
  state: "",
  consent: false,
  paymentMethod: "pix",
};

// ────────────────────────────────────────────────────────────────────────────
// Helpers de máscara e validação (próprios — sem libs pra manter bundle leve)
// ────────────────────────────────────────────────────────────────────────────

function maskCpf(v: string) {
  const d = v.replace(/\D/g, "").slice(0, 11);
  return d
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d{1,2})$/, "$1-$2");
}

function maskPhone(v: string) {
  const d = v.replace(/\D/g, "").slice(0, 11);
  if (d.length <= 10) {
    return d.replace(/(\d{2})(\d{4})(\d{0,4}).*/, "($1) $2-$3").trim();
  }
  return d.replace(/(\d{2})(\d{5})(\d{0,4}).*/, "($1) $2-$3").trim();
}

function maskZipcode(v: string) {
  const d = v.replace(/\D/g, "").slice(0, 8);
  return d.replace(/(\d{5})(\d{0,3}).*/, "$1-$2").replace(/-$/, "");
}

/**
 * Valida CPF pelo algoritmo dos dígitos verificadores. Não confia em
 * regex sozinha porque "111.111.111-11" passaria.
 */
function isValidCpf(cpf: string): boolean {
  const c = cpf.replace(/\D/g, "");
  if (c.length !== 11) return false;
  if (/^(\d)\1+$/.test(c)) return false;

  const digits = c.split("").map(Number);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += digits[i] * (10 - i);
  let r = (sum * 10) % 11;
  if (r === 10) r = 0;
  if (r !== digits[9]) return false;

  sum = 0;
  for (let i = 0; i < 10; i++) sum += digits[i] * (11 - i);
  r = (sum * 10) % 11;
  if (r === 10) r = 0;
  return r === digits[10];
}

const BRL_FORMAT = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatBRL(cents: number) {
  return BRL_FORMAT.format(cents / 100);
}

// ────────────────────────────────────────────────────────────────────────────
// Componente principal
// ────────────────────────────────────────────────────────────────────────────

export function CheckoutForm({ plan }: { plan: CheckoutPlan }) {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(INITIAL);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [cepLoading, setCepLoading] = useState(false);
  const [cepError, setCepError] = useState<string | null>(null);
  const numberRef = useRef<HTMLInputElement>(null);

  // Pré-preenche nome/telefone se o usuário já passou pelo quiz nesta sessão.
  // Isso reduz fricção para quem já capturamos o lead — eles só precisam
  // completar CPF, email e endereço.
  useEffect(() => {
    try {
      const name = localStorage.getItem("inm_lead_name");
      const phone = localStorage.getItem("inm_lead_phone");
      setForm((f) => ({
        ...f,
        name: f.name || name || "",
        phone: f.phone || (phone ? maskPhone(phone) : ""),
      }));
    } catch {}
  }, []);

  // Valor a cobrar varia por método de pagamento
  const amountCents = useMemo(() => {
    return form.paymentMethod === "cartao"
      ? plan.price_cents
      : plan.price_pix_cents;
  }, [form.paymentMethod, plan]);

  // Auto-preencher endereço quando o CEP estiver completo (ViaCEP)
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
          street: data.logradouro || f.street,
          district: data.bairro || f.district,
          city: data.localidade || f.city,
          state: data.uf || f.state,
        }));
        // Foca no campo "número" pra fluir mais rápido
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

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function clientValidation(): string | null {
    if (form.name.trim().length < 3) return "Informe seu nome completo.";
    if (!isValidCpf(form.cpf)) return "CPF inválido. Confira os dígitos.";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email))
      return "Email inválido.";
    if (form.phone.replace(/\D/g, "").length < 10)
      return "Telefone inválido. Use o formato (DDD) número.";
    if (form.zipcode.replace(/\D/g, "").length !== 8)
      return "Informe um CEP válido (8 dígitos).";
    if (form.street.trim().length < 3) return "Informe o nome da rua.";
    if (form.number.trim().length < 1) return "Informe o número do endereço.";
    if (form.district.trim().length < 2) return "Informe o bairro.";
    if (form.city.trim().length < 2) return "Informe a cidade.";
    if (form.state.trim().length !== 2) return "UF inválida.";
    if (!form.consent)
      return "É necessário aceitar os Termos e a Política de Privacidade.";
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);

    const errMsg = clientValidation();
    if (errMsg) {
      setServerError(errMsg);
      return;
    }

    setSubmitting(true);
    try {
      // Recupera leadId opcional do localStorage (quem veio do quiz)
      let leadId: string | null = null;
      try {
        leadId = localStorage.getItem("inm_lead_id");
      } catch {
        leadId = null;
      }

      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planSlug: plan.slug,
          paymentMethod: form.paymentMethod,
          name: form.name,
          cpf: form.cpf,
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
          consent: form.consent,
          leadId,
        }),
      });

      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        details?: string;
        invoiceUrl?: string;
        paymentId?: string;
        method?: PaymentMethod;
      };

      if (!res.ok || !data.ok) {
        setServerError(
          data.error
            ? data.details
              ? `${data.error} — ${data.details}`
              : data.error
            : "Não foi possível gerar a cobrança. Tente novamente."
        );
        setSubmitting(false);
        return;
      }

      // Salva o id local pra exibir nas páginas de status
      try {
        if (data.paymentId) {
          localStorage.setItem("inm_last_payment_id", data.paymentId);
        }
      } catch {
        // localStorage indisponível, ok
      }

      // Cartão é cobrança imediata na invoice → sucesso ou erro vão acontecer
      // na página hospedada. PIX/boleto vão pra "aguardando".
      if (data.invoiceUrl) {
        // Redireciona pra invoice hospedada do Asaas
        window.location.href = data.invoiceUrl;
        return;
      }

      // Fallback: sem invoiceUrl, vai pra "aguardando" interna
      router.push(
        form.paymentMethod === "cartao"
          ? "/checkout/sucesso"
          : "/checkout/aguardando"
      );
    } catch {
      setServerError(
        "Falha de conexão. Verifique sua internet e tente novamente."
      );
      setSubmitting(false);
    }
  }

  return (
    <div className="grid lg:grid-cols-[1fr_360px] gap-8 lg:gap-12 items-start">
      {/* Form ─────────────────────────────────────────────────────────── */}
      <form
        onSubmit={handleSubmit}
        className="space-y-8 bg-cream-50 border border-ink-100 rounded-3xl p-6 sm:p-8 lg:p-10"
        noValidate
      >
        {/* Bloco 1 — Identificação */}
        <fieldset className="space-y-5">
          <legend className="font-serif text-[1.25rem] text-ink-800 mb-1">
            Seus dados
          </legend>
          <Field label="Nome completo" htmlFor="name">
            <input
              id="name"
              type="text"
              autoComplete="name"
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
              className={inputClass}
              placeholder="Como aparece no seu documento"
              required
            />
          </Field>
          <div className="grid sm:grid-cols-2 gap-5">
            <Field label="CPF" htmlFor="cpf">
              <input
                id="cpf"
                inputMode="numeric"
                value={form.cpf}
                onChange={(e) => update("cpf", maskCpf(e.target.value))}
                className={inputClass}
                placeholder="000.000.000-00"
                required
              />
            </Field>
            <Field label="WhatsApp" htmlFor="phone">
              <input
                id="phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                value={form.phone}
                onChange={(e) => update("phone", maskPhone(e.target.value))}
                className={inputClass}
                placeholder="(21) 99999-0000"
                required
              />
            </Field>
          </div>
          <Field label="Email" htmlFor="email">
            <input
              id="email"
              type="email"
              autoComplete="email"
              value={form.email}
              onChange={(e) => update("email", e.target.value)}
              className={inputClass}
              placeholder="seu@email.com"
              required
            />
          </Field>
        </fieldset>

        {/* Bloco 2 — Endereço de entrega */}
        <fieldset className="space-y-5">
          <legend className="font-serif text-[1.25rem] text-ink-800 mb-1">
            Endereço de entrega
          </legend>
          <p className="text-[0.88rem] text-ink-400 -mt-3 mb-2">
            Para envio do medicamento manipulado em embalagem refrigerada.
          </p>

          <div className="grid sm:grid-cols-[180px_1fr] gap-5">
            <Field label="CEP" htmlFor="zipcode">
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
            </Field>
            <Field label="Rua / Logradouro" htmlFor="street">
              <input
                id="street"
                autoComplete="address-line1"
                value={form.street}
                onChange={(e) => update("street", e.target.value)}
                className={inputClass}
                required
              />
            </Field>
          </div>

          <div className="grid sm:grid-cols-[140px_1fr] gap-5">
            <Field label="Número" htmlFor="number">
              <input
                id="number"
                ref={numberRef}
                value={form.number}
                onChange={(e) => update("number", e.target.value)}
                className={inputClass}
                required
              />
            </Field>
            <Field label="Complemento (opcional)" htmlFor="complement">
              <input
                id="complement"
                value={form.complement}
                onChange={(e) => update("complement", e.target.value)}
                className={inputClass}
                placeholder="Apto, bloco, ponto de referência…"
              />
            </Field>
          </div>

          <Field label="Bairro" htmlFor="district">
            <input
              id="district"
              autoComplete="address-level3"
              value={form.district}
              onChange={(e) => update("district", e.target.value)}
              className={inputClass}
              required
            />
          </Field>

          <div className="grid sm:grid-cols-[1fr_120px] gap-5">
            <Field label="Cidade" htmlFor="city">
              <input
                id="city"
                autoComplete="address-level2"
                value={form.city}
                onChange={(e) => update("city", e.target.value)}
                className={inputClass}
                required
              />
            </Field>
            <Field label="UF" htmlFor="state">
              <input
                id="state"
                autoComplete="address-level1"
                value={form.state}
                onChange={(e) =>
                  update("state", e.target.value.toUpperCase().slice(0, 2))
                }
                className={inputClass}
                placeholder="RJ"
                required
              />
            </Field>
          </div>
        </fieldset>

        {/* Bloco 3 — Forma de pagamento */}
        <fieldset className="space-y-3">
          <legend className="font-serif text-[1.25rem] text-ink-800 mb-2">
            Como prefere pagar?
          </legend>
          <div className="grid gap-3">
            <PaymentOption
              checked={form.paymentMethod === "pix"}
              onChange={() => update("paymentMethod", "pix")}
              title="PIX"
              tag={`${formatBRL(plan.price_pix_cents)} à vista`}
              tagAccent
              hint="Pagamento instantâneo, com 10% de desconto. QR Code gerado na próxima tela."
            />
            <PaymentOption
              checked={form.paymentMethod === "cartao"}
              onChange={() => update("paymentMethod", "cartao")}
              title="Cartão de crédito"
              tag={`${formatBRL(plan.price_cents)} em 3x sem juros`}
              hint="Visa, Master, Elo, Hiper, Amex. Aprovação em segundos."
            />
            <PaymentOption
              checked={form.paymentMethod === "boleto"}
              onChange={() => update("paymentMethod", "boleto")}
              title="Boleto bancário"
              tag={`${formatBRL(plan.price_pix_cents)} à vista`}
              tagAccent
              hint="Vencimento em 3 dias úteis, com 10% de desconto."
            />
          </div>
        </fieldset>

        {/* Bloco 4 — Termos */}
        <div className="rounded-2xl bg-cream-200/60 px-5 py-4 sm:px-6 sm:py-5">
          <label className="flex gap-3 cursor-pointer items-start">
            <input
              type="checkbox"
              checked={form.consent}
              onChange={(e) => update("consent", e.target.checked)}
              className="mt-1 h-4 w-4 accent-sage-700"
              required
            />
            <span className="text-[0.92rem] leading-[1.55] text-ink-600">
              Li e concordo com os{" "}
              <Link
                href="/termos"
                target="_blank"
                className="text-sage-700 hover:text-sage-800 underline underline-offset-2"
              >
                Termos de Uso
              </Link>{" "}
              e a{" "}
              <Link
                href="/privacidade"
                target="_blank"
                className="text-sage-700 hover:text-sage-800 underline underline-offset-2"
              >
                Política de Privacidade
              </Link>
              . Autorizo o tratamento dos meus dados pessoais e de saúde nos
              termos da LGPD para a finalidade da contratação deste plano.
            </span>
          </label>
        </div>

        {serverError && (
          <div
            role="alert"
            className="rounded-2xl border border-terracotta-200 bg-terracotta-50 px-5 py-4 text-[0.93rem] leading-[1.5] text-terracotta-800"
          >
            {serverError}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full inline-flex items-center justify-center gap-2 rounded-full bg-sage-700 hover:bg-sage-800 text-cream-100 font-medium px-6 py-4 text-[1rem] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {submitting ? (
            <>
              <Spinner /> Gerando sua cobrança…
            </>
          ) : (
            <>
              Continuar para o pagamento
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path
                  d="M3 7H11M11 7L7 3M11 7L7 11"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </>
          )}
        </button>

        <p className="text-center text-[0.82rem] text-ink-400">
          Pagamento processado pela Asaas em ambiente seguro. Não armazenamos
          dados do seu cartão.
        </p>
      </form>

      {/* Resumo lateral ───────────────────────────────────────────────── */}
      <aside className="lg:sticky lg:top-20 bg-ink-800 text-cream-100 rounded-3xl p-7 lg:p-8 space-y-5">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-cream-100/60 font-medium">
          Seu plano
        </p>
        <div>
          <h2 className="font-serif text-[1.6rem] leading-tight text-cream-100">
            {plan.name}
          </h2>
          {plan.medication && (
            <p className="mt-1 text-[0.88rem] text-cream-100/70">
              {plan.medication}
            </p>
          )}
        </div>

        <div className="border-t border-cream-100/15 pt-5">
          <div className="flex justify-between text-[0.92rem] text-cream-100/80">
            <span>Ciclo de tratamento</span>
            <span>{plan.cycle_days} dias</span>
          </div>
          <div className="mt-2 flex justify-between text-[0.92rem] text-cream-100/80">
            <span>Forma de pagamento</span>
            <span className="capitalize">{form.paymentMethod}</span>
          </div>
          {form.paymentMethod === "cartao" && (
            <div className="mt-2 flex justify-between text-[0.92rem] text-cream-100/80">
              <span>Parcelamento</span>
              <span>3x sem juros</span>
            </div>
          )}
          {(form.paymentMethod === "pix" || form.paymentMethod === "boleto") && (
            <div className="mt-2 flex justify-between text-[0.92rem] text-terracotta-200">
              <span>Desconto à vista</span>
              <span>– {formatBRL(plan.price_cents - plan.price_pix_cents)}</span>
            </div>
          )}
        </div>

        <div className="border-t border-cream-100/15 pt-5">
          <div className="flex justify-between items-baseline">
            <span className="text-[0.85rem] text-cream-100/70">Total a pagar</span>
            <span className="font-serif text-[2rem] leading-none">
              {formatBRL(amountCents)}
            </span>
          </div>
          {form.paymentMethod === "cartao" && (
            <p className="mt-2 text-[0.82rem] text-cream-100/60">
              ou 3x de {formatBRL(plan.price_cents / 3)}
            </p>
          )}
        </div>

        <ul className="border-t border-cream-100/15 pt-5 space-y-2.5 text-[0.88rem] text-cream-100/80">
          <li className="flex gap-2.5 items-start">
            <CheckIcon /> Reembolso integral se a médica não indicar
            tratamento.
          </li>
          <li className="flex gap-2.5 items-start">
            <CheckIcon /> Cancelamento sem multa em 7 dias (CDC art. 49).
          </li>
          <li className="flex gap-2.5 items-start">
            <CheckIcon /> Entrega refrigerada com farmácia parceira da Anvisa.
          </li>
        </ul>
      </aside>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Subcomponentes
// ────────────────────────────────────────────────────────────────────────────

const inputClass =
  "w-full rounded-xl border border-ink-200 bg-cream-50 px-4 py-3 text-[0.97rem] text-ink-800 placeholder:text-ink-300 outline-none focus:border-sage-500 focus:ring-2 focus:ring-sage-500/20 transition";

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="block text-[0.85rem] font-medium text-ink-700 mb-1.5"
      >
        {label}
      </label>
      {children}
    </div>
  );
}

function PaymentOption({
  checked,
  onChange,
  title,
  tag,
  tagAccent,
  hint,
}: {
  checked: boolean;
  onChange: () => void;
  title: string;
  tag: string;
  tagAccent?: boolean;
  hint: string;
}) {
  return (
    <label
      className={
        "flex cursor-pointer rounded-2xl border px-5 py-4 transition gap-4 " +
        (checked
          ? "border-sage-500 bg-sage-50 ring-2 ring-sage-500/30"
          : "border-ink-100 bg-cream-50 hover:border-ink-200")
      }
    >
      <input
        type="radio"
        name="paymentMethod"
        checked={checked}
        onChange={onChange}
        className="mt-1 h-4 w-4 accent-sage-700"
      />
      <div className="flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-medium text-ink-800">{title}</span>
          <span
            className={
              "text-[0.88rem] " +
              (tagAccent ? "text-terracotta-700" : "text-ink-600")
            }
          >
            {tag}
          </span>
        </div>
        <p className="mt-0.5 text-[0.85rem] text-ink-500 leading-snug">
          {hint}
        </p>
      </div>
    </label>
  );
}

function CheckIcon() {
  return (
    <span
      className="shrink-0 mt-[3px] inline-flex h-4 w-4 items-center justify-center rounded-full bg-terracotta-500/20 text-terracotta-200"
      aria-hidden="true"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
        <path
          d="M2 5.5L4 7.5L8 3"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function Spinner() {
  return (
    <svg
      className="animate-spin h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="3"
      />
      <path
        d="M22 12a10 10 0 0 1-10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
