/**
 * /medico/ganhos — extrato de earnings da médica.
 *
 * Filtro por mês de competência (default: mês corrente). Lista todas as
 * earnings (positivas e negativas) com tipo, descrição, status e valor.
 *
 * Resumo no topo: 3 totais (pending, available, paid) só do filtro ativo.
 */

import Link from "next/link";
import { requireDoctor } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { formatCurrencyBRL, formatDateBR } from "@/lib/datetime-br";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/medico/ganhos" });

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type EarningRow = {
  id: string;
  type: string;
  amount_cents: number;
  description: string | null;
  earned_at: string;
  status: string;
  available_at: string | null;
  paid_at: string | null;
  cancelled_at: string | null;
  payout_id: string | null;
};

type SearchParams = Promise<{ month?: string }>;

function parseMonth(input: string | undefined): { year: number; month: number; key: string } {
  const now = new Date();
  if (input && /^\d{4}-\d{2}$/.test(input)) {
    const [y, m] = input.split("-").map((s) => Number(s));
    if (m >= 1 && m <= 12) {
      return { year: y, month: m, key: input };
    }
  }
  return {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    key: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
  };
}

function monthRange(year: number, month: number): { start: string; end: string } {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

function recentMonths(count: number): { key: string; label: string }[] {
  const now = new Date();
  const out: { key: string; label: string }[] = [];
  for (let i = 0; i < count; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = formatDateBR(d, { month: "long", year: "numeric" });
    out.push({ key, label });
  }
  return out;
}

async function loadEarnings(doctorId: string, year: number, month: number) {
  const supabase = getSupabaseAdmin();
  const { start, end } = monthRange(year, month);

  const { data, error } = await supabase
    .from("doctor_earnings")
    .select(
      "id, type, amount_cents, description, earned_at, status, available_at, paid_at, cancelled_at, payout_id"
    )
    .eq("doctor_id", doctorId)
    .gte("earned_at", start)
    .lt("earned_at", end)
    .order("earned_at", { ascending: false });

  if (error) {
    log.error("load", { err: error });
    return [] as EarningRow[];
  }
  return (data ?? []) as EarningRow[];
}

function brl(cents: number): string {
  return formatCurrencyBRL(cents);
}

function brlSigned(cents: number): string {
  const abs = brl(Math.abs(cents));
  return cents < 0 ? `− ${abs}` : abs;
}

function fmtDate(iso: string): string {
  return formatDateBR(iso, {
    day: "2-digit",
    month: "short",
  });
}

const TYPE_LABEL: Record<string, string> = {
  consultation: "Consulta",
  on_demand_bonus: "Bônus on-demand",
  plantao_hour: "Plantão",
  after_hours_bonus: "Adicional",
  adjustment: "Ajuste",
  bonus: "Bônus",
  refund_clawback: "Estorno",
};

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  pending: { label: "Aguardando", className: "bg-ink-50 text-ink-600 border-ink-200" },
  available: { label: "Disponível", className: "bg-sage-50 text-sage-800 border-sage-200" },
  in_payout: { label: "Em repasse", className: "bg-terracotta-50 text-terracotta-800 border-terracotta-200" },
  paid: { label: "Pago", className: "bg-sage-100 text-sage-900 border-sage-300" },
  cancelled: { label: "Cancelada", className: "bg-ink-50 text-ink-400 border-ink-100" },
};

