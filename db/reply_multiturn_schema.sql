-- Multi-turn reply + deferred follow-up queue.
-- Idempotent. Apply after db/reply_schema.sql.

-- Thread-level suppress (hard opt-out).
ALTER TABLE outreach.email_sends
  ADD COLUMN IF NOT EXISTS reply_suppressed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reply_suppress_reason text;

ALTER TABLE outreach.reply_sends
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'immediate',
  ADD COLUMN IF NOT EXISTS disposition text,
  ADD COLUMN IF NOT EXISTS include_calendly boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS defer_until date,
  ADD COLUMN IF NOT EXISTS defer_reason text,
  ADD COLUMN IF NOT EXISTS followup_of_reply_id uuid REFERENCES outreach.reply_sends (id),
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_reason text;

-- Follow-ups are not tied 1:1 to a new inbound; allow null inbound for scheduled follow-ups.
ALTER TABLE outreach.reply_sends
  ALTER COLUMN inbound_email_id DROP NOT NULL;

-- Allow many auto-replies per outbound thread (one decision per inbound immediate).
DROP INDEX IF EXISTS outreach.idx_reply_sends_one_per_outbound;

CREATE UNIQUE INDEX IF NOT EXISTS idx_reply_sends_one_per_inbound
    ON outreach.reply_sends (inbound_email_id)
    WHERE inbound_email_id IS NOT NULL
      AND kind = 'immediate';

DO $$
BEGIN
  ALTER TABLE outreach.reply_sends DROP CONSTRAINT IF EXISTS reply_sends_status_check;
EXCEPTION WHEN undefined_object THEN
  NULL;
END $$;

ALTER TABLE outreach.reply_sends
  ADD CONSTRAINT reply_sends_status_check
  CHECK (status IN (
    'queued', 'drafting', 'sent', 'failed', 'skipped', 'scheduled', 'cancelled'
  )) NOT VALID;

DO $$
BEGIN
  ALTER TABLE outreach.reply_sends DROP CONSTRAINT IF EXISTS reply_sends_kind_check;
EXCEPTION WHEN undefined_object THEN
  NULL;
END $$;

ALTER TABLE outreach.reply_sends
  ADD CONSTRAINT reply_sends_kind_check
  CHECK (kind IN ('immediate', 'followup')) NOT VALID;

DO $$
BEGIN
  ALTER TABLE outreach.reply_sends DROP CONSTRAINT IF EXISTS reply_sends_disposition_check;
EXCEPTION WHEN undefined_object THEN
  NULL;
END $$;

ALTER TABLE outreach.reply_sends
  ADD CONSTRAINT reply_sends_disposition_check
  CHECK (
    disposition IS NULL
    OR disposition IN ('reply_now', 'defer', 'suppress')
  ) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_reply_sends_followup_due
    ON outreach.reply_sends (scheduled_for)
    WHERE kind = 'followup' AND status = 'scheduled';

CREATE INDEX IF NOT EXISTS idx_reply_sends_thread_kind
    ON outreach.reply_sends (email_send_id, kind, created_at);

GRANT USAGE ON SCHEMA outreach TO postgres, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA outreach TO postgres, service_role;
