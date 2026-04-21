-- ============================================================================
-- Migration · Hardening de texto livre clínico/operacional
-- PR-036-B · D-055 · audit [9.1] (remaining)
-- ============================================================================
--
-- Motivação:
--   1. A Onda 2D (PR-036) fechou `leads.answers` com CHECK + sanitize app.
--   2. Sobrou, do finding [9.1], o restante dos campos de texto livre:
--        - `appointments.hipotese` / `conduta` / `anamnese` (médica)
--        - `fulfillments.tracking_note` / `cancelled_reason` (operador)
--        - `doctors.notes` (admin)
--        - `doctor_payouts.notes`/`failed_reason`/`cancelled_reason` (admin)
--        - `doctor_billing_documents.validation_notes` (admin)
--   3. A camada de app agora sanitiza via `sanitizeFreeText` de
--      `src/lib/text-sanitize.ts` (bloqueia NULL/ESC/zero-width/bidi,
--      normaliza newlines, limita tamanho e número de linhas). Mesmo
--      assim, queremos um **teto duro no banco** — defense-in-depth pra
--      caso o operador execute UPDATE direto via service_role, import
--      SQL ou backfill.
--
-- Trade-off (limites):
--   Batem com `APPOINTMENT_TEXT_LIMITS` e `FULFILLMENT_TEXT_LIMITS` da
--   aplicação, mas com folga (+2x ou +4KB) porque o banco não deve
--   falhar em casos de borda que a app aceita; o CHECK é uma última
--   linha de defesa contra payloads patológicos (10MB+), não uma
--   validação fina.
--
--   - appointments.hipotese    ≤ 8 KB   (app: 4 000 chars)
--   - appointments.conduta     ≤ 8 KB   (app: 4 000 chars)
--   - appointments.anamnese    ≤ 64 KB  (jsonb; app: 32 KB)
--   - fulfillments.tracking_note  ≤ 1 KB   (app: 500 chars)
--   - fulfillments.cancelled_reason ≤ 4 KB  (app: 2 000 chars)
--   - doctors.notes            ≤ 8 KB
--   - doctor_payouts.notes     ≤ 4 KB
--   - doctor_payouts.cancelled_reason ≤ 4 KB
--   - doctor_payouts.failed_reason    ≤ 4 KB
--   - doctor_billing_documents.validation_notes ≤ 4 KB
--
-- `char_length` é preferível a `length` pra colunas text (conta grafemas
-- em UTF-8, não bytes). `pg_column_size` usado em jsonb porque
-- char_length não se aplica.
--
-- IMPORTANTE: limites aplicados com `check(... is null or ...)` — todos
-- esses campos são opcionais no schema; o check só atua quando há valor.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────
-- appointments
-- ────────────────────────────────────────────────────────────────────────

alter table public.appointments
  drop constraint if exists appointments_hipotese_len_chk;
alter table public.appointments
  add constraint appointments_hipotese_len_chk
  check (hipotese is null or char_length(hipotese) <= 8192);

alter table public.appointments
  drop constraint if exists appointments_conduta_len_chk;
alter table public.appointments
  add constraint appointments_conduta_len_chk
  check (conduta is null or char_length(conduta) <= 8192);

alter table public.appointments
  drop constraint if exists appointments_anamnese_size_chk;
alter table public.appointments
  add constraint appointments_anamnese_size_chk
  check (anamnese is null or pg_column_size(anamnese) < 65536);

comment on constraint appointments_hipotese_len_chk on public.appointments is
  'PR-036-B / D-055. Teto duro 8 KB em hipótese (app limita a 4 KB).';
comment on constraint appointments_conduta_len_chk on public.appointments is
  'PR-036-B / D-055. Teto duro 8 KB em conduta (app limita a 4 KB).';
comment on constraint appointments_anamnese_size_chk on public.appointments is
  'PR-036-B / D-055. Teto duro 64 KB em anamnese jsonb (app limita a 32 KB).';

-- ────────────────────────────────────────────────────────────────────────
-- fulfillments
-- ────────────────────────────────────────────────────────────────────────

alter table public.fulfillments
  drop constraint if exists fulfillments_tracking_note_len_chk;
alter table public.fulfillments
  add constraint fulfillments_tracking_note_len_chk
  check (tracking_note is null or char_length(tracking_note) <= 1024);

alter table public.fulfillments
  drop constraint if exists fulfillments_cancelled_reason_len_chk;
alter table public.fulfillments
  add constraint fulfillments_cancelled_reason_len_chk
  check (cancelled_reason is null or char_length(cancelled_reason) <= 4096);

comment on constraint fulfillments_tracking_note_len_chk on public.fulfillments is
  'PR-036-B / D-055. Teto duro 1 KB em tracking_note (app limita a 500 chars).';
comment on constraint fulfillments_cancelled_reason_len_chk on public.fulfillments is
  'PR-036-B / D-055. Teto duro 4 KB em cancelled_reason (app limita a 2 KB).';

-- ────────────────────────────────────────────────────────────────────────
-- doctors · notes (admin-only)
-- ────────────────────────────────────────────────────────────────────────

alter table public.doctors
  drop constraint if exists doctors_notes_len_chk;
alter table public.doctors
  add constraint doctors_notes_len_chk
  check (notes is null or char_length(notes) <= 8192);

comment on constraint doctors_notes_len_chk on public.doctors is
  'PR-036-B / D-055. Teto duro em doctors.notes (admin free-text).';

-- ────────────────────────────────────────────────────────────────────────
-- doctor_payouts · notes, failed_reason, cancelled_reason
-- ────────────────────────────────────────────────────────────────────────

alter table public.doctor_payouts
  drop constraint if exists doctor_payouts_notes_len_chk;
alter table public.doctor_payouts
  add constraint doctor_payouts_notes_len_chk
  check (notes is null or char_length(notes) <= 4096);

alter table public.doctor_payouts
  drop constraint if exists doctor_payouts_failed_reason_len_chk;
alter table public.doctor_payouts
  add constraint doctor_payouts_failed_reason_len_chk
  check (failed_reason is null or char_length(failed_reason) <= 4096);

alter table public.doctor_payouts
  drop constraint if exists doctor_payouts_cancelled_reason_len_chk;
alter table public.doctor_payouts
  add constraint doctor_payouts_cancelled_reason_len_chk
  check (cancelled_reason is null or char_length(cancelled_reason) <= 4096);

comment on constraint doctor_payouts_notes_len_chk on public.doctor_payouts is
  'PR-036-B / D-055. Teto duro em doctor_payouts.notes (admin free-text).';

-- ────────────────────────────────────────────────────────────────────────
-- doctor_billing_documents · validation_notes
-- ────────────────────────────────────────────────────────────────────────

alter table public.doctor_billing_documents
  drop constraint if exists doctor_billing_documents_validation_notes_len_chk;
alter table public.doctor_billing_documents
  add constraint doctor_billing_documents_validation_notes_len_chk
  check (
    validation_notes is null or char_length(validation_notes) <= 4096
  );

comment on constraint doctor_billing_documents_validation_notes_len_chk
  on public.doctor_billing_documents is
  'PR-036-B / D-055. Teto duro em validation_notes (admin free-text).';

-- ────────────────────────────────────────────────────────────────────────
-- Validação final: os limites aqui definidos SÃO o piso. A camada de
-- app aplica limites menores e sanitização de caracteres. Se alguém
-- aumentar o limite da app SEM subir esse CHECK, o app seguirá vetando
-- primeiro (comportamento desejado).
-- ────────────────────────────────────────────────────────────────────────
