/**
 * Lógica do cron `notify_pending_documents` (D-041).
 *
 * Roda 1x/dia (06:00 BRT ≈ 09:00 UTC). Para cada payout `confirmed` cujo
 * PIX saiu há pelo menos `REMINDER_AFTER_DAYS` dias E não tem
 * `doctor_billing_documents.validated_at`, envia WhatsApp
 * (`medica_documento_pendente`). Idempotência por
 * `doctor_payouts.last_nf_reminder_at` — só cobra se o último lembrete
 * foi há ≥ `REMINDER_INTERVAL_HOURS` horas.
 *
 * Stub-safe: se o template não estiver aprovado (`sendMedicaDocumentoPendente`
 * já devolve `templates_not_approved` ou `dry_run`), o cron registra o
 * resultado como `skipped_template` mas atualiza `last_nf_reminder_at`
 * mesmo assim (impede loop de retry diário em ambiente sem Meta aprovado).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendMedicaDocumentoPendente } from "@/lib/wa-templates";
import { formatCurrencyBRL } from "@/lib/datetime-br";

/** Só cobra NF se o PIX saiu há pelo menos 7 dias. */
export const REMINDER_AFTER_DAYS = 7;

/** Intervalo mínimo entre lembretes pra mesma payout (evita spam). */
export const REMINDER_INTERVAL_HOURS = 24;

/** Não manda mais que N lembretes num único ciclo (guard-rail). */
export const MAX_NOTIFICATIONS_PER_RUN = 100;

export type NotifyResult = {
  ok: boolean;
  evaluated: number;
  notified: number;
  skippedInterval: number;
  skippedTemplate: number;
  skippedMissingPhone: number;
  skippedMissingName: number;
  errors: number;
  details: Array<{
    payoutId: string;
    doctorId: string;
    referencePeriod: string;
    outcome:
      | "notified"
      | "skipped_interval"
      | "skipped_template"
      | "skipped_missing_phone"
      | "skipped_missing_name"
      | "error";
    message?: string;
  }>;
};

function formatPeriodBR(period: string): string {
  if (!/^\d{4}-\d{2}$/.test(period)) return period;
  const [y, m] = period.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toLocaleDateString("pt-BR", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function brl(cents: number): string {
  return formatCurrencyBRL(cents);
}

type PayoutRow = {
  id: string;
  doctor_id: string;
  reference_period: string;
  amount_cents: number;
  paid_at: string | null;
  confirmed_at: string | null;
  last_nf_reminder_at: string | null;
  doctors: {
    id: string;
    full_name: string | null;
    display_name: string | null;
    phone: string | null;
  } | null;
  doctor_billing_documents:
    | Array<{ id: string; validated_at: string | null }>
    | null;
};

export async function notifyPendingDocuments(
  supabase: SupabaseClient,
  now: Date = new Date()
): Promise<NotifyResult> {
  const result: NotifyResult = {
    ok: true,
    evaluated: 0,
    notified: 0,
    skippedInterval: 0,
    skippedTemplate: 0,
    skippedMissingPhone: 0,
    skippedMissingName: 0,
    errors: 0,
    details: [],
  };

  const cutoff = new Date(
    now.getTime() - REMINDER_AFTER_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const intervalCutoff = new Date(
    now.getTime() - REMINDER_INTERVAL_HOURS * 60 * 60 * 1000
  ).toISOString();

  const { data, error } = await supabase
    .from("doctor_payouts")
    .select(
      `
      id,
      doctor_id,
      reference_period,
      amount_cents,
      paid_at,
      confirmed_at,
      last_nf_reminder_at,
      doctors ( id, full_name, display_name, phone ),
      doctor_billing_documents ( id, validated_at )
      `
    )
    .eq("status", "confirmed")
    .not("paid_at", "is", null)
    .lte("paid_at", cutoff)
    .limit(MAX_NOTIFICATIONS_PER_RUN * 2);

  if (error) {
    result.ok = false;
    result.errors += 1;
    console.error("[notify-pending-documents] load:", error);
    return result;
  }

  const rows = (data ?? []) as unknown as PayoutRow[];

  for (const row of rows) {
    // A partir do join shape do Supabase, "doctors" pode vir como objeto ou
    // (em outras versões) como array — normalizamos aqui.
    const doctor = Array.isArray(row.doctors) ? row.doctors[0] ?? null : row.doctors;
    const docs = row.doctor_billing_documents ?? [];
    const hasValidated = docs.some((d) => d.validated_at != null);
    if (hasValidated) continue;
    if (result.notified + result.skippedInterval >= MAX_NOTIFICATIONS_PER_RUN) {
      break;
    }

    result.evaluated += 1;

    // Interval guard — permite uma tolerância pequena pra alinhamento do cron
    if (row.last_nf_reminder_at && row.last_nf_reminder_at > intervalCutoff) {
      result.skippedInterval += 1;
      result.details.push({
        payoutId: row.id,
        doctorId: row.doctor_id,
        referencePeriod: row.reference_period,
        outcome: "skipped_interval",
      });
      continue;
    }

    if (!doctor) {
      result.errors += 1;
      result.details.push({
        payoutId: row.id,
        doctorId: row.doctor_id,
        referencePeriod: row.reference_period,
        outcome: "error",
        message: "doctor_not_found",
      });
      continue;
    }
    const phone = doctor.phone?.trim();
    if (!phone) {
      result.skippedMissingPhone += 1;
      result.details.push({
        payoutId: row.id,
        doctorId: row.doctor_id,
        referencePeriod: row.reference_period,
        outcome: "skipped_missing_phone",
      });
      // marca last_nf_reminder_at mesmo assim pra não entrar em loop
      await supabase
        .from("doctor_payouts")
        .update({ last_nf_reminder_at: now.toISOString() })
        .eq("id", row.id);
      continue;
    }
    const name = (doctor.display_name || doctor.full_name || "").trim();
    if (!name) {
      result.skippedMissingName += 1;
      result.details.push({
        payoutId: row.id,
        doctorId: row.doctor_id,
        referencePeriod: row.reference_period,
        outcome: "skipped_missing_name",
      });
      await supabase
        .from("doctor_payouts")
        .update({ last_nf_reminder_at: now.toISOString() })
        .eq("id", row.id);
      continue;
    }

    try {
      const send = await sendMedicaDocumentoPendente({
        to: phone,
        doctorNome: name,
        periodoRef: formatPeriodBR(row.reference_period),
        valorReais: brl(row.amount_cents),
      });

      // Em qualquer resultado (ok, dry_run, templates_not_approved)
      // registramos last_nf_reminder_at pra evitar loop — o status fica
      // no payload pra auditoria.
      await supabase
        .from("doctor_payouts")
        .update({ last_nf_reminder_at: now.toISOString() })
        .eq("id", row.id);

      if (send.ok) {
        result.notified += 1;
        result.details.push({
          payoutId: row.id,
          doctorId: row.doctor_id,
          referencePeriod: row.reference_period,
          outcome: "notified",
        });
      } else {
        result.skippedTemplate += 1;
        result.details.push({
          payoutId: row.id,
          doctorId: row.doctor_id,
          referencePeriod: row.reference_period,
          outcome: "skipped_template",
          message: send.message ?? "template_send_not_ok",
        });
      }
    } catch (e) {
      result.errors += 1;
      result.ok = false;
      console.error("[notify-pending-documents] send falhou:", e);
      result.details.push({
        payoutId: row.id,
        doctorId: row.doctor_id,
        referencePeriod: row.reference_period,
        outcome: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return result;
}
