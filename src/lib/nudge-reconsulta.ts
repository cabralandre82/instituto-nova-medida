/**
 * src/lib/nudge-reconsulta.ts — D-045 · 3.C
 *
 * Cron que avisa pacientes cujo ciclo de tratamento tá terminando
 * (ex: 7 dias antes de `delivered_at + plan.cycle_days`) pra agendarem
 * a reconsulta. Idempotente via `fulfillments.reconsulta_nudged_at`.
 *
 * Regras (2026-04):
 *   - Paciente só recebe 1 nudge por ciclo de fulfillment.
 *   - Nudge dispara quando faltam <= `NUDGE_WINDOW_DAYS` dias pro fim
 *     do ciclo (`delivered_at + plan.cycle_days - NUDGE_WINDOW_DAYS <= now`).
 *   - Só considera fulfillments em `delivered` (ciclo ativo e entregue).
 *   - Fulfillments `auto_delivered` pelo cron também entram (status =
 *     delivered independente de quem marcou).
 *
 * Tradeoffs:
 *   - Simples e idempotente mas não escalonado (1 nudge só). Se o paciente
 *     ignorar, não há follow-up automático. Esse follow-up vai no 3.D
 *     (alertas WA pro admin por SLA), que transforma em tarefa humana.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { composeReconsultaNudgeMessage } from "@/lib/fulfillment-messages";
import { sendText } from "@/lib/whatsapp";

/** Quantos dias antes do fim do ciclo disparamos o nudge. */
export const NUDGE_WINDOW_DAYS = 7;

/** Guard-rail: quantos fulfillments processar por run. */
export const MAX_PER_RUN = 100;

export type NudgeOutcome =
  | "nudged"
  | "skipped_missing_phone"
  | "skipped_not_due"
  | "wa_failed"
  | "db_error"
  | "error";

export type NudgeReport = {
  evaluated: number;
  nudged: number;
  skipped: number;
  errors: number;
  details: Array<{
    fulfillmentId: string;
    customerId: string;
    outcome: NudgeOutcome;
    daysRemaining?: number;
    message?: string;
  }>;
};

export type NudgeOptions = {
  now?: Date;
  maxPerRun?: number;
  windowDays?: number;
};

type Row = {
  id: string;
  customer_id: string;
  delivered_at: string | null;
  customers: { name: string | null; phone: string | null } | null;
  plans: { name: string | null; cycle_days: number | null } | null;
};

/**
 * Calcula quantos dias faltam até o fim do ciclo. Pode ser negativo
 * (ciclo já passou — ainda mandamos nudge, porque é melhor tarde).
 * Retorna `null` quando faltam dados pra calcular.
 */
export function daysRemaining(
  now: Date,
  deliveredAt: string | null,
  cycleDays: number | null
): number | null {
  if (!deliveredAt) return null;
  if (cycleDays == null || cycleDays <= 0) return null;
  const delivered = new Date(deliveredAt);
  if (Number.isNaN(delivered.getTime())) return null;
  const end = delivered.getTime() + cycleDays * 24 * 60 * 60 * 1000;
  const diffMs = end - now.getTime();
  return Math.round(diffMs / (24 * 60 * 60 * 1000));
}

export async function nudgeReconsulta(
  supabase: SupabaseClient,
  opts: NudgeOptions = {}
): Promise<NudgeReport> {
  const now = opts.now ?? new Date();
  const max = Math.min(Math.max(opts.maxPerRun ?? MAX_PER_RUN, 1), 500);
  const window = opts.windowDays ?? NUDGE_WINDOW_DAYS;

  // Pega fulfillments `delivered` ainda não nudgeados. A janela é filtrada
  // em memória porque depende de `plan.cycle_days` que varia por plano
  // (no SQL exigiria um join + expressão — fazer depois se virar gargalo).
  const { data, error } = await supabase
    .from("fulfillments")
    .select(
      `id, customer_id, delivered_at,
       customers:customer_id ( name, phone ),
       plans:plan_id ( name, cycle_days )`
    )
    .eq("status", "delivered")
    .is("reconsulta_nudged_at", null)
    .not("delivered_at", "is", null)
    .order("delivered_at", { ascending: true })
    .limit(max);

  if (error) {
    throw new Error(`nudge-reconsulta query failed: ${error.message}`);
  }

  // Cast via unknown: o supabase-js tipa joins 1:1 como array.
  const rows = (data ?? []) as unknown as Row[];

  const report: NudgeReport = {
    evaluated: rows.length,
    nudged: 0,
    skipped: 0,
    errors: 0,
    details: [],
  };

  for (const r of rows) {
    try {
      const remaining = daysRemaining(
        now,
        r.delivered_at,
        r.plans?.cycle_days ?? null
      );

      if (remaining == null || remaining > window) {
        report.skipped += 1;
        report.details.push({
          fulfillmentId: r.id,
          customerId: r.customer_id,
          outcome: "skipped_not_due",
          daysRemaining: remaining ?? undefined,
        });
        continue;
      }

      const phone = r.customers?.phone;
      if (!phone) {
        report.skipped += 1;
        report.details.push({
          fulfillmentId: r.id,
          customerId: r.customer_id,
          outcome: "skipped_missing_phone",
          daysRemaining: remaining,
        });
        continue;
      }

      const message = composeReconsultaNudgeMessage({
        customerName: r.customers?.name ?? "",
        planName: r.plans?.name ?? "seu plano",
        daysRemaining: remaining,
      });

      const waRes = await sendText({ to: phone, text: message });

      if (!waRes.ok) {
        report.errors += 1;
        report.details.push({
          fulfillmentId: r.id,
          customerId: r.customer_id,
          outcome: "wa_failed",
          daysRemaining: remaining,
          message: waRes.message,
        });
        continue;
      }

      // Marca nudgeado. Se der db_error aqui, é ruim porque já mandamos WA.
      // Logamos como error pra investigação manual — no pior caso o
      // paciente recebe 2x em 1 dia (aceitável, é só 1 dia de janela).
      const upd = await supabase
        .from("fulfillments")
        .update({ reconsulta_nudged_at: now.toISOString() })
        .eq("id", r.id)
        .is("reconsulta_nudged_at", null);

      if (upd.error) {
        report.errors += 1;
        report.details.push({
          fulfillmentId: r.id,
          customerId: r.customer_id,
          outcome: "db_error",
          daysRemaining: remaining,
          message: `wa sent but update failed: ${upd.error.message}`,
        });
        continue;
      }

      report.nudged += 1;
      report.details.push({
        fulfillmentId: r.id,
        customerId: r.customer_id,
        outcome: "nudged",
        daysRemaining: remaining,
      });
    } catch (err) {
      report.errors += 1;
      report.details.push({
        fulfillmentId: r.id,
        customerId: r.customer_id,
        outcome: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return report;
}
