/**
 * src/lib/lead-cookie.ts — PR-075-A · D-086
 *
 * Cookie httpOnly que carrega o `lead_id` entre `/api/lead` (captura) e
 * `/agendar` (consulta gratuita) sem depender de localStorage.
 *
 * Por que httpOnly?
 *   - localStorage é client-side, falsificável por extensão maliciosa
 *     ou XSS. O server lendo `inm_lead_id` direto do cookie
 *     httpOnly elimina essa superfície.
 *   - SameSite=Lax: cookie acompanha navegação top-level (suficiente
 *     pro fluxo home → /agendar) mas não vai em iframe terceiro.
 *
 * Por que o lib é puro?
 *   - Server components e route handlers usam APIs ligeiramente
 *     diferentes (cookies() no App Router; req.headers.cookie no
 *     handler de webhook). Essa lib só formata strings, não fala
 *     com Next. Cada caller decide como entregar.
 *
 * O cookie NÃO contém PII — apenas um UUID interno do `leads.id`. Mesmo
 * vazado, sozinho não permite ações sensíveis (todas as rotas
 * downstream re-validam o lead no DB).
 */

export const LEAD_COOKIE_NAME = "inm_lead_id";

/**
 * 30 dias. Cobre o gap natural entre quiz e agendamento (que
 * normalmente acontece em minutos, mas pode estender alguns dias se
 * o paciente fechar a aba). Após 30 dias o cookie expira e o paciente
 * é redirecionado pra refazer o quiz.
 */
export const LEAD_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 3600;

/**
 * Retorna o cookie já formatado pra `Set-Cookie`.
 *
 * `secure` é forçado fora de development pra evitar que o cookie vaze
 * em testes locais via http (Next dev server). Em produção,
 * institutonovamedida.com.br é HTTPS-only via HSTS.
 */
export function buildLeadCookieHeader(leadId: string): string {
  if (!isUuid(leadId)) {
    throw new Error("buildLeadCookieHeader: leadId não é UUID");
  }
  const isProd = process.env.NODE_ENV === "production";
  const parts = [
    `${LEAD_COOKIE_NAME}=${leadId}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${LEAD_COOKIE_MAX_AGE_SECONDS}`,
  ];
  if (isProd) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Cookie que apaga o anterior. Usado em logout do paciente ou após
 * agendamento concluído — uma vez agendada a consulta, o lead já
 * cumpriu o papel.
 */
export function buildLeadCookieClearHeader(): string {
  const isProd = process.env.NODE_ENV === "production";
  const parts = [
    `${LEAD_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (isProd) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Parser puro pra `Cookie:` header. Usado em route handlers que não
 * têm `cookies()` ergonômico (ex: webhooks).
 */
export function readLeadIdFromCookieHeader(
  cookieHeader: string | null | undefined,
): string | null {
  if (!cookieHeader) return null;
  for (const piece of cookieHeader.split(";")) {
    const eq = piece.indexOf("=");
    if (eq === -1) continue;
    const k = piece.slice(0, eq).trim();
    const v = piece.slice(eq + 1).trim();
    if (k === LEAD_COOKIE_NAME) {
      return isUuid(v) ? v : null;
    }
  }
  return null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(s: string): boolean {
  return typeof s === "string" && UUID_RE.test(s);
}
