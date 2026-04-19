/**
 * Cliente WhatsApp Cloud API (Meta) — Instituto Nova Medida.
 *
 * Server-only. Não importar em client components.
 *
 * Conceitos importantes:
 *
 * - Mensagem TEMPLATE (`sendTemplate`): pode ser enviada a qualquer momento,
 *   mas o template precisa estar APROVADO pela Meta. Usado para a primeira
 *   mensagem (quando ainda não há janela de 24h aberta) e para reengajamentos
 *   fora dessa janela. Templates são submetidos no painel WhatsApp Manager.
 *
 * - Mensagem TEXTO LIVRE (`sendText`): só pode ser enviada se houver uma
 *   "conversa de serviço" aberta — ou seja, o paciente respondeu algo nos
 *   últimos 24h. Não precisa de aprovação prévia, é livre.
 *
 * - Estamos usando o TEST NUMBER da Meta (Phone Number ID 1093315577192606).
 *   Limitação: só envia para até 5 destinatários verificados manualmente
 *   no painel. Suficiente para todo o desenvolvimento.
 */

const GRAPH_API_VERSION = "v21.0";

type WhatsAppEnv = {
  phoneNumberId: string;
  accessToken: string;
};

function loadEnv(): WhatsAppEnv {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    throw new Error(
      "[whatsapp] WHATSAPP_PHONE_NUMBER_ID e WHATSAPP_ACCESS_TOKEN são obrigatórios."
    );
  }

  return { phoneNumberId, accessToken };
}

/**
 * Normaliza número brasileiro para o formato esperado pela Meta:
 * "5521997322906" (E.164 sem o "+", apenas dígitos).
 *
 * Aceita entradas como:
 *   "(21) 99732-2906"
 *   "21997322906"
 *   "5521997322906"
 *   "+55 21 99732-2906"
 */
export function normalizeBrPhone(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (digits.startsWith("55") && digits.length >= 12) return digits;
  if (digits.length === 11 || digits.length === 10) return `55${digits}`;
  return digits;
}

type WhatsAppApiResponse = {
  messaging_product?: string;
  contacts?: Array<{ input: string; wa_id: string }>;
  messages?: Array<{ id: string; message_status?: string }>;
  error?: {
    message: string;
    type: string;
    code: number;
    error_data?: { details?: string };
    fbtrace_id?: string;
  };
};

export type WhatsAppSendResult =
  | { ok: true; messageId: string; waId: string }
  | { ok: false; code: number | null; message: string; details?: string };

async function postToGraph(payload: unknown): Promise<WhatsAppSendResult> {
  const { phoneNumberId, accessToken } = loadEnv();
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
  } catch (err) {
    return {
      ok: false,
      code: null,
      message:
        err instanceof Error ? err.message : "Falha de rede ao chamar Meta API",
    };
  }

  let data: WhatsAppApiResponse;
  try {
    data = (await res.json()) as WhatsAppApiResponse;
  } catch {
    return {
      ok: false,
      code: res.status,
      message: `Resposta da Meta não é JSON (HTTP ${res.status})`,
    };
  }

  if (!res.ok || data.error) {
    return {
      ok: false,
      code: data.error?.code ?? res.status,
      message: data.error?.message ?? `HTTP ${res.status}`,
      details: data.error?.error_data?.details,
    };
  }

  const messageId = data.messages?.[0]?.id;
  const waId = data.contacts?.[0]?.wa_id;
  if (!messageId || !waId) {
    return {
      ok: false,
      code: null,
      message: "Resposta inesperada da Meta (sem message id)",
    };
  }

  return { ok: true, messageId, waId };
}

/**
 * Envia mensagem usando um template aprovado na Meta.
 *
 * @param to        Telefone do destinatário (qualquer formato BR — será normalizado)
 * @param template  Nome do template aprovado, ex: "hello_world"
 * @param language  Idioma do template, ex: "en_US", "pt_BR"
 * @param variables Valores para placeholders {{1}}, {{2}}, ... do corpo
 */
export async function sendTemplate(opts: {
  to: string;
  template: string;
  language?: string;
  variables?: string[];
}): Promise<WhatsAppSendResult> {
  const language = opts.language ?? "pt_BR";
  const components =
    opts.variables && opts.variables.length > 0
      ? [
          {
            type: "body",
            parameters: opts.variables.map((v) => ({ type: "text", text: v })),
          },
        ]
      : undefined;

  return postToGraph({
    messaging_product: "whatsapp",
    to: normalizeBrPhone(opts.to),
    type: "template",
    template: {
      name: opts.template,
      language: { code: language },
      ...(components ? { components } : {}),
    },
  });
}

/**
 * Envia mensagem de texto livre. Só funciona se houver janela de 24h
 * aberta com o destinatário (ele respondeu alguma coisa nas últimas 24h).
 * Caso contrário, a Meta retorna erro 131047.
 */
export async function sendText(opts: {
  to: string;
  text: string;
  previewUrl?: boolean;
}): Promise<WhatsAppSendResult> {
  return postToGraph({
    messaging_product: "whatsapp",
    to: normalizeBrPhone(opts.to),
    type: "text",
    text: {
      preview_url: opts.previewUrl ?? false,
      body: opts.text,
    },
  });
}

/**
 * MSG 1 do fluxo — primeira mensagem disparada quando o lead cai na tabela.
 *
 * REGRA da Meta: a primeira mensagem para um número (sem janela de 24h
 * aberta) PRECISA ser um template aprovado. Texto livre só após o cliente
 * responder algo, abrindo a janela.
 *
 * Estratégia:
 * - HOJE (dev): usamos `hello_world` (template padrão da Meta, sempre
 *   aprovado em todas as contas). Mensagem genérica em inglês — só pra
 *   confirmar que o pipeline funciona.
 * - PRÓXIMO PASSO: submeter o template `boas_vindas_inicial` em pt_BR
 *   no WhatsApp Manager (a copy está em docs/COPY.md). Aprovação leva
 *   1-24h. Quando aprovar, basta trocar o template name aqui embaixo.
 *
 * Após o cliente responder qualquer coisa, abre janela de 24h e podemos
 * usar `sendText()` à vontade nas mensagens seguintes do fluxo.
 */
export async function sendBoasVindas(opts: {
  to: string;
  firstName: string;
}): Promise<WhatsAppSendResult> {
  // TODO: trocar para "boas_vindas_inicial" + variables: [firstName]
  // assim que o template for aprovado pela Meta.
  void opts.firstName;

  return sendTemplate({
    to: opts.to,
    template: "hello_world",
    language: "en_US",
  });
}
