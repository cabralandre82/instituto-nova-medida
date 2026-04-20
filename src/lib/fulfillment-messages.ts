/**
 * src/lib/fulfillment-messages.ts — D-044 · onda 2.E
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
 */

function firstName(fullName: string): string {
  const clean = fullName.trim();
  if (!clean) return "paciente";
  return clean.split(/\s+/)[0] ?? "paciente";
}

// ────────────────────────────────────────────────────────────────────────
// pharmacy_requested — clínica despachou a receita pra farmácia de manipulação
// ────────────────────────────────────────────────────────────────────────

export function composePharmacyRequestedMessage(params: {
  customerName: string;
  planName: string;
}): string {
  const name = firstName(params.customerName);
  return [
    `Oi, ${name}. Atualização do Instituto Nova Medida.`,
    "",
    `Sua prescrição do ${params.planName} já foi enviada à farmácia de manipulação parceira.`,
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
  const name = firstName(params.customerName);
  const tracking = (params.trackingNote ?? "").trim();
  return [
    `Boa notícia, ${name}!`,
    "",
    `O ${params.planName} saiu pra entrega no seu endereço cadastrado.`,
    "",
    `Rastreio: ${tracking}`,
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
  const name = firstName(params.customerName);
  return [
    `${name}, tudo certo por aqui.`,
    "",
    `A entrega do ${params.planName} foi confirmada.`,
    "",
    "Siga a orientação médica pra aplicação e guarde o medicamento refrigerado conforme a bula. Qualquer dúvida, é só responder — a equipe tá aqui.",
    "",
    "Bom tratamento!",
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
  const name = firstName(params.customerName);
  const reason = (params.reason ?? "").trim();
  return [
    `${name}, precisamos te avisar.`,
    "",
    `O fornecimento do ${params.planName} foi cancelado.`,
    `Motivo: ${reason}`,
    "",
    "Se o cancelamento envolver restituição financeira, a equipe do Instituto vai te contatar diretamente pra tratar os detalhes. Fica à vontade pra responder aqui com qualquer dúvida.",
  ].join("\n");
}
