/**
 * Wrappers tipados para os 7 templates WhatsApp do Instituto.
 *
 * Cada helper corresponde 1:1 a um template documentado em
 * `docs/WHATSAPP_TEMPLATES.md` e delega ao `sendTemplate` da lib
 * base (`whatsapp.ts`). O objetivo desta camada é:
 *
 *   1. Tipar os parâmetros (não deixa trocar ordem das vars).
 *   2. Formatar data/hora no padrão pt_BR uniforme (America/Sao_Paulo).
 *   3. Centralizar os NOMES dos templates num só lugar — quando a Meta
 *      aprovar uma v2, a gente troca aqui.
 *   4. Respeitar a flag `WHATSAPP_TEMPLATES_APPROVED`: enquanto os
 *      templates estão em review na Meta, a função retorna um stub
 *      `ok=false, code=null` marcando `templates_not_approved` —
 *      o worker interpreta isso como "não enviou, mantém pending pra
 *      re-tentar quando o env var virar true", em vez de marcar como
 *      failed permanente.
 *
 * Env vars:
 *   - `WHATSAPP_TEMPLATES_APPROVED=true`  → envia via Meta.
 *   - `WHATSAPP_TEMPLATES_APPROVED=false` (default) → stub dry-run.
 *   - `WHATSAPP_TEMPLATE_VERSION=2`       → se precisarmos rotacionar
 *     pra v2 depois de uma rejeição (D-031 nos docs). Default: sem
 *     sufixo (templates originais).
 */

import { sendTemplate, type WhatsAppSendResult } from "@/lib/whatsapp";

const TZ = "America/Sao_Paulo";

function approved(): boolean {
  // Default "false" protege produção de spamar pacientes com templates
  // não aprovados (a Meta devolve erro 132001 e gasta quota).
  return process.env.WHATSAPP_TEMPLATES_APPROVED === "true";
}

function templateName(base: string): string {
  const v = process.env.WHATSAPP_TEMPLATE_VERSION;
  if (!v || v === "1") return base;
  return `${base}_v${v}`;
}

function dryRun(templateBase: string): WhatsAppSendResult {
  return {
    ok: false,
    code: null,
    message: "templates_not_approved",
    details: `Template ${templateBase} não disparado — env WHATSAPP_TEMPLATES_APPROVED!=true.`,
  };
}

// ─── Formatters ──────────────────────────────────────────────────────────

/** "Quinta-feira, 22 de Maio às 14h00" */
export function formatConsultaDateTime(d: Date): string {
  const dateFmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ,
    weekday: "long",
    day: "2-digit",
    month: "long",
  });
  const timeFmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
  });
  const datePart = dateFmt.format(d);
  const capitalized = datePart.charAt(0).toUpperCase() + datePart.slice(1);
  const timePart = timeFmt.format(d).replace(":", "h");
  return `${capitalized} às ${timePart}`;
}

/** "amanhã às 14h00" — usado no lembrete_24h para compactar */
export function formatRelativeTomorrow(d: Date): string {
  const timeFmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
  });
  return `amanhã às ${timeFmt.format(d).replace(":", "h")}`;
}

/** "hoje às 14h00" — usado no lembrete_1h */
export function formatRelativeToday(d: Date): string {
  const timeFmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
  });
  return `hoje às ${timeFmt.format(d).replace(":", "h")}`;
}

/** "14h00" */
export function formatTime(d: Date): string {
  const timeFmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
  });
  return timeFmt.format(d).replace(":", "h");
}

