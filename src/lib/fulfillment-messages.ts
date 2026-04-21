/**
 * src/lib/fulfillment-messages.ts — D-044 · onda 2.E / D-056 (PR-037)
 *
 * Composers puros das mensagens WhatsApp disparadas a cada transição
 * operacional do fulfillment. Separados da lib de transitions pra
 * manterem-se testáveis em isolamento e fáceis de iterar (o texto
 * tende a evoluir com feedback do paciente).
 *
 * Tom editorial (alinhado com `composePaidWhatsAppMessage` da 2.D):
 *   - 1ª pessoa plural "a gente" / "o Instituto"
 *   - primeiro nome do paciente
 *   - sem emoji, sem exagero
 *   - uma ação clara no final quando aplicável
 *
 * IMPORTANTE: nenhuma mensagem aqui expõe CPF, endereço ou dados
 * médicos detalhados. WhatsApp é canal público do ponto de vista
 * LGPD — mantemos conteúdo sensível fora.
 *
 * ---
 *
 * PR-037 (D-056): todo valor interpolado passa por
 * `display*`/`sanitize*` antes. Motivo:
 *   (a) linhas históricas em `customers.name` podem conter controles
 *       / zero-width / template chars herdados do pré-PR-037.
 *   (b) uma das vias futuras é enviar esse mesmo texto a um LLM de
 *       atendimento; `display*` garante que nenhum `\nIGNORE PREVIOUS`
 *       chegue ao prompt via `customerName`.
 *   (c) defesa em profundidade: mesmo com validação de escrita apertada
 *       (PR-036/037), uma regressão em um endpoint não deve tornar o
 *       template inseguro.
 */

import {
  displayCityState,
  displayFirstName,
  displayPlanName,
} from "./customer-display";
import { sanitizeFreeText } from "./text-sanitize";

/**
 * Sanitiza um texto operacional curto (ex.: `trackingNote`, `reason`)
 * antes de interpolar em mensagem WhatsApp. Não é free-text legítimo
 * multi-linha aqui — WhatsApp é um canal conciso — mas aceitamos o
 * output do `sanitizeFreeText` que já rodou no write path.
 *
 * Fallback é string vazia (o chamador decide se omite a linha).
 */
function safeOpNote(
  raw: string | null | undefined,
  opts: { maxLen: number; maxLines: number }
): string {
  const r = sanitizeFreeText(raw ?? "", {
    maxLen: opts.maxLen,
    maxLines: opts.maxLines,
    allowEmpty: true,
  });
  return r.ok ? r.value : "";
}

// ────────────────────────────────────────────────────────────────────────
// pharmacy_requested — clínica despachou a receita pra farmácia de manipulação
// ────────────────────────────────────────────────────────────────────────

export function composePharmacyRequestedMessage(params: {
  customerName: string;
  planName: string;
}): string {
  const name = displayFirstName(params.customerName);
  const plan = displayPlanName(params.planName);
  return [
    `Oi, ${name}. Atualização do Instituto Nova Medida.`,
    "",
    `Sua prescrição do ${plan} já foi enviada à farmácia de manipulação parceira.`,
    "",
    "A manipulação costuma levar de 3 a 5 dias úteis. Assim que o medicamento for despachado pro seu endereço, você recebe aqui o código de rastreio.",
  ].join("\n");
}

// ────────────────────────────────────────────────────────────────────────
// shipped — clínica despachou ao paciente
// ────────────────────────────────────────────────────────────────────────

export function composeShippedMessage(params: {
  customerName: string;
  planName: string;
  trackingNote: string;
}): string {
  const name = displayFirstName(params.customerName);
  const plan = displayPlanName(params.planName);
  // `tracking_note` já roda por `sanitizeFreeText` em
  // `fulfillment-transitions.ts` (PR-036-B); aqui é defesa em
  // profundidade pra linha histórica ou regressão.
  const tracking = safeOpNote(params.trackingNote, { maxLen: 500, maxLines: 10 });
  return [
    `Boa notícia, ${name}!`,
    "",
    `O ${plan} saiu pra entrega no seu endereço cadastrado.`,
    "",
    `Rastreio: ${tracking || "consulte sua área do Instituto"}`,
    "",
    "Assim que receber a caixa, confirme o recebimento na sua área do Instituto pra gente fechar o ciclo de acompanhamento.",
  ].join("\n");
}

// ────────────────────────────────────────────────────────────────────────
// delivered — entrega confirmada
// ────────────────────────────────────────────────────────────────────────

