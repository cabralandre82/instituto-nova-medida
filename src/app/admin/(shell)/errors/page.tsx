/**
 * /admin/errors — D-045 · 3.G
 *
 * Timeline consolidada de falhas operacionais. Agrega cron_runs
 * (status=error), asaas_events (processing_error), daily_events
 * (processing_error), appointment_notifications (status=failed) e
 * whatsapp_events (status=failed) na mesma lista, ordenada DESC
 * por quando ocorreu.
 *
 * Objetivo: operador solo abre UMA tela e vê "o que quebrou nas
 * últimas 24h" sem precisar de SSH, logs do Vercel ou lembrar
 * quais 5 tabelas olhar.
 *
 * Filtros via querystring:
 *   - `?h=72`  → janela de 72h (default 24h, máx 720h/30d)
 *   - `?source=cron` → filtra por origem (cron, asaas_webhook,
 *     daily_webhook, notification, whatsapp_delivery)
 *
 * Complementar a `/admin/health` (estado ATUAL). Aqui é o histórico.
 */

import Link from "next/link";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  loadErrorLog,
  type ErrorEntry,
  type ErrorSource,
} from "@/lib/error-log";
import { formatDateBR } from "@/lib/datetime-br";

export const dynamic = "force-dynamic";

type SearchParams = {
  h?: string;
  source?: string;
};

const SOURCE_LABEL: Record<ErrorSource, string> = {
  cron: "Cron",
  asaas_webhook: "Asaas",
  daily_webhook: "Daily",
  notification: "Envio WA",
  whatsapp_delivery: "Entrega WA",
};

const SOURCE_CHIP: Record<ErrorSource, string> = {
  cron: "bg-terracotta-50 border-terracotta-200 text-terracotta-800",
  asaas_webhook: "bg-amber-50 border-amber-200 text-amber-800",
  daily_webhook: "bg-amber-50 border-amber-200 text-amber-800",
  notification: "bg-cream-100 border-ink-200 text-ink-700",
  whatsapp_delivery: "bg-cream-100 border-ink-200 text-ink-700",
};

const ALL_SOURCES: ErrorSource[] = [
  "cron",
  "asaas_webhook",
  "daily_webhook",
  "notification",
  "whatsapp_delivery",
];

function parseWindow(raw: string | undefined): number {
  const n = Number(raw ?? "24");
  if (!Number.isFinite(n) || n <= 0) return 24;
  return Math.min(Math.max(Math.round(n), 1), 720);
}

function parseSource(raw: string | undefined): ErrorSource | null {
  if (!raw) return null;
  if ((ALL_SOURCES as string[]).includes(raw)) return raw as ErrorSource;
  return null;
}

