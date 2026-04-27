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
import { processDuePendingDoctor } from "@/lib/doctor-notifications";
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

  // PR-077 · D-089 — processa AS DUAS filas no mesmo cron pra economizar
  // schedule e maxDuration. As filas são independentes (tabelas
  // diferentes); falha em uma não bloqueia a outra.
  const [patientReport, doctorReport] = await Promise.all([
    processDuePending(limit).catch((err) => {
      log.error("patient queue threw", { err });
      return { processed: 0, sent: 0, failed: 0, retried: 0, details: [] };
    }),
    processDuePendingDoctor(limit).catch((err) => {
      log.error("doctor queue threw", { err });
      return { processed: 0, sent: 0, failed: 0, retried: 0, details: [] };
    }),
  ]);

  const totalActivity =
    patientReport.sent +
    patientReport.failed +
    doctorReport.sent +
    doctorReport.failed;

  if (totalActivity > 0) {
    log.info("run finished", {
      patient: {
        processed: patientReport.processed,
        sent: patientReport.sent,
        failed: patientReport.failed,
        retried: patientReport.retried,
      },
      doctor: {
        processed: doctorReport.processed,
        sent: doctorReport.sent,
        failed: doctorReport.failed,
        retried: doctorReport.retried,
      },
    });
  }

  return NextResponse.json({
    ok: true,
    patient: patientReport,
    doctor: doctorReport,
    ran_at: new Date().toISOString(),
  });
}

export async function POST(req: NextRequest) {
  return GET(req);
}
