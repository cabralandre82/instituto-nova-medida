/**
 * /admin/doctors/[id] — Detalhes e gestão de uma médica.
 *
 * Painel com 4 seções:
 *   1. Perfil (status, contato, CRM, CNPJ, bio, especialidades)
 *   2. Compensação (regra ativa + histórico)
 *   3. PIX (chave para repasses)
 *   4. Agenda semanal (slots agendada vs plantão)
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { getSupabaseAdmin } from "@/lib/supabase";
import { DoctorDetailTabs } from "./DoctorDetailTabs";

export const dynamic = "force-dynamic";

type Doctor = {
  id: string;
  user_id: string;
  full_name: string;
  display_name: string | null;
  email: string;
  phone: string;
  crm_number: string;
  crm_uf: string;
  cnpj: string | null;
  bio: string | null;
  specialty: string | null;
  consultation_minutes: number;
  status: string;
  invited_at: string | null;
  activated_at: string | null;
  created_at: string;
};

type CompensationRule = {
  id: string;
  doctor_id: string;
  consultation_cents: number;
  on_demand_bonus_cents: number;
  plantao_hour_cents: number;
  after_hours_multiplier: number;
  available_days_pix: number;
  available_days_boleto: number;
  available_days_card: number;
  effective_from: string;
  effective_to: string | null;
  reason: string | null;
};

type PaymentMethod = {
  id: string;
  pix_key_type: string;
  pix_key: string;
  account_holder_name: string;
  account_holder_cpf_or_cnpj: string;
  is_default: boolean;
};

type AvailabilitySlot = {
  id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  type: "scheduled" | "on_call" | "agendada" | "plantao";
  active: boolean;
};

async function load(id: string) {
  const supabase = getSupabaseAdmin();
  const [docRes, rulesRes, pmRes, slotsRes] = await Promise.all([
    supabase.from("doctors").select("*").eq("id", id).maybeSingle(),
    supabase
      .from("doctor_compensation_rules")
      .select("*")
      .eq("doctor_id", id)
      .order("effective_from", { ascending: false }),
    supabase
      .from("doctor_payment_methods")
      .select("*")
      .eq("doctor_id", id)
      .order("is_default", { ascending: false }),
    supabase
      .from("doctor_availability")
      .select("*")
      .eq("doctor_id", id)
      .order("weekday", { ascending: true })
      .order("start_time", { ascending: true }),
  ]);

  if (!docRes.data) return null;
  return {
    doctor: docRes.data as Doctor,
    rules: (rulesRes.data ?? []) as CompensationRule[],
    paymentMethods: (pmRes.data ?? []) as PaymentMethod[],
    slots: (slotsRes.data ?? []) as AvailabilitySlot[],
  };
}

export default async function DoctorDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const data = await load(id);
  if (!data) notFound();

  const { doctor, rules, paymentMethods, slots } = data;
  const activeRule = rules.find((r) => !r.effective_to) ?? rules[0] ?? null;
  const defaultPix = paymentMethods.find((p) => p.is_default) ?? paymentMethods[0] ?? null;

  return (
    <div className="max-w-4xl">
      {sp.created === "1" && (
        <div className="mb-6 rounded-xl bg-sage-50 border border-sage-200 px-5 py-4 text-sage-800">
          ✓ Médica cadastrada. Convite enviado para <strong>{doctor.email}</strong>.
        </div>
      )}

      <header className="mb-8">
        <Link
          href="/admin/doctors"
          className="text-sm text-ink-500 hover:text-ink-800 mb-3 inline-flex items-center gap-1"
        >
          ← Voltar
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[0.78rem] uppercase tracking-[0.18em] text-sage-700 font-medium mb-2">
              Perfil clínico
            </p>
            <h1 className="font-serif text-[2rem] leading-tight text-ink-800">
              {doctor.display_name || doctor.full_name}
            </h1>
            <p className="mt-1 text-ink-500 font-mono text-sm">
              CRM-{doctor.crm_uf} {doctor.crm_number} · {doctor.email}
            </p>
          </div>
          <StatusBadge status={doctor.status} />
        </div>
      </header>

      <DoctorDetailTabs
        doctor={doctor}
        rules={rules}
        activeRule={activeRule}
        paymentMethods={paymentMethods}
        defaultPix={defaultPix}
        slots={slots}
      />
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    invited: { label: "Convidada", cls: "bg-cream-100 text-ink-600 border-ink-200" },
    pending: { label: "Aguardando ativação", cls: "bg-terracotta-50 text-terracotta-700 border-terracotta-200" },
    active: { label: "Ativa", cls: "bg-sage-50 text-sage-800 border-sage-200" },
    suspended: { label: "Suspensa", cls: "bg-terracotta-100 text-terracotta-800 border-terracotta-300" },
    archived: { label: "Arquivada", cls: "bg-ink-100 text-ink-500 border-ink-200" },
  };
  const m = map[status] ?? { label: status, cls: "bg-cream-100 text-ink-600 border-ink-200" };
  return (
    <span
      className={`inline-flex items-center text-sm font-medium px-3 py-1.5 rounded-full border ${m.cls}`}
    >
      {m.label}
    </span>
  );
}