function fmtDateTime(iso: string): string {
  return formatDateBR(iso, {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function ageFrom(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "agora";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function formatContextValue(v: string | number | boolean | null): string {
  if (v === null) return "—";
  if (typeof v === "boolean") return v ? "sim" : "não";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    return fmtDateTime(v);
  }
  return String(v);
}

export default async function AdminErrorsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const windowHours = parseWindow(searchParams?.h);
  const sourceFilter = parseSource(searchParams?.source);

  const supabase = getSupabaseAdmin();
  const log = await loadErrorLog(supabase, { windowHours });

  const entries = sourceFilter
    ? log.entries.filter((e) => e.source === sourceFilter)
    : log.entries;

  return (
    <div>
      <header className="mb-6">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Observabilidade
        </p>
        <h1 className="font-serif text-[1.85rem] sm:text-[2.2rem] leading-tight text-ink-800">
          Erros
        </h1>
        <p className="mt-1 text-ink-500 max-w-2xl">
          Timeline consolidada de falhas operacionais nas últimas{" "}
          {windowHours}h. Agrega cron, webhooks de Asaas e Daily, envios
          de WhatsApp e status de entrega. Ordem: mais recente primeiro.
        </p>
      </header>

      {/* Janela temporal */}
      <section className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-[0.78rem] uppercase tracking-wider text-ink-500 font-medium mr-1">
          Janela:
        </span>
        {[6, 24, 72, 168, 720].map((h) => {
          const href = buildQuery({ h, source: sourceFilter });
          const active = windowHours === h;
          return (
            <Link
              key={h}
              href={href}
              className={`px-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${
                active
                  ? "bg-ink-800 text-white border-ink-800"
                  : "bg-white border-ink-200 text-ink-600 hover:border-ink-400"
              }`}
            >
              {h < 24 ? `${h}h` : h < 168 ? `${h / 24}d` : `${h / 24}d`}
            </Link>
          );
        })}
      </section>

      {/* Filtro por source */}
      <section className="mb-6 flex flex-wrap items-center gap-2">
        <span className="text-[0.78rem] uppercase tracking-wider text-ink-500 font-medium mr-1">
          Fonte:
        </span>
        <Link
          href={buildQuery({ h: windowHours, source: null })}
          className={`px-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${
            !sourceFilter
              ? "bg-ink-800 text-white border-ink-800"
              : "bg-white border-ink-200 text-ink-600 hover:border-ink-400"
          }`}
        >
          Todas ({log.total})
        </Link>
        {ALL_SOURCES.map((s) => {
          const count = log.sourceCounts[s];
          const href = buildQuery({ h: windowHours, source: s });
          const active = sourceFilter === s;
          return (
            <Link
              key={s}
              href={href}
              className={`px-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${
                active
                  ? "bg-ink-800 text-white border-ink-800"
                  : "bg-white border-ink-200 text-ink-600 hover:border-ink-400"
              }`}
            >
              {SOURCE_LABEL[s]} ({count})
            </Link>
          );
        })}
      </section>

      {/* Lista */}
      {entries.length === 0 ? (
        <div className="rounded-2xl border border-sage-200 bg-sage-50 p-6">
          <p className="font-serif text-[1.2rem] text-sage-800">
            Silêncio total.
          </p>
          <p className="mt-1 text-sm text-sage-700">
            Nenhum erro registrado na janela selecionada. Sistema saudável
            ou ninguém usou — olhe{" "}
            <Link
              href="/admin/health"
              className="underline hover:text-sage-900"
            >
              /admin/health
            </Link>{" "}
            pra confirmar.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {entries.map((entry, idx) => (
            <ErrorCard key={`${entry.reference}-${idx}`} entry={entry} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ErrorCard({ entry }: { entry: ErrorEntry }) {
  const chip = SOURCE_CHIP[entry.source];
  const contextEntries = Object.entries(entry.context).filter(
    ([, v]) => v !== null && v !== undefined
  );
  return (
    <li className="rounded-2xl border border-ink-100 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <span
            className={`shrink-0 px-2.5 py-1 rounded-full border text-[0.7rem] uppercase tracking-wider font-medium ${chip}`}
          >
            {SOURCE_LABEL[entry.source]}
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="font-medium text-ink-800 text-[1rem] truncate">
              {entry.label}
            </h3>
            <p className="mt-1 text-sm text-ink-700 whitespace-pre-wrap break-words">
              {entry.message}
            </p>
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className="text-[0.78rem] text-ink-500">
            {fmtDateTime(entry.occurredAt)}
          </p>
          <p className="text-[0.7rem] text-ink-400 font-mono">
            há {ageFrom(entry.occurredAt)}
          </p>
        </div>
      </div>

      {contextEntries.length > 0 && (
        <dl className="mt-3 pt-3 border-t border-ink-100 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
          {contextEntries.map(([k, v]) => (
            <div
              key={k}
              className="flex items-baseline justify-between gap-3 text-xs"
            >
              <dt className="text-ink-500 font-medium shrink-0">{k}</dt>
              <dd className="font-mono text-ink-700 text-right break-all">
                {formatContextValue(v)}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <p className="mt-2 text-[0.68rem] text-ink-400 font-mono">
        ref: {entry.reference}
      </p>
    </li>
  );
}

function buildQuery(params: {
  h: number;
  source: ErrorSource | null;
}): string {
  const qs = new URLSearchParams();
  if (params.h !== 24) qs.set("h", String(params.h));
  if (params.source) qs.set("source", params.source);
  const s = qs.toString();
  return s ? `/admin/errors?${s}` : "/admin/errors";
}
