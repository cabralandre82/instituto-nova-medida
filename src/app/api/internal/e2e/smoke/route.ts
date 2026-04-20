/**
 * GET /api/internal/e2e/smoke — Smoke test sintético (D-039).
 *
 * Endpoint read-only que roda `runHealthCheck` e devolve JSON. Foi
 * pensado pra três consumidores:
 *
 *   1. Cron externo de monitoria (UptimeRobot, Better Uptime, etc):
 *      configura um HTTP monitor com header `x-cron-secret: <CRON_SECRET>`
 *      batendo a cada 5 min. Se `overall` != "ok", dispara alerta.
 *
 *   2. Humano durante runbook de prova de fogo (docs/RUNBOOK-E2E.md):
 *      `curl -H "x-cron-secret: ..." https://.../api/internal/e2e/smoke?ping=1`
 *      retorna o retrato completo incluindo ping real nas integrações
 *      externas (valida autenticação Asaas/Daily em produção).
 *
 *   3. CI/teste de deploy: bate no endpoint após deploy pra ver se tudo
 *      subiu ok antes de promover. Não fazemos isso hoje, mas o contrato
 *      já suporta.
 *
 * Protocolo:
 *   - Auth: `CRON_SECRET` via `Authorization: Bearer <secret>` OU header
 *     `x-cron-secret`. Sem secret configurado no env = aberto (dev/local).
 *     Mesmo padrão dos crons internos existentes.
 *   - Query params:
 *       `ping=1` → força `pingExternal: true` (faz HTTP real em
 *         Asaas/Daily; gasta quota; use com parcimônia).
 *       (ausente) → só checks internos + env vars (default, rápido).
 *   - HTTP status:
 *       200 quando `overall` é "ok" ou "warning" (ainda responde pra
 *         automação ler o JSON).
 *       503 quando `overall` é "error" (facilita UptimeRobot que só
 *         olha status code sem parsear body).
 *       401 quando secret inválido.
 *   - Body: `HealthReport` completo (ver `src/lib/system-health.ts`).
 *
 * Zero mutation. Zero side effect. 100% seguro pra rodar a cada minuto
 * ou sob demanda durante incidente.
 */

import { NextResponse, type NextRequest } from "next/server";
import { runHealthCheck } from "@/lib/system-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // dev / local
  const auth = req.headers.get("authorization") || "";
  if (auth === `Bearer ${secret}`) return true;
  if (req.headers.get("x-cron-secret") === secret) return true;
  return false;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 }
    );
  }

  const pingExternal = req.nextUrl.searchParams.get("ping") === "1";

  const report = await runHealthCheck({ pingExternal });

  // 503 só no estado "error" pra facilitar UptimeRobot.
  // "warning" ainda responde 200 porque não bloqueia operação.
  const httpStatus = report.overall === "error" ? 503 : 200;

  return NextResponse.json(
    {
      ok: report.overall !== "error",
      report,
    },
    {
      status: httpStatus,
      headers: { "Cache-Control": "no-store" },
    }
  );
}
