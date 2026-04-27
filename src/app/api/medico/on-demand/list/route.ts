/**
 * GET /api/medico/on-demand/list
 *
 * PR-080 · D-092. Lista de requests on-demand `pending` (todos —
 * fila aberta, qualquer médica online pode pegar). Polling endpoint
 * pra UI da médica em /medico/plantao.
 *
 * Auth: requireDoctor.
 *
 * Resposta: lista pequena (≤ 20) ordenada por created_at ASC (FIFO),
 * cada item com: id, customer_first_name (FE only), chief_complaint
 * (curto, ≤120 chars truncados), expires_at, secondsUntilExpiry,
 * dispatchedToMe (booleano — médica recebeu WA do fan-out).
 */

import { NextResponse } from "next/server";
import { requireDoctor } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  computeSecondsUntilExpiry,
  truncateChiefComplaintForWa,
} from "@/lib/on-demand";
import { firstName } from "@/lib/wa-templates";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/medico/on-demand/list" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LIMIT = 20;

export async function GET() {
  const { doctorId } = await requireDoctor();
  const supabase = getSupabaseAdmin();
  const now = new Date();

  const { data: requests, error } = await supabase
    .from("on_demand_requests")
    .select(
      "id, customer_id, status, expires_at, created_at, chief_complaint"
    )
    .eq("status", "pending")
    .gt("expires_at", now.toISOString())
    .order("created_at", { ascending: true })
    .limit(MAX_LIMIT);

  if (error) {
    log.error("list failed", { err: error });
    return NextResponse.json(
      { ok: false, error: "internal" },
      { status: 500 }
    );
  }

  const rows = (requests ?? []) as Array<{
    id: string;
    customer_id: string;
    status: string;
    expires_at: string;
    created_at: string;
    chief_complaint: string;
  }>;

  if (rows.length === 0) {
    return NextResponse.json({ ok: true, requests: [] });
  }

  // Hidrata customer firstName.
  const customerIds = Array.from(new Set(rows.map((r) => r.customer_id)));
  const { data: customers } = await supabase
    .from("customers")
    .select("id, name")
    .in("id", customerIds);
  const nameById = new Map<string, string>();
  for (const c of (customers ?? []) as Array<{ id: string; name: string | null }>) {
    nameById.set(c.id, c.name ?? "");
  }

  // Marca quais já foram dispatched pra esta médica (WA enviado).
  const requestIds = rows.map((r) => r.id);
  const { data: dispatches } = await supabase
    .from("on_demand_request_dispatches")
    .select("request_id, dispatch_status")
    .eq("doctor_id", doctorId)
    .in("request_id", requestIds);
  const dispatchedSet = new Set(
    ((dispatches ?? []) as Array<{ request_id: string; dispatch_status: string }>)
      .filter((d) => d.dispatch_status === "sent" || d.dispatch_status === "skipped")
      .map((d) => d.request_id)
  );

  const items = rows.map((r) => ({
    id: r.id,
    pacienteFirstName: firstName(nameById.get(r.customer_id) ?? "Paciente"),
    chiefComplaintShort: truncateChiefComplaintForWa(r.chief_complaint),
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    secondsUntilExpiry: computeSecondsUntilExpiry({
      expiresAt: r.expires_at,
      now,
    }),
    dispatchedToMe: dispatchedSet.has(r.id),
  }));

  return NextResponse.json({ ok: true, requests: items });
}
