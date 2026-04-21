/**
 * Feature flag para as rotas de compra legadas.
 *
 * Rotas afetadas:
 *   - `/agendar/[plano]` — antigo fluxo de agendamento direto de
 *     consulta paga (sem triagem prévia).
 *   - `/checkout/[plano]` — antigo fluxo de compra direta de plano.
 *
 * Contexto (D-044 / audit [1.1]):
 *   A partir do pacto "consulta gratuita primeiro", o fluxo canônico é:
 *
 *     home → quiz/lead → agenda consulta gratuita → médica avalia →
 *     prescreve plano → paciente aceita em /paciente/oferta/[id] → paga
 *
 *   As rotas legadas ainda existiam porque (a) links antigos podiam
 *   estar circulando e (b) o operador poderia precisar enviar um link
 *   manual em caso excepcional. Mas estavam **publicamente acessíveis**,
 *   deixando qualquer um comprar medicação sem passar por médica. Isso
 *   viola CFM 2.314/2022 Art. 7º + Nota Anvisa 200/2025 (prescrição sem
 *   exame) + o próprio pacto com o paciente.
 *
 * Comportamento:
 *   - Produção: default `false` — rota bloqueada, redireciona pro home
 *     com `?aviso=consulta_primeiro`.
 *   - Dev/test: default `true` — facilita desenvolvimento local sem
 *     precisar setar env var.
 *   - Admin pode ativar explicitamente em produção setando
 *     `LEGACY_PURCHASE_ENABLED=true` no Vercel se, por motivo
 *     excepcional, precisar enviar um link manual. **Não é
 *     recomendado** — preferível sempre rotear pelo fluxo canônico.
 *
 * Follow-up possível (fora do escopo PR-020):
 *   - Em vez de flag global, exigir `?token=<hmac>` assinado por admin
 *     pra casos pontuais, para que a permissão seja por-link em vez de
 *     global.
 *   - Remover as rotas de vez após 90 dias sem uso comprovado.
 */

export function isLegacyPurchaseEnabled(): boolean {
  const value = process.env.LEGACY_PURCHASE_ENABLED;
  if (value === "true") return true;
  if (value === "false") return false;
  return process.env.NODE_ENV !== "production";
}