export function composeDeliveredMessage(params: {
  customerName: string;
  planName: string;
}): string {
  const name = displayFirstName(params.customerName);
  const plan = displayPlanName(params.planName);
  return [
    `${name}, tudo certo por aqui.`,
    "",
    `A entrega do ${plan} foi confirmada.`,
    "",
    "Siga a orientação médica pra aplicação e guarde o medicamento refrigerado conforme a bula. Qualquer dúvida, é só responder — a equipe tá aqui.",
    "",
    "Bom tratamento!",
  ].join("\n");
}

// ────────────────────────────────────────────────────────────────────────
// auto-delivered — cron fechou ciclo após SHIPPED_TO_DELIVERED_DAYS
// ────────────────────────────────────────────────────────────────────────

export function composeAutoDeliveredMessage(params: {
  customerName: string;
  planName: string;
}): string {
  const name = displayFirstName(params.customerName);
  const plan = displayPlanName(params.planName);
  return [
    `${name}, um aviso rápido.`,
    "",
    `Como já se passaram algumas semanas desde o envio do ${plan} e a gente não teve retorno, estamos considerando a entrega como concluída pra fechar o ciclo de acompanhamento.`,
    "",
    "Se por algum motivo a caixa não chegou ou chegou com problema, é só responder aqui que a equipe do Instituto resolve com você.",
    "",
    "Bom tratamento!",
  ].join("\n");
}

// ────────────────────────────────────────────────────────────────────────
// reconsulta nudge — ciclo do plano está terminando
// ────────────────────────────────────────────────────────────────────────

export function composeReconsultaNudgeMessage(params: {
  customerName: string;
  planName: string;
  daysRemaining: number;
}): string {
  const name = displayFirstName(params.customerName);
  const plan = displayPlanName(params.planName);
  const days = Math.max(0, Math.round(params.daysRemaining));
  const prazo =
    days === 0
      ? "nos próximos dias"
      : days === 1
      ? "em cerca de 1 dia"
      : `em cerca de ${days} dias`;
  return [
    `${name}, passando pra avisar.`,
    "",
    `O ciclo do ${plan} termina ${prazo}. Pra continuar o tratamento com segurança, é importante agendar uma reconsulta com a equipe médica — ela vai avaliar a evolução e ajustar a prescrição se necessário.`,
    "",
    "Você pode agendar direto pela sua área do Instituto. Qualquer dúvida, é só responder aqui.",
  ].join("\n");
}

// ────────────────────────────────────────────────────────────────────────
// patient-cancelled — paciente desistiu da oferta antes de pagar
// ────────────────────────────────────────────────────────────────────────

export function composePatientCancelledMessage(params: {
  customerName: string;
  planName: string;
  reason: string | null;
}): string {
  const name = displayFirstName(params.customerName);
  const plan = displayPlanName(params.planName);
  const reason = safeOpNote(params.reason, { maxLen: 2000, maxLines: 40 });
  const reasonLine = reason.length > 0 ? `Motivo informado: ${reason}` : null;
  return [
    `${name}, recebemos seu cancelamento.`,
    "",
    `A indicação do ${plan} foi encerrada a seu pedido. Nenhuma cobrança foi feita.`,
    ...(reasonLine ? ["", reasonLine] : []),
    "",
    "Se mudar de ideia, é só agendar uma nova consulta pra revisitarmos o plano juntos.",
  ].join("\n");
}

// ────────────────────────────────────────────────────────────────────────
// shipping-updated — paciente editou endereço após pagar
// ────────────────────────────────────────────────────────────────────────

export function composeShippingUpdatedMessage(params: {
  customerName: string;
  planName: string;
  cityState: string;
}): string {
  const name = displayFirstName(params.customerName);
  const plan = displayPlanName(params.planName);
  const where = displayCityState(params.cityState);
  return [
    `${name}, atualização registrada.`,
    "",
    `O endereço de entrega do ${plan} foi atualizado pra ${where}.`,
    "",
    "Se isso não foi você, responde aqui imediatamente — antes de despacharmos pra farmácia a gente consegue reverter.",
  ].join("\n");
}

// ────────────────────────────────────────────────────────────────────────
// cancelled — fulfillment cancelado (raro, mas precisa existir)
// ────────────────────────────────────────────────────────────────────────

export function composeCancelledMessage(params: {
  customerName: string;
  planName: string;
  reason: string;
}): string {
  const name = displayFirstName(params.customerName);
  const plan = displayPlanName(params.planName);
  const reason = safeOpNote(params.reason, { maxLen: 2000, maxLines: 40 });
  return [
    `${name}, precisamos te avisar.`,
    "",
    `O fornecimento do ${plan} foi cancelado.`,
    `Motivo: ${reason || "indisponível"}`,
    "",
    "Se o cancelamento envolver restituição financeira, a equipe do Instituto vai te contatar diretamente pra tratar os detalhes. Fica à vontade pra responder aqui com qualquer dúvida.",
  ].join("\n");
}
