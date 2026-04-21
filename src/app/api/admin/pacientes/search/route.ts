/**
 * GET /api/admin/pacientes/search?q=... — D-045 · 3.B
 *
 * Endpoint de autocomplete da busca global de pacientes no admin.
 * Gateado por `requireAdmin`.
 *
 * Query params:
 *   - `q`:     string de busca (nome/email/telefone/CPF). Pode vir com máscara.
 *   - `limit`: opcional, default 8, clamped em [1, 20]
 *
 * Retorna:
 *   200 { ok: true, strategy, hits: [{id, name, email, phone, cpfMasked, createdAt}] }
 *   400 { ok: false, error }  — validação
 *
 * Nota: mascaramos o CPF no resultado (nenhuma tela de autocomplete
 * tem motivo pra mostrar CPF inteiro). Ficha completa em
 * /admin/pacientes/[id] mostra CPF por inteiro.
 */

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  classifyQuery,
  searchCustomers,
  normalizeQuery,
} from "@/lib/patient-search";
import {
  getAccessContextFromRequest,
  logPatientAccess,
} from "@/lib/patient-access-log";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/admin/pacientes/search" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const admin = await requireAdmin();

  const url = new URL(req.url);
  const q = normalizeQuery(url.searchParams.get("q"));
  const limitRaw = url.searchParams.get("limit");
  const limit = Math.min(
    Math.max(parseInt(limitRaw ?? "8", 10) || 8, 1),
    20
  );

  const strategy = classifyQuery(q);
  if (strategy === "empty") {
    return NextResponse.json({ ok: true, strategy, hits: [] });
  }

  try {
    const supabase = getSupabaseAdmin();
    const hits = await searchCustomers(supabase, q, { limit });

    // PR-032 · D-051: registra cada busca com termo + contagem de
    // resultados. customer_id=null porque a busca não aponta pra um
    // paciente específico (o clique numa ficha é logado separadamente).
    // failSoft: busca não pode ser bloqueada por indisponibilidade do
    // log.
    await logPatientAccess(supabase, {
      adminUserId: admin.id,
      adminEmail: admin.email,
      customerId: null,
      action: "search",
      metadata: {
        ...getAccessContextFromRequest(req),
        query: q,
        strategy,
        hits: hits.length,
      },
    });

    return NextResponse.json({
      ok: true,
      strategy,
      hits: hits.map((h) => ({
        id: h.id,
        name: h.name,
        email: h.email,
        phone: h.phone,
        cpfMasked: maskCpf(h.cpf),
        createdAt: h.createdAt,
      })),
    });
  } catch (err) {
    log.error("query failed", { err });
    return NextResponse.json(
      { ok: false, error: "search_failed" },
      { status: 500 }
    );
  }
}

function maskCpf(cpf: string): string {
  const d = cpf.replace(/\D/g, "");
  if (d.length !== 11) return "***";
  return `${d.slice(0, 3)}.***.***-${d.slice(-2)}`;
}