/** Primeiro nome (capitaliza primeira letra só) */
export function firstName(fullName: string): string {
  const first = fullName.trim().split(/\s+/)[0] ?? "";
  if (!first) return "";
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

// ─── 1. confirmacao_agendamento ──────────────────────────────────────────

export async function sendConfirmacaoAgendamento(opts: {
  to: string;
  pacienteNome: string;
  consultaDateTime: Date;
  doctorDisplay: string;
  reagendamentoUrl: string;
}): Promise<WhatsAppSendResult> {
  const base = "confirmacao_agendamento";
  if (!approved()) return dryRun(base);
  return sendTemplate({
    to: opts.to,
    template: templateName(base),
    variables: [
      firstName(opts.pacienteNome),
      formatConsultaDateTime(opts.consultaDateTime),
      opts.doctorDisplay,
      opts.reagendamentoUrl,
    ],
  });
}

// ─── 2. lembrete_consulta_24h ────────────────────────────────────────────

export async function sendLembrete24h(opts: {
  to: string;
  pacienteNome: string;
  consultaDateTime: Date;
  doctorDisplay: string;
}): Promise<WhatsAppSendResult> {
  const base = "lembrete_consulta_24h";
  if (!approved()) return dryRun(base);
  return sendTemplate({
    to: opts.to,
    template: templateName(base),
    variables: [
      firstName(opts.pacienteNome),
      formatRelativeTomorrow(opts.consultaDateTime),
      opts.doctorDisplay,
    ],
  });
}

// ─── 3. lembrete_consulta_1h ─────────────────────────────────────────────

export async function sendLembrete1h(opts: {
  to: string;
  pacienteNome: string;
  consultaDateTime: Date;
}): Promise<WhatsAppSendResult> {
  const base = "lembrete_consulta_1h";
  if (!approved()) return dryRun(base);
  return sendTemplate({
    to: opts.to,
    template: templateName(base),
    variables: [firstName(opts.pacienteNome), formatRelativeToday(opts.consultaDateTime)],
  });
}

// ─── 4. link_sala_consulta ───────────────────────────────────────────────

export async function sendLinkSala(opts: {
  to: string;
  pacienteNome: string;
  /** URL da página do paciente: `/consulta/[id]?t=<HMAC>`. Preferir sobre a URL crua do Daily. */
  consultaUrl: string;
  /** Horário de término da sala (normalmente `scheduled_at + duration`). */
  salaValidaAte: Date;
}): Promise<WhatsAppSendResult> {
  const base = "link_sala_consulta";
  if (!approved()) return dryRun(base);
  return sendTemplate({
    to: opts.to,
    template: templateName(base),
    variables: [
      firstName(opts.pacienteNome),
      opts.consultaUrl,
      formatTime(opts.salaValidaAte),
    ],
  });
}

// ─── 5. vez_chegou_on_demand ─────────────────────────────────────────────

export async function sendVezChegouOnDemand(opts: {
  to: string;
  pacienteNome: string;
  doctorDisplay: string;
  consultaUrl: string;
}): Promise<WhatsAppSendResult> {
  const base = "vez_chegou_on_demand";
  if (!approved()) return dryRun(base);
  return sendTemplate({
    to: opts.to,
    template: templateName(base),
    variables: [
      firstName(opts.pacienteNome),
      opts.doctorDisplay,
      opts.consultaUrl,
    ],
  });
}

// ─── 6. pos_consulta_resumo ──────────────────────────────────────────────

export async function sendPosConsultaResumo(opts: {
  to: string;
  pacienteNome: string;
  receitaUrl: string;
  condutaResumo: string;
}): Promise<WhatsAppSendResult> {
  const base = "pos_consulta_resumo";
  if (!approved()) return dryRun(base);
  return sendTemplate({
    to: opts.to,
    template: templateName(base),
    variables: [
      firstName(opts.pacienteNome),
      opts.receitaUrl,
      opts.condutaResumo,
    ],
  });
}

// ─── 7. pagamento_pix_pendente ───────────────────────────────────────────

export async function sendPagamentoPixPendente(opts: {
  to: string;
  pacienteNome: string;
  planoNome: string;
  invoiceUrl: string;
}): Promise<WhatsAppSendResult> {
  const base = "pagamento_pix_pendente";
  if (!approved()) return dryRun(base);
  return sendTemplate({
    to: opts.to,
    template: templateName(base),
    variables: [
      firstName(opts.pacienteNome),
      opts.planoNome,
      opts.invoiceUrl,
    ],
  });
}

// ─── 8. medica_repasse_pago (equipe interna) ─────────────────────────────

export async function sendMedicaRepassePago(opts: {
  to: string;
  doctorNome: string;
  periodoRef: string;
  valorReais: string;
  painelUrl: string;
}): Promise<WhatsAppSendResult> {
  const base = "medica_repasse_pago";
  if (!approved()) return dryRun(base);
  return sendTemplate({
    to: opts.to,
    template: templateName(base),
    variables: [
      opts.doctorNome,
      opts.periodoRef,
      opts.valorReais,
      opts.painelUrl,
    ],
  });
}

// ─── 9. medica_documento_pendente (equipe interna) ───────────────────────

export async function sendMedicaDocumentoPendente(opts: {
  to: string;
  doctorNome: string;
  periodoRef: string;
  valorReais: string;
}): Promise<WhatsAppSendResult> {
  const base = "medica_documento_pendente";
  if (!approved()) return dryRun(base);
  return sendTemplate({
    to: opts.to,
    template: templateName(base),
    variables: [opts.doctorNome, opts.periodoRef, opts.valorReais],
  });
}

// ─── Kind ↔ Template dispatcher ──────────────────────────────────────────
// Usado pelo worker em notifications.ts pra despachar uma linha
// de appointment_notifications pro helper correto.

export type NotificationKind =
  | "confirmacao"
  | "t_minus_24h"
  | "t_minus_1h"
  | "t_minus_15min"
  | "on_demand_call"
  | "pos_consulta"
  | "reserva_expirada"
  | "t_plus_10min";

export const KIND_TO_TEMPLATE: Record<NotificationKind, string> = {
  confirmacao: "confirmacao_agendamento",
  t_minus_24h: "lembrete_consulta_24h",
  t_minus_1h: "lembrete_consulta_1h",
  t_minus_15min: "link_sala_consulta",
  on_demand_call: "vez_chegou_on_demand",
  pos_consulta: "pos_consulta_resumo",
  t_plus_10min: "pos_consulta_resumo", // mesmo template, disparado 10min pós consulta quando sem prescrição
  reserva_expirada: "pagamento_pix_pendente", // reuso: PIX expirou / reserva expirou (template novo seria ideal)
};
