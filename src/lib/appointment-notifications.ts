/**
 * src/lib/appointment-notifications.ts — PR-067 · D-075 · finding [17.7]
 *
 * Render canônico do corpo (body) das mensagens WhatsApp + snapshot
 * forense do telefone de destino. Isola a lógica de "o que o paciente
 * efetivamente viu naquele momento" num único lugar puro + testável,
 * e persiste em `appointment_notifications.{body,target_phone,rendered_at}`
 * antes do dispatch HTTP.
 *
 * Por que existe
 * ──────────────
 * CFM 2.314/2022 (telemedicina) e CDC Art. 39 VIII exigem que a
 * clínica consiga provar conteúdo e destinatário de comunicações
 * transacionais enviadas ao paciente. Hoje `wa-templates.ts` só
 * dispara via Meta (que substitui variáveis server-side), e o log
 * salva apenas `kind` + `sent_at`. Se o paciente reclamar ("não
 * recebi essa mensagem" ou "recebi no número errado"), não havia
 * como reconstituir. Esta lib grava o que seria enviado **antes**
 * do HTTP, imutável após sucesso (trigger DB D-075).
 *
 * Design
 * ──────
 *
 * 1. `renderNotificationBody()` — PURA. Recebe kind + contexto
 *    (customer, doctor, appointment, payload) e devolve {body,
 *    templateName, targetPhone}. Os templates textuais espelham 1:1
 *    os aprovados na Meta e documentados em `docs/WHATSAPP_TEMPLATES.md`.
 *    Substituição de variáveis via simple `replaceVars()` (sem regex
 *    complexa, sem dependência externa).
 *
 * 2. `maskPhoneForAdmin()` — helper de UI: converte telefone real
 *    em formato com últimos 4 dígitos preservados pra exibição em
 *    relatórios admin sem vazar PII no Vercel log. "+5511987654321"
 *    → "+55 11 ****4321". Fail-soft: telefone curto → "****".
 *
 * 3. `recordBodySnapshot()` — I/O. UPDATE guard por `sent_at IS NULL`
 *    (impede corrida com envio em andamento); se a linha já foi
 *    enviada, é no-op idempotente (não re-grava) pra não disparar
 *    o trigger `trg_an_body_immutable_after_send`.
 *
 * 4. Nunca chama rede ou helpers do Supabase além do UPDATE — todo
 *    state/DB externo é explícito via parâmetro.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  formatConsultaDateTime,
  formatRelativeTomorrow,
  formatRelativeToday,
  formatTime,
  firstName,
  KIND_TO_TEMPLATE,
  type NotificationKind,
} from "./wa-templates";
import { logger } from "./logger";

const log = logger.with({ mod: "appt-notifications" });

// ─── Templates textuais ─────────────────────────────────────────────────
//
// Espelho 1:1 do conteúdo dos templates Meta documentados em
// `docs/WHATSAPP_TEMPLATES.md`. Variáveis como {{1}}, {{2}} são
// substituídas pelo `replaceVars()`. A intenção é que o texto aqui
// seja o que o paciente efetivamente leria — se a Meta mudar o body
// aprovado, atualizamos AQUI + lá. Se divergir, isto vira ground-truth
// pra forense ("o que tentamos enviar") mesmo que a Meta tenha enviado
// diferente.

const BODIES: Record<NotificationKind, string> = {
  confirmacao: `Olá, {{1}}! Sua consulta no Instituto Nova Medida está confirmada.

📅 *{{2}}*
👩‍⚕️ {{3}}

Você receberá um lembrete 1 hora antes e o link da sala 15 minutos antes do horário marcado.

Para reagendar ou cancelar, acesse: {{4}}`,

  t_minus_24h: `Oi, {{1}}! Lembrando da sua consulta amanhã 👋

📅 *{{2}}* com {{3}}

Tudo certo? Se precisar reagendar, é só responder essa mensagem agora — depois fica difícil. 🙏`,

  t_minus_1h: `{{1}}, sua consulta é em 1 hora ⏰

📅 {{2}}

Em 45 minutos enviamos o link da sala. Esteja em ambiente reservado, com boa iluminação e câmera funcionando. Pode testar agora se quiser.`,

  t_minus_15min: `{{1}}, sua sala está pronta 🎥

🔗 *Entrar na consulta agora:*
{{2}}

Aberta a partir de agora até {{3}}.

⚠️ Use o navegador *Chrome*, *Edge* ou *Safari* (Firefox dá problema). Permita acesso à câmera e ao microfone quando o navegador pedir.`,

  on_demand_call: `{{1}}, é a sua vez! 🎉

A {{2}} acabou de te chamar para a consulta.

🔗 *Entrar agora (link válido por 5 minutos):*
{{3}}

Se você não entrar em 5 minutos, voltamos pra fila e chamamos a próxima pessoa. Mas garantimos sua prioridade nas próximas 4 horas.`,

  pos_consulta: `{{1}}, obrigado pelo seu tempo na consulta de hoje 💚

📋 *Sua receita digital* (assinada com ICP-Brasil):
{{2}}

Resumo da conduta:
{{3}}

Qualquer dúvida sobre dose, efeitos ou logística da entrega, é só responder essa mensagem.`,

  t_plus_10min: `{{1}}, obrigado pelo seu tempo na consulta de hoje 💚

📋 *Sua receita digital* (assinada com ICP-Brasil):
{{2}}

Resumo da conduta:
{{3}}

Qualquer dúvida sobre dose, efeitos ou logística da entrega, é só responder essa mensagem.`,

  reserva_expirada: `{{1}}, seu PIX do plano {{2}} expira em 12 horas ⏳

Para garantir o início do seu tratamento, finalize agora:
{{3}}

Pagamentos confirmados antes das 22h ainda permitem agendar consulta para amanhã.`,

  // Templates ainda não aprovados pela Meta (PR-031). Renderizamos o
  // texto que seria enviado assim que forem aprovados — a lib grava
  // mesmo em dry-run pra ajudar QA a validar a cópia.
  no_show_patient: `Oi, {{1}}. A gente sentiu sua falta hoje na consulta com {{2}}.

Se precisar remarcar, é só clicar aqui: {{3}}

Se foi engano, é só responder essa mensagem que a gente te ajuda.`,

  no_show_doctor: `Olá, {{1}}. Infelizmente a consulta de hoje com {{2}} não pôde acontecer por problema do nosso lado. Pedimos desculpas.

Você pode reagendar sem custo: {{3}}

Se preferir o reembolso integral, é só responder essa mensagem.`,
};

// ─── Helpers puros ──────────────────────────────────────────────────────

/**
 * Substitui placeholders `{{1}}`, `{{2}}`... pelos valores fornecidos
 * (1-indexed). Tolerante a vars faltantes: substitui por string vazia.
 * Não faz escape — os templates são pt_BR literal sem HTML.
 */
