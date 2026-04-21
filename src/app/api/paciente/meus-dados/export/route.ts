/**
 * GET /api/paciente/meus-dados/export — PR-017 · Onda 2A · D-051
 *
 * Self-service de portabilidade (LGPD Art. 18, V). O paciente logado
 * baixa imediatamente um JSON com todos os seus dados — mesma função
 * que o admin já usa em `/api/admin/pacientes/[id]/export`, mas
 * protegida por `requirePatient()` e entregue ao próprio titular.
 *
 * Regras:
 *
 *   - `requirePatient()` valida sessão + role=patient + `customers.id`
 *     linkado ao `auth.users.id`. Nunca aceita id pelo query string;
 *     o cliente não pode solicitar export de outro paciente.
 *
 *   - Se o paciente já foi anonimizado (anonymized_at != null), o
 *     export entrega o que restou (placeholders + histórico imutável),
 *     porque é prova de que a anonimização foi aplicada.
 *
 *   - O row em `lgpd_requests` (kind='export_copy', status='fulfilled')
 *     é inserido best-effort. Se falhar, ainda entregamos o JSON — o
 *     paciente tem direito ao seu dado independente do nosso audit.
 *     A falha é logada no console pra investigação.
 *
 *   - Cache explicitamente desabilitado (`no-store`) pra evitar que CDN
 *     ou service worker guardem PII.
 */

import { NextResponse } from "next/server";
import { requirePatient } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { exportPatientData } from "@/lib/patient-lgpd";
import { createExportAudit } from "@/lib/patient-lgpd-requests";
import { getAuditContextFromRequest } from "@/lib/admin-audit-log";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/paciente/meus-dados/export" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { customerId } = await requirePatient();

  try {
    const supabase = getSupabaseAdmin();
    const exportData = await exportPatientData(supabase, customerId);
    if (!exportData) {
      // Edge case: sessão sobrevive mas o customer foi apagado. Trata
      // como 404 pra o paciente logar de novo.
      return NextResponse.json(
        { ok: false, error: "customer_not_found" },
        { status: 404 }
      );
    }

    const body = JSON.stringify(exportData, null, 2);

    // Audit best-effort. Falha não bloqueia entrega ao titular.
    const ctx = getAuditContextFromRequest(req);
    const auditRes = await createExportAudit(supabase, {
      customerId,
      exportBytes: Buffer.byteLength(body, "utf8"),
      ip: typeof ctx.ip === "string" ? ctx.ip : null,
      userAgent: typeof ctx.userAgent === "string" ? ctx.userAgent : null,
    });
    if (!auditRes.ok) {
      log.error("audit insert falhou (entrega continua)", {
        err: auditRes.message,
        customer_id: customerId,
      });
    }

    const filename = `meus-dados-${exportData.exported_at.slice(0, 10)}.json`;
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
    log.error("failed", { err });
    return NextResponse.json(
      { ok: false, error: "export_failed", message },
      { status: 500 }
    );
  }
}
