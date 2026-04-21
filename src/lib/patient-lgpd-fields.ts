/**
 * src/lib/patient-lgpd-fields.ts — Onda 2A · PR-016 · D-051
 *
 * Allowlist explícita de colunas incluídas no export LGPD do paciente
 * (Art. 18, V — portabilidade de dados).
 *
 * Por que um allowlist em vez de `SELECT *`:
 *
 *  1. **Defesa em profundidade contra vazamento por novas colunas.**
 *     Se alguém adiciona `appointments.internal_triage_score` amanhã
 *     sem notar o impacto LGPD, `SELECT *` passaria a exportar essa
 *     informação interna para o paciente. Com allowlist, novas colunas
 *     ficam fora até decisão explícita.
 *
 *  2. **Credenciais e tokens nunca saem.** `appointments.video_doctor_token`,
 *     `appointments.video_patient_token`, `payments.asaas_raw` e afins
 *     contêm segredos que o paciente não precisa ver (e alguns
 *     representam chaves de acesso ao provedor externo).
 *
 *  3. **Shape estável e testável.** O contrato do arquivo JSON que o
 *     paciente baixa fica imune a adições silenciosas — quebrar o
 *     contrato exige mexer aqui. Testes podem fazer snapshot do shape.
 *
 *  4. **Documentação inline.** Cada coluna listada responde "por que o
 *     titular tem interesse legítimo nisso?". Revisão jurídica/DPO
 *     passa a ler um só arquivo.
 *
 * Princípios de inclusão:
 *
 *  - **Sim:** dados identificáveis do titular, dados clínicos do
 *    tratamento dele, timestamps que permitem reconstruir a experiência.
 *  - **Sim:** metadados imutáveis (acceptance_hash, terms_version) que
 *    provam o que o titular aceitou.
 *  - **Não:** credenciais (tokens, URLs assinadas do provedor de vídeo),
 *    PII duplicada em payload bruto de terceiros (`asaas_raw`), IDs
 *    externos de vendor (`asaas_customer_id`), campos internos (notes
 *    do admin, flags de reliability da médica, audit dos outros atores).
 *  - **Não:** colunas do provedor de vídeo (`daily_raw`, `daily_room_id`,
 *    `video_room_name`) — são detalhes de implementação e expiram.
 */

export const CUSTOMER_COLUMNS = [
  "id",
  "name",
  "email",
  "phone",
  "cpf",
  "address_zipcode",
  "address_street",
  "address_number",
  "address_complement",
  "address_district",
  "address_city",
  "address_state",
  // vínculo com auth.users pra o titular saber se tem login ativo
  "user_id",
  // anonimização: se já foi anonimizado, o export mostra evidência
  "anonymized_at",
  "anonymized_ref",
  "created_at",
  "updated_at",
] as const;

export const APPOINTMENT_COLUMNS = [
  "id",
  "doctor_id",
  "customer_id",
  "payment_id",
  "kind",
  "status",
  "scheduled_at",
  "scheduled_until",
  // link de vídeo público (URL da sala) — sem tokens, que são credenciais
  "video_room_url",
  "recording_consent",
  "recording_url",
  "started_at",
  "ended_at",
  "duration_seconds",
  // dados clínicos do próprio titular (direito de acesso ao prontuário)
  "anamnese",
  "hipotese",
  "conduta",
  "memed_prescription_id",
  "memed_prescription_url",
  "prescribed_plan_id",
  "prescription_status",
  "finalized_at",
  "cancelled_at",
  "cancelled_reason",
  // política de no-show e reembolso — afeta o titular
  "no_show_policy_applied_at",
  "refund_required",
  "refund_processed_at",
  "no_show_notes",
  // rastros de reconciliação (útil em disputa "minha consulta não foi registrada")
  "reconciled_at",
  "reconciled_by_source",
  "refund_external_ref",
  "refund_processed_notes",
  "pending_payment_expires_at",
  "created_at",
  "updated_at",
] as const;

export const FULFILLMENT_COLUMNS = [
  "id",
  "appointment_id",
  "customer_id",
  "doctor_id",
  "plan_id",
  "payment_id",
  "status",
  "accepted_at",
  "paid_at",
  "pharmacy_requested_at",
  "shipped_at",
  "delivered_at",
  "cancelled_at",
  "tracking_note",
  "cancelled_reason",
  // snapshot de envio (endereço é PII direta do titular)
  "shipping_recipient_name",
  "shipping_zipcode",
  "shipping_street",
  "shipping_number",
  "shipping_complement",
  "shipping_district",
  "shipping_city",
  "shipping_state",
  "reconsulta_nudged_at",
  "created_at",
  "updated_at",
] as const;

