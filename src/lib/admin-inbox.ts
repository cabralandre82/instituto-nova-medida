/**
 * src/lib/admin-inbox.ts — D-045 · 3.A
 *
 * Fonte única da "Inbox do Operador Solo": as ações pendentes que
 * precisam de intervenção humana, agregadas de várias fontes num
 * objeto ordenado por urgência.
 *
 * Motivação: operar a plataforma sozinho exige que o admin abra
 * UMA tela e saiba, em 10 segundos, o que precisa fazer hoje — sem
 * cruzar 5 painéis na cabeça. O `/admin` home deixa de ser dashboard
 * de métricas e vira um todo-list inteligente.
 *
 * Design:
 *   - SLAs centralizados em `SLA_HOURS`. Mudar um SLA é uma constante.
 *   - Cada `InboxItem` tem `urgency` (overdue / due_soon / info),
 *     `count` (quantos), `oldestAgeHours` (pra mostrar "há 36h"),
 *     e `href` (ação imediata).
 *   - `loadAdminInbox` busca tudo em paralelo (Promise.all) e
 *     retorna itens JÁ ordenados: overdue primeiro, depois due_soon,
 *     depois info.
 *   - Lib não faz I/O de notificação — só retorna dados. A onda 3.D
 *     consumirá os mesmos itens pra WA de rollup matinal.
 *
 * Classificação de urgência:
 *   - `overdue`: algum item estourou o SLA (ageHours > slaHours).
 *   - `due_soon`: existe item mas todos dentro de 50-100% do SLA.
 *   - `info`: não existe item relevante (retorna só se queremos
 *     mostrar zero-state; neste MVP descartamos itens com count=0).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// ────────────────────────────────────────────────────────────────────────
// SLAs (horas). Ajustar aqui = ajustar em todo o app.
// ────────────────────────────────────────────────────────────────────────

export const SLA_HOURS = {
  /**
   * appointment em `pending_payment` (LEGADO D-044) > 24h — watchdog
   * do PR-071 · D-079 · finding [1.4]. Novo modelo não cria appointments
   * nesse estado; se ficar velho, é resíduo/ghost e paciente vê
   * "Aguardando confirmação" sem ação possível.
   */
  appointment_pending_payment_stale: 24,
  /** paid → pharmacy_requested: o Instituto tem 1 dia útil pra acionar farmácia */
  paid_to_pharmacy: 24,
  /** pharmacy_requested → shipped: farmácia + recebimento pelo Instituto */
  pharmacy_to_shipped: 5 * 24,
  /** shipped → delivered: depois disso, cron 3.C vai auto-delivered */
  shipped_to_delivered: 14 * 24,
  /** pending_acceptance: paciente recebeu indicação, não aceitou */
  acceptance_stale: 72,
  /** pending_payment: aceitou, não pagou */
  payment_stale: 48,
  /** refund_required: ninguém processou ainda */
  refund_stale: 48,
  /** reconciliação de appointments (D-035) */
  reconcile_stuck: 2,
  /** lgpd_requests pendentes: Art. 19 §1º dá 15 dias corridos */
  lgpd_pending: 15 * 24,
} as const;

// ────────────────────────────────────────────────────────────────────────
// Tipos
// ────────────────────────────────────────────────────────────────────────

export type InboxUrgency = "overdue" | "due_soon";

export type InboxCategory =
  | "fulfillment_paid"
  | "fulfillment_pharmacy"
  | "fulfillment_shipped"
  | "offer_acceptance"
  | "offer_payment"
  | "refund"
  | "notification"
  | "reconciliation"
  | "reliability_paused"
  | "reliability_warn"
  | "finance_critical"
  | "finance_warning"
  | "doctor_pending"
  | "lgpd_pending"
  /**
   * PR-071 · D-079 · finding 1.4. Appointment LEGADO preso em
   * `pending_payment` — nenhum novo deveria existir no modelo D-044.
   * Alerta acima de 24h: provavelmente ghost do fluxo antigo ou bug.
   */
  | "appointment_pending_payment_stale";

export type InboxItem = {
  /** Chave única estável (categoria). Usada como React key e id de notificação. */
  id: InboxCategory;
  urgency: InboxUrgency;
  category: InboxCategory;
  /** Título curto da ação, modo imperativo. */
  title: string;
  /** Uma frase explicando o que é e o que tem que ser feito. */
  description: string;
  /** Contagem de itens pendentes nessa categoria. */
  count: number;
  /** Idade do item MAIS ANTIGO, em horas. `null` se não se aplica. */
  oldestAgeHours: number | null;
  /** SLA configurado pra essa categoria, em horas. `null` se não se aplica. */
  slaHours: number | null;
  /** Link direto pra ação. */
  href: string;
};

