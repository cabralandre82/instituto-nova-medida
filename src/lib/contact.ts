/**
 * src/lib/contact.ts — PR-057 · D-068 · finding 1.5
 *
 * Fonte única de verdade do canal público de contato (WhatsApp,
 * e-mail). Antes deste módulo, o número aparecia hardcoded em
 * `/paciente/renovar/page.tsx` ("5521998851851"). A auditoria
 * sinalizou risco de o operador trocar de chip e esquecer um
 * lugar — paciente continuaria ligando no número velho.
 *
 * Política de configuração:
 *
 *   - Lê de `NEXT_PUBLIC_WA_SUPPORT_NUMBER` em build-time (precisa ser
 *     `NEXT_PUBLIC_*` pra ser inlined no bundle do client; o número de
 *     suporte é dado público — não é segredo).
 *   - Fallback `5521998851851` (mesmo número que estava hardcoded) pra
 *     não quebrar dev/preview enquanto a env não estiver definida.
 *   - Aceita formatos com máscara (`(21) 99885-1851`, `+55 21 ...`),
 *     normaliza pra dígitos puros antes de montar URLs.
 *   - LGPD `dpoEmail` sai do mesmo lugar pra evitar drift.
 *
 * Helpers:
 *
 *   - `getSupportWhatsappNumber()` — número normalizado (dígitos).
 *   - `getSupportWhatsappE164()` — formato `+55…` (legível em UI).
 *   - `whatsappSupportUrl(message?)` — URL `https://wa.me/<num>?text=…`
 *     (encoda o texto se vier).
 *   - `telSupportUrl()` — URL `tel:+55…` pra `<a>` em mobile.
 *   - `getDpoEmail()` — e-mail do DPO/LGPD.
 */

// Fallback é o número que estava hardcoded em /paciente/renovar.
// Quando o operador definir env permanente, dropa este fallback.
const DEFAULT_WHATSAPP_NUMBER = "5521998851851";
const DEFAULT_DPO_EMAIL = "lgpd@institutonovamedida.com.br";

/**
 * Remove qualquer não-dígito. Se o input for inválido (vazio,
 * < 10 dígitos depois de limpo, > 13 dígitos), devolve o fallback —
 * preferimos um número funcional ao silêncio absoluto.
 */
function sanitizeNumber(raw: string | undefined): string {
  if (!raw) return DEFAULT_WHATSAPP_NUMBER;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 13) {
    return DEFAULT_WHATSAPP_NUMBER;
  }
  // Garante DDI 55 (Brasil). Se vier sem (ex.: "21998851851"),
  // prefixa. Se já tiver (`5521…`), preserva.
  return digits.startsWith("55") ? digits : `55${digits}`;
}

export function getSupportWhatsappNumber(): string {
  return sanitizeNumber(process.env.NEXT_PUBLIC_WA_SUPPORT_NUMBER);
}

/** Formato `+55 (DD) 9XXXX-XXXX` pra exibição em UI/footer. */
export function getSupportWhatsappE164(): string {
  const n = getSupportWhatsappNumber();
  // n = "55DDXXXXXXXXX" (12 ou 13 chars). Quebra em pedaços.
  if (n.length === 13) {
    return `+${n.slice(0, 2)} (${n.slice(2, 4)}) ${n.slice(4, 9)}-${n.slice(9)}`;
  }
  if (n.length === 12) {
    return `+${n.slice(0, 2)} (${n.slice(2, 4)}) ${n.slice(4, 8)}-${n.slice(8)}`;
  }
  return `+${n}`;
}

/**
 * Monta URL `https://wa.me/<num>?text=…`. Se `message` vier, é
 * URL-encodado. Sem `message` retorna sem query string.
 */
export function whatsappSupportUrl(message?: string): string {
  const num = getSupportWhatsappNumber();
  if (!message) return `https://wa.me/${num}`;
  return `https://wa.me/${num}?text=${encodeURIComponent(message)}`;
}

/** Para `<a href="tel:+55…">` em mobile. */
export function telSupportUrl(): string {
  return `tel:+${getSupportWhatsappNumber()}`;
}

export function getDpoEmail(): string {
  const fromEnv = process.env.NEXT_PUBLIC_DPO_EMAIL?.trim();
  if (fromEnv && fromEnv.includes("@")) return fromEnv.toLowerCase();
  return DEFAULT_DPO_EMAIL;
}
