-- ──────────────────────────────────────────────────────────────────────────
-- Migration 007 — Storage privado para comprovantes de PIX (e futuros NF-e).
-- ──────────────────────────────────────────────────────────────────────────
-- Cria o bucket `payouts-proofs` (private). Toda manipulação acontece via
-- API server-side com service role — o bucket NÃO é exposto diretamente
-- ao cliente, e os links são sempre signed URLs de curta duração (60s).
--
-- Convenção de path:
--   payouts/{payout_id}/{timestamp}-{filename_slug}.{ext}
--
-- Tipos aceitos (validado na API): application/pdf, image/png, image/jpeg.
-- Tamanho máximo: 5 MB (validado na API; bucket aceita até 10 MB pra dar
-- margem de manobra a anexos como NF-e PDF/A no futuro).
--
-- A coluna `doctor_payouts.pix_proof_url` (já existente desde a 006) passa
-- a guardar o STORAGE PATH em vez de URL externa. A API GET resolve isso
-- pra signed URL na hora.
--
-- ┌─ NOTA IMPORTANTE ─────────────────────────────────────────────────────┐
-- │ Não criamos policies em storage.objects: a única forma de tocar no    │
-- │ bucket é via service role (admin client), que bypassa RLS. Isso       │
-- │ centraliza autorização nos handlers Next.js (requireAdmin/Doctor +    │
-- │ checagem de ownership), evitando policies SQL frágeis.                │
-- └───────────────────────────────────────────────────────────────────────┘
-- ──────────────────────────────────────────────────────────────────────────

-- Cria o bucket se não existir. Idempotente.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'payouts-proofs',
  'payouts-proofs',
  false,                      -- private
  10485760,                   -- 10 MB hard cap (API valida 5 MB lógico)
  array[
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/webp'
  ]
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Comentário documental (sobrevive em pg_dump)
comment on column public.doctor_payouts.pix_proof_url is
  'Storage path no bucket payouts-proofs (ex: payouts/{id}/{ts}-comprovante.pdf). '
  'Resolvido pra signed URL pela API GET /api/admin/payouts/{id}/proof. '
  'Pode coexistir com URL externa de backfill (qualquer string que comece com http).';

comment on column public.doctor_payouts.receipt_url is
  'DEPRECATED — mantido por compatibilidade. Use pix_proof_url + bucket payouts-proofs.';