export type AdminInbox = {
  items: InboxItem[];
  counts: {
    overdue: number;
    dueSoon: number;
    total: number;
  };
  generatedAt: string;
};

// ────────────────────────────────────────────────────────────────────────
// Classificadores puros (testáveis sem I/O)
// ────────────────────────────────────────────────────────────────────────

/**
 * Decide a urgência baseada na idade do item mais antigo vs. SLA.
 * - `overdue`: ageHours > slaHours
 * - `due_soon`: 50% < ageHours <= slaHours
 * - `null`: ageHours <= 50% (não virou item da inbox)
 *
 * Obs: para itens sem SLA (ex: reliability_paused = estado, não
 * temporal), chamamos com `slaHours=null` e retornamos sempre
 * `overdue` se count>0 (visto que são estados que pedem ação humana).
 */
export function classifyUrgency(
  ageHours: number | null,
  slaHours: number | null
): InboxUrgency | null {
  if (slaHours == null) {
    // Sem SLA temporal — é uma pendência de estado, sempre "atenção".
    return "overdue";
  }
  if (ageHours == null || ageHours < 0) {
    return null;
  }
  if (ageHours > slaHours) return "overdue";
  if (ageHours > slaHours * 0.5) return "due_soon";
  return null;
}

/**
 * Formata idade em horas pra texto legível em pt-BR.
 *   - < 1: "há menos de 1h"
 *   - 1-23: "há Xh"
 *   - 24-48: "há 1 dia"
 *   - 48+: "há X dias"
 */
export function formatAge(hours: number | null | undefined): string {
  if (hours == null || !Number.isFinite(hours) || hours < 0) return "—";
  if (hours < 1) return "há menos de 1h";
  if (hours < 24) {
    const h = Math.floor(hours);
    return `há ${h}h`;
  }
  const days = Math.floor(hours / 24);
  if (days === 1) return "há 1 dia";
  return `há ${days} dias`;
}

/**
 * Ordena itens: overdue primeiro (por idade desc), depois due_soon
 * (por idade desc). Empates: por `count` desc, depois `category`.
 */
export function sortInboxItems(items: InboxItem[]): InboxItem[] {
  const urgencyRank: Record<InboxUrgency, number> = {
    overdue: 0,
    due_soon: 1,
  };
  return [...items].sort((a, b) => {
    if (a.urgency !== b.urgency) {
      return urgencyRank[a.urgency] - urgencyRank[b.urgency];
    }
    const ageA = a.oldestAgeHours ?? 0;
    const ageB = b.oldestAgeHours ?? 0;
    if (ageA !== ageB) return ageB - ageA;
    if (a.count !== b.count) return b.count - a.count;
    return a.category.localeCompare(b.category);
  });
}

// ────────────────────────────────────────────────────────────────────────
// Helper I/O: count + idade do mais antigo
// ────────────────────────────────────────────────────────────────────────

type CountAgeResult = { count: number; oldestAgeHours: number | null };

/**
 * Faz duas operações numa query: conta registros da condição e pega
 * o mais antigo no campo `ageField` pra calcular `oldestAgeHours`.
 *
 * Usa PostgREST: `select(ageField, { count: 'exact' })` + order asc +
 * limit 1. `data` traz até 1 linha, `count` traz o total.
 *
 * Tipagem relaxada: quem chama passa o `.from(...).select(...)` já
 * com `{ count: 'exact' }` e filtros aplicados; o builder do Supabase
 * é genérico demais pra refletir aqui sem acoplar tipos internos, então
 * aceitamos `unknown` e validamos a shape em runtime.
 */
async function countWithOldest(
  query: unknown,
  ageField: string,
  now: Date
): Promise<CountAgeResult> {
  const q = query as {
    order: (
      col: string,
      opts: { ascending: boolean }
    ) => { limit: (n: number) => Promise<unknown> };
  };
  const res = (await q.order(ageField, { ascending: true }).limit(1)) as {
    data: Array<Record<string, unknown>> | null;
    error: { message: string } | null;
    count: number | null;
  };

  if (res.error) {
    throw new Error(`admin-inbox countWithOldest: ${res.error.message}`);
  }

  const count = res.count ?? 0;
  const firstRow = (res.data ?? [])[0];
  const oldestTs = firstRow?.[ageField];
  const oldestAgeHours =
    typeof oldestTs === "string"
      ? (now.getTime() - new Date(oldestTs).getTime()) / (60 * 60 * 1000)
      : null;

  return { count, oldestAgeHours };
}

