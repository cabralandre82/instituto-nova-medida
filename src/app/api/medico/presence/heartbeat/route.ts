/**
 * POST /api/medico/presence/heartbeat
 *
 * PR-075-B · D-087. A UI da médica em /medico/plantao chama este
 * endpoint a cada PRESENCE_HEARTBEAT_INTERVAL_SECONDS (30s) enquanto
 * o toggle "estou de plantão" estiver ativo. Refresca
 * `last_heartbeat_at` na tabela `doctor_presence`. NÃO altera
 * status — quem altera status é POST /api/medico/presence/status.
 *
 * Auth: requireDoctor (cookie Supabase). Heartbeats só do dono da
 * sessão; doctor_id vem da resolução server-side, não do body.
 *
 * Body opcional:
 *   { client_meta?: { ua?: string, app_version?: string } }
 *
 * Retorna a row atualizada pra UI mostrar "ping ok" e refletir
 * casos de drift (médica foi forçada offline pelo cron mas a aba
 * dela ainda mandou heartbeat — UI vê status='offline' no response
 * e pede toggle de novo).
 */

import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { requireDoctor } from "@/lib/auth";
import { recordHeartbeat } from "@/lib/doctor-presence";
import { extractClientIp } from "@/lib/checkout-consent";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/medico/presence/heartbeat" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  client_meta?: {
    ua?: string;
    app_version?: string;
  };
};

function hashIp(ip: string | null): string | null {
  if (!ip) return null;
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

export async function POST(req: Request) {
  const { doctorId } = await requireDoctor();

  let body: Body = {};
  try {
    const raw = (await req.json()) as Body;
    if (raw && typeof raw === "object") body = raw;
  } catch {
    // body é opcional — heartbeat sem corpo é válido.
  }

  const ua = req.headers.get("user-agent");
  const ip = extractClientIp(req);

  const result = await recordHeartbeat(doctorId, {
    ua: ua ?? body.client_meta?.ua ?? null,
    app_version: body.client_meta?.app_version ?? null,
    ip_hash: hashIp(ip),
  });

  if (!result.ok) {
    log.error("heartbeat_failed", { doctor_id: doctorId, error: result.error });
    return NextResponse.json(
      { ok: false, error: "internal" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    presence: {
      status: result.row.status,
      last_heartbeat_at: result.row.last_heartbeat_at,
      online_since: result.row.online_since,
      source: result.row.source,
    },
  });
}
