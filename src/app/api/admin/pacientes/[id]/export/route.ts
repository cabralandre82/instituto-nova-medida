/**
 * GET /api/admin/pacientes/[id]/export — D-045 · 3.G
 *
 * Exporta TODOS os dados pessoais e operacionais do paciente num
 * JSON downloadable, em cumprimento ao direito de portabilidade da
 * LGPD (Art. 18, V).
 *
 * Gated por `requireAdmin` — operador executa a pedido do titular
 * (ou por obrigação em auditoria). O arquivo inclui `legal_notice`
 * explicando que dados fiscais/clínicos retidos por obrigação legal
 * não podem ser excluídos (CFM 1.821/2007, Decreto 6.022/2007).
 *
 * Retorna 200 com Content-Disposition: attachment, 404 se paciente
 * não existe.
 */

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { exportPatientData } from "@/lib/patient-lgpd";
import {
  getAccessContextFromRequest,
  logPatientAccess,
} from "@/lib/patient-access-log";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/admin/pacientes/[id]/export" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  const { id } = await params;

  try {
    const supabase = getSupabaseAdmin();
    const exportData = await exportPatientData(supabase, id);
    if (!exportData) {
      return NextResponse.json(
        { ok: false, error: "customer_not_found" },
        { status: 404 }
      );
    }

    const body = JSON.stringify(exportData, null, 2);
    const filename = `lgpd-export-${id}-${exportData.exported_at.slice(0, 10)}.json`;

    // PR-032 · D-051: export de PII por admin exige trilha imutável.
    // failSoft pra não bloquear download se log indisponível, mas
    // logamos no console pra investigação.
    await logPatientAccess(supabase, {
      adminUserId: admin.id,
      adminEmail: admin.email,
      customerId: id,
      action: "export",
      metadata: {
        ...getAccessContextFromRequest(req),
        bytes: body.length,
      },
    });

    return new NextResponse(body, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown_error";
    log.error("failed", { err, customer_id: id });
    return NextResponse.json(
      { ok: false, error: "export_failed", message },
      { status: 500 }
    );
  }
}
