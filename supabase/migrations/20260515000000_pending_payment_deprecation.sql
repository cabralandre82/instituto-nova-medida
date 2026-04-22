-- ───────────────────────────────────────────────────────────────────────
-- Migration: 20260515000000_pending_payment_deprecation
-- Decisão arquitetural: D-079 (PR-071 · finding 1.4)
--
-- Contexto
-- ────────
-- `appointments.status = 'pending_payment'` é resíduo do fluxo ANTIGO
-- ("agendar + pagar antes da consulta") descontinuado em D-044:
--
--   D-044: consulta inicial é GRATUITA. O paciente agenda, a médica
--   atende, e só então — se apropriado — a médica emite uma indicação
--   que vira um `fulfillment` (pago). `appointments` em si não tem
--   mais etapa de pagamento no fluxo canônico.
--
-- O que ainda cria `appointments.status='pending_payment'`:
--
--   - RPC `book_pending_appointment_slot()` (migration 20260419070000)
--   - Invocada por `/api/agendar/reserve` (rota legada)
--   - Gate em código: `isLegacyPurchaseEnabled()` em
--     `src/lib/legacy-purchase-gate.ts` — default `false` em produção
--     desde PR-020 · D-048.
--
-- Portanto em produção estável **nenhum novo appointment
-- pending_payment é criado**. As linhas existentes são histórico.
-- Mesmo assim o enum value `pending_payment` permanece (CHECK continua
-- aceitando) porque:
--
--   (a) Desabilitar o enum quebraria a RPC legada (que o admin pode
--       excepcionalmente reativar via LEGACY_PURCHASE_ENABLED=true);
--   (b) Queries analíticas / UI / state-machine D-070 ainda precisam
--       distinguir linhas históricas pra renderizar corretamente.
--
-- Finding [1.4 🟡 MÉDIO] da auditoria sinaliza o risco UX: se um
-- appointment ficar preso em `pending_payment` (bug, ghost,
-- payment-gateway flaky), o paciente vê "Aguardando confirmação do
-- pagamento" sem ação possível, e nenhum alerta toca no admin.
--
-- Solução
-- ────────
-- Três peças complementares:
--
-- 1) **Documentação estrutural** — COMMENTs nas colunas relevantes
--    marcando o estado como LEGADO. Próximo agente que grep-ar
--    `pending_payment` no DB vê imediatamente que é resíduo D-044,
--    não fluxo ativo.
--
-- 2) **Índice parcial `idx_appointments_pending_payment_legacy`** —
--    otimiza watchdog de admin-inbox que vai detectar
--    `pending_payment` antigas. Partial garante custo quase zero em
--    produção (tabela terá 0 linhas matching).
--
-- 3) **Lado app-side (fora desta migration)** — PR-071 adiciona:
--    - `admin_inbox.appointment_pending_payment_stale` com SLA 24h
--      (conforme sugestão explícita do finding item (c)).
--    - UI do paciente: card "pending_payment" ganha CTA WhatsApp de
--      suporte (finding item (b)).
--
-- Não-objetivos
-- ────────────
-- - NÃO remover o enum value `pending_payment`. Isso quebraria
--   `book_pending_appointment_slot` + state machine D-070 + RPC
--   `activate_appointment_after_payment` + linhas históricas.
--   Remoção só é aceitável depois de um período (>180 dias) de
--   `LEGACY_PURCHASE_ENABLED=false` sem a menor exceção, com
--   migration dedicada e escopo CI maior.
-- - NÃO remover a coluna `pending_payment_expires_at`. Mesma razão.
-- - NÃO mudar o CHECK constraint da state machine D-070. Transições
--   continuam válidas pra quando o modo legacy for reativado.
-- ───────────────────────────────────────────────────────────────────────

-- 1) Documentação estrutural
-- ──────────────────────────

comment on column public.appointments.pending_payment_expires_at is
  'LEGACY D-044. Só populado pela RPC book_pending_appointment_slot (fluxo /agendar/[plano] ativado por LEGACY_PURCHASE_ENABLED=true). No modelo canônico D-044 consultas são gratuitas e esta coluna permanece NULL em novos registros. Documentado em D-079.';

-- Não dá pra comentar um enum value direto; o comment na coluna status
-- serve como âncora. Usamos o template documenta-valor-por-valor
-- informal ainda-em-prod dentro do próprio comment.
comment on column public.appointments.status is
  'Enum appointment_status. VALORES ATIVOS: scheduled/confirmed/in_progress/completed/cancelled_by_admin/cancelled_by_doctor/cancelled_by_patient/no_show_patient/no_show_doctor. LEGACY (D-044): pending_payment — só criado pelo fluxo /agendar/[plano] quando LEGACY_PURCHASE_ENABLED=true. Em produção estável nenhum novo pending_payment é criado; linhas existentes são históricas. Ver D-079.';

-- 2) Índice parcial pra watchdog `pending_payment > 24h`
-- ─────────────────────────────────────────────────────
-- Serve o item candidato `appointment_pending_payment_stale` no
-- admin_inbox (PR-071 · lib). Partial porque em produção estável essa
-- lista tende a zero; custo de manutenção desprezível.
--
-- Ordena por `pending_payment_expires_at ASC` pra permitir "me dê o
-- mais antigo primeiro" em O(log n) via .order().limit(1) — padrão
-- usado em `admin-inbox.ts::countWithOldest`.

create index if not exists idx_appointments_pending_payment_legacy
  on public.appointments (pending_payment_expires_at asc)
  where status = 'pending_payment';

comment on index public.idx_appointments_pending_payment_legacy is
  'PR-071 · D-079 · watchdog finding 1.4. Índice parcial das appointments ainda presas em pending_payment (fluxo LEGACY D-044). Em produção estável esta lista tende a zero; tamanho do índice é desprezível. Usado por admin-inbox.ts pra detectar ghosts > 24h.';