export default async function DoctorEarningsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { doctorId } = await requireDoctor();
  const sp = await searchParams;
  const { year, month, key } = parseMonth(sp.month);
  const earnings = await loadEarnings(doctorId, year, month);

  const totals = earnings.reduce(
    (acc, e) => {
      if (e.status === "pending") acc.pending += e.amount_cents;
      else if (e.status === "available") acc.available += e.amount_cents;
      else if (e.status === "in_payout") acc.inPayout += e.amount_cents;
      else if (e.status === "paid") acc.paid += e.amount_cents;
      return acc;
    },
    { pending: 0, available: 0, inPayout: 0, paid: 0 }
  );

  const months = recentMonths(6);

  return (
    <div>
      <header className="mb-8">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Ganhos
        </p>
        <h1 className="font-serif text-[2rem] sm:text-[2.4rem] leading-tight text-ink-800">
          Extrato por mês
        </h1>
        <p className="mt-2 text-ink-500">
          Cada consulta vira uma linha. Liberação para repasse segue D+7 (PIX),
          D+3 (boleto) ou D+30 (cartão).
        </p>
      </header>

      <nav className="mb-6 flex flex-wrap gap-2">
        {months.map((m) => {
          const active = m.key === key;
          return (
            <Link
              key={m.key}
              href={`/medico/ganhos?month=${m.key}`}
              className={`px-3.5 py-1.5 rounded-full text-sm font-medium border transition-colors capitalize ${
                active
                  ? "bg-ink-800 text-white border-ink-800"
                  : "bg-white text-ink-600 border-ink-200 hover:border-ink-400"
              }`}
            >
              {m.label}
            </Link>
          );
        })}
      </nav>

      <section className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-8">
        <Summary label="Aguardando" value={brl(totals.pending)} tone="ink" />
        <Summary label="Disponível" value={brl(totals.available)} tone="sage" />
        <Summary label="Em repasse" value={brl(totals.inPayout)} tone="terracotta" />
        <Summary label="Pago" value={brl(totals.paid)} tone="ink" />
      </section>

      {earnings.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-ink-200 bg-cream-50 p-8 text-center">
          <p className="text-ink-600">Nenhum ganho registrado neste mês.</p>
          <p className="mt-2 text-sm text-ink-500">
            Os valores aparecem aqui assim que o pagamento do paciente é confirmado.
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border border-ink-100 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-cream-50 text-ink-600 text-[0.78rem] uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Data</th>
                <th className="px-4 py-3 text-left font-medium">Descrição</th>
                <th className="px-4 py-3 text-left font-medium hidden sm:table-cell">Tipo</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Valor</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {earnings.map((e) => {
                const badge = STATUS_BADGE[e.status] ?? {
                  label: e.status,
                  className: "bg-ink-50 text-ink-600 border-ink-200",
                };
                const negative = e.amount_cents < 0;
                return (
                  <tr key={e.id} className="hover:bg-cream-50/60">
                    <td className="px-4 py-3 text-ink-700 whitespace-nowrap">
                      {fmtDate(e.earned_at)}
                    </td>
                    <td className="px-4 py-3 text-ink-800 max-w-[420px]">
                      <p className="truncate" title={e.description ?? undefined}>
                        {e.description ?? "—"}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-ink-500 hidden sm:table-cell whitespace-nowrap">
                      {TYPE_LABEL[e.type] ?? e.type}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${badge.className}`}
                      >
                        {badge.label}
                      </span>
                    </td>
                    <td
                      className={`px-4 py-3 text-right font-medium tabular-nums whitespace-nowrap ${
                        negative ? "text-terracotta-700" : "text-ink-800"
                      }`}
                    >
                      {brlSigned(e.amount_cents)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Summary({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "sage" | "terracotta" | "ink";
}) {
  const toneClasses = {
    sage: "border-sage-200 bg-sage-50",
    terracotta: "border-terracotta-200 bg-terracotta-50",
    ink: "border-ink-100 bg-white",
  }[tone];
  const valueClasses = {
    sage: "text-sage-800",
    terracotta: "text-terracotta-700",
    ink: "text-ink-800",
  }[tone];

  return (
    <div className={`rounded-2xl border p-4 ${toneClasses}`}>
      <p className="text-[0.78rem] uppercase tracking-[0.14em] text-ink-500 font-medium mb-1.5">
        {label}
      </p>
      <p className={`font-serif text-[1.5rem] leading-none ${valueClasses}`}>{value}</p>
    </div>
  );
}
