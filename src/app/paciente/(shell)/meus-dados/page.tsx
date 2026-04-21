/**
 * /paciente/meus-dados — Self-service LGPD — PR-017 · Onda 2A · D-051
 *
 * Entrega ao paciente:
 *
 *   - Resumo dos seus dados pessoais (nome, email, CPF mascarado,
 *     endereço, quantidade de consultas/fulfillments/pagamentos).
 *   - Botão "Baixar meus dados" → GET do JSON completo.
 *   - Bloco "Direito à anonimização" com disclaimer CFM/fiscal
 *     (prontuário e fiscal são retidos por obrigação legal) e botão
 *     pra solicitar — a anonimização é feita pelo operador depois.
 *   - Histórico das solicitações anteriores (export baixados + pedidos
 *     de anonimização com status).
 *
 * A tela nunca manipula PII no cliente; renderização é server-side.
 */

import { requirePatient } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { formatDateTimeShortBR } from "@/lib/datetime-br";
import {
  getPendingAnonymizeRequest,
  listLgpdRequestsForCustomer,
  type LgpdRequestRecord,
} from "@/lib/patient-lgpd-requests";
import { MeusDadosActions } from "./_MeusDadosActions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function maskCpf(cpf: string | null | undefined): string {
  if (!cpf) return "—";
  const only = cpf.replace(/\D/g, "");
  if (only.length !== 11) return "—";
  return `${only.slice(0, 3)}.***.***-${only.slice(9)}`;
}

function statusLabel(status: LgpdRequestRecord["status"]): string {
  switch (status) {
    case "pending":
      return "Em análise";
    case "fulfilled":
      return "Atendida";
    case "rejected":
      return "Recusada";
    case "cancelled":
      return "Cancelada";
  }
}

function kindLabel(kind: LgpdRequestRecord["kind"]): string {
  return kind === "export_copy"
    ? "Download dos dados"
    : "Solicitação de anonimização";
}

