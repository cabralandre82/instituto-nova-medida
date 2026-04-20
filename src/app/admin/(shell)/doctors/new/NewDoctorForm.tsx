"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const UFS = [
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA",
  "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN",
  "RS", "RO", "RR", "SC", "SP", "SE", "TO",
];

type FormState = {
  fullName: string;
  displayName: string;
  email: string;
  phone: string;
  crmNumber: string;
  crmUf: string;
  cnpj: string;
  consultationMinutes: string;
};

const INITIAL: FormState = {
  fullName: "",
  displayName: "",
  email: "",
  phone: "",
  crmNumber: "",
  crmUf: "RJ",
  cnpj: "",
  consultationMinutes: "30",
};

function maskPhone(raw: string): string {
  const d = raw.replace(/\D/g, "").slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 7) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

function maskCnpj(raw: string): string {
  const d = raw.replace(/\D/g, "").slice(0, 14);
  if (d.length <= 2) return d;
  if (d.length <= 5) return `${d.slice(0, 2)}.${d.slice(2)}`;
  if (d.length <= 8) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5)}`;
  if (d.length <= 12) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8)}`;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

export function NewDoctorForm() {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(INITIAL);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/doctors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: form.fullName.trim(),
          displayName: form.displayName.trim() || undefined,
          email: form.email.trim().toLowerCase(),
          phone: form.phone,
          crmNumber: form.crmNumber.trim(),
          crmUf: form.crmUf,
          cnpj: form.cnpj || undefined,
          consultationMinutes: Number(form.consultationMinutes) || 30,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      router.push(`/admin/doctors/${data.doctorId}?created=1`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao cadastrar.");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-2xl bg-white border border-ink-100 p-6 sm:p-8 space-y-5">
      <Field label="Nome completo" required>
        <input
          type="text"
          required
          autoFocus
          value={form.fullName}
          onChange={(e) => update("fullName", e.target.value)}
          placeholder="Joana da Silva"
          className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 focus:outline-none focus:ring-2 focus:ring-sage-500 focus:border-transparent"
        />
      </Field>

      <Field label="Nome público" hint="Como aparece pro paciente. Ex: Dra. Joana Silva. Vazio = usa nome completo.">
        <input
          type="text"
          value={form.displayName}
          onChange={(e) => update("displayName", e.target.value)}
          placeholder="Dra. Joana Silva"
          className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 focus:outline-none focus:ring-2 focus:ring-sage-500 focus:border-transparent"
        />
      </Field>

      <div className="grid sm:grid-cols-2 gap-5">
        <Field label="E-mail" required hint="Recebe magic link de acesso.">
          <input
            type="email"
            required
            value={form.email}
            onChange={(e) => update("email", e.target.value)}
            placeholder="joana@..."
            className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 focus:outline-none focus:ring-2 focus:ring-sage-500 focus:border-transparent"
          />
        </Field>
        <Field label="WhatsApp" required>
          <input
            type="tel"
            inputMode="tel"
            required
            value={form.phone}
            onChange={(e) => update("phone", maskPhone(e.target.value))}
            placeholder="(21) 99999-9999"
            className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 focus:outline-none focus:ring-2 focus:ring-sage-500 focus:border-transparent"
          />
        </Field>
      </div>

      <div className="grid sm:grid-cols-[1fr_120px] gap-5">
        <Field label="Número do CRM" required>
          <input
            type="text"
            required
            value={form.crmNumber}
            onChange={(e) => update("crmNumber", e.target.value.replace(/\D/g, "").slice(0, 10))}
            placeholder="12345"
            className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 font-mono focus:outline-none focus:ring-2 focus:ring-sage-500 focus:border-transparent"
          />
        </Field>
        <Field label="UF" required>
          <select
            required
            value={form.crmUf}
            onChange={(e) => update("crmUf", e.target.value)}
            className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 focus:outline-none focus:ring-2 focus:ring-sage-500 focus:border-transparent"
          >
            {UFS.map((uf) => (
              <option key={uf} value={uf}>
                {uf}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="CNPJ (PJ)" hint="Opcional agora. Obrigatório antes da primeira consulta paga.">
        <input
          type="text"
          inputMode="numeric"
          value={form.cnpj}
          onChange={(e) => update("cnpj", maskCnpj(e.target.value))}
          placeholder="00.000.000/0001-00"
          className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 font-mono focus:outline-none focus:ring-2 focus:ring-sage-500 focus:border-transparent"
        />
      </Field>

      <Field label="Duração padrão da consulta (min)">
        <input
          type="number"
          min={10}
          max={120}
          step={5}
          value={form.consultationMinutes}
          onChange={(e) => update("consultationMinutes", e.target.value)}
          className="w-full sm:w-32 rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 focus:outline-none focus:ring-2 focus:ring-sage-500 focus:border-transparent"
        />
      </Field>

      <div className="rounded-xl bg-cream-50 border border-ink-100 px-4 py-3 text-sm text-ink-600">
        <strong className="text-ink-700">Será criado:</strong> conta de
        login + perfil de médica + regra de remuneração default
        (R$ 200 consulta, R$ 240 on-demand, R$ 30/h plantão).
      </div>

      {error && (
        <p role="alert" className="text-[0.95rem] text-terracotta-700">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-3 pt-2">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-xl bg-ink-800 hover:bg-ink-900 disabled:opacity-50 text-white font-medium px-6 py-3 transition-colors"
        >
          {submitting ? "Cadastrando..." : "Cadastrar e enviar convite"}
        </button>
        <a
          href="/admin/doctors"
          className="rounded-xl border border-ink-200 hover:bg-cream-50 text-ink-700 font-medium px-6 py-3 transition-colors"
        >
          Cancelar
        </a>
      </div>
    </form>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-[0.85rem] font-medium text-ink-700 mb-1.5">
        {label}
        {required && <span className="text-terracotta-600 ml-1">*</span>}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}
