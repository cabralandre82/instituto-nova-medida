/**
 * src/lib/patient-quick-links.ts — PR-072 · D-080 · finding 1.7
 *
 * Alimenta o "painel de atalhos" no dashboard do paciente
 * (`/paciente`) com os dois auto-atendimentos de maior valor
 * identificados na auditoria:
 *
 *   (a) **Receita vigente (Memed)** — link direto pra última prescrição
 *       ativa. Elimina o ciclo "paciente perde a URL → pede no WhatsApp
 *       → admin solo repassa", que era o maior dreno de atenção do
 *       operador solo (finding [1.7]).
 *
 *   (b) **Endereço de entrega cadastrado** — preview do endereço
 *       vigente + CTA pra `/paciente/meus-dados/atualizar` (PR-056 ·
 *       D-067). Evita surpresas de "caixa foi pro endereço antigo".
 *
 * Desenho:
 *
 *   - Função única `getPatientQuickLinks(supabase, customerId)` faz
 *     duas queries em paralelo. Zero acoplamento com o render.
 *   - Tipos de retorno são discriminated unions (`latest_prescription`,
 *     `shipping_address`) — o caller decide o que renderizar, e cada
 *     estado tem os campos exatos que precisa, sem optional chaining
 *     perigoso na UI.
 *   - **Normalização defensiva**: todos os campos string passam por
 *     `trim`; endereços "só zip" ou "só street" já foram proibidos
 *     pelo sanitizador em `validateAddress` (D-053), mas pode haver
 *     linhas legadas; tratamos como `missing` e oferecemos link de
 *     edição ao invés de renderizar "—" esquisito.
 *   - **Privacidade**: a função é server-only (SupabaseClient admin).
 *     O componente cliente só recebe o objeto formatado — não expõe
 *     CPF, email ou dados além do necessário pro atalho.
 *
 * Trade-off consciente:
 *
 *   Não navegamos `fulfillments` pra achar "memed URL da indicação
 *   ATIVA". Preferimos a URL da **última consulta finalizada com
 *   prescrição** (`memed_prescription_url NOT NULL`) — é a fonte
 *   primária (prontuário) e é imutável (D-056 · trigger
 *   `appointments_medical_record_immutable`). Se a médica re-prescreveu
 *   numa consulta mais recente, aparece a nova. Se a receita antiga
 *   expirou no Memed, o atalho leva à página Memed que mostra o status
 *   real — não é papel nosso duplicar essa validação.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";
import {
  daysUntilExpiry,
  type AppointmentCreditReason,
} from "@/lib/appointment-credits";

const log = logger.with({ mod: "patient-quick-links" });

// ────────────────────────────────────────────────────────────────────
// Tipos
// ────────────────────────────────────────────────────────────────────

/**
 * Estado do atalho "Receita vigente".
 *
 *   - `ready`: há prescrição com URL Memed válida; renderiza link
 *     direto pro PDF.
 *   - `none`: paciente nunca recebeu prescrição (pré-consulta ou
 *     médica descartou). Oculta o atalho.
 */
export type LatestPrescription =
  | {
      kind: "ready";
      /** URL http(s) da prescrição no Memed. Imutável após finalização. */
      url: string;
      /** ISO da consulta onde foi prescrita. Serve pra mostrar "de DD/MM". */
      issuedAt: string;
      /** ID do appointment — usado pro link "Ver consulta completa". */
      appointmentId: string;
      /** Nome de exibição da médica (display_name || full_name). */
      doctorName: string;
    }
  | { kind: "none" };

/**
 * Estado do atalho "Endereço de entrega".
 *
 *   - `ready`: endereço completo (CEP + rua + número + cidade + UF).
 *     Renderiza uma linha resumida + CTA "Revisar endereço".
 *   - `incomplete`: customer existe mas faltam campos obrigatórios.
 *     Renderiza CTA "Cadastrar endereço" com aviso explícito.
 *   - `missing`: customer sem endereço nenhum (fluxo muito antigo).
 *     Mesmo CTA do `incomplete`, copy diferente.
 *
 * CEP/rua/número/cidade/UF são normalizados (`trim`) mas **não
 * mascarados** — não é dado sensível como CPF.
 */
export type ShippingAddress =
  | {
      kind: "ready";
      /** "12345-678" (mantém máscara para humano) ou apenas dígitos — a UI formata. */
      zipcode: string;
      /** Linha resumida pronta pra render: "Rua X, 123 · Centro". */
      summaryLine: string;
      /** "São Paulo / SP" pronto pra render. */
      cityState: string;
      /** Complemento, se houver; a UI pode esconder se vazio. */
      complement: string | null;
    }
  | { kind: "incomplete"; missingFields: readonly string[] }
  | { kind: "missing" };

