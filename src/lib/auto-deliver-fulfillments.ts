/**
 * src/lib/auto-deliver-fulfillments.ts — D-045 · 3.C
 *
 * Cron que fecha fulfillments que ficaram em `shipped` por mais de X dias
 * sem o paciente confirmar recebimento. Após o `SHIPPED_TO_DELIVERED_DAYS`
 * assumimos que a entrega ocorreu (Correios raramente falham e o paciente
 * já teria acionado a gente em caso contrário).
 *
 * Sem isso, fulfillments ficariam eternamente em `shipped` e o sistema
 * não teria sinal de "ciclo completado" — afetando o cron de reconsulta
 * nudge, relatórios de LTV, e o card do paciente.
 *
 * Design:
 *   - Lib pura (recebe supabase por injeção). Testável com mock.
 *   - Usa `transitionFulfillment` com `actor: 'system'` (reaproveitamento
 *     total da lógica existente, inclusive guard de race).
 *   - Dispara WA best-effort de notificação ao paciente ("assumimos
 *     entregue; se não recebeu, responde aqui").
 *   - Retorna relatório com evaluated/delivered/errors/skipped.
 *   - Guard-rail de MAX_PER_RUN pra evitar batch catastrófico em caso
 *     de bug (ex: cron pausado por uma semana).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { transitionFulfillment } from "@/lib/fulfillment-transitions";
import { composeAutoDeliveredMessage } from "@/lib/fulfillment-messages";
import { sendText } from "@/lib/whatsapp";

/** Dias depois de `shipped_at` até assumir entrega automática. */
export const SHIPPED_TO_DELIVERED_DAYS = 14;

/** Guard-rail: quantos fulfillments processar por run (evita flood). */
export const MAX_PER_RUN = 50;

export type AutoDeliverOutcome =
  | "auto_delivered"
  | "transition_failed"
  | "wa_failed"
  | "skipped_missing_phone"
  | "error";

export type AutoDeliverReport = {
  evaluated: number;
  delivered: number;
  errors: number;
  skipped: number;
  details: Array<{
    fulfillmentId: string;
    customerId: string;
    outcome: AutoDeliverOutcome;
    message?: string;
  }>;
};

export type AutoDeliverOptions = {
  now?: Date;
  maxPerRun?: number;
  daysThreshold?: number;
};

export async function autoDeliverFulfillments(
  supabase: SupabaseClient,
  opts: AutoDeliverOptions = {}
): Promise<AutoDeliverReport> {
  const now = opts.now ?? new Date();
  const max = Math.min(Math.max(opts.maxPerRun ?? MAX_PER_RUN, 1), 500);
  const threshold = opts.daysThreshold ?? SHIPPED_TO_DELIVERED_DAYS;

  const cutoff = new Date(
    now.getTime() - threshold * 24 * 60 * 60 * 1000
  ).toISOString();

  const { data, error } = await supabase
    .from("fulfillments")
    .select(
      `id, customer_id, shipped_at,
       customers:customer_id ( name, phone ),
       plans:plan_id ( name )`
    )
    .eq("status", "shipped")
    .lt("shipped_at", cutoff)
    .order("shipped_at", { ascending: true })
    .limit(max);

  if (error) {
    throw new Error(`auto-deliver-fulfillments query failed: ${error.message}`);
  }

  // O client do supabase-js tipa joins 1:1 como array — cast via unknown
  // é consciente e documentado.
  const rows = (data ?? []) as unknown as Array<{
    id: string;
    customer_id: string;
    shipped_at: string;
    customers: { name: string | null; phone: string | null } | null;
    plans: { name: string | null } | null;
  }>;

  const report: AutoDeliverReport = {
    evaluated: rows.length,
    delivered: 0,
    errors: 0,
    skipped: 0,
    details: [],
  };

  for (const r of rows) {
    try {
      const transitionResult = await transitionFulfillment(supabase, {
        fulfillmentId: r.id,
        to: "delivered",
        actor: "system",
        actorUserId: null,
        now,
      });

      if (!transitionResult.ok) {
        report.errors += 1;
        report.details.push({
          fulfillmentId: r.id,
          customerId: r.customer_id,
          outcome: "transition_failed",
          message: `${transitionResult.code}: ${transitionResult.message}`,
        });
        continue;
      }

      report.delivered += 1;

      // WA best-effort. Falha aqui é warning, não erro da transition.
      const phone = r.customers?.phone;
      const customerName = r.customers?.name ?? "";
      const planName = r.plans?.name ?? "seu plano";

      if (!phone) {
        report.skipped += 1;
        report.details.push({
          fulfillmentId: r.id,
          customerId: r.customer_id,
          outcome: "skipped_missing_phone",
        });
        continue;
      }

      const message = composeAutoDeliveredMessage({
        customerName: customerName || "",
        planName,
      });

      try {
        const waRes = await sendText({ to: phone, text: message });
        if (waRes.ok) {
          report.details.push({
            fulfillmentId: r.id,
            customerId: r.customer_id,
            outcome: "auto_delivered",
          });
        } else {
          report.details.push({
            fulfillmentId: r.id,
            customerId: r.customer_id,
            outcome: "wa_failed",
            message: waRes.message,
          });
        }
      } catch (waErr) {
        report.details.push({
          fulfillmentId: r.id,
          customerId: r.customer_id,
          outcome: "wa_failed",
          message: waErr instanceof Error ? waErr.message : String(waErr),
        });
      }
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
