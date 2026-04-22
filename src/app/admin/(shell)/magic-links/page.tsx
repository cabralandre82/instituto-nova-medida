/**
 * /admin/magic-links — Trilha forense de magic-link (PR-070-B · D-084).
 *
 * Por quê:
 *   PR-070 · D-078 instalou `magic_link_issued_log` com trilha forense
 *   LGPD-safe (email hasheado SHA-256, IP/UA/route). Até aqui, triagem
 *   de "não recebi o link" era via SQL Editor no Supabase Studio (ver
 *   RUNBOOK §16). Essa UI consolida o mesmo fluxo em navegação — sem
 *   precisar decorar `select email_hash = encode(digest(lower(trim($1)),
 *   'sha256'), 'hex')`.
 *
 * O que mostra:
 *   - Listagem das últimas N linhas (default 200), ordenada por
 *     `issued_at DESC`.
 *   - Filtros: busca por email (lib computa o hash antes de consultar;
 *     email nunca trafega pro DB em formato consultável), `action`,
 *     `role`, IP, intervalo de datas em BRT.
 *   - Resumo: contagem por action nas últimas 24h pra detectar spike
 *     de `rate_limited`/`provider_error`/`silenced_*`.
 *
 * Privacidade:
 *   - Esta UI é admin-only (`requireAdmin` via shell layout).
 *   - Email digitado pelo admin pra busca é hasheado **no servidor**
 *     antes da query — nunca vira WHERE plaintext. Mesma invariante
 *     do `hashEmail()` em `src/lib/magic-link-log.ts`.
 *   - Listagem mostra `email_hash` (8 chars prefixo pra compactar) +
 *     `email_domain` cleartext (já pensado LGPD-safe em D-078). Email
 *     plaintext JAMAIS aparece — nem quando o admin buscou por ele.
 *
 * Escopo:
 *   - Read-only. Nenhum botão de "reenviar" (isso é disparar
 *     `POST /api/auth/magic-link` do paciente/médica, responsabilidade
 *     dele). Nenhum botão de "deletar" (imutável por design).
 */

import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase";
import { formatDateTimeBR } from "@/lib/datetime-br";
import { logger } from "@/lib/logger";
import {
  buildAdminListUrl,
  hasActiveFilters,
  parseDateRange,
  parseSearch,
  parseStatusFilter,
} from "@/lib/admin-list-filters";
import { hashEmail, type MagicLinkAction } from "@/lib/magic-link-log";

const log = logger.with({ route: "/admin/magic-links" });

export const dynamic = "force-dynamic";

const ACTIONS = [
  "issued",
  "silenced_no_account",
  "silenced_no_role",
  "silenced_wrong_scope",
  "silenced_no_customer",
  "rate_limited",
  "provider_error",
  "auto_provisioned",
  "verified",
  "verify_failed",
] as const satisfies readonly MagicLinkAction[];

const ACTION_LABELS: Record<MagicLinkAction, string> = {
  issued: "Emitido",
  silenced_no_account: "Silenciado (conta inexistente)",
  silenced_no_role: "Silenciado (sem role)",
  silenced_wrong_scope: "Silenciado (scope errado)",
  silenced_no_customer: "Silenciado (sem customer)",
  rate_limited: "Rate-limited",
  provider_error: "Erro do provider",
  auto_provisioned: "Auto-provisionado",
  verified: "Verificado",
  verify_failed: "Verificação falhou",
};

const ACTION_TONES: Record<MagicLinkAction, "sage" | "ink" | "terracotta" | "amber"> = {
  issued: "sage",
  silenced_no_account: "amber",
  silenced_no_role: "amber",
  silenced_wrong_scope: "amber",
  silenced_no_customer: "amber",
  rate_limited: "terracotta",
  provider_error: "terracotta",
  auto_provisioned: "ink",
  verified: "sage",
  verify_failed: "terracotta",
};

const ROLES = ["admin", "doctor", "patient"] as const;
type Role = (typeof ROLES)[number];

type LogRow = {
  id: string;
  email_hash: string;
  email_domain: string | null;
  role: string | null;
  action: MagicLinkAction;
  reason: string | null;
  route: string;
  ip: string | null;
  user_agent: string | null;
  next_path: string | null;
  metadata: Record<string, unknown> | null;
  issued_at: string;
};

