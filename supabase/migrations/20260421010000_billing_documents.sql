-- Instituto Nova Medida · Migration 015
-- D-041 · Upload de NF-e pela médica + validação admin + cron de cobrança
--
-- Contexto:
--   D-040 automatizou a geração dos payouts e a promoção de earnings, mas
--   o ciclo fiscal ainda é manual fora do sistema: a médica emite NF-e no
--   prefeitura dela, envia por e-mail/WhatsApp pro instituto, e o admin
--   arquiva. Isso quebra auditabilidade (D-022) e cria ruído operacional.
--
-- Estratégia:
--   1. Bucket dedicado `billing-documents` (separado de `payouts-proofs`
--      que é do lado do instituto). Mesmas políticas: private, service
--      role only, signed URLs curtas.
--   2. UNIQUE constraint em `doctor_billing_documents(payout_id)` — 1 NF
--      por payout. Se médica precisar trocar, faz DELETE + POST (simples
--      e suficiente; versionamento é overkill pro MVP).
--   3. Nova coluna `doctor_payouts.last_nf_reminder_at` pra idempotência
--      do cron de cobrança (evita spamar a médica mais de 1x/dia).

-- ──────────────────────────────────────────────────────────────────────────
-- 1) Bucket privado `billing-documents`
-- ──────────────────────────────────────────────────────────────────────────
--
-- Mesma convenção do `payouts-proofs`:
--   - private
--   - 10 MB hard cap (API valida 5 MB lógico)
--   - aceita PDF/PNG/JPG/WEBP + application/xml (alguns municípios emitem
--     só XML NFS-e como "autêntico"; PDF costuma ser derivado)
--
-- Path: billing/{payout_id}/{timestamp}-{slug}.{ext}

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'billing-documents',
  'billing-documents',
  false,
  10485760,
  array[
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/webp',
    'application/xml',
    'text/xml'
  ]
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ──────────────────────────────────────────────────────────────────────────
-- 2) UNIQUE em doctor_billing_documents(payout_id)
-- ──────────────────────────────────────────────────────────────────────────
--
-- 1 NF por payout. Se precisar substituir (ex: NF emitida com erro),
-- médica DELETE + POST novamente. Operação explícita é melhor que
-- coleção invisível de documentos abandonados.

create unique index if not exists ux_dbd_payout_unique
  on public.doctor_billing_documents(payout_id);

comment on table public.doctor_billing_documents is
  'NF-e (ou equivalente) emitida pela médica por payout. Armazenada em '
  'storage bucket billing-documents com path billing/{payout_id}/... '
  'UNIQUE por payout — substituição é DELETE+POST explícito (D-041).';

comment on column public.doctor_billing_documents.document_url is
  'Storage path no bucket billing-documents. Resolvido pra signed URL '
  'pela API (GET /api/{medico,admin}/payouts/[id]/billing-document).';

comment on column public.doctor_billing_documents.validated_at is
  'Preenchido pelo admin em /admin/payouts/[id]. Se null, documento está '
  'em "recebido, aguardando validação". Cobrança (cron) para quando '
  'documento tem validated_at OR payout.paid_at está null.';

-- ──────────────────────────────────────────────────────────────────────────
-- 3) doctor_payouts.last_nf_reminder_at
-- ──────────────────────────────────────────────────────────────────────────
--
-- Idempotência do cron `notify-pending-documents`: se ele já cobrou a
-- médica hoje pra este payout, não cobra de novo (evita ruído mesmo
-- que o cron rode N vezes).

alter table public.doctor_payouts
  add column if not exists last_nf_reminder_at timestamptz;

comment on column public.doctor_payouts.last_nf_reminder_at is
  'Timestamp do último WhatsApp/e-mail cobrando a NF-e deste payout. '
  'Usado pelo cron notify-pending-documents pra manter cadência de '
  'lembretes (1/dia após D+7 do paid_at até validated_at).';

-- Índice parcial pra query do cron: payouts confirmed sem NF validada
-- e sem lembrete recente.
create index if not exists idx_dp_pending_nf_reminder
  on public.doctor_payouts(paid_at, last_nf_reminder_at)
  where status = 'confirmed';
