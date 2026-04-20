/**
 * /medico/perfil/pix — D-042 · PIX self-service
 *
 * A médica vê o PIX default atual, o histórico de chaves anteriores,
 * e pode cadastrar/trocar a própria chave. O form (client component)
 * chama POST /api/medico/payment-methods.
 *
 * Trocar a chave não apaga o registro anterior: ele fica como
 * `is_default=false, active=false` pra auditoria (coluna replaced_at).
 */

import Link from "next/link";
import { requireDoctor } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  labelForPixType,
  listPaymentMethods,
  maskPixKey,
  type PaymentMethod,
  type PixKeyType,
} from "@/lib/doctor-payment-methods";
import { PixForm } from "./PixForm";
import { HistoryItem } from "./HistoryItem";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function formatDoc(doc: string | null): string {
  if (!doc) return "—";
  const d = doc.replace(/\D/g, "");
  if (d.length === 11) {
    return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  }
  if (d.length === 14) {
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  }
  return d;
}

export default async function DoctorPixPage() {
  const { doctorId } = await requireDoctor();
  const supabase = getSupabaseAdmin();
  const methods = await listPaymentMethods(supabase, doctorId);

  const current = methods.find((m) => m.is_default) ?? null;
  const history = methods.filter((m) => !m.is_default);

  return (
    <div>
      <header className="mb-8">
        <Link
          href="/medico/perfil"
          className="text-sm text-ink-500 hover:text-ink-800 mb-3 inline-flex items-center gap-1"
        >
          ← Voltar ao perfil
        </Link>
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Perfil · Financeiro
        </p>
        <h1 className="font-serif text-[2rem] sm:text-[2.4rem] leading-tight text-ink-800">
          Chave PIX
        </h1>
        <p className="mt-2 text-ink-500 max-w-2xl">
          Sua chave PIX recebe os repasses mensais. Confira o tipo, a chave
          e o CPF/CNPJ do titular antes de salvar — um erro aqui adia o pagamento.
        </p>
      </header>

      <div className="grid lg:grid-cols-[1fr_360px] gap-8">
        <section className="space-y-6">
          <CurrentCard current={current} />

          <div className="rounded-2xl border border-ink-100 bg-white p-6 sm:p-8">
            <h2 className="font-serif text-[1.25rem] text-ink-800 mb-1">
              {current ? "Trocar chave" : "Cadastrar PIX"}
            </h2>
            <p className="text-sm text-ink-500 mb-5">
              Ao salvar, a chave atual passa para o histórico e a nova vira o
              default imediatamente.
            </p>
            <PixForm
              initial={
                current
                  ? {
                      pix_key_type: current.pix_key_type,
                      pix_key: current.pix_key,
                      account_holder_name: current.account_holder_name ?? "",
                      account_holder_cpf_or_cnpj:
                        current.account_holder_cpf_or_cnpj ?? "",
                    }
                  : null
              }
            />
          </div>

          {history.length > 0 && (
            <div className="rounded-2xl border border-ink-100 bg-white p-6 sm:p-8">
              <h2 className="font-serif text-[1.25rem] text-ink-800 mb-1">
                Histórico
              </h2>
              <p className="text-sm text-ink-500 mb-4">
                Chaves anteriores. Você pode remover qualquer uma — isso não
                afeta pagamentos já enviados.
              </p>
              <ul className="divide-y divide-ink-100">
                {history.map((m) => (
                  <HistoryItem key={m.id} method={serializeForClient(m)} />
                ))}
              </ul>
            </div>
          )}
        </section>

        <aside className="space-y-5">
          <div className="rounded-2xl border border-ink-100 bg-cream-50 p-5">
            <h3 className="font-serif text-[1.05rem] text-ink-800 mb-2">
              Como os repasses funcionam
            </h3>
            <ol className="space-y-2 text-sm text-ink-600 list-decimal pl-5">
              <li>Todo dia 1 o sistema fecha o mês anterior e cria seu repasse.</li>
              <li>O admin confere, executa o PIX e anexa o comprovante.</li>
              <li>Você confirma o recebimento na aba <Link href="/medico/repasses" className="underline">Repasses</Link>.</li>
            </ol>
          </div>

          <div className="rounded-2xl border border-ink-100 bg-white p-5 text-sm text-ink-600 space-y-3">
            <h3 className="font-serif text-[1.05rem] text-ink-800">Dicas</h3>
            <p>
              Se a chave for CPF ou CNPJ, o titular deve ser você —
              recebimentos em nome de terceiros não são aceitos.
            </p>
            <p>
              Precisa atualizar nome ou documento? A troca aqui atualiza o
              titular. Para mudar o CNPJ do seu cadastro, fale com o operador.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

function CurrentCard({ current }: { current: PaymentMethod | null }) {
  if (!current) {
    return (
      <div className="rounded-2xl border border-terracotta-200 bg-terracotta-50 p-6 sm:p-8">
        <h2 className="font-serif text-[1.25rem] text-ink-800 mb-1">
          Sem chave cadastrada
        </h2>
        <p className="text-sm text-ink-600">
          Cadastre agora para que seus repasses sejam processados no próximo
          fechamento. Sem PIX, o payout fica bloqueado para revisão manual.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-sage-200 bg-sage-50 p-6 sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
        <div>
          <p className="text-[0.75rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-1">
            PIX vigente
          </p>
          <h2 className="font-serif text-[1.5rem] text-ink-800">
            {labelForPixType(current.pix_key_type as PixKeyType)}
          </h2>
        </div>
        {current.verified_at ? (
          <span className="inline-flex items-center text-xs font-medium px-2.5 py-1 rounded-full bg-white border border-sage-300 text-sage-800">
            Validada em {formatDate(current.verified_at)}
          </span>
        ) : (
          <span className="inline-flex items-center text-xs font-medium px-2.5 py-1 rounded-full bg-white border border-ink-200 text-ink-600">
            Aguardando validação
          </span>
        )}
      </div>
      <dl className="grid sm:grid-cols-2 gap-4 text-sm">
        <div>
          <dt className="text-ink-500">Chave</dt>
          <dd className="text-ink-800 font-mono break-all">
            {maskPixKey(current.pix_key_type as PixKeyType, current.pix_key)}
          </dd>
        </div>
        <div>
          <dt className="text-ink-500">Titular</dt>
          <dd className="text-ink-800">{current.account_holder_name ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-ink-500">CPF/CNPJ do titular</dt>
          <dd className="text-ink-800 font-mono">
            {formatDoc(current.account_holder_cpf_or_cnpj)}
          </dd>
        </div>
        <div>
          <dt className="text-ink-500">Cadastrada em</dt>
          <dd className="text-ink-800">{formatDate(current.created_at)}</dd>
        </div>
      </dl>
    </div>
  );
}

function serializeForClient(m: PaymentMethod) {
  return {
    id: m.id,
    pix_key_type: m.pix_key_type as PixKeyType,
    pix_key_masked: maskPixKey(m.pix_key_type as PixKeyType, m.pix_key),
    account_holder_name: m.account_holder_name ?? "—",
    created_at: formatDate(m.created_at),
    replaced_at: formatDate(m.replaced_at),
  };
}
