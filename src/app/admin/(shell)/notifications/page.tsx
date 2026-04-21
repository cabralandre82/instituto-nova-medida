/**
 * /admin/notifications — Observabilidade da fila `appointment_notifications`.
 *
 * Por quê (D-033):
 *   D-031 introduziu a fila persistente de WhatsApp com worker rodando a
 *   cada 1 min. Sem UI, a única forma de saber "a Meta está rejeitando?
 *   ficou tudo pending? templates aprovados?" é SQL manual no Supabase.
 *   Esta tela é o HUD do operador.
 *
 * Filtros via query string (server-rendered, cacheável):
 *   - ?status=pending|sent|failed|delivered|read|all (default: all, mas
 *     ordenação favorece failed + pending no topo)
 *   - ?kind=<qualquer valor textual> (match exato)
 *   - ?appointment=<uuid parcial> (match ILIKE)
 *   - ?page=N (0-indexed, 50 por página)
 *
 * Ação única hoje: "re-enfileirar" uma notif `failed` ou `pending` travada
 * via `POST /api/admin/notifications/[id]/retry`.
 */

import Link from "next/link";
import { getSupabaseAdmin } from "@/lib/supabase";
import { NotificationRetryButton } from "./_NotificationRetryButton";
import { NotificationFilters } from "./_NotificationFilters";
import { formatDateBR } from "@/lib/datetime-br";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/admin/notifications" });

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

type NotifStatus = "pending" | "sent" | "delivered" | "read" | "failed";

type NotificationRow = {
  id: string;
  appointment_id: string;
  kind: string;
  template_name: string | null;
  status: NotifStatus;
  scheduled_for: string | null;
  sent_at: string | null;
  message_id: string | null;
  error: string | null;
  created_at: string;
  appointments: {
    id: string;
    scheduled_at: string;
    status: string;
    customers: { name: string } | null;
    doctors: { display_name: string | null; full_name: string } | null;
  } | null;
};

type Counts = Record<NotifStatus, number>;

const STATUS_CLS: Record<NotifStatus, string> = {
  pending: "bg-cream-100 text-ink-700 border-ink-200",
  sent: "bg-blue-50 text-blue-800 border-blue-200",
  delivered: "bg-sage-50 text-sage-800 border-sage-200",
  read: "bg-sage-100 text-sage-900 border-sage-300",
  failed: "bg-terracotta-100 text-terracotta-800 border-terracotta-300",
};

const STATUS_LABEL: Record<NotifStatus, string> = {
  pending: "Pendente",
  sent: "Enviada",
  delivered: "Entregue",
  read: "Lida",
  failed: "Falhou",
};

