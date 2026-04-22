/**
 * src/lib/customer-pii-guard.ts — PR-054 · D-065 · finding 5.8 (parte 1+2)
 *
 * Defesa contra "customer takeover" no upsert por CPF dos endpoints
 * `/api/checkout` e `/api/agendar/reserve`. Antes deste guard, ambos
 * faziam `UPDATE customers SET name=$, email=$, phone=$, address_*=$`
 * cegamente quando o CPF já existia — qualquer um com CPF da vítima
 * podia tomber email (e direcionar invoices), tomber telefone (recebe
 * WhatsApp da vítima), tomber endereço (envenena entrega futura).
 *
 * Modelo de ameaça:
 *
 *   1. CPF é dado pseudo-público no Brasil (vaza fácil).
 *   2. Atacante com CPF da vítima monta payload com email/phone/
 *      address dele e POST. UPDATE cego sobrescreve a vítima.
 *   3. Próxima cobrança/comunicação vai pro atacante.
 *
 * Política (D-065):
 *
 *   - **CPF não existe** → INSERT normal (paciente novo).
 *
 *   - **CPF existe + `customer.user_id IS NULL`** (paciente nunca
 *     fez login via magic-link): permite UPDATE — não há ninguém
 *     pra defender o registro. Risco residual aceito (fantasma do
 *     próprio sistema). Loga `pii_updated_unauthenticated` quando
 *     há diff real, pra trilha LGPD.
 *
 *   - **CPF existe + `customer.user_id IS NOT NULL` + sem sessão
 *     patient** (ou sessão de outro user): **BLOQUEIA o UPDATE de
 *     PII**. Os dados do request são DESCARTADOS. A rota continua
 *     usando os dados gravados em `customers` pra criar a cobrança.
 *     Loga `pii_takeover_blocked`. O atacante não consegue desviar
 *     comunicação — ironicamente, se pagar, paga em nome da vítima
 *     (cobrança vai pro email/phone real da vítima).
 *
 *   - **CPF existe + `customer.user_id IS NOT NULL` + sessão patient
 *     com `user.id === customer.user_id`**: permite UPDATE (paciente
 *     legítimo atualizando seus próprios dados). Loga
 *     `pii_updated_authenticated`.
 *
 * Por que NÃO retornar erro 409 quando bloqueia:
 *
 *   - Atacante saberia que o CPF tem cadastro fortalecido (oracle).
 *   - Vítima legítima fica frustrada se mudou de email e quer renovar
 *     plano sem fazer login antes.
 *   - Continuar a cobrança com dados gravados é seguro: o atacante
 *     paga (raro) ou desiste (comum), a vítima recebe a comunicação.
 *
 * Por que NÃO usar `requirePatient()` (que redireciona):
 *
 *   - Esses endpoints são POSTs JSON, não Server Components — redirect
 *     é semântica errada.
 *   - Sessão é OPCIONAL aqui (não-logado é cidadão de primeira classe).
 *   - Helper dedicado `getOptionalPatientCustomerId()` retorna null
 *     se não há sessão, sem redirect.
 *
 * Failure modes:
 *
 *   - Decisão é pura (sem IO). Nunca falha.
 *   - O log de tentativas é best-effort (failSoft) — perda de log não
 *     bloqueia a request, só reduz observabilidade.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logPatientAccess } from "./patient-access-log";
import { logger } from "./logger";

const log = logger.with({ mod: "customer-pii-guard" });

// ────────────────────────────────────────────────────────────────────────
// Tipos
// ────────────────────────────────────────────────────────────────────────

/**
 * Snapshot do customer existente. Apenas os campos relevantes pra
 * decisão e pro diff. Não carrega todos os campos da tabela pra
 * minimizar acoplamento.
 */
