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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  await requireAdmin();

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
    console.error("[admin/pacientes/search] query failed", err);
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
