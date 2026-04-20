/**
 * FinalizeForm — client component.
 *
 * Form controlado. Expõe 2 modos mutuamente exclusivos:
 *
 *   - declined:   campos clínicos (anamnese/hipótese/conduta) opcionais.
 *   - prescribed: adiciona seletor de plano + URL Memed obrigatórios.
 *
 * Ao submeter, bate em POST /api/medico/appointments/[id]/finalize.
 * Em sucesso, redireciona pra /medico/agenda. Em erro, mostra a
 * mensagem do backend inline (o endpoint já devolve `field` quando
 * sabe).
 */

"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

type Decision = "prescribed" | "declined";

type PlanOption = { id: string; label: string };

type Props = {
  appointmentId: string;
  plans: PlanOption[];
};

export function FinalizeForm({ appointmentId, plans }: Props) {
  const router = useRouter();

  const [decision, setDecision] = useState<Decision>("declined");
  const [anamnese, setAnamnese] = useState("");
  const [hipotese, setHipotese] = useState("");
  const [conduta, setConduta] = useState("");
  const [planId, setPlanId] = useState("");
  const [memedUrl, setMemedUrl] = useState("");
  const [memedId, setMemedId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<string | null>(null);

  const isPrescribed = decision === "prescribed";
  const canSubmit = useMemo(() => {
    if (submitting) return false;
    if (!isPrescribed) return true;
    return planId.length > 0 && memedUrl.trim().length > 0;
  }, [submitting, isPrescribed, planId, memedUrl]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setErrorField(null);
    setSubmitting(true);
    try {
      const body = {
        decision,
        anamnese: anamnese.trim() ? { text: anamnese.trim() } : null,
        hipotese: hipotese.trim() || null,
        conduta: conduta.trim() || null,
        prescribed_plan_id: isPrescribed ? planId : null,
        memed_prescription_url: isPrescribed ? memedUrl.trim() : null,
        memed_prescription_id:
          isPrescribed && memedId.trim() ? memedId.trim() : null,
      };
      const res = await fetch(
        `/api/medico/appointments/${appointmentId}/finalize`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      const json = (await res.json()) as {
        ok: boolean;
        message?: string;
        field?: string;
      };
      if (!res.ok || !json.ok) {
        setError(json.message ?? "Não foi possível finalizar.");
        setErrorField(json.field ?? null);
        return;
      }
      router.push("/medico/agenda");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro inesperado.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Decisão */}
      <fieldset className="space-y-3">
        <legend className="text-[0.82rem] uppercase tracking-wider text-ink-500 font-medium">
          Decisão clínica
        </legend>

        <label
          className={`flex gap-3 p-4 rounded-2xl border cursor-pointer transition-colors ${
            decision === "declined"
              ? "border-ink-800 bg-cream-50"
              : "border-ink-100 hover:border-ink-200"
          }`}
        >
          <input
            type="radio"
            name="decision"
            value="declined"
            checked={decision === "declined"}
            onChange={() => setDecision("declined")}
            className="mt-1"
          />
          <div>
            <p className="text-ink-800 font-medium">Sem indicação clínica</p>
            <p className="text-sm text-ink-500 mt-0.5">
              Avaliei a paciente e não indico o tratamento agora. Nenhuma
              cobrança será gerada.
            </p>
          </div>
        </label>

        <label
          className={`flex gap-3 p-4 rounded-2xl border cursor-pointer transition-colors ${
            decision === "prescribed"
              ? "border-sage-700 bg-sage-50"
              : "border-ink-100 hover:border-ink-200"
          }`}
        >
          <input
            type="radio"
            name="decision"
            value="prescribed"
            checked={decision === "prescribed"}
            onChange={() => setDecision("prescribed")}
            className="mt-1"
          />
          <div>
            <p className="text-ink-800 font-medium">Indicar tratamento</p>
            <p className="text-sm text-ink-500 mt-0.5">
              Vou prescrever um plano. A paciente vai ver a receita, aceitar
              formalmente e pagar na área logada antes da clínica encaminhar
              pra farmácia.
            </p>
          </div>
        </label>
      </fieldset>

      {/* Clínicos */}
      <div className="space-y-4">
        <TextArea
          label="Anamnese (opcional)"
          hint="Relato do paciente. Pode colar texto corrido."
          value={anamnese}
          onChange={setAnamnese}
          rows={4}
          fieldError={errorField === "anamnese" ? error : null}
        />
        <TextArea
          label="Hipótese diagnóstica (opcional)"
          value={hipotese}
          onChange={setHipotese}
          rows={2}
          fieldError={errorField === "hipotese" ? error : null}
        />
        <TextArea
          label="Conduta (opcional)"
          hint="O que foi orientado. Fica no histórico da paciente."
          value={conduta}
          onChange={setConduta}
          rows={3}
          fieldError={errorField === "conduta" ? error : null}
        />
      </div>

      {/* Prescrição */}
      {isPrescribed && (
        <div className="rounded-2xl border border-sage-200 bg-sage-50/40 p-5 space-y-4">
          <p className="text-[0.82rem] uppercase tracking-wider text-sage-700 font-medium">
            Prescrição
          </p>

          <div>
            <label
              htmlFor="plan"
              className="block text-sm text-ink-700 font-medium mb-1"
            >
              Plano indicado *
            </label>
            <select
              id="plan"
              required
              value={planId}
              onChange={(e) => setPlanId(e.target.value)}
              className={`w-full rounded-xl border px-3 py-2.5 bg-white text-ink-800 ${
                errorField === "prescribed_plan_id"
                  ? "border-red-400"
                  : "border-ink-200"
              }`}
            >
              <option value="">Selecione um plano</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            {plans.length === 0 && (
              <p className="mt-1 text-sm text-red-700">
                Nenhum plano ativo no catálogo. Fale com o operador antes de
                prescrever.
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor="memed_url"
              className="block text-sm text-ink-700 font-medium mb-1"
            >
              URL da receita Memed *
            </label>
            <input
              id="memed_url"
              type="url"
              required={isPrescribed}
              value={memedUrl}
              onChange={(e) => setMemedUrl(e.target.value)}
              placeholder="https://memed.com.br/r/..."
              className={`w-full rounded-xl border px-3 py-2.5 bg-white text-ink-800 placeholder:text-ink-400 ${
                errorField === "memed_prescription_url"
                  ? "border-red-400"
                  : "border-ink-200"
              }`}
            />
            <p className="mt-1 text-xs text-ink-500">
              Cole aqui o link público da receita que você gerou na Memed.
              A paciente e a farmácia vão abrir por esse link.
            </p>
          </div>

          <div>
            <label
              htmlFor="memed_id"
              className="block text-sm text-ink-700 font-medium mb-1"
            >
              ID Memed (opcional)
            </label>
            <input
              id="memed_id"
              type="text"
              value={memedId}
              onChange={(e) => setMemedId(e.target.value)}
              placeholder="ex: MEMED-12345"
              className="w-full rounded-xl border border-ink-200 px-3 py-2.5 bg-white text-ink-800 placeholder:text-ink-400"
            />
          </div>
        </div>
      )}

      {error && !errorField && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between gap-4 pt-2">
        <button
          type="button"
          onClick={() => router.push("/medico/agenda")}
          className="text-sm text-ink-600 hover:text-ink-800"
        >
          Cancelar
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          className="inline-flex items-center justify-center rounded-full bg-sage-700 hover:bg-sage-800 disabled:bg-ink-200 disabled:text-ink-400 text-cream-50 text-[0.94rem] font-medium px-6 py-3 transition-colors"
        >
          {submitting
            ? "Finalizando..."
            : isPrescribed
              ? "Finalizar e enviar prescrição"
              : "Finalizar sem prescrição"}
        </button>
      </div>
    </form>
  );
}

function TextArea({
  label,
  hint,
  value,
  onChange,
  rows,
  fieldError,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  rows: number;
  fieldError?: string | null;
}) {
  return (
    <div>
      <label className="block text-sm text-ink-700 font-medium mb-1">
        {label}
      </label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className={`w-full rounded-xl border px-3 py-2.5 bg-white text-ink-800 placeholder:text-ink-400 ${
          fieldError ? "border-red-400" : "border-ink-200"
        }`}
      />
      {hint && <p className="mt-1 text-xs text-ink-500">{hint}</p>}
      {fieldError && (
        <p className="mt-1 text-xs text-red-700">{fieldError}</p>
      )}
    </div>
  );
}