export type ExistingCustomerSnapshot = {
  id: string;
  user_id: string | null;
  // Campos PII pra computar diff. Null aceito (campo opcional).
  name: string | null;
  email: string | null;
  phone: string | null;
  address_zipcode: string | null;
  address_street: string | null;
  address_number: string | null;
  address_complement: string | null;
  address_district: string | null;
  address_city: string | null;
  address_state: string | null;
};

/**
 * Payload de PII vindo da request (já normalizado pelo `parseAndValidate`
 * da rota — name sanitized, cpf só dígitos, etc).
 */
export type IncomingCustomerPii = {
  name: string;
  email: string;
  phone: string;
  address: {
    zipcode: string;
    street: string;
    number: string;
    complement?: string;
    district: string;
    city: string;
    state: string;
  };
};

/**
 * Resultado da decisão. A rota deve agir em:
 *
 *   - `action='update_full'`: aplicar todos os campos do payload no
 *     UPDATE (comportamento legacy, agora com gate).
 *   - `action='update_blocked'`: NÃO aplicar nenhum campo de PII.
 *     Os dados gravados em `customers` ficam intocados. A rota
 *     continua o fluxo (cobrança Asaas com `asaas_customer_id`
 *     existente etc).
 *
 * `reason` é didática — entra no log estruturado.
 *
 * `changedFields[]` lista os campos que diferem entre incoming e
 * existing (case-insensitive p/ email, dígitos-only p/ phone/zipcode).
 * Ajuda o operador a entender no audit log "o que foi tentado mudar".
 */
export type CustomerUpsertDecision =
  | {
      action: "update_full";
      reason:
        | "no_user_id_link" // customer não tem user_id → permite
        | "session_matches_user_id"; // sessão patient bate
      changedFields: string[];
    }
  | {
      action: "update_blocked";
      reason: "user_id_set_no_session" | "user_id_set_other_session";
      changedFields: string[];
      /** user_id do customer (pra audit). NUNCA o user_id da sessão. */
      defendedCustomerUserId: string;
    };

// ────────────────────────────────────────────────────────────────────────
// Decisão (pura)
// ────────────────────────────────────────────────────────────────────────

/**
 * Decisão estruturada pra upsert de customer existente. Pura e
 * determinística — não toca banco.
 *
 * `sessionUserId` deve vir de `getOptionalPatientCustomerId()` (ou
 * equivalente). `null` significa "não há sessão patient".
 */
export function decideCustomerUpsert(args: {
  existing: ExistingCustomerSnapshot;
  incoming: IncomingCustomerPii;
  sessionUserId: string | null;
}): CustomerUpsertDecision {
  const { existing, incoming, sessionUserId } = args;
  const changedFields = computeChangedFields(existing, incoming);

  // Caso A: customer nunca foi vinculado a um auth.user → permite
  // (não há identidade real defendendo o registro).
  if (!existing.user_id) {
    return {
      action: "update_full",
      reason: "no_user_id_link",
      changedFields,
    };
  }

  // Caso B: customer tem user_id + sessão patient bate → permite.
  if (sessionUserId && sessionUserId === existing.user_id) {
    return {
      action: "update_full",
      reason: "session_matches_user_id",
      changedFields,
    };
  }

  // Caso C: customer tem user_id + nenhuma sessão patient → bloqueia.
  if (!sessionUserId) {
    return {
      action: "update_blocked",
      reason: "user_id_set_no_session",
      changedFields,
      defendedCustomerUserId: existing.user_id,
    };
  }

  // Caso D: sessão de OUTRO user (suspeito) → bloqueia.
  return {
    action: "update_blocked",
    reason: "user_id_set_other_session",
    changedFields,
    defendedCustomerUserId: existing.user_id,
  };
}

/**
 * Computa lista de campos PII que mudariam se o UPDATE fosse aplicado.
 * Normaliza minimamente (trim, lowercase de email, só dígitos pra
 * phone/zipcode, uppercase de state) pra evitar falso positivo
 * tipo "endereço com espaço extra → considerou mudou".
 *
 * Lista canônica é estável → ordem alfabética. Permite asserts
 * determinísticos no audit log e nos testes.
 */
