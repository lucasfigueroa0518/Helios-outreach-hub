-- Remove needs_human item state + packet status (fail closed instead).
-- Safe to re-run.

BEGIN;

-- Migrate any leftover rows before tightening constraints.
UPDATE outreach.drafting_items
SET state = 'failed_research',
    last_error_code = coalesce(last_error_code, 'needs_human_removed'),
    last_error_message = coalesce(
      last_error_message,
      'needs_human state removed; fail closed as failed_research'
    ),
    updated_at = now()
WHERE state = 'needs_human';

UPDATE outreach.draft_research_packets
SET status = 'invalid',
    updated_at = now()
WHERE status = 'needs_human';

-- Item state CHECK
ALTER TABLE outreach.drafting_items
  DROP CONSTRAINT IF EXISTS drafting_items_state_check;

ALTER TABLE outreach.drafting_items
  ADD CONSTRAINT drafting_items_state_check
  CHECK (state IN (
    'waiting_for_enrichment',
    'needs_lead_review',
    'verifying_mailbox',
    'removed',
    'budget_paused',
    'queued_research',
    'researching',
    'queued_write',
    'writing',
    'repairing',
    'ready_for_review',
    'approved',
    'queued_rewrite',
    'rewriting',
    'failed_research',
    'failed_write',
    'failed_rewrite',
    'cancelled'
  )) NOT VALID;

-- Packet status CHECK
ALTER TABLE outreach.draft_research_packets
  DROP CONSTRAINT IF EXISTS draft_research_packets_status_check;

ALTER TABLE outreach.draft_research_packets
  ADD CONSTRAINT draft_research_packets_status_check
  CHECK (status IN ('valid', 'invalid', 'stale')) NOT VALID;

-- Active-state index (partial)
DROP INDEX IF EXISTS outreach.idx_drafting_items_workspace_active_state;
CREATE INDEX idx_drafting_items_workspace_active_state
  ON outreach.drafting_items (workspace_id, state)
  WHERE state IN (
    'waiting_for_enrichment',
    'needs_lead_review',
    'verifying_mailbox',
    'budget_paused',
    'queued_research',
    'researching',
    'queued_write',
    'writing',
    'repairing',
    'ready_for_review',
    'queued_rewrite',
    'rewriting'
  );

COMMIT;
