-- Inbound reply storage + auto-response (calendly nudge) lifecycle.
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS outreach.inbound_emails (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id                uuid NOT NULL REFERENCES outreach.users (id),
    campaign_id             uuid NOT NULL REFERENCES outreach.campaigns (id) ON DELETE CASCADE,
    email_send_id           uuid NOT NULL REFERENCES outreach.email_sends (id) ON DELETE CASCADE,
    drafting_item_id        uuid NOT NULL REFERENCES outreach.drafting_items (id) ON DELETE CASCADE,
    provider_email_id       text NOT NULL,
    from_email              text NOT NULL,
    to_emails               text[] NOT NULL DEFAULT '{}'::text[],
    subject                 text,
    text_body               text,
    html_body               text,
    headers                 jsonb NOT NULL DEFAULT '{}'::jsonb,
    received_at             timestamptz NOT NULL DEFAULT now(),
    forwarded_to_sender_at  timestamptz,
    auto_reply_skipped      text,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider_email_id)
);

CREATE INDEX IF NOT EXISTS idx_inbound_emails_owner_received
    ON outreach.inbound_emails (owner_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbound_emails_email_send
    ON outreach.inbound_emails (email_send_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbound_emails_campaign
    ON outreach.inbound_emails (owner_id, campaign_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbound_emails_item
    ON outreach.inbound_emails (drafting_item_id, received_at DESC);

CREATE TABLE IF NOT EXISTS outreach.reply_sends (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id                uuid NOT NULL REFERENCES outreach.users (id),
    campaign_id             uuid NOT NULL REFERENCES outreach.campaigns (id) ON DELETE CASCADE,
    inbound_email_id        uuid NOT NULL REFERENCES outreach.inbound_emails (id) ON DELETE CASCADE,
    drafting_item_id        uuid NOT NULL REFERENCES outreach.drafting_items (id) ON DELETE CASCADE,
    email_send_id           uuid NOT NULL REFERENCES outreach.email_sends (id) ON DELETE CASCADE,
    status                  text NOT NULL DEFAULT 'queued',
    subject                 text,
    body_text               text,
    provider_message_id     text,
    provider_rfc_message_id text,
    scheduled_for           timestamptz NOT NULL,
    sent_at                 timestamptz,
    error_message           text,
    model_id                text,
    prompt_version          text,
    skill_version           text,
    skill_sha256            text,
    used_tools              jsonb NOT NULL DEFAULT '[]'::jsonb,
    orchestration_job_id    uuid,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'reply_sends_status_check'
        AND conrelid = 'outreach.reply_sends'::regclass
    ) THEN
      ALTER TABLE outreach.reply_sends
        ADD CONSTRAINT reply_sends_status_check
        CHECK (status IN ('queued', 'drafting', 'sent', 'failed', 'skipped')) NOT VALID;
    END IF;
END $$;

-- One auto-response per original outbound send (anti-loop).
CREATE UNIQUE INDEX IF NOT EXISTS idx_reply_sends_one_per_outbound
    ON outreach.reply_sends (email_send_id);
CREATE INDEX IF NOT EXISTS idx_reply_sends_owner_scheduled
    ON outreach.reply_sends (owner_id, scheduled_for)
    WHERE status IN ('queued', 'drafting');
CREATE INDEX IF NOT EXISTS idx_reply_sends_owner_status
    ON outreach.reply_sends (owner_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_reply_sends_inbound
    ON outreach.reply_sends (inbound_email_id);

GRANT USAGE ON SCHEMA outreach TO postgres, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA outreach TO postgres, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA outreach TO postgres, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA outreach
  GRANT ALL ON TABLES TO postgres, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA outreach
  GRANT ALL ON SEQUENCES TO postgres, service_role;
