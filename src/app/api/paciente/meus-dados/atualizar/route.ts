/**
 * POST /api/paciente/meus-dados/atualizar — PR-056 · D-067
 *
 * Permite ao paciente autenticado atualizar seus próprios dados
 * pessoais (nome, email, phone, endereço). CPF é imutável — o
 * payload é silenciosamente ignorado se enviado.
 *
 * Contexto (por que existe):
 *
 *   O guard D-065 (PR-054) bloqueia atualização cega de PII nos
 *   endpoints de checkout/agendar quando `customers.user_id` está
 *   populado (defesa contra CPF-takeover). Isso é correto, mas
 *   cria uma fricção: paciente legítimo que mudou de email/phone
 *   não tem como atualizar via funil de compra. A resposta dessa
 *   fricção é EXATAMENTE este endpoint — atualização via SESSÃO
 *   AUTENTICADA, onde `requirePatient()` prova quem é o dono.
 *
 * Decisões:
 *
 *   - Reusa a lib `patient-address.ts::validateAddress` (mesma usada
 *     em checkout/agendar/edit-shipping). Consistência de regras.
 *   - Reusa `text-sanitize::sanitizeShortText(TEXT_PATTERNS.personName)`
 *     pra nome (PR-037).
 *   - Email: regex simples + lowercase + trim.
 *   - Phone: só dígitos + length >= 10.
 *   - CPF é ignorado (mesmo que venha no payload). O front não envia;
 *     se tivesse, recusar seria excesso — aceitar e ignorar é mais
 *     tolerante e evita oracle ("erro porque mandei o CPF").
 *   - Log: `logPatientAccess` com action='pii_updated_authenticated'
 *     (criada pelo PR-054) incluindo `changed_fields[]` — trilha
 *     LGPD consistente com o mesmo evento via checkout/agendar.
 *   - Sincronização com Asaas: NÃO faz. A próxima cobrança vai com
 *     os dados atuais do banco (comportamento atual já re-busca).
 *     Asaas customer não precisa estar perfeitamente espelhado —
 *     as comunicações da plataforma saem dos nossos dados, não dos
 *     dele. Sync do Asaas fica como follow-up opcional se virar dor.
 *   - Anonimizado: bloqueia atualização (paciente anonimizado não
 *     tem PII coerente pra sobrescrever).
 *
 * Resposta:
 *
 *   - 200 `{ ok: true, updated: true, changedFields: string[] }` — sucesso.
 *   - 200 `{ ok: true, updated: false, changedFields: [] }` — payload
 *     igual ao estado atual (não-evento).
 *   - 400 `{ ok: false, error, fieldErrors? }` — validação.
 *   - 409 `{ ok: false, error: 'anonymized' }` — conta anonimizada.
 */

import { NextResponse } from "next/server";
import { requirePatient } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { snapshotToCustomerPatch } from "@/lib/patient-address";
import {
  logPatientAccess,
  getAccessContextFromRequest,
} from "@/lib/patient-access-log";
import {
  parseAndValidateUpdate,
  computeChangedFields,
  type CustomerSnapshot,
} from "@/lib/meus-dados-update";
import { logger } from "@/lib/logger";

const log = logger.with({ route: "/api/paciente/meus-dados/atualizar" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ────────────────────────────────────────────────────────────────────────
// Handler
// ────────────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const { user, customerId } = await requirePatient();

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "json_invalid" },
      { status: 400 }
    );
  }

  const parsed = parseAndValidateUpdate(raw);
  if (!parsed.ok) {
    return NextResponse.json(
      { ok: false, error: parsed.error, fieldErrors: parsed.fieldErrors },
      { status: 400 }
    );
  }
  const input = parsed.input;

  const supabase = getSupabaseAdmin();

  // Re-busca o estado atual. Duas razões:
  //   1. Verificar `anonymized_at` (conta anonimizada não atualiza).
  //   2. Computar `changed_fields` pra audit.
  const { data: existing, error: readErr } = await supabase
    .from("customers")
    .select(
      "id, anonymized_at, name, email, phone, address_zipcode, address_street, address_number, address_complement, address_district, address_city, address_state"
    )
    .eq("id", customerId)
    .single();

  if (readErr || !existing) {
    log.error("customer read", { err: readErr, customer_id: customerId });
    return NextResponse.json(
      { ok: false, error: "read_failed" },
      { status: 500 }
    );
  }

  if ((existing as { anonymized_at: string | null }).anonymized_at) {
    return NextResponse.json(
      { ok: false, error: "anonymized" },
      { status: 409 }
    );
  }

  const changedFields = computeChangedFields(
    existing as unknown as CustomerSnapshot,
    input
  );

  if (changedFields.length === 0) {
    // Não-evento: nada a fazer, nada a logar. Retorna sucesso pra UI
    // simplificar (form pode fechar com "tudo certo").
    return NextResponse.json({
      ok: true,
      updated: false,
      changedFields: [] as string[],
    });
  }

  const addressPatch = snapshotToCustomerPatch({
    // validateAddress devolveu um snapshot SEM recipient_name (campo de
    // fulfillment, não de customers) — aqui montamos o shape que
    // `snapshotToCustomerPatch` espera, sem tocar em recipient.
    recipient_name: input.name,
    zipcode: input.address.zipcode,
    street: input.address.street,
    number: input.address.number,
    complement: input.address.complement,
    district: input.address.district,
    city: input.address.city,
    state: input.address.state,
  });

  const { error: updErr } = await supabase
    .from("customers")
    .update({
      name: input.name,
      email: input.email,
      phone: input.phone,
      ...addressPatch,
    })
    .eq("id", customerId);

  if (updErr) {
    log.error("customer update", { err: updErr, customer_id: customerId });
    return NextResponse.json(
      { ok: false, error: "update_failed" },
      { status: 500 }
    );
  }

  // Trilha LGPD reusando action do PR-054. Aqui SEMPRE é
  // 'pii_updated_authenticated' porque já passamos por `requirePatient()`.
  const ctx = getAccessContextFromRequest(req);
  const logResult = await logPatientAccess(supabase, {
    adminUserId: null,
    adminEmail: `system:${ctx.route ?? "/api/paciente/meus-dados/atualizar"}`,
    actorKind: "system",
    customerId,
    action: "pii_updated_authenticated",
    metadata: {
      decision_reason: "session_matches_user_id",
      changed_fields: changedFields,
      route: ctx.route,
      ip: ctx.ip,
      user_agent: ctx.userAgent,
      patient_user_id: user.id,
      self_service: true,
    },
  });
  if (!logResult.ok) {
    log.warn("audit log failSoft", {
      customer_id: customerId,
      err: logResult.message,
    });
  }

  return NextResponse.json({
    ok: true,
    updated: true,
    changedFields,
  });
}
