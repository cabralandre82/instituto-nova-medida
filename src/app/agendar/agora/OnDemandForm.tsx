"use client";

/**
 * OnDemandForm — PR-080 · D-092
 *
 * Formulário de "atendimento agora". Igual em espírito ao
 * `FreeBookingForm`, com 1 campo extra (chief_complaint) e sem slot.
 *
 * Pós-submit, a página recarrega e o server detecta o pending → renderiza
 * `OnDemandWaitingClient`.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

type FormState = {
  name: string;
  cpf: string;
  email: string;
  phone: string;
  chiefComplaint: string;
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

export function OnDemandForm({
  leadHints,
  defaultTtlSeconds,
}: {
  leadHints: { name: string; phone: string };
  defaultTtlSeconds: number;
}) {
  const router = useRouter();
  const [form, setForm] = useState<FormState>({
    name: leadHints.name || "",
    cpf: "",
    email: "",
    phone: leadHints.phone ? maskPhone(leadHints.phone) : "",
    chiefComplaint: "",
    recordingConsent: false,
    consent: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

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
    if (form.chiefComplaint.trim().length < 4)
      return "Conte em poucas palavras o que está sentindo (mínimo 4 caracteres).";
    if (form.chiefComplaint.length > 500)
      return "Limite o relato a 500 caracteres.";
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
      const res = await fetch("/api/agendar/agora", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          cpf: form.cpf,
          email: form.email,
          phone: form.phone,
          chiefComplaint: form.chiefComplaint,
          consent: form.consent,
          recordingConsent: form.recordingConsent,
        }),
      });

      const data = (await res.json().catch(() => null)) as
        | {
            ok?: boolean;
            error?: string;
            requestId?: string;
            noDoctorsOnline?: boolean;
          }
        | null;

      if (!res.ok || !data?.ok) {
        const err = data?.error ?? "internal";
        if (err === "lead_required" || err === "lead_invalid_or_expired") {
          setServerError(
            "Para solicitar atendimento, primeiro preencha o questionário inicial."
          );
          setTimeout(() => router.push("/?aviso=quiz_primeiro"), 2000);
          return;
        }
        if (err === "chief_complaint_too_short") {
          setServerError("Descreva em poucas palavras o que está sentindo.");
          return;
        }
        if (err === "chief_complaint_too_long") {
          setServerError("Relato muito longo (máximo 500 caracteres).");
          return;
        }
        setServerError(
          "Não foi possível solicitar agora. Tente novamente em instantes."
        );
        return;
      }

      // Sucesso → recarrega a página, server detecta o pending,
      // renderiza OnDemandWaitingClient.
      router.refresh();
    } catch {
      setServerError("Falha de rede. Verifique sua conexão e tente novamente.");
    } finally {
      setSubmitting(false);
    }
  }

  const ttlMinutes = Math.ceil(defaultTtlSeconds / 60);

  return (
    <>
      <header className="mb-8">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-terracotta-700 font-medium mb-3">
          Atendimento agora
        </p>
        <h1 className="font-serif text-[2.2rem] sm:text-[2.6rem] leading-[1.05] tracking-tight text-ink-800">
          Solicitar consulta imediata
        </h1>
        <p className="mt-3 text-ink-600 leading-relaxed">
          Sua solicitação será enviada pelas médicas que estão de plantão
          neste momento. A primeira disponível abrirá a sala. Você espera
          até {ttlMinutes} minutos.
        </p>
      </header>

      <form
        onSubmit={handleSubmit}
        className="rounded-2xl bg-white border border-ink-100 p-6 sm:p-8 space-y-6"
      >
        <div>
          <h2 className="font-serif text-[1.4rem] text-ink-800 leading-tight">
            Seus dados
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
          />
          <Field
            label="WhatsApp"
            value={form.phone}
            onChange={(v) => update("phone", maskPhone(v))}
            inputMode="numeric"
            autoComplete="tel"
            placeholder="(DDD) 00000-0000"
            required
          />
        </div>

        <div>
          <label className="block">
            <span className="block text-[0.85rem] font-medium text-ink-700 mb-1.5">
              O que você está sentindo agora?{" "}
              <span className="text-red-500">*</span>
            </span>
            <textarea
              value={form.chiefComplaint}
              onChange={(e) => update("chiefComplaint", e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="Ex.: dor abdominal forte há 2 horas; tontura constante desde ontem…"
              className="w-full rounded-xl border border-ink-200 bg-cream-50 px-3.5 py-2.5 text-[0.96rem] text-ink-800 placeholder:text-ink-400 focus:border-sage-500 focus:outline-none focus:ring-1 focus:ring-sage-500"
              required
            />
            <p className="mt-1 text-xs text-ink-400">
              Texto curto (até 500 caracteres). A médica usa pra decidir se
              consegue atender agora.
            </p>
          </label>
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
              .
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
          className="w-full inline-flex items-center justify-center gap-2 rounded-full bg-terracotta-700 hover:bg-terracotta-800 text-cream-50 font-medium px-7 py-3.5 text-[0.96rem] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {submitting ? "Enviando…" : "Solicitar atendimento agora"}
        </button>

        <p className="text-xs text-ink-400 leading-relaxed">
          Sem cobrança nesta etapa. Se a médica indicar tratamento, você
          decide se aceita o plano depois.
        </p>
      </form>
    </>
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: "text" | "email";
  inputMode?: "numeric" | "text" | "tel";
  autoComplete?: string;
  placeholder?: string;
  required?: boolean;
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
    </label>
  );
}