/**
 * Estado do atalho "Reagendamento gratuito" (PR-073 · D-081).
 *
 *   - `ready`: paciente tem pelo menos um `appointment_credits` ativo
 *     emitido por no-show da médica (ou sala expirada vazia).
 *     Renderiza um banner destacado com CTA pra WhatsApp de suporte.
 *   - `none`: nenhum crédito ativo. Esconde o bloco.
 *
 * Mostramos apenas o **mais antigo** — se houver mais de um, o admin
 * resolve todos no mesmo contato (cenário raríssimo).
 */
export type RescheduleCredit =
  | {
      kind: "ready";
      /** ID do crédito — usado pelo admin pra marcar consumed. */
      creditId: string;
      /** ISO de quando o crédito foi emitido (= no-show aplicado). */
      issuedAt: string;
      /** ISO do limite de uso do crédito. */
      expiresAt: string;
      /** Dias restantes (>=0). Pronto pra render "expira em N dias". */
      daysRemaining: number;
      /** Razão — determina a copy ("a médica faltou" vs "sala expirou"). */
      reason: AppointmentCreditReason;
    }
  | { kind: "none" };

export type PatientQuickLinks = {
  latestPrescription: LatestPrescription;
  shippingAddress: ShippingAddress;
  rescheduleCredit: RescheduleCredit;
};

// ────────────────────────────────────────────────────────────────────
// Helpers puros (testáveis sem IO)
// ────────────────────────────────────────────────────────────────────