type Filters = {
  emailHash: string | null;
  rawEmail: string | null;
  action: MagicLinkAction | null;
  role: Role | null;
  ip: string | null;
  fromIso: string | null;
  toIso: string | null;
  invertedRange: boolean;
};

function fmtDateTime(iso: string): string {
  return formatDateTimeBR(iso);
}

async function loadLogs(filters: Filters): Promise<LogRow[]> {
  const supabase = getSupabaseAdmin();

  let builder = supabase
    .from("magic_link_issued_log")
    .select(
      "id, email_hash, email_domain, role, action, reason, route, ip, user_agent, next_path, metadata, issued_at",
    )
    .order("issued_at", { ascending: false })
    .limit(200);

  if (filters.emailHash) builder = builder.eq("email_hash", filters.emailHash);
  if (filters.action) builder = builder.eq("action", filters.action);
  if (filters.role) builder = builder.eq("role", filters.role);
  if (filters.ip) builder = builder.eq("ip", filters.ip);
  if (filters.fromIso) builder = builder.gte("issued_at", filters.fromIso);
  if (filters.toIso) builder = builder.lte("issued_at", filters.toIso);

  const { data, error } = await builder;
  if (error) {
    log.error("loadLogs", { err: error.message });
    return [];
  }
  return (data ?? []) as unknown as LogRow[];
}

/**
 * Conta ocorrências por action nas últimas 24h. Pra detecção rápida de
 * anomalias: spike de `rate_limited` sinaliza tentativa de enumeração;
 * spike de `provider_error` sinaliza provedor (Supabase SMTP) degradado.
 *
 * Feito separado da listagem pra não interagir com filtros — o operador
 * quer o heatmap "absoluto" mesmo quando filtrou por um email específico.
 */
async function loadLast24hCounts(
  supabase: SupabaseClient,
): Promise<Record<MagicLinkAction, number>> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("magic_link_issued_log")
    .select("action")
    .gte("issued_at", since)
    .limit(5000);
  if (error) {
    log.error("loadLast24hCounts", { err: error.message });
    return {
      issued: 0,
      silenced_no_account: 0,
      silenced_no_role: 0,
      silenced_wrong_scope: 0,
      silenced_no_customer: 0,
      rate_limited: 0,
      provider_error: 0,
      auto_provisioned: 0,
      verified: 0,
      verify_failed: 0,
    };
  }
  const out = {
    issued: 0,
    silenced_no_account: 0,
    silenced_no_role: 0,
    silenced_wrong_scope: 0,
    silenced_no_customer: 0,
    rate_limited: 0,
    provider_error: 0,
    auto_provisioned: 0,
    verified: 0,
    verify_failed: 0,
  } as Record<MagicLinkAction, number>;
  for (const r of (data ?? []) as { action: MagicLinkAction }[]) {
    if (r.action in out) out[r.action] += 1;
  }
  return out;
}

type SearchParams = {
  email?: string;
  action?: string;
  role?: string;
  ip?: string;
  from?: string;
  to?: string;
};

/**
 * Normaliza IP digitado pelo admin. Aceita:
 *   - IPv4 simples: "1.2.3.4"
 *   - IPv6: "::1", "fe80::1"
 *
 * Recusa strings com espaço, comma ou caracteres fora do set aceito.
 * Não valida semanticamente (Postgres `inet` faz isso); só evita
 * injection via query param.
 */
function parseIpFilter(raw: string | string[] | undefined): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (trimmed.length === 0 || trimmed.length > 45) return null;
  // IPv4/IPv6 sanity: apenas hex, dígitos, '.', ':'.
  if (!/^[0-9a-fA-F:.]+$/.test(trimmed)) return null;
  return trimmed;
}

