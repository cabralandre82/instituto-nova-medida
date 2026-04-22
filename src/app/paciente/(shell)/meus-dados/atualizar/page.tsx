/**
 * /paciente/meus-dados/atualizar — PR-056 · D-067
 *
 * Self-service do paciente autenticado pra atualizar nome, email,
 * telefone e endereço. Existe porque o guard D-065 (PR-054) bloqueia
 * updates de PII via funil de compra quando `customers.user_id` está
 * populado — então o paciente precisa de UM lugar pra manter os
 * dados em dia.
 *
 * Contrato de tela:
 *
 *   - Server component lê o estado atual de `customers` e passa ao
 *     form como defaults (zero flicker, sem fetch extra no client).
 *   - CPF NÃO aparece no form (imutável; é o identificador).
 *   - Quem está anonimizado cai num estado readonly (mostramos aviso
 *     e escondemos o form).
 *   - Link de volta pra `/paciente/meus-dados` (origem).
 */

import Link from "next/link";
import { requirePatient } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { AtualizarForm } from "./_AtualizarForm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AtualizarMeusDadosPage() {
  const { customerId } = await requirePatient();
  const supabase = getSupabaseAdmin();

  const { data } = await supabase
    .from("customers")
    .select(
      "name, email, phone, address_zipcode, address_street, address_number, address_complement, address_district, address_city, address_state, anonymized_at"
    )
    .eq("id", customerId)
    .maybeSingle();

  const row = (data ?? null) as {
    name: string | null;
    email: string | null;
    phone: string | null;
    address_zipcode: string | null;
    address_street: string | null;
    address_number: string | null;
    address_complement: string | null;
    address_district: string | null;
    address_city: string | null;
    address_state: string | null;
    anonymized_at: string | null;
  } | null;

  const anonymized = Boolean(row?.anonymized_at);

  return (
    <div>
      <header className="mb-6">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Meus dados · Atualizar
        </p>
        <h1 className="font-serif text-[2rem] sm:text-[2.4rem] leading-tight text-ink-800">
          Atualizar meus dados
        </h1>
        <p className="mt-2 text-ink-500 max-w-xl">
          Mantenha seu e-mail, telefone e endereço atualizados. Essas
          informações são usadas para enviar a medicação manipulada e
          notificações clínicas. Seu CPF é usado como identificador e
          não pode ser alterado.
        </p>
      </header>

      {anonymized ? (
        <section className="rounded-2xl border border-ink-100 bg-white p-6 text-sm text-ink-700">
          <p className="font-medium mb-2">
            Sua conta foi anonimizada.
          </p>
          <p className="text-ink-500">
            Não é possível atualizar dados pessoais em uma conta
            anonimizada. Se você acredita que isso é um erro, entre
            em contato:{" "}
            <a
              href="mailto:lgpd@institutonovamedida.com.br"
              className="underline"
            >
              lgpd@institutonovamedida.com.br
            </a>
            .
          </p>
        </section>
      ) : (
        <AtualizarForm
          defaults={{
            name: row?.name ?? "",
            email: row?.email ?? "",
            phone: row?.phone ?? "",
            address: {
              zipcode: row?.address_zipcode ?? "",
              street: row?.address_street ?? "",
              number: row?.address_number ?? "",
              complement: row?.address_complement ?? "",
              district: row?.address_district ?? "",
              city: row?.address_city ?? "",
              state: row?.address_state ?? "",
            },
          }}
        />
      )}

      <p className="mt-8 text-xs text-ink-500">
        <Link href="/paciente/meus-dados" className="underline">
          ← Voltar para Meus dados
        </Link>
      </p>
    </div>
  );
}
