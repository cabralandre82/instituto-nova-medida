/**
 * Helper central de autenticação para endpoints de cron / monitoria interna.
 *
 * Contrato (consolidado a partir do padrão espalhado em cada `route.ts`):
 *   - Em produção, exige `process.env.CRON_SECRET`. Se ausente, retorna
 *     `503 misconfigured` em runtime (fail-fast explícito). Nunca faz
 *     "fallback silencioso para aberto" em prod.
 *   - Em dev (`NODE_ENV !== "production"`) sem secret configurada, permite
 *     a chamada (com `console.warn` uma única vez por processo, pra não
 *     poluir terminal mas deixar o operador ciente).
 *   - Aceita tanto `Authorization: Bearer <secret>` (padrão Vercel Cron)
 *     quanto `x-cron-secret: <secret>` (debug manual via curl).
 *   - Comparação da secret é timing-safe (resistente a side-channel).
 *
 * Motivação (auditoria 2026-04-20, finding [8.3] ALTO / D-046 wave):
 *   O padrão anterior `if (!secret) return true` fazia com que, se o admin
 *   esquecesse `CRON_SECRET` em um preview environment da Vercel, todas as
 *   rotas `/api/internal/cron/*` virassem públicas — expondo jobs de
 *   payout, refund, auto-deliver e digest a qualquer visitante que
 *   conhecesse a URL. Em produção esse modo é inaceitável.
 *
 * Uso canônico (copiar em qualquer `route.ts` novo):
 *
 *   import { assertCronRequest } from "@/lib/cron-auth";
 *
 *   export async function GET(req: NextRequest) {
 *     const unauth = assertCronRequest(req);
 *     if (unauth) return unauth;
 *     // ...lógica do cron...
 *   }
 */

import { NextResponse, type NextRequest } from "next/server";
import { logger } from "./logger";

const log = logger.with({ mod: "cron-auth" });

function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}

let warnedMissingInDev = false;

/**
 * Exposto só para testes — limpa o flag que suprime o warn dev em runs
 * subsequentes. Não use em código de produção.
 */
export function __resetCronAuthWarningForTests(): void {
  warnedMissingInDev = false;
}

/**
 * Valida a autenticação de um request de cron ou monitoria.
 *
 * @returns `null` se autorizado (segue com o cron). `NextResponse` pronto
 *   para retornar se a request deve ser rejeitada — o chamador apenas faz
 *   `return`.
 */
export function assertCronRequest(req: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    if (isProd()) {
      // Fail-fast: produção sem CRON_SECRET = misconfiguração crítica.
      // Vercel Cron vai ver 503 e marcar o job como falhou, o que dispara
      // alertas. Prefere-se isso a abrir silenciosamente os endpoints.
      log.error("CRON_SECRET missing in production — refusing request", {
        path: req.nextUrl?.pathname,
      });
      return NextResponse.json(
        {
          ok: false,
          error: "misconfigured",
          hint: "CRON_SECRET env var is required in production",
        },
        { status: 503 }
      );
    }

    if (!warnedMissingInDev && process.env.NODE_ENV !== "test") {
      log.warn(
        "CRON_SECRET not set — allowing unauthenticated cron calls (dev only)"
      );
      warnedMissingInDev = true;
    }
    return null;
  }

  const auth = req.headers.get("authorization") || "";
  const header = req.headers.get("x-cron-secret") || "";

  if (safeEqual(auth, `Bearer ${secret}`)) return null;
  if (safeEqual(header, secret)) return null;

  return NextResponse.json(
    { ok: false, error: "unauthorized" },
    { status: 401 }
  );
}

/**
 * Comparação de strings resistente a timing attacks.
 *
 * Igual a `crypto.timingSafeEqual`, mas aceitando strings de tamanhos
 * diferentes sem throwar (retorna `false` nesse caso). Usado porque
 * headers HTTP arbitrários podem ter qualquer tamanho.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
