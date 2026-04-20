"use client";

import { useState } from "react";

type DoctorEditable = {
  display_name: string | null;
  bio: string | null;
  phone: string | null;
  consultation_minutes: number;
};

export function ProfileForm({ initial }: { initial: DoctorEditable }) {
  const [displayName, setDisplayName] = useState(initial.display_name ?? "");
  const [bio, setBio] = useState(initial.bio ?? "");
  const [phone, setPhone] = useState(initial.phone ?? "");
  const [minutes, setMinutes] = useState(String(initial.consultation_minutes));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/medico/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          display_name: displayName,
          bio,
          phone,
          consultation_minutes: Number(minutes),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Falha ao salvar.");
      }
      setSavedAt(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro inesperado.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <label
          htmlFor="display_name"
          className="block text-[0.85rem] font-medium text-ink-700 mb-2"
        >
          Nome de exibição
        </label>
        <input
          id="display_name"
          type="text"
          maxLength={80}
          disabled={submitting}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Dra. Joana Silva"
          className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 placeholder:text-ink-300 focus:outline-none focus:ring-2 focus:ring-sage-500 focus:border-transparent disabled:opacity-50"
        />
        <p className="mt-1.5 text-xs text-ink-500">
          Como o paciente verá você na agenda. Deixe vazio para usar seu nome completo.
        </p>
      </div>

      <div>
        <label
          htmlFor="phone"
          className="block text-[0.85rem] font-medium text-ink-700 mb-2"
        >
          Telefone (somente operação)
        </label>
        <input
          id="phone"
          type="tel"
          inputMode="tel"
          disabled={submitting}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="(11) 99999-9999"
          className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 placeholder:text-ink-300 focus:outline-none focus:ring-2 focus:ring-sage-500 focus:border-transparent disabled:opacity-50"
        />
        <p className="mt-1.5 text-xs text-ink-500">Não é exibido para pacientes.</p>
      </div>

      <div>
        <label
          htmlFor="minutes"
          className="block text-[0.85rem] font-medium text-ink-700 mb-2"
        >
          Duração padrão da consulta
        </label>
        <select
          id="minutes"
          disabled={submitting}
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
          className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 focus:outline-none focus:ring-2 focus:ring-sage-500 focus:border-transparent disabled:opacity-50"
        >
          {[15, 20, 30, 45, 60].map((n) => (
            <option key={n} value={String(n)}>
              {n} minutos
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="bio" className="block text-[0.85rem] font-medium text-ink-700 mb-2">
          Mini biografia
        </label>
        <textarea
          id="bio"
          rows={6}
          maxLength={1500}
          disabled={submitting}
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          placeholder="Apresente-se em poucas linhas: formação, abordagem, áreas de cuidado."
          className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 placeholder:text-ink-300 focus:outline-none focus:ring-2 focus:ring-sage-500 focus:border-transparent disabled:opacity-50 resize-y"
        />
        <p className="mt-1.5 text-xs text-ink-500">
          {bio.length} / 1500 caracteres. Aparece na sua página pública de agendamento.
        </p>
      </div>

      {error && (
        <p role="alert" className="text-[0.92rem] text-terracotta-700">
          {error}
        </p>
      )}

      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-xl bg-ink-800 hover:bg-ink-900 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium py-3 px-6 transition-colors"
        >
          {submitting ? "Salvando..." : "Salvar alterações"}
        </button>
        {savedAt && (
          <span className="text-sm text-sage-700">
            Salvo às{" "}
            {savedAt.toLocaleTimeString("pt-BR", {
              hour: "2-digit",
              minute: "2-digit",
            })}
            .
          </span>
        )}
      </div>
    </form>
  );
}
