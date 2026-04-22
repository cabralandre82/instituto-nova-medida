/**
 * src/lib/checkout-consent-terms.ts — PR-053 · D-064 · finding 5.6
 *
 * Textos legais exibidos na checkbox de aceite do `/api/checkout`
 * (fluxo legacy back-office pós-D-044). Versionados exatamente como
 * `acceptance-terms.ts` (D-044): toda nova versão cria uma entrada
 * nova; versões antigas NUNCA são removidas ou editadas.
 *
 * Este texto é CURTO (rotula um checkbox) — NÃO é o termo de
 * contratação completo (que cobre art. 49 CDC, posologia, riscos,
 * etc). Paciente que vem por `/api/checkout` paga o plano direto,
 * sem o fluxo `/paciente/oferta` — então este texto referencia os
 * documentos externos (`/termos`, `/privacidade`) + autorização
 * LGPD explícita pra dados sensíveis de saúde.
 *
 * Por que registrar o snapshot mesmo sendo curto:
 *   - LGPD Art. 8º §1º: "o consentimento deverá ser fornecido por
 *     escrito ou outro meio que demonstre a manifestação de vontade".
 *     Sem snapshot gravado, não há prova do QUÊ foi aceito.
 *   - Art. 8º §5º: "o consentimento deve ser específico para
 *     finalidades determinadas". O texto aqui especifica "finalidade
 *     da contratação deste plano" — tem que ficar na row.
 *
 * Canonicalização do hash:
 *   A decisão `computeCheckoutConsentHash()` (em `checkout-consent.ts`)
 *   concatena text_snapshot + text_version + customer_id + payment_id.
 *   Isso garante que o hash é único por aceite — mesma aceitação repetida
 *   com customer/payment diferentes geram hashes distintos.
 */

export const CHECKOUT_CONSENT_TEXT_VERSION = "v1-2026-05" as const;
export type CheckoutConsentTextVersion = typeof CHECKOUT_CONSENT_TEXT_VERSION;

/**
 * Versões já publicadas, em ordem cronológica. Nunca remover.
 */
export const KNOWN_CHECKOUT_CONSENT_VERSIONS: readonly string[] = [
  "v1-2026-05",
] as const;

export function isKnownCheckoutConsentVersion(
  v: string
): v is CheckoutConsentTextVersion {
  return KNOWN_CHECKOUT_CONSENT_VERSIONS.includes(v);
}

// ────────────────────────────────────────────────────────────────────────
// v1 — maio/2026
//
// Redigido em registro jurídico contido (é rótulo de checkbox).
// Cobre: referência a Termos de Uso + Política de Privacidade; base
// legal LGPD explícita para dado sensível de saúde (art. 11 II "a");
// finalidade delimitada ("contratação deste plano").
// ────────────────────────────────────────────────────────────────────────

const V1_TEXT =
  "Li e concordo com os Termos de Uso e a Política de Privacidade do " +
  "Instituto Nova Medida. Autorizo, nos termos do art. 11, II, \"a\", " +
  "da Lei nº 13.709/2018 (LGPD), o tratamento dos meus dados pessoais " +
  "e de saúde para a finalidade da contratação deste plano e sua " +
  "execução operacional, incluindo o compartilhamento estritamente " +
  "necessário com a farmácia de manipulação parceira e com " +
  "prestadores de serviço logístico contratados pelo Instituto.";

/**
 * Retorna o texto canônico de uma versão publicada. Lança em versão
 * desconhecida (protege a rota contra `?version=invent-me`).
 */
export function getCheckoutConsentText(version: string): string {
  switch (version) {
    case "v1-2026-05":
      return V1_TEXT;
    default:
      throw new Error(
        `getCheckoutConsentText: versão desconhecida "${version}".`
      );
  }
}