export function replaceVars(template: string, vars: readonly string[]): string {
  return template.replace(/\{\{(\d+)\}\}/g, (_, idxStr) => {
    const idx = Number.parseInt(idxStr, 10);
    if (!Number.isFinite(idx) || idx < 1) return "";
    return vars[idx - 1] ?? "";
  });
}

/**
 * Normaliza telefone pra só-dígitos + prefixo opcional. Entrada pode
 * vir com máscara, sinais, espaços. Saída: "5511987654321" (E.164 sem `+`).
 * Fail-soft: entrada inválida → string vazia (caller decide o que fazer).
 */
export function normalizePhoneDigits(phone: string | null | undefined): string {
  if (typeof phone !== "string") return "";
  const digits = phone.replace(/\D+/g, "");
  if (digits.length < 10 || digits.length > 15) return "";
  return digits;
}

/**
 * Mascara telefone pra exibição em UI admin ou log. Mantém DDI + DDD
 * legíveis e últimos `visible` dígitos (default 4); resto vira `*`.
 *
 *   maskPhoneForAdmin("+55 11 98765-4321") → "+55 11 ****4321"
 *   maskPhoneForAdmin("5511987654321")     → "+55 11 ****4321"
 *   maskPhoneForAdmin("123")               → "****"  (curto demais)
 *   maskPhoneForAdmin(null)                → "—"
 */
