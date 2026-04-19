-- ============================================================================
-- 20260419020000_whatsapp_events.sql
-- Tabela append-only de eventos brutos recebidos da Meta WhatsApp via webhook.
-- Serve como audit log + permite reprocessar caso o handler tenha bug.
-- ============================================================================

CREATE TABLE IF NOT EXISTS whatsapp_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at   timestamptz NOT NULL DEFAULT now(),

  -- Identificação rápida (extraídos do payload pra indexação)
  event_type    text,        -- 'message_status' | 'message' | 'unknown'
  message_id    text,        -- wamid.* (quando aplicável)
  status        text,        -- 'sent' | 'delivered' | 'read' | 'failed'
  recipient_id  text,        -- número do destinatário (sem '+')
  phone_number_id text,      -- nosso phone_number_id (caso operemos múltiplos)

  -- Payload completo pra auditoria/replay
  payload       jsonb NOT NULL,

  -- Erro (se status=failed)
  error_code    integer,
  error_title   text,
  error_message text
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_events_received_at  ON whatsapp_events (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_whatsapp_events_message_id   ON whatsapp_events (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_whatsapp_events_recipient_id ON whatsapp_events (recipient_id) WHERE recipient_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_whatsapp_events_status       ON whatsapp_events (status) WHERE status IS NOT NULL;

ALTER TABLE whatsapp_events ENABLE ROW LEVEL SECURITY;

-- Sem policies = ninguém com role anon/authenticated lê. Só service_role (admin) acessa.
-- (mesmo padrão usado em leads).

COMMENT ON TABLE  whatsapp_events            IS 'Log append-only dos eventos enviados pela Meta WhatsApp via webhook';
COMMENT ON COLUMN whatsapp_events.event_type IS 'Categoria do evento: message_status (entrega) | message (resposta do paciente) | unknown';
COMMENT ON COLUMN whatsapp_events.message_id IS 'wamid retornado pela Meta no envio original — chave pra correlacionar com leads.whatsapp_msg1_message_id';
COMMENT ON COLUMN whatsapp_events.payload    IS 'Payload integral do webhook. Verdade única em caso de divergência.';
