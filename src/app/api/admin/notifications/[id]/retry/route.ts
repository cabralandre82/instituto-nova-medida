/**
 * POST /api/admin/notifications/[id]/retry
 *
 * Re-enfileira uma notificação `failed` OU uma `pending` travada (sem
 * progresso) pra o próximo tick do worker `wa-reminders`.
 *
 * Estratégia intencionalmente simples:
 *   - Seta `status='pending'`, `scheduled_for=now()`, limpa `error`.
 *   - NÃO dispara síncrono — deixa o cron existente (roda a cada 1 min)
 *     pegar. Evita duplicar código de dispatch e respeita rate-limit global.
 *
 * Pré-condições:
 *   - Notificação existe.
 *   - Status atual é `failed` ou `pending`. Linhas `sent`/`delivered`/
 *     `read` não são re-enfileiráveis — se precisar reenviar "de verdade",
 *     o admin cria outra via fluxo de enqueue específico.
 *
 * Idempotência: chamar 2x seguidas é inofensivo — a segunda vez só
 * atualiza timestamps sem alterar status (já está pending).
 */

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { requireAdmin } from "@/lib/auth";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/admin/notifications/[id]/retry" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type NotificationRow = {
  id: string;
  status: "pending" | "sent" | "delivered" | "read" | "failed";
  kind: string;
  appointment_id: string;
};

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  await requireAdmin();
  const { id } = await params;
  const supabase = getSupabaseAdmin();

  const { data: notif, error: loadErr } = await supabase
    .from("appointment_notifications")
    .select("id, status, kind, appointment_id")
    .eq("id", id)
    .maybeSingle();

  if (loadErr) {
    log.error("load", { err: loadErr, notification_id: id });
    return NextResponse.json(
      { ok: false, error: loadErr.message },
      { status: 500 }
    );
  }
  if (!notif) {
    return NextResponse.json(
      { ok: false, error: "Notificação não encontrada." },
      { status: 404 }
    );
  }

  const row = notif as NotificationRow;

  if (row.status !== "failed" && row.status !== "pending") {
    return NextResponse.json(
      {
        ok: false,
        error: `Status atual é "${row.status}" — só "failed" ou "pending" podem ser re-enfileirados.`,
      },
      { status: 409 }
    );
  }

  const { error: upErr } = await supabase
    .from("appointment_notifications")
    .update({
      status: "pending",
      scheduled_for: new Date().toISOString(),
      error: null,
      sent_at: null,
      delivered_at: null,
      read_at: null,
      message_id: null,
    })
    .eq("id", row.id);

  if (upErr) {
    log.error("update", { err: upErr, notification_id: id });
    return NextResponse.json(
      { ok: false, error: upErr.message },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    id: row.id,
    kind: row.kind,
    appointment_id: row.appointment_id,
    note: "Re-enfileirado. Vai ser disparado no próximo tick do cron (até 60s).",
  });
}
