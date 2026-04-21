/**
 * src/lib/patient-lgpd.ts — D-045 · 3.G
 *
 * Duas operações LGPD disponibilizadas ao operador admin:
 *
 *   1. `exportPatientData(supabase, customerId)` — compila TODOS os
 *      dados pessoais e operacionais de um paciente num JSON pro
 *      direito de portabilidade (Art. 18, V). Devolve objeto
 *      estruturado pronto pra serializar e enviar ao titular.
 *
 *   2. `anonymizePatient(supabase, customerId, opts)` — substitui PII
 *      em `customers` por valores placeholder que passam as
 *      constraints da tabela. Dados financeiros (payments, earnings)
 *      e clínicos (prescriptions, fulfillments, plan_acceptances)
 *      ficam intactos por exigência de retenção legal (CFM 20 anos
 *      pra prontuário, Receita 5 anos pra fiscal). LGPD Art. 16
 *      autoriza essa retenção por obrigação legal.
 *
 * Design:
 *   - LIB PURA. Sem UI, sem HTTP. Rotas `/api/admin/pacientes/[id]/*`
 *     delegam aqui.
 *   - Anonymization é IRREVERSÍVEL. Não guardamos valores antigos.
 *     Auditoria fica com `anonymized_at` + `anonymized_ref` (hash
 *     curto do id original pra correlação, não reversível).
 *   - `exportPatientData` retorna JSON serializável direto — sem
 *     tipos não-JSON (Date vira string ISO, Buffer não aparece).
 *   - Anonymization usa `anonymized_ref` como sufixo em placeholders
 *     pra garantir unicidade (CPF/email/phone têm UNIQUE).
 *
 * O que NÃO fazemos aqui:
 *   - Não mexemos em `auth.users`. Se o paciente tinha login por
 *     magic-link, o user_id continua vinculado; admin pode revogar
 *     sessão no próprio Supabase Auth se quiser, mas isso é outra
 *     operação (pedimos ao operador via runbook).
 *   - Não deletamos `appointments`, `fulfillments`, `plan_acceptances`
 *     nem `payments`. Retenção legal obrigatória.
 *   - Não modificamos `leads` originais (podem estar vinculados a
 *     outros dados de marketing; dropamos só o link via lead_id).
 */

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  APPOINTMENT_COLUMNS,
  APPOINTMENT_NOTIFICATION_COLUMNS,
  CUSTOMER_COLUMNS,
  FULFILLMENT_ADDRESS_CHANGE_COLUMNS,
  FULFILLMENT_COLUMNS,
  PAYMENT_COLUMNS,
  PLAN_ACCEPTANCE_COLUMNS,
  columnsList,
} from "./patient-lgpd-fields";

// ────────────────────────────────────────────────────────────────────────
// Tipos exportados
// ────────────────────────────────────────────────────────────────────────

export type LgpdExportSchemaVersion = "v1-2026-04";

export type LgpdExport = {
  schema_version: LgpdExportSchemaVersion;
  exported_at: string;
  legal_notice: string;
  customer: Record<string, unknown>;
  appointments: Record<string, unknown>[];
  fulfillments: Record<string, unknown>[];
  payments: Record<string, unknown>[];
  plan_acceptances: Record<string, unknown>[];
  appointment_notifications: Record<string, unknown>[];
  fulfillment_address_changes: Record<string, unknown>[];
};

export type AnonymizeResult = {
  ok: true;
  customerId: string;
  anonymizedAt: string;
  anonymizedRef: string;
};

export type AnonymizeError = {
  ok: false;
  code:
    | "customer_not_found"
    | "already_anonymized"
    | "update_failed"
    | "has_active_fulfillment";
  message: string;
};

// ────────────────────────────────────────────────────────────────────────
// Helpers puros (exportados pra teste)
// ────────────────────────────────────────────────────────────────────────

/**
 * Deriva um sufixo curto e estável pra placeholders, sem revelar o id
 * original. 8 chars hex = 2^32 combinações → colisão praticamente
 * impossível no universo de pacientes do Instituto.
 */
export function anonymizedRefFromId(customerId: string): string {
  return createHash("sha256")
    .update(customerId)
    .digest("hex")
    .slice(0, 8);
}

/**
 * CPF placeholder com 11 dígitos derivados do ref (garante UNIQUE).
 * Nunca coincide com CPF real (não passa validação de dígitos
 * verificadores, mas a coluna só exige 11 dígitos, não validade).
 */
