/**
 * Worker HTTP da fila `appointment_notifications`.
 *
 * Agendado via Vercel Cron (vercel.json) a cada 1 minuto. Chama
 * `processDuePending(limit)` do lib `notifications.ts`, que:
 *
 *   - Carrega notifs com `status='pending'` e `scheduled_for <= now()`.
 *   - Dispara cada uma via helper tipado em `wa-templates.ts`.
 *   - Atualiza `status` para `sent` (sucesso), `failed` (erro permanente)
 *     ou mantém `pending` com erro loggado (erro transitório, ex:
 *     `WHATSAPP_TEMPLATES_APPROVED` ainda não true).
 *
 * Autenticação idêntica à do cron de expiração (CRON_SECRET). Ver
 * docs/DECISIONS.md D-030 e D-031.
 *
 * Limites:
 *   - Até 20 notifs por execução — cabem folgadamente no maxDuration=30s.
 *   - Em caso de backlog, rodar manualmente com `?limit=100`:
 *     `curl -H "x-cron-secret: $CRON_SECRET" \
 *      https://.../api/internal/cron/wa-reminders?limit=100`
 */

import { NextResponse, type NextRequest } from "next/server";
import { processDuePending } from "@/lib/notifications";
import { assertCronRequest } from "@/lib/cron-auth";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/internal/cron/wa-reminders" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

function parseLimit(req: NextRequest): number {
  const raw = req.nextUrl.searchParams.get("limit");
  if (!raw) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

export async function GET(req: NextRequest) {
  const unauth = assertCronRequest(req);
  if (unauth) return unauth;

  const limit = parseLimit(req);
  const report = await processDuePending(limit);

  if (report.sent > 0 || report.failed > 0) {
    log.info("run finished", {
      processed: report.processed,
      sent: report.sent,
      failed: report.failed,
      retried: report.retried,
    });
  }

  return NextResponse.json({
    ok: true,
    ...report,
    ran_at: new Date().toISOString(),
  });
}

export async function POST(req: NextRequest) {
  return GET(req);
}
