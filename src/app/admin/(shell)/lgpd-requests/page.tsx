/**
 * /admin/lgpd-requests — PR-017 · Onda 2A · D-051
 *
 * Triagem de solicitações LGPD feitas pelo paciente via self-service.
 *
 * Lista 3 seções:
 *   1. Pendentes de anonimização (a triar, SLA 15 dias).
 *   2. Histórico recente de anonimizações concluídas e recusadas.
 *   3. Últimos exports baixados (só pra observabilidade — não exigem ação).
 *
 * O operador processa cada pendência num mini-form inline (fulfill /
 * reject com motivo). Ao concluir, a página se recarrega e reflete o
 * estado.
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import { formatDateTimeBR, formatDateTimeShortBR } from "@/lib/datetime-br";
import { SLA_HOURS } from "@/lib/admin-inbox";
import { LgpdRequestRow } from "./_LgpdRequestRow";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type PendingRow = {
  id: string;
  kind: "anonymize";
  status: "pending";
  requested_at: string;
  requester_ip: string | null;
  requester_user_agent: string | null;
  customer_id: string;
  customers: {
    name: string | null;
    email: string | null;
    phone: string | null;
    anonymized_at: string | null;
  } | null;
};

type HistoryRow = {
  id: string;
  kind: "export_copy" | "anonymize";
  status: "fulfilled" | "rejected" | "cancelled";
  requested_at: string;
  fulfilled_at: string | null;
  rejected_reason: string | null;
  export_bytes: number | null;
  customer_id: string;
  customers: { name: string | null; anonymized_ref: string | null } | null;
};

type RetentionRow = {
  id: string;
  created_at: string;
  entity_id: string | null;
  after_json: { anonymized_ref?: string; anonymized_at?: string } | null;
  metadata: {
    thresholdDays?: number;
    candidateCreatedAt?: string;
    candidateUpdatedAt?: string;
  } | null;
};

function hoursSince(iso: string, now: Date): number {
  const ms = now.getTime() - new Date(iso).getTime();
  return ms / 3_600_000;
}

export default async function LgpdRequestsPage() {
  const supabase = getSupabaseAdmin();
  const now = new Date();

  const [
    { data: pending },
    { data: history },
    { data: retention },
  ] = await Promise.all([
    supabase
      .from("lgpd_requests")
      .select(
        "id, kind, status, requested_at, requester_ip, requester_user_agent, customer_id, customers(name, email, phone, anonymized_at)"
      )
      .eq("kind", "anonymize")
      .eq("status", "pending")
      .order("requested_at", { ascending: true })
      .limit(100),
    supabase
      .from("lgpd_requests")
      .select(
        "id, kind, status, requested_at, fulfilled_at, rejected_reason, export_bytes, customer_id, customers(name, anonymized_ref)"
      )
      .in("status", ["fulfilled", "rejected", "cancelled"])
      .order("updated_at", { ascending: false })
      .limit(50),
    // PR-033-A · D-052: últimas anonimizações automáticas por política
    // de retenção (actor_kind=system). Puramente informativo — não
    // exige ação do operador — mas dá visibilidade de quanto a política
    // está "funcionando sozinha" e de quais registros foram tocados.
    supabase
      .from("admin_audit_log")
      .select("id, created_at, entity_id, after_json, metadata")
      .eq("action", "customer.retention_anonymize")
      .eq("actor_kind", "system")
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  // supabase-js infere joins N:1 como array; normalizamos aqui.
  const pendingRows = (pending ?? []) as unknown as PendingRow[];
  const historyRows = (history ?? []) as unknown as HistoryRow[];
  const retentionRows = (retention ?? []) as unknown as RetentionRow[];

  return (
    <div className="p-6 lg:p-8 space-y-10">
      <header>
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Privacidade
        </p>
        <h1 className="font-serif text-[2rem] text-ink-800">
          Solicitações LGPD
        </h1>
        <p className="mt-2 text-sm text-ink-500 max-w-2xl">
          Pacientes pediram anonimização via self-service em{" "}
          <code>/paciente/meus-dados</code>. Prazo legal de resposta: 15
          dias corridos (Art. 19 §1º). Ação é irreversível — revise antes
          de confirmar.
        </p>
      </header>

      {/* Pendentes */}
      <section>
        <h2 className="font-serif text-[1.35rem] text-ink-800 mb-4">
          Pendentes ({pendingRows.length})
        </h2>
        {pendingRows.length === 0 ? (
          <p className="text-sm text-ink-500">
            Nenhuma solicitação pendente no momento.
          </p>
        ) : (
          <div className="space-y-3">
            {pendingRows.map((r) => {
              const age = hoursSince(r.requested_at, now);
              const overSla = age > SLA_HOURS.lgpd_pending;
              return (
                <LgpdRequestRow
                  key={r.id}
                  requestId={r.id}
                  customerId={r.customer_id}
                  requestedAt={formatDateTimeBR(r.requested_at)}
                  patientName={r.customers?.name ?? "—"}
                  patientEmail={r.customers?.email ?? null}
                  patientPhone={r.customers?.phone ?? null}
                  requesterIp={r.requester_ip}
                  requesterUserAgent={r.requester_user_agent}
                  overSla={overSla}
                  alreadyAnonymized={Boolean(r.customers?.anonymized_at)}
                />
              );
            })}
          </div>
        )}
      </section>

      {/* Histórico */}
      <section>
        <h2 className="font-serif text-[1.35rem] text-ink-800 mb-4">
          Histórico recente
        </h2>
        {historyRows.length === 0 ? (
          <p className="text-sm text-ink-500">
            Nenhuma solicitação concluída ainda.
          </p>
        ) : (
          <div className="rounded-lg border border-ink-100 bg-white overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-cream-50 text-ink-500">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Tipo</th>
                  <th className="text-left px-3 py-2 font-medium">Paciente</th>
                  <th className="text-left px-3 py-2 font-medium">
                    Solicitado
                  </th>
                  <th className="text-left px-3 py-2 font-medium">Status</th>
                  <th className="text-left px-3 py-2 font-medium">Detalhe</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {historyRows.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2 text-ink-800">
                      {r.kind === "export_copy" ? "Export" : "Anonimização"}
                    </td>
                    <td className="px-3 py-2 text-ink-800">
                      {r.customers?.name ??
                        (r.customers?.anonymized_ref
                          ? `#${r.customers.anonymized_ref}`
                          : "—")}
                    </td>
                    <td className="px-3 py-2 text-ink-600">
                      {formatDateTimeShortBR(r.requested_at)}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${
                          r.status === "fulfilled"
                            ? "bg-sage-100 text-sage-800"
                            : r.status === "rejected"
                            ? "bg-terracotta-100 text-terracotta-800"
                            : "bg-ink-50 text-ink-600"
                        }`}
                      >
                        {r.status === "fulfilled"
                          ? "Atendida"
                          : r.status === "rejected"
                          ? "Recusada"
                          : "Cancelada"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-ink-600">
                      {r.rejected_reason ??
                        (r.fulfilled_at
                          ? formatDateTimeShortBR(r.fulfilled_at)
                          : r.export_bytes != null
                          ? `${(r.export_bytes / 1024).toFixed(1)} KB`
                          : "—")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Retenção automática (PR-033-A) */}
      <section>
        <h2 className="font-serif text-[1.35rem] text-ink-800 mb-1">
          Retenção automática{" "}
          <span className="text-sm text-ink-500 font-sans font-normal">
            (últimas 20)
          </span>
        </h2>
        <p className="text-sm text-ink-500 mb-4 max-w-2xl">
          Pacientes &quot;ghost&quot; (cadastraram-se e não geraram
          consulta/fulfillment) anonimizados pelo cron semanal conforme LGPD
          Art. 16. Estas ações são executadas por{" "}
          <code>system:retention</code> sem intervenção humana.
        </p>
        {retentionRows.length === 0 ? (
          <p className="text-sm text-ink-500">
            Nenhuma anonimização automática registrada até o momento.
          </p>
        ) : (
          <div className="rounded-lg border border-ink-100 bg-white overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-cream-50 text-ink-500">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">
                    Executado em
                  </th>
                  <th className="text-left px-3 py-2 font-medium">Ref</th>
                  <th className="text-left px-3 py-2 font-medium">
                    Threshold
                  </th>
                  <th className="text-left px-3 py-2 font-medium">
                    Cadastro original
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {retentionRows.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2 text-ink-800">
                      {formatDateTimeShortBR(r.created_at)}
                    </td>
                    <td className="px-3 py-2 text-ink-800 font-mono text-xs">
                      {r.after_json?.anonymized_ref
                        ? `#${r.after_json.anonymized_ref}`
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-ink-600">
                      {r.metadata?.thresholdDays
                        ? `${r.metadata.thresholdDays}d`
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-ink-600">
                      {r.metadata?.candidateCreatedAt
                        ? formatDateTimeShortBR(
                            r.metadata.candidateCreatedAt
                          )
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