export default async function MagicLinksPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const rawEmail = parseSearch(params.email);
  const action = parseStatusFilter<MagicLinkAction>(params.action, ACTIONS);
  const role = parseStatusFilter<Role>(params.role, ROLES);
  const ip = parseIpFilter(params.ip);
  const { fromIso, toIso, invertedRange } = parseDateRange(params.from, params.to);

  // Hash do email é computado no servidor antes de virar WHERE.
  // Se o admin digitar email malformado, hashEmail lança — tratamos
  // fail-soft: sem hash, filtro vira null (sem resultado).
  let emailHash: string | null = null;
  if (rawEmail) {
    try {
      emailHash = hashEmail(rawEmail);
    } catch {
      emailHash = null;
    }
  }

  const filters: Filters = {
    emailHash,
    rawEmail,
    action,
    role,
    ip,
    fromIso,
    toIso,
    invertedRange,
  };
  const isFiltered = hasActiveFilters({ rawEmail, action, role, ip, fromIso, toIso });

  const supabase = getSupabaseAdmin();
  const [rows, counts24h] = await Promise.all([
    loadLogs(filters),
    loadLast24hCounts(supabase),
  ]);

  const totalLast24h = Object.values(counts24h).reduce((a, b) => a + b, 0);
  const issuesLast24h =
    counts24h.rate_limited + counts24h.provider_error + counts24h.verify_failed;

  return (
    <div>
      <header className="mb-6">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Observabilidade
        </p>
        <h1 className="font-serif text-[1.85rem] sm:text-[2.2rem] leading-tight text-ink-800">
          Magic-links
        </h1>
        <p className="mt-1 text-ink-500 max-w-2xl">
          Trilha forense de emissões e verificações de magic-link (D-078).
          Email nunca é armazenado em plaintext — o hash SHA-256 é
          determinístico, então digitar o email aqui encontra todas as
          linhas daquela pessoa sem vazar dado no banco. Read-only por
          design (audit trail é imutável).
        </p>
      </header>

      {/* Resumo 24h */}
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        <Card
          label="Últimas 24h"
          value={String(totalLast24h)}
          hint="eventos registrados"
          tone="ink"
        />
        <Card
          label="Emitidos"
          value={String(counts24h.issued + counts24h.auto_provisioned)}
          hint={`${counts24h.issued} issued · ${counts24h.auto_provisioned} auto-provisionados`}
          tone="sage"
        />
        <Card
          label="Verificados"
          value={String(counts24h.verified)}
          hint="tokens usados com sucesso"
          tone="sage"
        />
        <Card
          label="Incidentes"
          value={String(issuesLast24h)}
          hint={`${counts24h.rate_limited} RL · ${counts24h.provider_error} provider · ${counts24h.verify_failed} verify`}
          tone={issuesLast24h > 0 ? "terracotta" : "ink"}
        />
      </section>

      {/* Filtros */}
      <FilterBar
        defaults={{
          email: rawEmail ?? "",
          action: action ?? "",
          role: role ?? "",
          ip: ip ?? "",
          from: typeof params.from === "string" ? params.from : "",
          to: typeof params.to === "string" ? params.to : "",
        }}
        invertedRange={invertedRange}
        emailHashMismatch={Boolean(rawEmail) && emailHash === null}
      />

      {/* Listagem */}
      <section>
        <h2 className="font-serif text-[1.3rem] text-ink-800 mb-4">
          Eventos{" "}
          <span className="text-ink-400 font-sans text-base font-normal">
            ({rows.length}
            {isFiltered ? " · filtrado" : ""})
          </span>
        </h2>

        {rows.length === 0 ? (
          <p className="text-ink-500">
            {isFiltered
              ? "Nenhum evento bate com os filtros."
              : "Sem eventos registrados ainda."}
          </p>
        ) : (
          <div className="rounded-2xl bg-white border border-ink-100 overflow-hidden">
            <table className="w-full">
              <thead className="bg-cream-50 border-b border-ink-100">
                <tr className="text-left text-[0.72rem] uppercase tracking-[0.12em] text-ink-500 font-medium">
                  <th className="px-5 py-2.5">Quando</th>
                  <th className="px-5 py-2.5">Ação</th>
                  <th className="px-5 py-2.5">Role</th>
                  <th className="px-5 py-2.5">Email</th>
                  <th className="px-5 py-2.5">IP</th>
                  <th className="px-5 py-2.5">Rota</th>
                  <th className="px-5 py-2.5">Detalhe</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-cream-50 align-top">
                    <td className="px-5 py-3 text-xs text-ink-600 font-mono whitespace-nowrap">
                      {fmtDateTime(r.issued_at)}
                    </td>
                    <td className="px-5 py-3 text-sm">
                      <ActionBadge action={r.action} />
                    </td>
                    <td className="px-5 py-3 text-sm text-ink-600">
                      {r.role ?? (
                        <span className="text-ink-400">—</span>
                      )}
                    </td>
                    <td
                      className="px-5 py-3 text-xs text-ink-500 font-mono"
                      title={`hash=${r.email_hash}`}
                    >
                      {r.email_domain ? (
                        <span className="text-ink-700">@{r.email_domain}</span>
                      ) : (
                        <span className="text-ink-400">—</span>
                      )}
                      <span className="text-ink-400">
                        {" "}
                        · {r.email_hash.slice(0, 8)}…
                      </span>
                    </td>
                    <td className="px-5 py-3 text-xs text-ink-600 font-mono whitespace-nowrap">
                      {r.ip ?? (
                        <span className="text-ink-400">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-xs text-ink-500 font-mono break-all max-w-[200px]">
                      {r.route}
                    </td>
                    <td className="px-5 py-3 text-xs text-ink-500 max-w-[280px]">
                      {r.reason ? (
                        <span className="italic break-words">
                          &ldquo;{r.reason.slice(0, 160)}
                          {r.reason.length > 160 ? "…" : ""}&rdquo;
                        </span>
                      ) : r.next_path ? (
                        <span className="font-mono">→ {r.next_path}</span>
                      ) : (
                        <span className="text-ink-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-10 rounded-2xl bg-cream-50 border border-ink-100 p-5 text-sm text-ink-600 leading-relaxed">
        <h3 className="font-serif text-[1.1rem] text-ink-800 mb-2">
          Troubleshooting rápido
        </h3>
        <p className="mb-2">
          Quando um paciente diz <em>&ldquo;não recebi o link&rdquo;</em>:
        </p>
        <ol className="list-decimal ml-5 space-y-1">
          <li>
            Peça o email exato e digite no campo &ldquo;Email&rdquo; acima.
          </li>
          <li>
            <strong>Se aparece linha com action &ldquo;Emitido&rdquo;</strong>:
            link foi enviado. Peça pro paciente olhar caixa de spam/promoções.
            Se ainda nada, o provedor (Supabase SMTP) pode ter bouncado —
            considere re-tentar depois de 1h.
          </li>
          <li>
            <strong>Se aparece &ldquo;Silenciado (conta inexistente)&rdquo;</strong>:
            paciente não tem `auth.user` com esse email. Veja em
            <code className="bg-white px-1 py-0.5 rounded border border-ink-200 ml-1">
              auth.users
            </code>{" "}
            se há typo.
          </li>
          <li>
            <strong>Se aparece &ldquo;Rate-limited&rdquo;</strong>: o IP
            excedeu o limite. Espere 15 min e peça pra tentar de novo. Múltiplos
            IPs no mesmo email = suspeita de ataque.
          </li>
          <li>
            <strong>Se aparece &ldquo;Erro do provider&rdquo;</strong>: Supabase
            devolveu erro. O detalhe está na coluna &ldquo;Detalhe&rdquo;. Abra
            o Supabase dashboard e verifique Auth → Logs.
          </li>
        </ol>
        <p className="mt-3">
          Consulta SQL equivalente em `docs/RUNBOOK.md` §16 (pra quando esta
          UI estiver indisponível).
        </p>
        <p className="mt-2 text-ink-500 text-xs">
          Ver também:{" "}
          <Link
            href="/admin/errors"
            className="underline decoration-ink-300 hover:decoration-ink-600"
          >
            /admin/errors
          </Link>{" "}
          (erros de sistema correlacionados) ·{" "}
          <Link
            href="/admin/health"
            className="underline decoration-ink-300 hover:decoration-ink-600"
          >
            /admin/health
          </Link>{" "}
          (snapshot geral).
        </p>
      </section>
    </div>
  );
}

function Card({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
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
      <p className="text-[0.72rem] uppercase tracking-[0.14em] text-ink-500 font-medium mb-2">
        {label}
      </p>
      <p className={`font-serif text-[1.6rem] leading-none ${valueClasses}`}>
        {value}
      </p>
      <p className="mt-2 text-xs text-ink-500">{hint}</p>
    </div>
  );
}

function ActionBadge({ action }: { action: MagicLinkAction }) {
  const tone = ACTION_TONES[action];
  const toneClasses: Record<typeof tone, string> = {
    sage: "bg-sage-50 text-sage-800 border-sage-200",
    ink: "bg-cream-100 text-ink-700 border-ink-200",
    terracotta: "bg-terracotta-50 text-terracotta-700 border-terracotta-200",
    amber: "bg-amber-50 text-amber-800 border-amber-200",
  };
  return (
    <span
      className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full border whitespace-nowrap ${toneClasses[tone]}`}
    >
      {ACTION_LABELS[action]}
    </span>
  );
}

function FilterBar({
  defaults,
  invertedRange,
  emailHashMismatch,
}: {
  defaults: {
    email: string;
    action: string;
    role: string;
    ip: string;
    from: string;
    to: string;
  };
  invertedRange: boolean;
  emailHashMismatch: boolean;
}) {
  const isFiltered =
    defaults.email.length > 0 ||
    defaults.action.length > 0 ||
    defaults.role.length > 0 ||
    defaults.ip.length > 0 ||
    defaults.from.length > 0 ||
    defaults.to.length > 0;

  return (
    <form
      method="get"
      action="/admin/magic-links"
      className="mb-6 rounded-2xl border border-ink-100 bg-white p-4"
    >
      <div className="grid gap-3 md:grid-cols-[1.5fr_1fr_140px_160px_140px_140px_auto]">
        <input
          type="email"
          name="email"
          defaultValue={defaults.email}
          placeholder="Email exato (será hasheado)"
          className="h-10 px-3 rounded-lg border border-ink-200 bg-white text-sm text-ink-800 focus:outline-none focus:border-sage-500"
          aria-label="Filtrar por email (hasheado no servidor)"
        />
        <select
          name="action"
          defaultValue={defaults.action}
          className="h-10 px-3 rounded-lg border border-ink-200 bg-white text-sm text-ink-800 focus:outline-none focus:border-sage-500"
          aria-label="Filtrar por ação"
        >
          <option value="">Todas as ações</option>
          {ACTIONS.map((a) => (
            <option key={a} value={a}>
              {ACTION_LABELS[a]}
            </option>
          ))}
        </select>
        <select
          name="role"
          defaultValue={defaults.role}
          className="h-10 px-3 rounded-lg border border-ink-200 bg-white text-sm text-ink-800 focus:outline-none focus:border-sage-500"
          aria-label="Filtrar por role"
        >
          <option value="">Todas as roles</option>
          <option value="admin">admin</option>
          <option value="doctor">doctor</option>
          <option value="patient">patient</option>
        </select>
        <input
          type="text"
          name="ip"
          defaultValue={defaults.ip}
          placeholder="IP exato"
          className="h-10 px-3 rounded-lg border border-ink-200 bg-white text-sm text-ink-800 focus:outline-none focus:border-sage-500 font-mono"
          aria-label="Filtrar por IP"
        />
        <input
          type="date"
          name="from"
          defaultValue={defaults.from}
          className="h-10 px-3 rounded-lg border border-ink-200 bg-white text-sm text-ink-800 focus:outline-none focus:border-sage-500"
          aria-label="Emitido a partir de"
        />
        <input
          type="date"
          name="to"
          defaultValue={defaults.to}
          className="h-10 px-3 rounded-lg border border-ink-200 bg-white text-sm text-ink-800 focus:outline-none focus:border-sage-500"
          aria-label="Emitido até"
        />
        <div className="flex gap-2">
          <button
            type="submit"
            className="h-10 px-4 rounded-lg bg-ink-800 text-white text-sm font-medium hover:bg-ink-700 transition-colors"
          >
            Filtrar
          </button>
          {isFiltered && (
            <Link
              href={buildAdminListUrl("/admin/magic-links", {})}
              className="h-10 px-4 flex items-center rounded-lg border border-ink-200 text-sm text-ink-600 hover:bg-cream-50 transition-colors"
            >
              Limpar
            </Link>
          )}
        </div>
      </div>
      {invertedRange && (
        <p className="mt-2 text-xs text-terracotta-700">
          ⚠ Data inicial maior que a final — corrija pra ver resultados.
        </p>
      )}
      {emailHashMismatch && (
        <p className="mt-2 text-xs text-terracotta-700">
          ⚠ Email malformado — impossível hashear. Corrija pra filtrar.
        </p>
      )}
      <p className="mt-2 text-[0.72rem] text-ink-500">
        Dica: email é hasheado <strong>no servidor</strong> antes da query —
        o banco nunca vê plaintext. Listagem mostra só hash (8 chars) +
        domínio (armazenado cleartext por design LGPD).
      </p>
    </form>
  );
}