// Labels humanos pros kinds conhecidos. Kinds desconhecidos renderizam o
// próprio valor (forward-compatible quando adicionarmos novos tipos).
const KIND_LABEL: Record<string, string> = {
  confirmacao: "Confirmação",
  t_minus_24h: "Lembrete T-24h",
  t_minus_1h: "Lembrete T-1h",
  t_minus_15min: "Link da sala (T-15min)",
  t_plus_10min: "Pós-consulta (T+10min)",
  pos_consulta: "Pós-consulta",
  reserva_expirada: "Reserva expirada",
  on_demand_call: "Fila on-demand",
  no_show_patient: "No-show paciente",
  no_show_doctor: "No-show médica",
};

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  return formatDateBR(iso, {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

async function loadCounts(): Promise<Counts> {
  const supabase = getSupabaseAdmin();
  const statuses: NotifStatus[] = [
    "pending",
    "sent",
    "delivered",
    "read",
    "failed",
  ];
  const results = await Promise.all(
    statuses.map((s) =>
      supabase
        .from("appointment_notifications")
        .select("id", { head: true, count: "exact" })
        .eq("status", s)
    )
  );
  const out = {} as Counts;
  statuses.forEach((s, i) => {
    out[s] = results[i].count ?? 0;
  });
  return out;
}

async function loadRows({
  status,
  kind,
  appointmentQuery,
  page,
}: {
  status: NotifStatus | "all";
  kind: string | null;
  appointmentQuery: string | null;
  page: number;
}): Promise<{ rows: NotificationRow[]; total: number }> {
  const supabase = getSupabaseAdmin();

  let query = supabase
    .from("appointment_notifications")
    .select(
      "id, appointment_id, kind, template_name, status, scheduled_for, sent_at, message_id, error, created_at, appointments ( id, scheduled_at, status, customers ( name ), doctors ( display_name, full_name ) )",
      { count: "exact" }
    );

  if (status !== "all") {
    query = query.eq("status", status);
  }
  if (kind) {
    query = query.eq("kind", kind);
  }
  if (appointmentQuery) {
    query = query.ilike("appointment_id", `%${appointmentQuery}%`);
  }

  const from = page * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  // Ordenação: failed primeiro (pra admin ver problema em cima), depois
  // pending pelo scheduled_for, depois o resto por created_at desc.
  // Como o Supabase client não suporta ORDER com CASE, aproximamos com 2
  // ordenações: primeiro por status (alfabética bota `failed` antes de
  // `pending`/`sent`), depois por created_at desc.
  const { data, error, count } = await query
    .order("status", { ascending: true })
    .order("created_at", { ascending: false })
    .range(from, to);

  if (error) {
    log.error("load", { err: error });
    return { rows: [], total: 0 };
  }
  return {
    rows: (data ?? []) as unknown as NotificationRow[],
    total: count ?? 0,
  };
}

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const statusRaw = (sp.status as string) ?? "all";
  const status: NotifStatus | "all" =
    statusRaw === "pending" ||
    statusRaw === "sent" ||
    statusRaw === "delivered" ||
    statusRaw === "read" ||
    statusRaw === "failed"
      ? (statusRaw as NotifStatus)
      : "all";
  const kind = typeof sp.kind === "string" && sp.kind.length > 0 ? sp.kind : null;
  const appointmentQuery =
    typeof sp.appointment === "string" && sp.appointment.length > 0
      ? sp.appointment.trim()
      : null;
  const pageNum = Math.max(0, parseInt((sp.page as string) ?? "0", 10) || 0);

  const [{ rows, total }, counts] = await Promise.all([
    loadRows({ status, kind, appointmentQuery, page: pageNum }),
    loadCounts(),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <header className="mb-6">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Operações
        </p>
        <h1 className="font-serif text-[1.85rem] sm:text-[2.2rem] leading-tight text-ink-800">
          Notificações WhatsApp
        </h1>
        <p className="mt-1 text-ink-500">
          Fila persistente de disparos (D-031). O worker processa a cada 1
          min. Enquanto <code className="font-mono text-xs">WHATSAPP_TEMPLATES_APPROVED</code>{" "}
          não for <code className="font-mono text-xs">true</code>, linhas
          ficam em <em>pending</em> sem gastar quota da Meta.
        </p>
      </header>

      {/* Contadores por status */}
      <section className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
        {(["failed", "pending", "sent", "delivered", "read"] as NotifStatus[]).map(
          (s) => (
            <Link
              key={s}
              href={`/admin/notifications?status=${s}`}
              className={`rounded-xl border px-4 py-3 transition-colors hover:border-ink-300 ${
                status === s ? "ring-2 ring-ink-800/10" : ""
              } ${STATUS_CLS[s]}`}
            >
              <div className="text-[0.72rem] uppercase tracking-[0.12em] font-medium opacity-80">
                {STATUS_LABEL[s]}
              </div>
              <div className="font-serif text-[1.6rem] leading-none mt-1">
                {counts[s]}
              </div>
            </Link>
          )
        )}
      </section>

      {/* Filtros */}
      <NotificationFilters
        status={status}
        kind={kind ?? ""}
        appointment={appointmentQuery ?? ""}
      />

      {/* Tabela */}
      <section className="rounded-2xl bg-white border border-ink-100 overflow-hidden">
        <header className="px-6 py-3 border-b border-ink-100 flex justify-between items-center text-sm">
          <span className="text-ink-600">
            {total === 0
              ? "Nenhuma notificação com esses filtros."
              : `${total} notificação${total === 1 ? "" : "s"}`}
          </span>
          {totalPages > 1 && (
            <span className="text-ink-500">
              Página {pageNum + 1} de {totalPages}
            </span>
          )}
        </header>

        {rows.length === 0 ? (
          <p className="px-6 py-10 text-center text-ink-500">
            Sem resultados.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px]">
              <thead className="bg-cream-50 border-b border-ink-100">
                <tr className="text-left text-[0.72rem] uppercase tracking-[0.12em] text-ink-500 font-medium">
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Tipo</th>
                  <th className="px-4 py-2.5">Consulta</th>
                  <th className="px-4 py-2.5">Agendado para</th>
                  <th className="px-4 py-2.5">Enviado</th>
                  <th className="px-4 py-2.5">Erro / msg_id</th>
                  <th className="px-4 py-2.5 text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-cream-50 align-top">
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full border ${STATUS_CLS[r.status]}`}
                      >
                        {STATUS_LABEL[r.status]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <div className="text-ink-800 font-medium">
                        {KIND_LABEL[r.kind] ?? r.kind}
                      </div>
                      {r.template_name && (
                        <div className="text-xs text-ink-400 font-mono mt-0.5">
                          {r.template_name}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <div className="text-ink-800">
                        {r.appointments?.customers?.name ?? "(sem cliente)"}
                      </div>
                      <div className="text-xs text-ink-500">
                        com{" "}
                        {r.appointments?.doctors?.display_name ??
                          r.appointments?.doctors?.full_name ??
                          "—"}
                      </div>
                      <div className="text-xs text-ink-400 mt-0.5">
                        {fmtDateTime(r.appointments?.scheduled_at ?? null)} ·{" "}
                        <span className="font-mono">
                          {r.appointment_id.slice(0, 8)}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-ink-600 font-mono">
                      {fmtDateTime(r.scheduled_for)}
                    </td>
                    <td className="px-4 py-3 text-sm text-ink-600 font-mono">
                      {fmtDateTime(r.sent_at)}
                    </td>
                    <td className="px-4 py-3 text-xs text-ink-500 max-w-[240px]">
                      {r.error ? (
                        <div className="text-terracotta-700 break-words">
                          {truncate(r.error, 120)}
                        </div>
                      ) : r.message_id ? (
                        <div className="font-mono text-ink-400 break-all">
                          {r.message_id}
                        </div>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {(r.status === "failed" || r.status === "pending") && (
                        <NotificationRetryButton id={r.id} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Paginação */}
        {totalPages > 1 && (
          <footer className="px-6 py-3 border-t border-ink-100 flex justify-between items-center text-sm">
            <PageLink
              label="← Anterior"
              disabled={pageNum === 0}
              pageNum={pageNum - 1}
              status={status}
              kind={kind}
              appointmentQuery={appointmentQuery}
            />
            <span className="text-ink-500">
              {pageNum + 1} / {totalPages}
            </span>
            <PageLink
              label="Próxima →"
              disabled={pageNum + 1 >= totalPages}
              pageNum={pageNum + 1}
              status={status}
              kind={kind}
              appointmentQuery={appointmentQuery}
            />
          </footer>
        )}
      </section>
    </div>
  );
}

function PageLink({
  label,
  disabled,
  pageNum,
  status,
  kind,
  appointmentQuery,
}: {
  label: string;
  disabled: boolean;
  pageNum: number;
  status: NotifStatus | "all";
  kind: string | null;
  appointmentQuery: string | null;
}) {
  if (disabled) {
    return <span className="text-ink-300">{label}</span>;
  }
  const qs = new URLSearchParams();
  if (status !== "all") qs.set("status", status);
  if (kind) qs.set("kind", kind);
  if (appointmentQuery) qs.set("appointment", appointmentQuery);
  qs.set("page", String(pageNum));
  return (
    <Link
      href={`/admin/notifications?${qs.toString()}`}
      className="text-sage-700 hover:text-sage-800 hover:underline font-medium"
    >
      {label}
    </Link>
  );
}
