/**
 * /medico/perfil — edita os campos sob controle da médica e exibe os
 * "duros" (read-only) que só o operador pode mudar (CRM, CNPJ, status).
 */

import Link from "next/link";
import { requireDoctor } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  getActivePaymentMethod,
  labelForPixType,
  maskPixKey,
  type PixKeyType,
} from "@/lib/doctor-payment-methods";
import { ProfileForm } from "./ProfileForm";
import { formatDateLongBR } from "@/lib/datetime-br";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type DoctorRecord = {
  id: string;
  full_name: string;
  display_name: string | null;
  email: string;
  phone: string | null;
  bio: string | null;
  consultation_minutes: number;
  crm_number: string;
  crm_uf: string;
  cnpj: string | null;
  status: string;
  activated_at: string | null;
  invited_at: string | null;
};

const STATUS_LABEL: Record<string, { label: string; className: string }> = {
  active: { label: "Ativa", className: "bg-sage-50 text-sage-800 border-sage-200" },
  invited: { label: "Convidada", className: "bg-cream-50 text-ink-700 border-ink-200" },
  pending: { label: "Pendente", className: "bg-cream-50 text-ink-700 border-ink-200" },
  suspended: {
    label: "Suspensa",
    className: "bg-terracotta-50 text-terracotta-700 border-terracotta-200",
  },
  archived: { label: "Arquivada", className: "bg-ink-50 text-ink-500 border-ink-200" },
};

export default async function DoctorProfilePage() {
  const { doctorId } = await requireDoctor();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("doctors")
    .select(
      "id, full_name, display_name, email, phone, bio, consultation_minutes, crm_number, crm_uf, cnpj, status, activated_at, invited_at"
    )
    .eq("id", doctorId)
    .maybeSingle();

  if (error || !data) {
    throw new Error("Perfil não encontrado.");
  }

  const doctor = data as DoctorRecord;
  const status = STATUS_LABEL[doctor.status] ?? {
    label: doctor.status,
    className: "bg-ink-50 text-ink-600 border-ink-200",
  };

  const pix = await getActivePaymentMethod(supabase, doctorId);

  return (
    <div>
      <header className="mb-8">
        <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
          Perfil
        </p>
        <h1 className="font-serif text-[2rem] sm:text-[2.4rem] leading-tight text-ink-800">
          Seus dados
        </h1>
        <p className="mt-2 text-ink-500">
          Edite o que aparece para o paciente. Dados de cadastro (CRM, CNPJ) só pelo operador.
        </p>
      </header>

      <section className="grid lg:grid-cols-[1fr_320px] gap-8">
        <div className="rounded-2xl border border-ink-100 bg-white p-6 sm:p-8">
          <ProfileForm
            initial={{
              display_name: doctor.display_name,
              bio: doctor.bio,
              phone: doctor.phone,
              consultation_minutes: doctor.consultation_minutes,
            }}
          />
        </div>

        <aside className="space-y-6">
          <div className="rounded-2xl border border-ink-100 bg-white p-5">
            <h3 className="font-serif text-[1.1rem] text-ink-800 mb-3">
              Cadastro
            </h3>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-ink-500">Nome completo</dt>
                <dd className="text-ink-800 font-medium">{doctor.full_name}</dd>
              </div>
              <div>
                <dt className="text-ink-500">E-mail</dt>
                <dd className="text-ink-800 break-all">{doctor.email}</dd>
              </div>
              <div>
                <dt className="text-ink-500">CRM</dt>
                <dd className="text-ink-800 font-medium">
                  {doctor.crm_number} / {doctor.crm_uf}
                </dd>
              </div>
              {doctor.cnpj && (
                <div>
                  <dt className="text-ink-500">CNPJ</dt>
                  <dd className="text-ink-800 font-mono text-xs">{doctor.cnpj}</dd>
                </div>
              )}
            </dl>
            <p className="mt-4 text-xs text-ink-500">
              Para alterar qualquer um destes, fale com o operador.
            </p>
          </div>

          <div className="rounded-2xl border border-ink-100 bg-white p-5">
            <div className="flex items-start justify-between gap-3 mb-3">
              <h3 className="font-serif text-[1.1rem] text-ink-800">Chave PIX</h3>
              <Link
                href="/medico/perfil/pix"
                className="text-xs font-medium text-sage-700 hover:text-sage-800"
              >
                {pix ? "Gerenciar →" : "Cadastrar →"}
              </Link>
            </div>
            {pix ? (
              <div className="text-sm space-y-1">
                <div className="text-ink-500">
                  {labelForPixType(pix.pix_key_type as PixKeyType)}
                </div>
                <div className="text-ink-800 font-mono break-all">
                  {maskPixKey(pix.pix_key_type as PixKeyType, pix.pix_key)}
                </div>
                <div className="text-xs text-ink-500">
                  Titular: {pix.account_holder_name ?? "—"}
                </div>
              </div>
            ) : (
              <p className="text-sm text-terracotta-700">
                Sem PIX cadastrado. Repasses ficam bloqueados.
              </p>
            )}
          </div>

          <div className="rounded-2xl border border-ink-100 bg-white p-5">
            <h3 className="font-serif text-[1.1rem] text-ink-800 mb-3">Status</h3>
            <span
              className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium border ${status.className}`}
            >
              {status.label}
            </span>
            {doctor.activated_at && (
              <p className="mt-3 text-xs text-ink-500">
                Ativada em {formatDateLongBR(doctor.activated_at)}.
              </p>
            )}
            {!doctor.activated_at && doctor.invited_at && (
              <p className="mt-3 text-xs text-ink-500">
                Convite enviado em {formatDateLongBR(doctor.invited_at)}.
              </p>
            )}
          </div>
        </aside>
      </section>
    </div>
  );
}