// ────────────────────────────────────────────────────────────────────────
// Construtor principal
// ────────────────────────────────────────────────────────────────────────

export async function loadAdminInbox(
  supabase: SupabaseClient,
  now: Date = new Date()
): Promise<AdminInbox> {
  const reconcileCutoff = new Date(
    now.getTime() - SLA_HOURS.reconcile_stuck * 60 * 60 * 1000
  ).toISOString();

  const [
    ffPaid,
    ffPharm,
    ffShipped,
    offerAcc,
    offerPay,
    refund,
    notifFailed,
    reconcile,
    doctorPending,
    lgpdPending,
    apptPendingPayment,
  ] = await Promise.all([
    countWithOldest(
      supabase
        .from("fulfillments")
        .select("paid_at", { count: "exact" })
        .eq("status", "paid"),
      "paid_at",
      now
    ),
    countWithOldest(
      supabase
        .from("fulfillments")
        .select("pharmacy_requested_at", { count: "exact" })
        .eq("status", "pharmacy_requested"),
      "pharmacy_requested_at",
      now
    ),
    countWithOldest(
      supabase
        .from("fulfillments")
        .select("shipped_at", { count: "exact" })
        .eq("status", "shipped"),
      "shipped_at",
      now
    ),
    countWithOldest(
      supabase
        .from("fulfillments")
        .select("created_at", { count: "exact" })
        .eq("status", "pending_acceptance"),
      "created_at",
      now
    ),
    countWithOldest(
      supabase
        .from("fulfillments")
        .select("accepted_at", { count: "exact" })
        .eq("status", "pending_payment"),
      "accepted_at",
      now
    ),
    countWithOldest(
      supabase
        .from("appointments")
        .select("no_show_policy_applied_at", { count: "exact" })
        .eq("refund_required", true)
        .is("refund_processed_at", null),
      "no_show_policy_applied_at",
      now
    ),
    countWithOldest(
      supabase
        .from("appointment_notifications")
        .select("created_at", { count: "exact" })
        .eq("status", "failed"),
      "created_at",
      now
    ),
    countWithOldest(
      supabase
        .from("appointments")
        .select("scheduled_at", { count: "exact" })
        .in("status", ["scheduled", "confirmed", "in_progress"])
        .not("video_room_name", "is", null)
        .lt("scheduled_at", reconcileCutoff)
        .is("reconciled_at", null),
      "scheduled_at",
      now
    ),
    countWithOldest(
      supabase
        .from("doctors")
        .select("created_at", { count: "exact" })
        .in("status", ["invited", "pending"]),
      "created_at",
      now
    ),
    countWithOldest(
      supabase
        .from("lgpd_requests")
        .select("requested_at", { count: "exact" })
        .eq("kind", "anonymize")
        .eq("status", "pending"),
      "requested_at",
      now
    ),
    // PR-071 · D-079: watchdog de appointments LEGADO presas em
    // pending_payment. Usa `created_at` como proxy de idade (não
    // `pending_payment_expires_at` porque essa coluna existe justo
    // pra expiração em 15min e não reflete "há quanto tempo o
    // appointment está ghost"). Em produção estável esse count é 0.
    countWithOldest(
      supabase
        .from("appointments")
        .select("created_at", { count: "exact" })
        .eq("status", "pending_payment"),
      "created_at",
      now
    ),
  ]);

  const candidates: Array<{
    category: InboxCategory;
    title: string;
    description: string;
    count: number;
    age: number | null;
    sla: number | null;
    href: string;
  }> = [
    {
      category: "fulfillment_paid",
      title: "Enviar receita à farmácia",
      description:
        "Pedidos pagos aguardando que você acione a farmácia de manipulação.",
      count: ffPaid.count,
      age: ffPaid.oldestAgeHours,
      sla: SLA_HOURS.paid_to_pharmacy,
      href: "/admin/fulfillments",
    },
    {
      category: "fulfillment_pharmacy",
      title: "Cutucar farmácia / receber caixa",
      description:
        "Receitas enviadas à farmácia já manipuladas ou pendentes há muito tempo.",
      count: ffPharm.count,
      age: ffPharm.oldestAgeHours,
      sla: SLA_HOURS.pharmacy_to_shipped,
      href: "/admin/fulfillments",
    },
    {
      category: "fulfillment_shipped",
      title: "Conferir entregas despachadas",
      description:
        "Caixas a caminho há bastante tempo sem o paciente confirmar recebimento.",
      count: ffShipped.count,
      age: ffShipped.oldestAgeHours,
      sla: SLA_HOURS.shipped_to_delivered,
      href: "/admin/fulfillments",
    },
    {
      category: "offer_acceptance",
      title: "Pacientes ainda não aceitaram indicação",
      description:
        "Ofertas prescritas pela médica aguardando aceite formal do paciente.",
      count: offerAcc.count,
      age: offerAcc.oldestAgeHours,
      sla: SLA_HOURS.acceptance_stale,
      href: "/admin/fulfillments",
    },
    {
      category: "offer_payment",
      title: "Ofertas aceitas sem pagamento",
      description:
        "Paciente aceitou, recebeu a cobrança e ainda não pagou.",
      count: offerPay.count,
      age: offerPay.oldestAgeHours,
      sla: SLA_HOURS.payment_stale,
      href: "/admin/fulfillments",
    },
    {
      category: "refund",
      title: "Processar estornos pendentes",
      description:
        "No-show da médica gerou direito a refund — ainda não processado.",
      count: refund.count,
      age: refund.oldestAgeHours,
      sla: SLA_HOURS.refund_stale,
      href: "/admin/refunds",
    },
    {
      category: "notification",
      title: "Notificações com falha",
      description:
        "WhatsApp/email que não entregaram — clientes podem estar sem aviso.",
      count: notifFailed.count,
      age: notifFailed.oldestAgeHours,
      sla: null, // notificação falha = crítico independente de idade
      href: "/admin/notifications?status=failed",
    },
    {
      category: "reconciliation",
      title: "Consultas não reconciliadas",
      description:
        "Consultas passadas em status não-terminal — cron Daily devia ter fechado.",
      count: reconcile.count,
      age: reconcile.oldestAgeHours,
      sla: SLA_HOURS.reconcile_stuck,
      href: "/admin/health",
    },
    {
      category: "doctor_pending",
      title: "Médicas aguardando ativação",
      description:
        "Cadastros em status `invited` ou `pending` — precisam de CRM/PIX pra virar `active`.",
      count: doctorPending.count,
      age: doctorPending.oldestAgeHours,
      sla: null, // é pendência, não SLA temporal
      href: "/admin/doctors",
    },
    {
      category: "lgpd_pending",
      title: "Solicitações LGPD a atender",
      description:
        "Pacientes pediram anonimização pelo self-service. Prazo legal: 15 dias corridos (Art. 19 §1º).",
      count: lgpdPending.count,
      age: lgpdPending.oldestAgeHours,
      sla: SLA_HOURS.lgpd_pending,
      href: "/admin/lgpd-requests",
    },
    {
      category: "appointment_pending_payment_stale",
      title: "Consulta LEGADO parada em 'pending_payment'",
      description:
        "Appointment ficou preso no fluxo antigo (pré-D-044). Verifique se é ghost ou se o paciente precisa de suporte — nenhum novo deveria surgir com LEGACY_PURCHASE_ENABLED=false.",
      count: apptPendingPayment.count,
      age: apptPendingPayment.oldestAgeHours,
      sla: SLA_HOURS.appointment_pending_payment_stale,
      href: "/admin/health",
    },
  ];

  const items: InboxItem[] = [];
  for (const c of candidates) {
    if (c.count === 0) continue;
    const urgency = classifyUrgency(c.age, c.sla);
    if (!urgency) continue;
    items.push({
      id: c.category,
      urgency,
      category: c.category,
      title: c.title,
      description: c.description,
      count: c.count,
      oldestAgeHours: c.age,
      slaHours: c.sla,
      href: c.href,
    });
  }

  const sorted = sortInboxItems(items);
  const overdue = sorted.filter((i) => i.urgency === "overdue").length;
  const dueSoon = sorted.filter((i) => i.urgency === "due_soon").length;

  return {
    items: sorted,
    counts: {
      overdue,
      dueSoon,
      total: sorted.length,
    },
    generatedAt: now.toISOString(),
  };
}