export const PAYMENT_COLUMNS = [
  "id",
  "customer_id",
  "plan_id",
  "subscription_id",
  "fulfillment_id",
  "amount_cents",
  "billing_type",
  "status",
  "due_date",
  // URLs públicas do recibo no Asaas — titular pode ter guardado esse link
  "invoice_url",
  "bank_slip_url",
  "paid_at",
  "refunded_at",
  "created_at",
  "updated_at",
  // NÃO INCLUSO: asaas_payment_id, asaas_env (ids externos opacos),
  //              asaas_raw (payload bruto — duplica PII + inclui dados do
  //              vendor irrelevantes ao titular),
  //              pix_qr_code, pix_qr_code_image (expiram; paciente já
  //              usou ou não vai mais usar).
] as const;

export const PLAN_ACCEPTANCE_COLUMNS = [
  "id",
  "fulfillment_id",
  "appointment_id",
  "customer_id",
  "plan_id",
  "accepted_at",
  "acceptance_text",
  "acceptance_hash",
  "terms_version",
  "shipping_snapshot",
  "user_id",
  // ip_address e user_agent: evidência de autoria do próprio titular;
  // não há risco de vazamento — é o IP do próprio paciente.
  "ip_address",
  "user_agent",
] as const;

export const APPOINTMENT_NOTIFICATION_COLUMNS = [
  "id",
  "appointment_id",
  "channel",
  "kind",
  "template_name",
  "status",
  "scheduled_for",
  "sent_at",
  "delivered_at",
  "read_at",
  "message_id",
  "created_at",
  "updated_at",
  // NÃO INCLUSO: payload (request body bruto — pode conter metadata
  //              interna do provedor), error (stack traces internas).
] as const;

export const FULFILLMENT_ADDRESS_CHANGE_COLUMNS = [
  "id",
  "fulfillment_id",
  "changed_at",
  "source",
  "before_snapshot",
  "after_snapshot",
  "note",
  // NÃO INCLUSO: changed_by_user_id — exposição do admin que editou não
  //              é útil pro titular e pode virar atrito operacional.
] as const;

/**
 * Helper pra usar nas queries Supabase: `.select(columnsList(CUSTOMER_COLUMNS))`.
 *
 * Exportado separado pra que o teste possa verificar shape sem depender
 * do runtime Supabase.
 */
export function columnsList(
  columns: ReadonlyArray<string>
): string {
  return columns.join(",");
}

/**
 * Conjunto completo dos allowlists, indexados por nome de tabela.
 * Útil pra testes de invariantes ("nenhum campo sensível escapa").
 */
export const LGPD_EXPORT_ALLOWLIST = {
  customers: CUSTOMER_COLUMNS,
  appointments: APPOINTMENT_COLUMNS,
  fulfillments: FULFILLMENT_COLUMNS,
  payments: PAYMENT_COLUMNS,
  plan_acceptances: PLAN_ACCEPTANCE_COLUMNS,
  appointment_notifications: APPOINTMENT_NOTIFICATION_COLUMNS,
  fulfillment_address_changes: FULFILLMENT_ADDRESS_CHANGE_COLUMNS,
} as const;

/**
 * Colunas explicitamente bloqueadas. Se alguma aparecer num export, é bug.
 * Esta lista é descritiva (não aplicada automaticamente) e serve como
 * âncora de revisão de código.
 */
export const LGPD_EXPORT_FORBIDDEN_FIELDS = [
  // credenciais / tokens
  "video_doctor_token",
  "video_patient_token",
  // payloads brutos de vendor (duplicam PII, incluem dados do provedor)
  "asaas_raw",
  "daily_raw",
  "asaas_customer_id",
  "asaas_payment_id",
  // detalhes internos do provedor de vídeo
  "daily_room_id",
  "daily_meeting_session_id",
  "video_room_name",
  // campos internos de notificação (stack traces, request body bruto)
  "payload",
  "error",
  // audit de outros atores
  "changed_by_user_id",
  "cancelled_by_user_id",
  "refund_processed_by",
] as const;