export function maskPhoneForAdmin(
  phone: string | null | undefined,
  opts: { visible?: number } = {}
): string {
  if (!phone) return "—";
  const digits = normalizePhoneDigits(phone);
  if (!digits) return "****";

  const visible = Math.max(0, Math.min(6, opts.visible ?? 4));
  if (digits.length <= visible) return "*".repeat(4);

  const hiddenCount = digits.length - visible;
  // slice(-0) devolve a string INTEIRA (mesma semântica de slice(0)).
  // Tratamos explicitamente o caso 0 pra que visible=0 mascare tudo.
  const suffix = visible > 0 ? digits.slice(-visible) : "";

  // DDI 2 + DDD 2 = 4 dígitos de cabeça; se cabe, formata bonito:
  if (digits.length >= 12) {
    const ddi = digits.slice(0, 2);
    const ddd = digits.slice(2, 4);
    return `+${ddi} ${ddd} ${"*".repeat(Math.max(0, hiddenCount - 4))}${suffix}`;
  }
  return `${"*".repeat(hiddenCount)}${suffix}`;
}

// ─── Render ─────────────────────────────────────────────────────────────

/** Contexto mínimo pra renderizar qualquer kind de notificação. */
export type RenderContext = {
  customerName: string;
  customerPhone: string;
  doctorDisplay: string;
  scheduledAt: Date;
  /** URL absoluta da sala (Daily ou `/consulta/[id]`). */
  consultaUrl: string;
  /** Para template link_sala_consulta: até quando a sala é válida. */
  salaValidaAte?: Date;
  /** URL de reagendamento (pode ser mesma do consultaUrl). */
  reagendamentoUrl: string;
  /** Payload extra da row (pos_consulta, reserva_expirada etc.). */
  payload?: {
    receita_url?: string | null;
    conduta_resumo?: string | null;
    plano_nome?: string | null;
    invoice_url?: string | null;
  } | null;
  /** URL base pra fallbacks (ex: /planos). */
  baseUrl: string;
};

export type RenderedNotification = {
  /** Corpo textual final (pt_BR) com variáveis substituídas. */
  body: string;
  /** Nome do template Meta alvo (sem sufixo de versão). */
  templateName: string;
  /** Telefone de destino normalizado (dígitos apenas). */
  targetPhone: string;
};

/**
 * Renderiza o body de uma notificação por kind. PURA: determinística em
 * função do input. Não faz fetch, não lê env vars, não chama Supabase.
 */
export function renderNotificationBody(
  kind: NotificationKind,
  ctx: RenderContext
): RenderedNotification {
  const templateName = KIND_TO_TEMPLATE[kind] ?? kind;
  const template = BODIES[kind];
  if (!template) {
    return {
      body: "",
      templateName,
      targetPhone: normalizePhoneDigits(ctx.customerPhone),
    };
  }

  const nameFirst = firstName(ctx.customerName);
  const targetPhone = normalizePhoneDigits(ctx.customerPhone);

  let vars: readonly string[] = [];

  switch (kind) {
    case "confirmacao":
      vars = [
        nameFirst,
        formatConsultaDateTime(ctx.scheduledAt),
        ctx.doctorDisplay,
        ctx.reagendamentoUrl,
      ];
      break;
    case "t_minus_24h":
      vars = [
        nameFirst,
        formatRelativeTomorrow(ctx.scheduledAt),
        ctx.doctorDisplay,
      ];
      break;
    case "t_minus_1h":
      vars = [nameFirst, formatRelativeToday(ctx.scheduledAt)];
      break;
    case "t_minus_15min": {
      const validaAte =
        ctx.salaValidaAte ??
        new Date(ctx.scheduledAt.getTime() + 30 * 60_000);
      vars = [nameFirst, ctx.consultaUrl, formatTime(validaAte)];
      break;
    }
    case "on_demand_call":
      vars = [nameFirst, ctx.doctorDisplay, ctx.consultaUrl];
      break;
    case "pos_consulta":
    case "t_plus_10min": {
      const receita = ctx.payload?.receita_url || ctx.consultaUrl;
      const conduta =
        ctx.payload?.conduta_resumo ||
        "Sua médica registrou a conduta. Qualquer dúvida, é só responder aqui.";
      vars = [nameFirst, receita, conduta];
      break;
    }
    case "reserva_expirada": {
      const planoNome = ctx.payload?.plano_nome || "seu plano";
      const invoice = ctx.payload?.invoice_url || `${ctx.baseUrl}/planos`;
      vars = [nameFirst, planoNome, invoice];
      break;
    }
    case "no_show_patient":
    case "no_show_doctor":
      vars = [nameFirst, ctx.doctorDisplay, ctx.reagendamentoUrl];
      break;
    default: {
      // Exaustividade estática: se um kind novo for adicionado ao union
      // em wa-templates.ts, TS reclama aqui.
      const _exhaustive: never = kind;
      void _exhaustive;
      vars = [];
    }
  }

  return {
    body: replaceVars(template, vars),
    templateName,
    targetPhone,
  };
}