export function placeholderCpf(ref: string): string {
  // Mapeia cada char hex pra um dígito; repete o ref até 11 chars.
  const hexDigitMap = (c: string): string => {
    const n = parseInt(c, 16);
    return Number.isNaN(n) ? "0" : String(n % 10);
  };
  let digits = "";
  for (let i = 0; digits.length < 11; i++) {
    digits += hexDigitMap(ref[i % ref.length]);
  }
  return digits.slice(0, 11);
}

export function placeholderEmail(ref: string): string {
  return `paciente-${ref}@anonimizado.invalid`;
}

export function placeholderPhone(ref: string): string {
  // Constraint: pelo menos 10 dígitos 0-9. O ref é hex, então mapeamos
  // cada char (0-15) → dígito (0-9) via mod 10 e prefixamos com "0000"
  // pra indicar placeholder. Mantém unicidade entre anonymizados
  // diferentes (refs diferentes → sequências diferentes).
  let digits = "";
  for (const c of ref) {
    const n = parseInt(c, 16);
    digits += Number.isNaN(n) ? "0" : String(n % 10);
  }
  return `0000${digits}`;
}

export function placeholderName(ref: string): string {
  return `Paciente anonimizado #${ref}`;
}

// ────────────────────────────────────────────────────────────────────────
// exportPatientData
// ────────────────────────────────────────────────────────────────────────

const LEGAL_NOTICE =
  "Este arquivo contém os dados pessoais mantidos pelo Instituto Nova " +
  "Medida sobre o titular solicitante, em cumprimento ao Art. 18, V da " +
  "LGPD (direito à portabilidade dos dados). Dados de prontuário, " +
  "prescrições e registros fiscais são mantidos conforme exigência " +
  "legal (Resolução CFM 1.821/2007 e Decreto 6.022/2007) e não podem " +
  "ser excluídos durante o prazo legal de retenção, ainda que " +
  "solicitada a exclusão.";

export async function exportPatientData(
  supabase: SupabaseClient,
  customerId: string
): Promise<LgpdExport | null> {
  // PR-016 · Onda 2A: allowlist explícita em cada SELECT. NUNCA `SELECT *`.
  // Se uma coluna nova for adicionada sem passar aqui, não vaza no export.
  // Consulte `src/lib/patient-lgpd-fields.ts` pra a lista completa e razões.
  const [
    customerRes,
    appsRes,
    ffRes,
    paysRes,
    accRes,
    notifsRes,
    addrRes,
  ] = await Promise.all([
    supabase
      .from("customers")
      .select(columnsList(CUSTOMER_COLUMNS))
      .eq("id", customerId)
      .maybeSingle(),
    supabase
      .from("appointments")
      .select(columnsList(APPOINTMENT_COLUMNS))
      .eq("customer_id", customerId)
      .order("scheduled_at", { ascending: false }),
    supabase
      .from("fulfillments")
      .select(columnsList(FULFILLMENT_COLUMNS))
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false }),
    supabase
      .from("payments")
      .select(columnsList(PAYMENT_COLUMNS))
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false }),
    supabase
      .from("plan_acceptances")
      .select(columnsList(PLAN_ACCEPTANCE_COLUMNS))
      .eq("customer_id", customerId)
      .order("accepted_at", { ascending: false }),
    // Notificações linkam via appointment_id; precisamos dos ids primeiro.
    (async () => {
      const { data: apps } = await supabase
        .from("appointments")
        .select("id")
        .eq("customer_id", customerId);
      const ids = (apps ?? []).map((a: { id: string }) => a.id);
      if (ids.length === 0) return { data: [], error: null } as const;
      return await supabase
        .from("appointment_notifications")
        .select(columnsList(APPOINTMENT_NOTIFICATION_COLUMNS))
        .in("appointment_id", ids)
        .order("created_at", { ascending: false });
    })(),
    // Mudanças de endereço linkam via fulfillment_id.
    (async () => {
      const { data: ffs } = await supabase
        .from("fulfillments")
        .select("id")
        .eq("customer_id", customerId);
      const ids = (ffs ?? []).map((f: { id: string }) => f.id);
      if (ids.length === 0) return { data: [], error: null } as const;
      return await supabase
        .from("fulfillment_address_changes")
        .select(columnsList(FULFILLMENT_ADDRESS_CHANGE_COLUMNS))
        .in("fulfillment_id", ids)
        .order("changed_at", { ascending: false });
    })(),
  ]);

  if (!customerRes.data) return null;

  return {
    schema_version: "v1-2026-04",
    exported_at: new Date().toISOString(),
    legal_notice: LEGAL_NOTICE,
    customer: customerRes.data as unknown as Record<string, unknown>,
    appointments: (appsRes.data ?? []) as unknown as Record<
      string,
      unknown
    >[],
    fulfillments: (ffRes.data ?? []) as unknown as Record<
      string,
      unknown
    >[],
    payments: (paysRes.data ?? []) as unknown as Record<string, unknown>[],
    plan_acceptances: (accRes.data ?? []) as unknown as Record<
      string,
      unknown
    >[],
    appointment_notifications: (notifsRes.data ?? []) as unknown as Record<
      string,
      unknown
    >[],
    fulfillment_address_changes: (addrRes.data ?? []) as unknown as Record<
      string,
      unknown
    >[],
  };
}

