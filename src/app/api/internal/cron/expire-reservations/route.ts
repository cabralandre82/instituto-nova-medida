/**
 * Cron de expiração de reservas `pending_payment`.
 *
 * Chamado pelo Vercel Cron (ver vercel.json) a cada 1 minuto. Faz
 * fallback/redundância com o pg_cron job agendado na migration 010
 * (se `pg_cron` estiver habilitado no Supabase, AMBOS rodam — a
 * função `expire_abandoned_reservations()` é idempotente, então
 * rodar duas vezes na mesma janela não causa problema; a segunda
 * chamada retorna 0 linhas).
 *
 * Motivos pra ter o cron HTTP além do pg_cron:
 *   1. pg_cron pode não estar habilitado (projetos Supabase free
 *      mais antigos, self-hosted, etc).
 *   2. Permite side-effects fora do Postgres (cancelar cobrança no
 *      Asaas, disparar WhatsApp "reserva expirou", log estruturado).
 *      Hoje é só sweep + log; ganchos ficam preparados pra Sprint 4.2.
 *   3. Visibilidade no dashboard do Vercel (execuções, erros, tempo
 *      de resposta) — o pg_cron roda em silêncio no Postgres.
 *
 * Segurança:
 *   - Vercel Cron adiciona automaticamente o header
 *     `Authorization: Bearer ${CRON_SECRET}` se a env var estiver
 *     definida. Validamos aqui.
 *   - Em dev / ausência de CRON_SECRET: a rota responde 200 pra
 *     qualquer chamada (pra facilitar debug local via curl).
 *
 * Docs: D-030 em docs/DECISIONS.md.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ExpiredRow = {
  appointment_id: string;
  doctor_id: string;
  scheduled_at: string;
  customer_id: string;
  payment_id: string | null;
  expired_at: string;
};

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // Dev mode: sem CRON_SECRET não há autorização a validar.
    return true;
  }
  const auth = req.headers.get("authorization") || "";
  // Vercel Cron envia "Bearer <CRON_SECRET>".
  // Aceitamos também "x-cron-secret: <CRON_SECRET>" pra debug manual.
  if (auth === `Bearer ${secret}`) return true;
  if (req.headers.get("x-cron-secret") === secret) return true;
  return false;
}

async function runSweep(): Promise<
  | { ok: true; expired_count: number; rows: ExpiredRow[] }
  | { ok: false; error: string }
> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("expire_abandoned_reservations");

  if (error) {
    return { ok: false, error: error.message };
  }

  const rows = (data ?? []) as ExpiredRow[];
  return { ok: true, expired_count: rows.length, rows };
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const result = await runSweep();

  if (!result.ok) {
    console.error("[cron/expire-reservations] rpc error", result.error);
    return NextResponse.json(result, { status: 500 });
  }

  if (result.expired_count > 0) {
    console.info(
      `[cron/expire-reservations] expired ${result.expired_count} slot(s):`,
      result.rows.map((r) => ({
        appointment_id: r.appointment_id,
        doctor_id: r.doctor_id,
        scheduled_at: r.scheduled_at,
      }))
    );
  }

  return NextResponse.json({
    ok: true,
    expired_count: result.expired_count,
    expired: result.rows.map((r) => ({
      appointment_id: r.appointment_id,
      doctor_id: r.doctor_id,
      scheduled_at: r.scheduled_at,
    })),
    ran_at: new Date().toISOString(),
  });
}

export async function POST(req: NextRequest) {
  // Alguns dashboards/monitoring usam POST; aceitamos também.
  return GET(req);
}