function computeChangedFields(
  existing: ExistingCustomerSnapshot,
  incoming: IncomingCustomerPii
): string[] {
  const changes: string[] = [];

  if (norm(existing.name) !== norm(incoming.name)) changes.push("name");
  if (normLower(existing.email) !== normLower(incoming.email))
    changes.push("email");
  if (digits(existing.phone) !== digits(incoming.phone))
    changes.push("phone");
  if (digits(existing.address_zipcode) !== digits(incoming.address.zipcode))
    changes.push("address_zipcode");
  if (norm(existing.address_street) !== norm(incoming.address.street))
    changes.push("address_street");
  if (norm(existing.address_number) !== norm(incoming.address.number))
    changes.push("address_number");
  // Complement: trata "" e null como equivalentes.
  const existingComplement = (existing.address_complement ?? "").trim();
  const incomingComplement = (incoming.address.complement ?? "").trim();
  if (norm(existingComplement) !== norm(incomingComplement))
    changes.push("address_complement");
  if (norm(existing.address_district) !== norm(incoming.address.district))
    changes.push("address_district");
  if (norm(existing.address_city) !== norm(incoming.address.city))
    changes.push("address_city");
  if (
    (existing.address_state ?? "").trim().toUpperCase() !==
    incoming.address.state.trim().toUpperCase()
  )
    changes.push("address_state");

  return changes.sort();
}

function norm(v: string | null | undefined): string {
  return (v ?? "").trim();
}
function normLower(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase();
}
function digits(v: string | null | undefined): string {
  return (v ?? "").replace(/\D/g, "");
}

// ────────────────────────────────────────────────────────────────────────
// Logging (best-effort)
// ────────────────────────────────────────────────────────────────────────

/**
 * Loga a decisão em `patient_access_log` quando relevante.
 *
 * - `update_blocked` → SEMPRE loga (ação adversa, prova LGPD).
 * - `update_full` com diff vazio → não loga (sem mudança real).
 * - `update_full` com diff não-vazio → loga atualização (trilha LGPD
 *   pra "quem mudou meus dados quando").
 *
 * `actorKind='system'` porque o ator efetivo do UPDATE é o servidor
 * (não há admin humano). O contexto da sessão patient (se houver)
 * vai em `metadata.patient_user_id`.
 *
 * failSoft: log perdido não bloqueia a request.
 */
export async function logCustomerUpsertDecision(
  supabase: SupabaseClient,
  args: {
    decision: CustomerUpsertDecision;
    customerId: string;
    sessionUserId: string | null;
    routeName: string;
    ipAddress: string | null;
    userAgent: string | null;
  }
): Promise<void> {
  const { decision, customerId, sessionUserId, routeName, ipAddress, userAgent } =
    args;

  // Diff vazio + permitido = não-evento. Não polui o log.
  if (decision.action === "update_full" && decision.changedFields.length === 0) {
    return;
  }

  const action =
    decision.action === "update_blocked"
      ? "pii_takeover_blocked"
      : decision.reason === "session_matches_user_id"
        ? "pii_updated_authenticated"
        : "pii_updated_unauthenticated";

  const result = await logPatientAccess(supabase, {
    adminUserId: null,
    adminEmail: `system:${routeName}`,
    actorKind: "system",
    customerId,
    action,
    metadata: {
      decision_reason: decision.reason,
      changed_fields: decision.changedFields,
      route: routeName,
      ip: ipAddress ?? null,
      user_agent: userAgent ?? null,
      patient_user_id: sessionUserId ?? null,
      ...(decision.action === "update_blocked"
        ? { defended_customer_user_id: decision.defendedCustomerUserId }
        : {}),
    },
  });

  if (!result.ok) {
    log.warn("log de upsert falhou (failSoft)", {
      route: routeName,
      action,
      err: result.message,
    });
  }
}