// ────────────────────────────────────────────────────────────────────────
// anonymizePatient
// ────────────────────────────────────────────────────────────────────────

/**
 * Estados de fulfillment que bloqueiam anonymization: entre `paid` e
 * `shipped` há medicamento já em rota — a clínica precisa do endereço
 * e da identidade pra despachar/rastrear. Anonimizar nesse momento é
 * auto-sabotagem. O operador deve completar ou cancelar antes.
 */
const BLOCKING_FULFILLMENT_STATUSES: ReadonlyArray<string> = [
  "paid",
  "pharmacy_requested",
  "shipped",
];

export type AnonymizePatientOptions = {
  /** Timestamp de referência (default now()), pra testes determinísticos. */
  now?: Date;
  /**
   * Se true, ignora o bloqueio de fulfillment ativo. Use com cuidado —
   * só em casos excepcionais tipo "paciente exige LGPD imediata e
   * aceita perder o tratamento em curso por escrito".
   */
  force?: boolean;
};

export async function anonymizePatient(
  supabase: SupabaseClient,
  customerId: string,
  opts: AnonymizePatientOptions = {}
): Promise<AnonymizeResult | AnonymizeError> {
  const now = opts.now ?? new Date();

  const { data: current, error: fetchErr } = await supabase
    .from("customers")
    .select("id, anonymized_at")
    .eq("id", customerId)
    .maybeSingle();

  if (fetchErr) {
    return {
      ok: false,
      code: "update_failed",
      message: `Falha ao carregar paciente: ${fetchErr.message}`,
    };
  }
  if (!current) {
    return {
      ok: false,
      code: "customer_not_found",
      message: "Paciente não encontrado.",
    };
  }
  if ((current as { anonymized_at: string | null }).anonymized_at) {
    return {
      ok: false,
      code: "already_anonymized",
      message: "Paciente já foi anonimizado anteriormente.",
    };
  }

  if (!opts.force) {
    const { data: activeFF } = await supabase
      .from("fulfillments")
      .select("id, status")
      .eq("customer_id", customerId)
      .in("status", BLOCKING_FULFILLMENT_STATUSES as string[])
      .limit(1);
    if ((activeFF ?? []).length > 0) {
      return {
        ok: false,
        code: "has_active_fulfillment",
        message:
          "Paciente tem tratamento em curso (paid/pharmacy_requested/shipped). " +
          "Conclua ou cancele antes de anonimizar, ou use force=true.",
      };
    }
  }

  const ref = anonymizedRefFromId(customerId);
  const nowIso = now.toISOString();

  const { error: updErr } = await supabase
    .from("customers")
    .update({
      name: placeholderName(ref),
      email: placeholderEmail(ref),
      phone: placeholderPhone(ref),
      cpf: placeholderCpf(ref),
      address_zipcode: null,
      address_street: null,
      address_number: null,
      address_complement: null,
      address_district: null,
      address_city: null,
      address_state: null,
      lead_id: null,
      asaas_raw: null,
      anonymized_at: nowIso,
      anonymized_ref: ref,
      updated_at: nowIso,
    })
    .eq("id", customerId)
    // idempotência: se outro processo já anonimizou entre o check e o
    // update, o WHERE abaixo garante que não sobrescrevemos.
    .is("anonymized_at", null);

  if (updErr) {
    return {
      ok: false,
      code: "update_failed",
      message: `Falha ao anonimizar: ${updErr.message}`,
    };
  }

  return {
    ok: true,
    customerId,
    anonymizedAt: nowIso,
    anonymizedRef: ref,
  };
}
