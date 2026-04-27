/**
 * POST /api/medico/presence/status
 *
 * PR-075-B · D-087. Mudança explícita de status pela UI da médica.
 * Toggle "estou de plantão / saí de plantão" e transição
 * online↔busy quando entra/sai de consulta.
 *
 * Body:
 *   { status: 'online' | 'busy' | 'offline' }
 *
 * Auth: requireDoctor (cookie). doctor_id vem da sessão.
 *
 * O endpoint sempre marca `source='manual'`. Source 'auto_offline' é
 * exclusivo do cron stale-presence.
 */

import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { requireDoctor } from "@/lib/auth";
import {
  setPresenceStatus,
  type PresenceStatus,
} from "@/lib/doctor-presence";
import { extractClientIp } from "@/lib/checkout-consent";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/medico/presence/status" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  status?: string;
  client_meta?: { app_version?: string };
};

const VALID: ReadonlyArray<PresenceStatus> = ["online", "busy", "offline"];

function hashIp(ip: string | null): string | null {
  if (!ip) return null;
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

export async function POST(req: Request) {
  const { doctorId } = await requireDoctor();

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "JSON inválido" },
      { status: 400 }
    );
  }

  const status = (body.status ?? "").trim();
  if (!VALID.includes(status as PresenceStatus)) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_status",
        message: "status deve ser online, busy ou offline",
      },
      { status: 400 }
    );
  }

  const ua = req.headers.get("user-agent");
  const ip = extractClientIp(req);

  const result = await setPresenceStatus(doctorId, status as PresenceStatus, {
    source: "manual",
    clientMeta: {
      ua: ua ?? null,
      app_version: body.client_meta?.app_version ?? null,
      ip_hash: hashIp(ip),
    },
  });

  if (!result.ok) {
    log.error("status_change_failed", {
      doctor_id: doctorId,
      target_status: status,
      error: result.error,
    });
    return NextResponse.json(
      { ok: false, error: "internal" },
      { status: 500 }
    );
  }

  log.info("status_changed", {
    doctor_id: doctorId,
    new_status: result.row.status,
    online_since: result.row.online_since,
  });

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