export default async function MeusDadosPage() {
  const { customerId } = await requirePatient();
  const supabase = getSupabaseAdmin();

  const [customer, appointmentsCount, fulfillmentsCount, paymentsCount, history, pendingAnonymize] =
    await Promise.all([
      supabase
        .from("customers")
        .select(
          "id, name, email, phone, cpf, address_zipcode, address_street, address_number, address_complement, address_district, address_city, address_state, anonymized_at, created_at"
        )
        .eq("id", customerId)
        .maybeSingle(),
      supabase
        .from("appointments")
        .select("id", { count: "exact", head: true })
        .eq("customer_id", customerId),
      supabase
        .from("fulfillments")
        .select("id", { count: "exact", head: true })
        .eq("customer_id", customerId),
      supabase
        .from("payments")
        .select("id", { count: "exact", head: true })
        .eq("customer_id", customerId),
      listLgpdRequestsForCustomer(supabase, customerId),
      getPendingAnonymizeRequest(supabase, customerId),
    ]);

  const data = (customer.data ?? null) as {
    name: string | null;
    email: string | null;
    phone: string | null;
    cpf: string | null;
    address_zipcode: string | null;
    address_street: string | null;
    address_number: string | null;
    address_complement: string | null;
    address_district: string | null;
    address_city: string | null;
    address_state: string | null;
    anonymized_at: string | null;
    created_at: string | null;
  } | null;

  const addressParts = data
    ? [
        data.address_street,
        data.address_number,
        data.address_complement,
        data.address_district,
        data.address_city && data.address_state
          ? `${data.address_city}/${data.address_state}`
          : null,
        data.address_zipcode ? `CEP ${data.address_zipcode}` : null,
      ].filter(Boolean)
    : [];

  return (
    <div>
      <header className="mb-8">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Privacidade e meus direitos
        </p>
        <h1 className="font-serif text-[2rem] sm:text-[2.4rem] leading-tight text-ink-800">
          Meus dados
        </h1>
        <p className="mt-2 text-ink-500 max-w-xl">
          Aqui você vê todos os dados pessoais que o Instituto Nova
          Medida mantém sobre você. Pode baixá-los ou solicitar
          anonimização — tudo direto, sem precisar pedir por e-mail.
        </p>
      </header>

      {/* Resumo em leitura */}
      <section className="mb-8 rounded-2xl border border-ink-100 bg-white p-6 space-y-4">
        <h2 className="font-serif text-[1.25rem] text-ink-800">
          Seu cadastro
        </h2>
        <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-4 text-sm">
          <div>
            <dt className="text-ink-500">Nome</dt>
            <dd className="text-ink-800 font-medium">{data?.name ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-ink-500">E-mail</dt>
            <dd className="text-ink-800">{data?.email ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-ink-500">Telefone</dt>
            <dd className="text-ink-800">{data?.phone ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-ink-500">CPF</dt>
            <dd className="text-ink-800 font-mono">{maskCpf(data?.cpf)}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-ink-500">Endereço</dt>
            <dd className="text-ink-800">
              {addressParts.length ? addressParts.join(", ") : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-ink-500">Cadastro desde</dt>
            <dd className="text-ink-800">
              {data?.created_at
                ? formatDateTimeShortBR(data.created_at)
                : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-ink-500">Consultas</dt>
            <dd className="text-ink-800">
              {appointmentsCount.count ?? 0} · {fulfillmentsCount.count ?? 0}{" "}
              tratamentos · {paymentsCount.count ?? 0} pagamentos
            </dd>
          </div>
        </dl>
        <p className="text-xs text-ink-500">
          CPF mascarado no topo por segurança. O CPF completo está no
          arquivo JSON que você baixa abaixo.
        </p>
      </section>

      <MeusDadosActions
        pendingAnonymizeRequestId={pendingAnonymize?.id ?? null}
        alreadyAnonymized={Boolean(data?.anonymized_at)}
      />

      {/* Histórico */}
      <section className="mt-8 rounded-2xl border border-ink-100 bg-white p-6">
        <h2 className="font-serif text-[1.25rem] text-ink-800 mb-3">
          Histórico de solicitações
        </h2>
        {history.length === 0 ? (
          <p className="text-sm text-ink-500">
            Nenhuma solicitação registrada ainda.
          </p>
        ) : (
          <ul className="divide-y divide-ink-100">
            {history.map((r) => (
              <li key={r.id} className="py-3 text-sm flex items-center justify-between gap-3">
                <div>
                  <p className="text-ink-800 font-medium">{kindLabel(r.kind)}</p>
                  <p className="text-ink-500 text-xs">
                    {formatDateTimeShortBR(r.requested_at)}
                    {r.fulfilled_at
                      ? ` · concluída em ${formatDateTimeShortBR(r.fulfilled_at)}`
                      : ""}
                    {r.rejected_reason ? ` · recusada: ${r.rejected_reason}` : ""}
                  </p>
                </div>
                <span
                  className={`px-2 py-0.5 rounded text-xs font-medium ${
                    r.status === "pending"
                      ? "bg-cream-200 text-cream-900"
                      : r.status === "fulfilled"
                      ? "bg-sage-100 text-sage-800"
                      : r.status === "rejected"
                      ? "bg-terracotta-100 text-terracotta-800"
                      : "bg-ink-50 text-ink-600"
                  }`}
                >
                  {statusLabel(r.status)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="mt-8 text-xs text-ink-500 max-w-2xl">
        Estes direitos são garantidos pela Lei Geral de Proteção de
        Dados (LGPD, Lei 13.709/2018, Art. 18). O Instituto atende
        solicitações em até 15 dias corridos a contar do pedido
        (Art. 19 §1º). Dúvidas: <a href="mailto:lgpd@institutonovamedida.com.br" className="underline">lgpd@institutonovamedida.com.br</a>.
      </p>
    </div>
  );
}