/** Trim + normalize null/empty string para null canônico. */
function normStr(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/** Só aceita http(s). Evita XSS via `javascript:` mesmo em dados legados. */
function isHttpsLink(v: string | null): v is string {
  if (!v) return false;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Shape esperado do row de appointments. `doctors` pode vir como
 * array (PostgREST nested select) — cuidado na desestruturação.
 */
type AppointmentRow = {
  id: string;
  memed_prescription_url: string | null;
  finalized_at: string | null;
  ended_at: string | null;
  doctors:
    | { display_name: string | null; full_name: string | null }
    | Array<{ display_name: string | null; full_name: string | null }>
    | null;
};

/** Decide qual timestamp usar pra "emitida em". Prioriza `finalized_at`
 *  (timestamp oficial de finalização, D-030); cai pra `ended_at` se
 *  vier null (linhas muito antigas pré-trigger de imutabilidade). */
export function pickIssuedAt(row: {
  finalized_at: string | null;
  ended_at: string | null;
}): string | null {
  return normStr(row.finalized_at) ?? normStr(row.ended_at);
}

/** Pega o nome de exibição da médica — primeiro display_name, depois
 *  full_name, fallback "Médica" pra não quebrar a UI. */
export function extractDoctorName(
  doctors: AppointmentRow["doctors"],
): string {
  const doctor = Array.isArray(doctors) ? doctors[0] : doctors;
  if (!doctor) return "Médica";
  return normStr(doctor.display_name) ?? normStr(doctor.full_name) ?? "Médica";
}

/**
 * Converte o row do DB em `LatestPrescription`. Pura para teste.
 */
export function toLatestPrescription(
  row: AppointmentRow | null,
): LatestPrescription {
  if (!row) return { kind: "none" };
  const url = normStr(row.memed_prescription_url);
  if (!isHttpsLink(url)) return { kind: "none" };
  const issuedAt = pickIssuedAt(row);
  if (!issuedAt) return { kind: "none" };
  return {
    kind: "ready",
    url,
    issuedAt,
    appointmentId: row.id,
    doctorName: extractDoctorName(row.doctors),
  };
}

/**
 * Campos de endereço que precisam estar preenchidos pra considerar
 * "ready". Complemento é opcional por definição.
 */
export const REQUIRED_ADDRESS_FIELDS = [
  "address_zipcode",
  "address_street",
  "address_number",
  "address_district",
  "address_city",
  "address_state",
] as const;

export type CustomerAddressRow = {
  address_zipcode: string | null;
  address_street: string | null;
  address_number: string | null;
  address_complement: string | null;
  address_district: string | null;
  address_city: string | null;
  address_state: string | null;
};

/**
 * Converte o row do customer em `ShippingAddress`. Pura para teste.
 */
export function toShippingAddress(
  row: CustomerAddressRow | null,
): ShippingAddress {
  if (!row) return { kind: "missing" };
  const entries = REQUIRED_ADDRESS_FIELDS.map(
    (k) => [k, normStr(row[k])] as const,
  );
  const hasAny = entries.some(([, v]) => v !== null);
  if (!hasAny) return { kind: "missing" };
  const missing = entries
    .filter(([, v]) => v === null)
    .map(([k]) => k);
  if (missing.length > 0) {
    return { kind: "incomplete", missingFields: missing };
  }
  const street = entries[1][1]!;
  const number = entries[2][1]!;
  const district = entries[3][1]!;
  const city = entries[4][1]!;
  const state = entries[5][1]!;
  return {
    kind: "ready",
    zipcode: entries[0][1]!,
    summaryLine: `${street}, ${number} · ${district}`,
    cityState: `${city} / ${state}`,
    complement: normStr(row.address_complement),
  };
}

// ────────────────────────────────────────────────────────────────────
// Reschedule credit (PR-073 · D-081)
// ────────────────────────────────────────────────────────────────────

export type AppointmentCreditLinkRow = {
  id: string;
  source_reason: AppointmentCreditReason;
  created_at: string;
  expires_at: string;
};

/**
 * Converte o row do DB em `RescheduleCredit`. Pura para teste.
 * O filtro `status='active' AND expires_at > now` já é aplicado pela
 * query — aqui só transformamos os campos e calculamos dias
 * restantes (defensivo: se chegar row expirada, retorna `none`).
 */
export function toRescheduleCredit(
  row: AppointmentCreditLinkRow | null,
  now: Date = new Date(),
): RescheduleCredit {
  if (!row) return { kind: "none" };
  const days = daysUntilExpiry(row, now);
  if (days < 0) return { kind: "none" };
  return {
    kind: "ready",
    creditId: row.id,
    issuedAt: row.created_at,
    expiresAt: row.expires_at,
    daysRemaining: days,
    reason: row.source_reason,
  };
}

// ────────────────────────────────────────────────────────────────────
// IO canônica
// ────────────────────────────────────────────────────────────────────

/**
 * Busca os dados dos quick-links do dashboard. Fail-soft: qualquer
 * erro de banco devolve `none/missing` em vez de lançar, porque o
 * dashboard inteiro não pode cair só porque um atalho opcional
 * falhou. Erros são logados com `log.error` pra correlação.
 */
export async function getPatientQuickLinks(
  supabase: SupabaseClient,
  customerId: string,
  now: Date = new Date(),
): Promise<PatientQuickLinks> {
  const nowIso = now.toISOString();
  const [prescriptionRes, customerRes, creditRes] = await Promise.allSettled([
    supabase
      .from("appointments")
      .select(
        "id, memed_prescription_url, finalized_at, ended_at, doctors ( display_name, full_name )",
      )
      .eq("customer_id", customerId)
      .not("memed_prescription_url", "is", null)
      .order("finalized_at", { ascending: false, nullsFirst: false })
      .order("ended_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("customers")
      .select(
        "address_zipcode, address_street, address_number, address_complement, address_district, address_city, address_state",
      )
      .eq("id", customerId)
      .maybeSingle(),
    supabase
      .from("appointment_credits")
      .select("id, source_reason, created_at, expires_at")
      .eq("customer_id", customerId)
      .eq("status", "active")
      .gt("expires_at", nowIso)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);

  let latestPrescription: LatestPrescription = { kind: "none" };
  if (prescriptionRes.status === "fulfilled") {
    const { data, error } = prescriptionRes.value;
    if (error) {
      log.error("load prescription failed", {
        customerId,
        err: error.message,
      });
    } else {
      latestPrescription = toLatestPrescription(
        (data as AppointmentRow | null) ?? null,
      );
    }
  } else {
    log.error("load prescription threw", {
      customerId,
      err: String(prescriptionRes.reason),
    });
  }

  let shippingAddress: ShippingAddress = { kind: "missing" };
  if (customerRes.status === "fulfilled") {
    const { data, error } = customerRes.value;
    if (error) {
      log.error("load customer address failed", {
        customerId,
        err: error.message,
      });
    } else {
      shippingAddress = toShippingAddress(
        (data as CustomerAddressRow | null) ?? null,
      );
    }
  } else {
    log.error("load customer address threw", {
      customerId,
      err: String(customerRes.reason),
    });
  }

  let rescheduleCredit: RescheduleCredit = { kind: "none" };
  if (creditRes.status === "fulfilled") {
    const { data, error } = creditRes.value;
    if (error) {
      log.error("load reschedule credit failed", {
        customerId,
        err: error.message,
      });
    } else {
      rescheduleCredit = toRescheduleCredit(
        (data as AppointmentCreditLinkRow | null) ?? null,
        now,
      );
    }
  } else {
    log.error("load reschedule credit threw", {
      customerId,
      err: String(creditRes.reason),
    });
  }

  return { latestPrescription, shippingAddress, rescheduleCredit };
}
