"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function NotificationRetryButton({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function retry() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/admin/notifications/${id}/retry`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      setMsg("Re-enfileirado");
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Erro");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={retry}
        disabled={busy}
        className="text-xs font-medium px-3 py-1.5 rounded-lg border border-sage-300 text-sage-800 hover:bg-sage-50 disabled:opacity-50 transition-colors"
      >
        {busy ? "..." : "Retry"}
      </button>
      {msg && (
        <span className="text-[0.7rem] text-ink-500 whitespace-nowrap">
          {msg}
        </span>
      )}
    </div>
  );
}
