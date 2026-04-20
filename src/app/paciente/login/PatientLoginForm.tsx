"use client";

import { useState } from "react";

export function PatientLoginForm({ nextPath }: { nextPath: string }) {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/paciente/auth/magic-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          next: nextPath,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || "Falha ao enviar link.");
      }
      const url = new URL(window.location.href);
      url.searchParams.set("sent", email.trim().toLowerCase());
      url.searchParams.delete("error");
      window.location.href = url.toString();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro inesperado.");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label
          htmlFor="email"
          className="block text-[0.85rem] font-medium text-ink-700 mb-2"
        >
          E-mail da compra
        </label>
        <input
          id="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          autoFocus
          disabled={submitting}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="seu.email@exemplo.com"
          className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 placeholder:text-ink-300 focus:outline-none focus:ring-2 focus:ring-sage-500 focus:border-transparent disabled:opacity-50"
        />
      </div>

      {error && (
        <p role="alert" className="text-[0.92rem] text-terracotta-700">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting || !email}
        className="w-full rounded-xl bg-ink-800 hover:bg-ink-900 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium py-3.5 px-6 transition-colors"
      >
        {submitting ? "Enviando..." : "Receber link mágico"}
      </button>
    </form>
  );
}
