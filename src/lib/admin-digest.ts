/**
 * src/lib/admin-digest.ts — D-045 · 3.D
 *
 * Rollup diário via WhatsApp pro operador solo. Em vez de abrir o
 * painel toda manhã pra conferir a inbox, o admin recebe UMA mensagem
 * curta no WhatsApp dizendo exatamente o que estourou SLA.
 *
 * Princípios:
 *   - **Reutiliza `loadAdminInbox`**: fonte única de verdade. Mudar SLA
 *     ou adicionar categoria no inbox é automaticamente refletido aqui.
 *   - **Uma mensagem, uma pessoa**: envia sempre pro mesmo `to`. Se o
 *     operador quiser múltiplos destinatários, roda o cron pra cada um
 *     (scope creep de multi-tenancy não entra hoje).
 *   - **Best-effort**: falha de WA não derruba o cron. Rastreia em
 *     `cron_runs.payload` pra investigação.
 *   - **Zero-state importa**: se a inbox tá vazia, MANDA mesmo assim
 *     uma msg curta ("tudo em ordem"). Sem isso, admin não sabe se é
 *     bom sinal ou se o cron morreu.
 *   - **Sem spam**: a única chamada real vem do cron (1x/dia). Se o
 *     mesmo job rodar 2x seguidas (ex: retry manual), mandamos 2x.
 *     Aceitável: é um chat — o admin ignora o duplicado.
 *
 * SLAs configuráveis: ficam em `admin-inbox.ts → SLA_HOURS` (constante).
 * Por ora, "configurável" = editar código + deploy. Se virar dor,
 * migramos pra tabela `app_settings` — mas hoje seria over-engineering.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadAdminInbox, type AdminInbox, type InboxItem } from "@/lib/admin-inbox";
import { sendText } from "@/lib/whatsapp";

/** Prefixo "dia da semana" em pt-BR pra cabeçalho. */
const WEEKDAYS_PT = [
  "domingo",
  "segunda",
  "terça",
  "quarta",
  "quinta",
  "sexta",
  "sábado",
];

function weekdayPt(date: Date): string {
  return WEEKDAYS_PT[date.getUTCDay()] ?? "dia";
}

function formatDatePt(date: Date): string {
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}`;
}

/** Formata idade curta pra linha de item (mais enxuta que formatAge). */
function ageLabelShort(hours: number | null): string {
  if (hours == null || !Number.isFinite(hours) || hours < 0) return "";
  if (hours < 1) return "há <1h";
  if (hours < 24) return `há ${Math.floor(hours)}h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "há 1d" : `há ${days}d`;
}

function itemLine(item: InboxItem): string {
  const bullet = item.urgency === "overdue" ? "•" : "◦";
  const countLabel =
    item.count === 1 ? "1 item" : `${item.count} itens`;
  const age = ageLabelShort(item.oldestAgeHours);
  const tail = age ? ` · ${age}` : "";
  return `${bullet} ${item.title}: ${countLabel}${tail}`;
}

export type ComposeDigestOptions = {
  /** URL do painel admin (sem barra final), ex: "https://app.x.com/admin" */
  adminUrl?: string;
};

/**
 * Compõe a mensagem WhatsApp. Pura — recebe a inbox já carregada.
 *
 * Formato aproximado:
 *   Bom dia (segunda, 21/04). Resumo da operação:
 *   
 *   Nada estourou SLA hoje. Tudo tranquilo.
 *
 * ou
 *
 *   Bom dia (segunda, 21/04). Resumo da operação:
 *   
 *   2 overdue · 1 em atenção
 *   
 *   • Enviar receita à farmácia: 2 itens · há 2d
 *   • Ofertas sem pagamento: 1 item · há 3d
 *   ◦ Conferir entregas despachadas: 1 item · há 9d
 *   
 *   Abrir painel: https://.../admin
 */
export function composeAdminDigestMessage(
  inbox: AdminInbox,
  now: Date,
  options: ComposeDigestOptions = {}
): string {
  const hour = now.getUTCHours();
  const greeting =
    hour < 14 // antes 11 BRT = 14 UTC → manhã
      ? "Bom dia"
      : hour < 20 // antes 17 BRT = 20 UTC → tarde
      ? "Boa tarde"
      : "Boa noite";

  const header = `${greeting} (${weekdayPt(now)}, ${formatDatePt(now)}). Resumo da operação:`;

  const parts: string[] = [header, ""];

  if (inbox.counts.total === 0) {
    parts.push("Nada estourou SLA hoje. Tudo tranquilo.");
  } else {
    const summaryChips: string[] = [];
    if (inbox.counts.overdue > 0) {
      summaryChips.push(
        `${inbox.counts.overdue} overdue`
      );
    }
    if (inbox.counts.dueSoon > 0) {
      summaryChips.push(
        `${inbox.counts.dueSoon} em atenção`
      );
    }
    parts.push(summaryChips.join(" · "));
    parts.push("");
    for (const item of inbox.items) {
      parts.push(itemLine(item));
    }
  }

  if (options.adminUrl) {
    parts.push("");
    parts.push(`Abrir painel: ${options.adminUrl}`);
  }

  return parts.join("\n");
}

// ────────────────────────────────────────────────────────────────────────
// I/O
// ────────────────────────────────────────────────────────────────────────

export type SendDigestOptions = {
  /** Número E.164 do destinatário (default: `process.env.ADMIN_DIGEST_PHONE`). */
  phone?: string | null;
  /** URL do painel (default: `process.env.NEXT_PUBLIC_SITE_URL + /admin`). */
  adminUrl?: string;
  /** Só envia se houver itens overdue ou due_soon (default: true — envia sempre). */
  requireNonEmpty?: boolean;
  now?: Date;
};

export type SendDigestReport = {
  sent: boolean;
  reason:
    | "sent"
    | "missing_phone"
    | "empty_inbox_and_require_non_empty"
    | "wa_failed";
  inboxCounts: AdminInbox["counts"];
  waCode?: number | null;
  waMessage?: string;
};

export async function sendAdminDigest(
  supabase: SupabaseClient,
  options: SendDigestOptions = {}
): Promise<SendDigestReport> {
  const now = options.now ?? new Date();
  const phone = options.phone ?? process.env.ADMIN_DIGEST_PHONE ?? "";
  const adminUrl =
    options.adminUrl ??
    (process.env.NEXT_PUBLIC_SITE_URL
      ? `${process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "")}/admin`
      : undefined);

  const inbox = await loadAdminInbox(supabase, now);

  if (!phone) {
    return {
      sent: false,
      reason: "missing_phone",
      inboxCounts: inbox.counts,
    };
  }

  if (options.requireNonEmpty === true && inbox.counts.total === 0) {
    return {
      sent: false,
      reason: "empty_inbox_and_require_non_empty",
      inboxCounts: inbox.counts,
    };
  }

  const body = composeAdminDigestMessage(inbox, now, { adminUrl });

  const waRes = await sendText({ to: phone, text: body });

  if (!waRes.ok) {
    return {
      sent: false,
      reason: "wa_failed",
      inboxCounts: inbox.counts,
      waCode: waRes.code,
      waMessage: waRes.message,
    };
  }

  return {
    sent: true,
    reason: "sent",
    inboxCounts: inbox.counts,
  };
}
