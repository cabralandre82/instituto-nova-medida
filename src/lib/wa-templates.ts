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

// ─── 10/11. no_show_patient / no_show_doctor (pós D-032) ─────────────────
// Templates dedicados ainda não submetidos à Meta (o copy final depende
// de revisão jurídica — o paciente precisa entender que o horário foi
// perdido OU que haverá reembolso). Enquanto isso, marcamos como stub
// não-enviado: a lib retorna `templates_not_approved` e o worker mantém
// a linha em `pending`, re-tentando todo minuto. Quando o template real
// for aprovado, basta preencher a função aqui e subir o env flag.

export async function sendNoShowPatient(_opts: {
  to: string;
  pacienteNome: string;
  doctorDisplay: string;
  reagendamentoUrl: string;
}): Promise<WhatsAppSendResult> {
  // TODO(Sprint 5): submeter template `no_show_patient_aviso` na Meta.
  return {
    ok: false,
    code: null,
    message: "templates_not_approved",
    details: "Template no_show_patient aguardando aprovação Meta (Sprint 5).",
  };
}

export async function sendNoShowDoctor(_opts: {
  to: string;
  pacienteNome: string;
  doctorDisplay: string;
  reagendamentoUrl: string;
}): Promise<WhatsAppSendResult> {
  // TODO(Sprint 5): submeter template `no_show_doctor_desculpas` na Meta.
  return {
    ok: false,
    code: null,
    message: "templates_not_approved",
    details:
      "Template no_show_doctor aguardando aprovação Meta (Sprint 5). Admin precisa fazer outreach manual via WhatsApp.",
  };
}

// ─── 12. medica_consulta_paga (PR-077 · D-089) ───────────────────────────
// Disparada quando o paciente paga consulta/plano e o webhook do Asaas
// confirma. A médica recebe aviso operacional de que tem revenue +
// agenda confirmada. Fica em dry-run até o template ser aprovado pela
// Meta.

export async function sendMedicaConsultaPaga(_opts: {
  to: string;
  doctorNome: string;
  pacienteFirstName: string;
  consultaDateTime: Date;
  valorReais: string;
  painelUrl: string;
}): Promise<WhatsAppSendResult> {
  // TODO(PR-077-B): submeter template `medica_consulta_paga` na Meta.
  return {
    ok: false,
    code: null,
    message: "templates_not_approved",
    details:
      "Template medica_consulta_paga aguardando aprovação Meta (PR-077-B).",
  };
}

// ─── 13. medica_link_sala (PR-077 · D-089) ───────────────────────────────
// 15 min antes da consulta agendada, manda link da sala pra médica.
// Equivalente operacional do `link_sala_consulta` do paciente.

export async function sendMedicaLinkSala(_opts: {
  to: string;
  doctorNome: string;
  pacienteFirstName: string;
  consultaUrl: string;
  salaValidaAte: Date;
}): Promise<WhatsAppSendResult> {
  // TODO(PR-077-B): submeter template `medica_link_sala` na Meta.
  return {
    ok: false,
    code: null,
    message: "templates_not_approved",
    details: "Template medica_link_sala aguardando aprovação Meta (PR-077-B).",
  };
}

// ─── 14. medica_resumo_amanha (PR-077 · D-089) ───────────────────────────
// Resumo diário (~20h Brasília) da agenda do dia seguinte.

export async function sendMedicaResumoAmanha(_opts: {
  to: string;
  doctorNome: string;
  totalConsultas: number;
  primeiroHorario: string; // "08h00"
  ultimoHorario: string;   // "16h00"
  painelUrl: string;
}): Promise<WhatsAppSendResult> {
  // TODO(PR-077-B): submeter template `medica_resumo_amanha` na Meta.
  return {
    ok: false,
    code: null,
    message: "templates_not_approved",
    details:
      "Template medica_resumo_amanha aguardando aprovação Meta (PR-077-B).",
  };
}

// ─── 15. medica_plantao_iniciando (PR-077 · D-089) ───────────────────────
// 15 min antes do início de bloco recorrente `on_call`. Avisa pra médica
// abrir o painel `/medico/plantao` (PR-080) ou `/medico/horarios`.

export async function sendMedicaPlantaoIniciando(_opts: {
  to: string;
  doctorNome: string;
  shiftStart: Date;
  shiftEnd: Date;
  painelUrl: string;
}): Promise<WhatsAppSendResult> {
  // TODO(PR-077-B): submeter template `medica_plantao_iniciando` na Meta.
  return {
    ok: false,
    code: null,
    message: "templates_not_approved",
    details:
      "Template medica_plantao_iniciando aguardando aprovação Meta (PR-077-B).",
  };
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
  | "t_plus_10min"
  | "no_show_patient"
  | "no_show_doctor";

export const KIND_TO_TEMPLATE: Record<NotificationKind, string> = {
  confirmacao: "confirmacao_agendamento",
  t_minus_24h: "lembrete_consulta_24h",
  t_minus_1h: "lembrete_consulta_1h",
  t_minus_15min: "link_sala_consulta",
  on_demand_call: "vez_chegou_on_demand",
  pos_consulta: "pos_consulta_resumo",
  t_plus_10min: "pos_consulta_resumo", // mesmo template, disparado 10min pós consulta quando sem prescrição
  reserva_expirada: "pagamento_pix_pendente", // reuso: PIX expirou / reserva expirou (template novo seria ideal)
  no_show_patient: "no_show_patient_aviso", // TODO Sprint 5: criar/aprovar na Meta
  no_show_doctor: "no_show_doctor_desculpas", // TODO Sprint 5: criar/aprovar na Meta
};

// ─── Doctor-side notification kinds (PR-077 · D-089) ─────────────────────
// Vivem em `doctor_notifications` (tabela separada), com worker próprio
// em `src/lib/doctor-notifications.ts`. Manter o registry aqui pra
// centralizar mapeamento kind → template_name num lugar só.

export type DoctorNotificationKind =
  | "doctor_paid"
  | "doctor_t_minus_15min"
  | "doctor_daily_summary"
  | "doctor_on_call_t_minus_15min";

export const DOCTOR_KIND_TO_TEMPLATE: Record<DoctorNotificationKind, string> = {
  doctor_paid: "medica_consulta_paga",
  doctor_t_minus_15min: "medica_link_sala",
  doctor_daily_summary: "medica_resumo_amanha",
  doctor_on_call_t_minus_15min: "medica_plantao_iniciando",
};
