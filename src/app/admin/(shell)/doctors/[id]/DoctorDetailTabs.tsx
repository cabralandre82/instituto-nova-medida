"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Doctor = {
  id: string;
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
};

type CompensationRule = {
  id: string;
  consultation_cents: number;
  on_demand_bonus_cents: number;
  plantao_hour_cents: number;
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

type Slot = {
  id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  type: "scheduled" | "on_call" | "agendada" | "plantao";
  active: boolean;
};

const TABS = [
  { id: "perfil", label: "Perfil & status" },
  { id: "compensacao", label: "Compensação" },
  { id: "pix", label: "PIX (repasses)" },
  { id: "agenda", label: "Agenda" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function DoctorDetailTabs(props: {
  doctor: Doctor;
  rules: CompensationRule[];
  activeRule: CompensationRule | null;
  paymentMethods: PaymentMethod[];
  defaultPix: PaymentMethod | null;
  slots: Slot[];
}) {
  const [tab, setTab] = useState<TabId>("perfil");

  return (
    <div>
      <nav className="flex gap-1 mb-6 border-b border-ink-100 -mx-2 px-2 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`whitespace-nowrap px-4 py-3 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === t.id
                ? "border-ink-800 text-ink-800"
                : "border-transparent text-ink-500 hover:text-ink-800"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "perfil" && <ProfilePanel doctor={props.doctor} />}
      {tab === "compensacao" && (
        <CompensationPanel doctorId={props.doctor.id} rules={props.rules} active={props.activeRule} />
      )}
      {tab === "pix" && (
        <PixPanel doctorId={props.doctor.id} current={props.defaultPix} />
      )}
      {tab === "agenda" && (
        <AgendaPanel doctorId={props.doctor.id} slots={props.slots} />
      )}
    </div>
  );
}

// ============================================================
// Perfil
// ============================================================
function ProfilePanel({ doctor }: { doctor: Doctor }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [form, setForm] = useState({
    full_name: doctor.full_name,
    display_name: doctor.display_name ?? "",
    phone: doctor.phone,
    bio: doctor.bio ?? "",
    cnpj: doctor.cnpj ?? "",
    consultation_minutes: doctor.consultation_minutes,
    status: doctor.status,
  });

  async function save() {
    setSubmitting(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/admin/doctors/${doctor.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? "Falha");
      setMsg({ kind: "ok", text: "Perfil atualizado." });
      router.refresh();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "Erro" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-2xl bg-white border border-ink-100 p-6 sm:p-8 space-y-5">
      <div className="grid sm:grid-cols-2 gap-5">
        <Field label="Nome completo">
          <input
            value={form.full_name}
            onChange={(e) => setForm({ ...form, full_name: e.target.value })}
            className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 focus:outline-none focus:ring-2 focus:ring-sage-500"
          />
        </Field>
        <Field label="Nome público">
          <input
            value={form.display_name}
            onChange={(e) => setForm({ ...form, display_name: e.target.value })}
            placeholder={doctor.full_name}
            className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 focus:outline-none focus:ring-2 focus:ring-sage-500"
          />
        </Field>
      </div>

      <div className="grid sm:grid-cols-2 gap-5">
        <Field label="WhatsApp" hint="Apenas dígitos.">
          <input
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value.replace(/\D/g, "").slice(0, 11) })}
            className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 font-mono focus:outline-none focus:ring-2 focus:ring-sage-500"
          />
        </Field>
        <Field label="CNPJ">
          <input
            value={form.cnpj}
            onChange={(e) => setForm({ ...form, cnpj: e.target.value.replace(/\D/g, "").slice(0, 14) })}
            placeholder="14 dígitos"
            className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 font-mono focus:outline-none focus:ring-2 focus:ring-sage-500"
          />
        </Field>
      </div>

      <div className="grid sm:grid-cols-2 gap-5">
        <Field label="Duração padrão (min)">
          <input
            type="number"
            min={10}
            max={120}
            step={5}
            value={form.consultation_minutes}
            onChange={(e) => setForm({ ...form, consultation_minutes: Number(e.target.value) })}
            className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 focus:outline-none focus:ring-2 focus:ring-sage-500"
          />
        </Field>
        <Field label="Status" hint="active = visível para agendamento.">
          <select
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value })}
            className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 focus:outline-none focus:ring-2 focus:ring-sage-500"
          >
            <option value="invited">Convidada</option>
            <option value="pending">Aguardando ativação</option>
            <option value="active">Ativa</option>
            <option value="suspended">Suspensa</option>
            <option value="archived">Arquivada</option>
          </select>
        </Field>
      </div>

      <Field label="Bio (perfil público)">
        <textarea
          value={form.bio}
          onChange={(e) => setForm({ ...form, bio: e.target.value })}
          rows={4}
          maxLength={500}
          placeholder="Médica formada em..."
          className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 focus:outline-none focus:ring-2 focus:ring-sage-500"
        />
      </Field>

      {msg && (
        <p
          role="alert"
          className={msg.kind === "ok" ? "text-sage-700" : "text-terracotta-700"}
        >
          {msg.text}
        </p>
      )}

      <div className="flex gap-3 pt-2">
        <button
          type="button"
          onClick={save}
          disabled={submitting}
          className="rounded-xl bg-ink-800 hover:bg-ink-900 disabled:opacity-50 text-white font-medium px-6 py-3 transition-colors"
        >
          {submitting ? "Salvando..." : "Salvar perfil"}
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Compensação
// ============================================================
function CompensationPanel({
  doctorId,
  rules,
  active,
}: {
  doctorId: string;
  rules: CompensationRule[];
  active: CompensationRule | null;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [form, setForm] = useState({
    consultation_brl: ((active?.consultation_cents ?? 20000) / 100).toFixed(2),
    on_demand_bonus_brl: ((active?.on_demand_bonus_cents ?? 4000) / 100).toFixed(2),
    plantao_hour_brl: ((active?.plantao_hour_cents ?? 3000) / 100).toFixed(2),
    available_days_pix: active?.available_days_pix ?? 7,
    available_days_boleto: active?.available_days_boleto ?? 3,
    available_days_card: active?.available_days_card ?? 30,
    reason: "",
  });

  async function save() {
    if (!form.reason.trim()) {
      setMsg({ kind: "err", text: "Justificativa obrigatória ao mudar regra." });
      return;
    }
    setSubmitting(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/admin/doctors/${doctorId}/compensation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          consultation_cents: Math.round(Number(form.consultation_brl) * 100),
          on_demand_bonus_cents: Math.round(Number(form.on_demand_bonus_brl) * 100),
          plantao_hour_cents: Math.round(Number(form.plantao_hour_brl) * 100),
          available_days_pix: Number(form.available_days_pix),
          available_days_boleto: Number(form.available_days_boleto),
          available_days_card: Number(form.available_days_card),
          reason: form.reason.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? "Falha");
      setMsg({ kind: "ok", text: "Nova regra aplicada. Anterior foi arquivada." });
      router.refresh();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "Erro" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl bg-white border border-ink-100 p-6 sm:p-8 space-y-5">
        <div>
          <h2 className="font-serif text-[1.3rem] text-ink-800">Regra ativa</h2>
          <p className="text-sm text-ink-500 mt-1">
            Mudanças geram nova versão. A anterior é fechada e mantida no
            histórico (auditoria).
          </p>
        </div>

        <div className="grid sm:grid-cols-3 gap-5">
          <Field label="Consulta agendada (R$)">
            <input
              inputMode="decimal"
              value={form.consultation_brl}
              onChange={(e) => setForm({ ...form, consultation_brl: e.target.value })}
              className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 font-mono focus:outline-none focus:ring-2 focus:ring-sage-500"
            />
          </Field>
          <Field label="Bônus on-demand (R$)">
            <input
              inputMode="decimal"
              value={form.on_demand_bonus_brl}
              onChange={(e) => setForm({ ...form, on_demand_bonus_brl: e.target.value })}
              className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 font-mono focus:outline-none focus:ring-2 focus:ring-sage-500"
            />
          </Field>
          <Field label="Plantão por hora (R$)">
            <input
              inputMode="decimal"
              value={form.plantao_hour_brl}
              onChange={(e) => setForm({ ...form, plantao_hour_brl: e.target.value })}
              className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 font-mono focus:outline-none focus:ring-2 focus:ring-sage-500"
            />
          </Field>
        </div>

        <div>
          <p className="text-[0.85rem] font-medium text-ink-700 mb-2">
            Janela &ldquo;disponível&rdquo; por método de pagamento (dias)
          </p>
          <div className="grid sm:grid-cols-3 gap-5">
            <Field label="PIX">
              <input
                type="number"
                min={0}
                max={60}
                value={form.available_days_pix}
                onChange={(e) => setForm({ ...form, available_days_pix: Number(e.target.value) })}
                className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 focus:outline-none focus:ring-2 focus:ring-sage-500"
              />
            </Field>
            <Field label="Boleto">
              <input
                type="number"
                min={0}
                max={60}
                value={form.available_days_boleto}
                onChange={(e) => setForm({ ...form, available_days_boleto: Number(e.target.value) })}
                className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 focus:outline-none focus:ring-2 focus:ring-sage-500"
              />
            </Field>
            <Field label="Cartão">
              <input
                type="number"
                min={0}
                max={60}
                value={form.available_days_card}
                onChange={(e) => setForm({ ...form, available_days_card: Number(e.target.value) })}
                className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 focus:outline-none focus:ring-2 focus:ring-sage-500"
              />
            </Field>
          </div>
        </div>

        <Field label="Justificativa (obrigatória)" hint="Ex: aumento de R$ 200 para R$ 220 — alinhamento de mercado.">
          <textarea
            value={form.reason}
            onChange={(e) => setForm({ ...form, reason: e.target.value })}
            rows={2}
            maxLength={300}
            className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 focus:outline-none focus:ring-2 focus:ring-sage-500"
          />
        </Field>

        {msg && (
          <p className={msg.kind === "ok" ? "text-sage-700" : "text-terracotta-700"}>
            {msg.text}
          </p>
        )}

        <div className="flex gap-3 pt-2">
          <button
            type="button"
            onClick={save}
            disabled={submitting}
            className="rounded-xl bg-ink-800 hover:bg-ink-900 disabled:opacity-50 text-white font-medium px-6 py-3 transition-colors"
          >
            {submitting ? "Aplicando..." : "Aplicar nova regra"}
          </button>
        </div>
      </div>

      {rules.length > 0 && (
        <div className="rounded-2xl bg-white border border-ink-100 p-6">
          <h3 className="font-serif text-[1.1rem] text-ink-800 mb-4">Histórico</h3>
          <ul className="divide-y divide-ink-100">
            {rules.map((r) => (
              <li key={r.id} className="py-3 text-sm">
                <div className="flex flex-wrap justify-between gap-2">
                  <div className="text-ink-700 font-mono">
                    R$ {(r.consultation_cents / 100).toFixed(2)} / agendada ·{" "}
                    R$ {(r.on_demand_bonus_cents / 100).toFixed(2)} bônus ·{" "}
                    R$ {(r.plantao_hour_cents / 100).toFixed(2)}/h plantão
                  </div>
                  <div className="text-xs text-ink-400">
                    {new Date(r.effective_from).toLocaleDateString("pt-BR")}
                    {" → "}
                    {r.effective_to
                      ? new Date(r.effective_to).toLocaleDateString("pt-BR")
                      : "ativa"}
                  </div>
                </div>
                {r.reason && <div className="text-xs text-ink-500 mt-1">{r.reason}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ============================================================
// PIX
// ============================================================
function PixPanel({
  doctorId,
  current,
}: {
  doctorId: string;
  current: PaymentMethod | null;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [form, setForm] = useState({
    pix_key_type: current?.pix_key_type ?? "cpf",
    pix_key: current?.pix_key ?? "",
    account_holder_name: current?.account_holder_name ?? "",
    account_holder_cpf_or_cnpj: current?.account_holder_cpf_or_cnpj ?? "",
  });

  async function save() {
    setSubmitting(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/admin/doctors/${doctorId}/payment-method`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? "Falha");
      setMsg({ kind: "ok", text: "PIX salvo." });
      router.refresh();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "Erro" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-2xl bg-white border border-ink-100 p-6 sm:p-8 space-y-5">
      <div>
        <h2 className="font-serif text-[1.3rem] text-ink-800">Chave PIX para repasses</h2>
        <p className="text-sm text-ink-500 mt-1">
          Esta chave receberá os pagamentos mensais consolidados. Confira
          dois ou três campos antes de cada lote.
        </p>
      </div>

      <div className="grid sm:grid-cols-[180px_1fr] gap-5">
        <Field label="Tipo">
          <select
            value={form.pix_key_type}
            onChange={(e) => setForm({ ...form, pix_key_type: e.target.value })}
            className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 focus:outline-none focus:ring-2 focus:ring-sage-500"
          >
            <option value="cpf">CPF</option>
            <option value="cnpj">CNPJ</option>
            <option value="email">E-mail</option>
            <option value="phone">Telefone</option>
            <option value="random">Chave aleatória</option>
          </select>
        </Field>
        <Field label="Chave">
          <input
            value={form.pix_key}
            onChange={(e) => setForm({ ...form, pix_key: e.target.value })}
            className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 font-mono focus:outline-none focus:ring-2 focus:ring-sage-500"
          />
        </Field>
      </div>

      <div className="grid sm:grid-cols-2 gap-5">
        <Field label="Titular (nome)">
          <input
            value={form.account_holder_name}
            onChange={(e) => setForm({ ...form, account_holder_name: e.target.value })}
            className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 focus:outline-none focus:ring-2 focus:ring-sage-500"
          />
        </Field>
        <Field label="CPF/CNPJ do titular">
          <input
            value={form.account_holder_cpf_or_cnpj}
            onChange={(e) =>
              setForm({
                ...form,
                account_holder_cpf_or_cnpj: e.target.value.replace(/\D/g, "").slice(0, 14),
              })
            }
            placeholder="só dígitos"
            className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 font-mono focus:outline-none focus:ring-2 focus:ring-sage-500"
          />
        </Field>
      </div>

      {msg && (
        <p className={msg.kind === "ok" ? "text-sage-700" : "text-terracotta-700"}>
          {msg.text}
        </p>
      )}

      <button
        type="button"
        onClick={save}
        disabled={submitting}
        className="rounded-xl bg-ink-800 hover:bg-ink-900 disabled:opacity-50 text-white font-medium px-6 py-3 transition-colors"
      >
        {submitting ? "Salvando..." : "Salvar PIX"}
      </button>
    </div>
  );
}

// ============================================================
// Agenda
// ============================================================
const WEEKDAYS = [
  "Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado",
];

function AgendaPanel({ doctorId, slots }: { doctorId: string; slots: Slot[] }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [form, setForm] = useState({
    weekday: 1,
    start_time: "09:00",
    end_time: "12:00",
    type: "scheduled" as "scheduled" | "on_call",
  });

  async function add() {
    setSubmitting("add");
    setMsg(null);
    try {
      const res = await fetch(`/api/admin/doctors/${doctorId}/availability`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? "Falha");
      setMsg({ kind: "ok", text: "Slot adicionado." });
      router.refresh();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "Erro" });
    } finally {
      setSubmitting(null);
    }
  }

  async function remove(id: string) {
    if (!confirm("Remover este horário?")) return;
    setSubmitting(id);
    try {
      const res = await fetch(`/api/admin/doctors/${doctorId}/availability?slotId=${id}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? "Falha");
      router.refresh();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "Erro" });
    } finally {
      setSubmitting(null);
    }
  }

  const byDay = slots.reduce<Record<number, Slot[]>>((acc, s) => {
    (acc[s.weekday] ??= []).push(s);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <div className="rounded-2xl bg-white border border-ink-100 p-6 sm:p-8 space-y-5">
        <div>
          <h2 className="font-serif text-[1.3rem] text-ink-800">Agenda semanal</h2>
          <p className="text-sm text-ink-500 mt-1">
            <strong>Agendada</strong> = slots de consulta marcada.{" "}
            <strong>Plantão</strong> = janela em que a médica está online
            pra atender on-demand (paga por hora online).
          </p>
        </div>

        <div className="grid sm:grid-cols-[1fr_120px_120px_180px_auto] gap-3 items-end">
          <Field label="Dia">
            <select
              value={form.weekday}
              onChange={(e) => setForm({ ...form, weekday: Number(e.target.value) })}
              className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 focus:outline-none focus:ring-2 focus:ring-sage-500"
            >
              {WEEKDAYS.map((d, i) => (
                <option key={i} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </Field>
          <Field label="De">
            <input
              type="time"
              value={form.start_time}
              onChange={(e) => setForm({ ...form, start_time: e.target.value })}
              className="w-full rounded-xl border border-ink-200 bg-white px-3 py-3 text-ink-800 focus:outline-none focus:ring-2 focus:ring-sage-500"
            />
          </Field>
          <Field label="Até">
            <input
              type="time"
              value={form.end_time}
              onChange={(e) => setForm({ ...form, end_time: e.target.value })}
              className="w-full rounded-xl border border-ink-200 bg-white px-3 py-3 text-ink-800 focus:outline-none focus:ring-2 focus:ring-sage-500"
            />
          </Field>
          <Field label="Tipo">
            <select
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value as "scheduled" | "on_call" })}
              className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-ink-800 focus:outline-none focus:ring-2 focus:ring-sage-500"
            >
              <option value="scheduled">Agendada</option>
              <option value="on_call">Plantão</option>
            </select>
          </Field>
          <button
            type="button"
            onClick={add}
            disabled={submitting === "add"}
            className="rounded-xl bg-ink-800 hover:bg-ink-900 disabled:opacity-50 text-white font-medium px-6 py-3 transition-colors h-[50px]"
          >
            +
          </button>
        </div>

        {msg && (
          <p className={msg.kind === "ok" ? "text-sage-700" : "text-terracotta-700"}>
            {msg.text}
          </p>
        )}
      </div>

      <div className="rounded-2xl bg-white border border-ink-100 p-6">
        {slots.length === 0 ? (
          <p className="text-ink-500 text-center py-6">
            Sem horários cadastrados. Adicione acima.
          </p>
        ) : (
          <div className="space-y-4">
            {WEEKDAYS.map((dayName, i) => {
              const list = byDay[i];
              if (!list || list.length === 0) return null;
              return (
                <div key={i}>
                  <h4 className="text-[0.78rem] uppercase tracking-[0.14em] text-ink-500 font-medium mb-2">
                    {dayName}
                  </h4>
                  <ul className="divide-y divide-ink-100">
                    {list.map((s) => (
                      <li
                        key={s.id}
                        className="py-3 flex items-center justify-between gap-4"
                      >
                        <div className="font-mono text-ink-700">
                          {s.start_time.slice(0, 5)} – {s.end_time.slice(0, 5)}
                          {(() => {
                            const isScheduled = s.type === "scheduled" || s.type === "agendada";
                            return (
                              <span
                                className={`ml-3 text-xs font-medium px-2 py-0.5 rounded-full ${
                                  isScheduled
                                    ? "bg-sage-50 text-sage-700"
                                    : "bg-terracotta-50 text-terracotta-700"
                                }`}
                              >
                                {isScheduled ? "Agendada" : "Plantão"}
                              </span>
                            );
                          })()}
                        </div>
                        <button
                          type="button"
                          onClick={() => remove(s.id)}
                          disabled={submitting === s.id}
                          className="text-sm text-terracotta-600 hover:text-terracotta-700 disabled:opacity-50"
                        >
                          Remover
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Field helper
// ============================================================
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-[0.85rem] font-medium text-ink-700 mb-1.5">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}
