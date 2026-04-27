"use client";

/**
 * FreeBookingForm — PR-075-A · D-086
 *
 * Formulário enxuto para agendar a CONSULTA INICIAL GRATUITA. Diferente
 * do `CheckoutForm` (legado): não pede endereço, não pede método de
 * pagamento, não exibe valor — porque nada é cobrado nesta etapa.
 *
 * Campos:
 *   - Nome (prefill do lead)
 *   - CPF (necessário pro prontuário e identificação clínica)
 *   - Email (pra magic-link em /paciente)
 *   - Telefone (prefill do lead — paciente pode corrigir)
 *   - Consentimento de gravação (opt-in)
 *   - Consentimento LGPD (obrigatório)
 *
 * O endereço será coletado APENAS se a médica prescrever um plano e
 * o paciente aceitar em /paciente/oferta/[id], no fluxo de fulfillment.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatDateBR } from "@/lib/datetime-br";

type FormState = {
  name: string;
  cpf: string;
  email: string;
  phone: string;
  recordingConsent: boolean;
  consent: boolean;
};

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

export type FreeBookingSlot = {
  startsAt: string;
  doctorName: string;
  durationMinutes: number;
};

export function FreeBookingForm({
  slot,
  leadHints,
}: {
  slot: FreeBookingSlot;
  leadHints: { name: string; phone: string };
}) {
  const router = useRouter();
  const [form, setForm] = useState<FormState>({
    name: leadHints.name || "",
    cpf: "",
    email: "",
    phone: leadHints.phone ? maskPhone(leadHints.phone) : "",
    recordingConsent: false,
    consent: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const slotDisplay = formatDateBR(slot.startsAt, {
    weekday: "long",
    day: "2-digit",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function clientValidation(): string | null {
    if (form.name.trim().length < 3) return "Informe seu nome completo.";
    if (!isValidCpf(form.cpf)) return "CPF inválido. Confira os dígitos.";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email))
      return "Informe um e-mail válido.";
    if (form.phone.replace(/\D/g, "").length < 10)
      return "Telefone inválido. Use o formato (DDD) número.";
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
      const res = await fetch("/api/agendar/free", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scheduledAt: slot.startsAt,
          name: form.name,
          cpf: form.cpf,
          email: form.email,
          phone: form.phone,
          consent: form.consent,
          recordingConsent: form.recordingConsent,
        }),
      });

      const data = (await res.json().catch(() => null)) as
        | {
            ok?: boolean;
            error?: string;
            message?: string;
            appointmentId?: string;
          }
        | null;

      if (!res.ok || !data?.ok || !data.appointmentId) {
        const err = data?.error ?? "internal";
        if (err === "lead_required" || err === "lead_invalid_or_expired") {
          setServerError(
            "Para agendar, primeiro preencha o questionário inicial.",
          );
          setTimeout(() => router.push("/?aviso=quiz_primeiro"), 2000);
          return;
        }
        if (err === "slot_taken" || err === "slot_unavailable") {
          setServerError(
            "Esse horário acabou de ser reservado. Vamos voltar pra escolher outro.",
          );
          setTimeout(() => router.push("/agendar"), 2000);
          return;
        }
        if (err === "no_doctor_active" || err === "doctor_reliability_paused") {
          setServerError(
            "Sem médica disponível agora. Tente novamente em alguns minutos.",
          );
          return;
        }
        setServerError(
          data?.message ??
            "Não foi possível agendar agora. Tente novamente em instantes.",
        );
        return;
      }

      router.push(`/agendar/sucesso?id=${encodeURIComponent(data.appointmentId)}`);
    } catch {
      setServerError(
        "Falha de rede. Verifique sua conexão e tente novamente.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid lg:grid-cols-[1fr_360px] gap-8">
      <form
        onSubmit={handleSubmit}
        className="rounded-2xl bg-white border border-ink-100 p-6 sm:p-8 space-y-6"
      >
        <div>
          <h2 className="font-serif text-[1.6rem] text-ink-800 leading-tight">
            Confirmar dados da consulta
          </h2>
          <p className="mt-1 text-sm text-ink-500">
            Esses dados ficam só com o Instituto Nova Medida e a médica
            responsável.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <Field
            label="Nome completo"
            value={form.name}
            onChange={(v) => update("name", v)}
            autoComplete="name"
            required
          />
          <Field
            label="CPF"
            value={form.cpf}
            onChange={(v) => update("cpf", maskCpf(v))}
            inputMode="numeric"
            autoComplete="off"
            placeholder="000.000.000-00"
            required
          />
          <Field
            label="E-mail"
            type="email"
            value={form.email}
            onChange={(v) => update("email", v)}
            autoComplete="email"
            required
            help="Usado para enviar lembretes e o link da sua área de paciente."
          />
          <Field
            label="WhatsApp"
            value={form.phone}
            onChange={(v) => update("phone", maskPhone(v))}
            inputMode="numeric"
            autoComplete="tel"
            placeholder="(DDD) 00000-0000"
            required
            help="Para confirmações e lembretes da consulta."
          />
        </div>

        <fieldset className="space-y-3">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={form.recordingConsent}
              onChange={(e) => update("recordingConsent", e.target.checked)}
              className="mt-1 h-4 w-4 rounded border-ink-300 text-sage-600 focus:ring-sage-500"
            />
            <span className="text-sm text-ink-700 leading-relaxed">
              <span className="font-medium text-ink-800">
                Autorizo a gravação da consulta
              </span>{" "}
              para apoio à anotação clínica e revisão por mim ou pela médica.
              A gravação fica em armazenamento criptografado, com acesso
              restrito. Você pode pedir o apagamento a qualquer momento.
            </span>
          </label>

          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={form.consent}
              onChange={(e) => update("consent", e.target.checked)}
              required
              className="mt-1 h-4 w-4 rounded border-ink-300 text-sage-600 focus:ring-sage-500"
            />
            <span className="text-sm text-ink-700 leading-relaxed">
              Li e concordo com os{" "}
              <a
                href="/termos"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sage-700 underline hover:text-sage-800"
              >
                Termos de Uso
              </a>{" "}
              e a{" "}
              <a
                href="/privacidade"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sage-700 underline hover:text-sage-800"
              >
                Política de Privacidade
              </a>
              . Autorizo o tratamento dos meus dados conforme a LGPD para
              prestação do atendimento online.
            </span>
          </label>
        </fieldset>

        {serverError && (
          <div
            role="alert"
            className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800"
          >
            {serverError}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full inline-flex items-center justify-center gap-2 rounded-full bg-sage-700 hover:bg-sage-800 text-cream-50 font-medium px-7 py-3.5 text-[0.96rem] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {submitting ? "Agendando…" : "Confirmar consulta gratuita"}
        </button>

        <p className="text-xs text-ink-400 leading-relaxed">
          Sem cobrança nesta etapa. Plano de tratamento, se houver, é
          discutido após a consulta e só é cobrado mediante seu aceite
          explícito na sua área de paciente.
        </p>
      </form>

      <aside className="space-y-4">
        <div className="rounded-2xl border border-sage-200 bg-sage-50/60 p-5">
          <p className="text-[0.78rem] uppercase tracking-wider text-sage-700 font-medium">
            Sua consulta
          </p>
          <p className="mt-2 font-serif text-[1.15rem] text-ink-800 leading-tight capitalize">
            {slotDisplay}
          </p>
          <p className="mt-2 text-sm text-ink-600">
            Com{" "}
            <span className="font-medium text-ink-800">{slot.doctorName}</span>
            {" · "}
            {slot.durationMinutes} minutos · 100% online
          </p>
        </div>

        <div className="rounded-2xl border border-ink-100 bg-cream-50 p-5 space-y-3 text-sm text-ink-600 leading-relaxed">
          <p>
            <strong className="text-ink-800">Sem cobrança nesta etapa.</strong>{" "}
            Você só paga se decidir aceitar um plano de tratamento depois da
            consulta.
          </p>
          <p>
            Receberá lembretes automáticos por WhatsApp{" "}
            <span className="text-ink-500">
              (24 horas antes, 1 hora antes e na hora da consulta)
            </span>
            .
          </p>
        </div>
      </aside>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  inputMode,
  autoComplete,
  placeholder,
  required,
  help,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: "text" | "email";
  inputMode?: "numeric" | "text" | "tel";
  autoComplete?: string;
  placeholder?: string;
  required?: boolean;
  help?: string;
}) {
  return (
    <label className="block">
      <span className="block text-[0.85rem] font-medium text-ink-700 mb-1.5">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </span>
      <input
        type={type}
        inputMode={inputMode}
        autoComplete={autoComplete}
        placeholder={placeholder}
        required={required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-ink-200 bg-cream-50 px-3.5 py-2.5 text-[0.96rem] text-ink-800 placeholder:text-ink-400 focus:border-sage-500 focus:outline-none focus:ring-1 focus:ring-sage-500"
      />
      {help && <p className="mt-1 text-xs text-ink-400">{help}</p>}
    </label>
  );
}