// ─── Persistência ───────────────────────────────────────────────────────

export type RecordSnapshotResult =
  | { ok: true; updated: boolean; alreadySent: boolean }
  | { ok: false; error: "invalid_id" | "invalid_body" | "db_error" | "not_found" };

/**
 * Grava body/target_phone/rendered_at na linha de `appointment_notifications`.
 *
 * Idempotência:
 *   - UPDATE guardado por `sent_at IS NULL` — se já foi enviada, é no-op
 *     (não tenta re-gravar, o que dispararia a trigger `trg_an_body_
 *     immutable_after_send` com `raise exception`).
 *   - Retorno `alreadySent=true` informa que a linha já tinha sent_at
 *     no momento do UPDATE.
 *
 * Uso típico no worker (em `notifications.ts`):
 *
 *   const rendered = renderNotificationBody(kind, ctx);
 *   await recordBodySnapshot(supabase, { notificationId, ...rendered });
 *   const outcome = await dispatch(row);   // HTTP pra Meta
 *   // UPDATE final de status continua igual
 */
export async function recordBodySnapshot(
  supabase: SupabaseClient,
  input: {
    notificationId: string;
    body: string;
    targetPhone: string;
    now?: Date;
  }
): Promise<RecordSnapshotResult> {
  if (typeof input.notificationId !== "string" || input.notificationId.trim().length < 8) {
    return { ok: false, error: "invalid_id" };
  }

  if (typeof input.body !== "string" || input.body.trim().length === 0) {
    return { ok: false, error: "invalid_body" };
  }

  // target_phone pode ser string vazia (sem phone cadastrado) — gravamos
  // mesmo assim pra deixar evidência explícita de "ninguém pra entregar".
  // Truncamos pra 32 chars (sanidade; E.164 max é 15 dígitos).
  const targetPhone = (input.targetPhone || "").slice(0, 32);
  const body = input.body.slice(0, 8000); // sanidade: corpo WA máx teórico ~4096
  const renderedAt = (input.now ?? new Date()).toISOString();

  const upd = await supabase
    .from("appointment_notifications")
    .update({
      body,
      target_phone: targetPhone,
      rendered_at: renderedAt,
    })
    .eq("id", input.notificationId)
    .is("sent_at", null)
    .select("id")
    .maybeSingle();

  if (upd.error) {
    log.error("recordBodySnapshot · update failed", {
      notification_id: input.notificationId,
      err: upd.error,
    });
    return { ok: false, error: "db_error" };
  }

  if (upd.data) {
    return { ok: true, updated: true, alreadySent: false };
  }

  // Sem row atualizada: ou a linha não existe OU já estava sent.
  // Distinguir pra feedback melhor ao caller.
  const existing = await supabase
    .from("appointment_notifications")
    .select("id, sent_at")
    .eq("id", input.notificationId)
    .maybeSingle();

  if (existing.error) {
    log.error("recordBodySnapshot · re-read failed", {
      notification_id: input.notificationId,
      err: existing.error,
    });
    return { ok: false, error: "db_error" };
  }

  if (!existing.data) {
    return { ok: false, error: "not_found" };
  }

  const alreadySent = Boolean(
    (existing.data as { sent_at: string | null }).sent_at
  );
  return { ok: true, updated: false, alreadySent };
}
