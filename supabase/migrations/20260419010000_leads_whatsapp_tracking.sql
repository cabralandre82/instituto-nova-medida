-- ============================================================================
-- 20260419010000_leads_whatsapp_tracking.sql
-- Adiciona rastreamento da MSG 1 (boas-vindas) enviada via WhatsApp Cloud API
-- a cada lead novo. Permite reprocessar/ressubmeter mensagens que falharam.
-- ============================================================================

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS whatsapp_msg1_status      text
    CHECK (whatsapp_msg1_status IS NULL OR whatsapp_msg1_status IN ('pending','sent','failed','delivered','read')),
  ADD COLUMN IF NOT EXISTS whatsapp_msg1_message_id  text,
  ADD COLUMN IF NOT EXISTS whatsapp_msg1_sent_at     timestamptz,
  ADD COLUMN IF NOT EXISTS whatsapp_msg1_error       text;

CREATE INDEX IF NOT EXISTS idx_leads_whatsapp_msg1_status
  ON leads (whatsapp_msg1_status)
  WHERE whatsapp_msg1_status IS NOT NULL;

COMMENT ON COLUMN leads.whatsapp_msg1_status     IS 'Status do disparo da MSG 1 (boas-vindas) via WhatsApp Cloud API';
COMMENT ON COLUMN leads.whatsapp_msg1_message_id IS 'ID retornado pela Meta para a MSG 1, usado pra correlacionar webhooks de status';
COMMENT ON COLUMN leads.whatsapp_msg1_sent_at    IS 'Timestamp do POST bem-sucedido para /messages';
COMMENT ON COLUMN leads.whatsapp_msg1_error      IS 'Detalhes do erro caso o envio tenha falhado (code + message + details)';
