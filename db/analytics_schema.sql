-- Outreach Analytics Hub — run exclusions for productivity/cost reports.
-- FUTURE (ACL): currently any signed-in hub user can exclude runs; wire
-- admin-only exclusion + visibility ACL later.
\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS outreach.analytics_run_exclusions (
    run_id      uuid PRIMARY KEY REFERENCES outreach.runs (id) ON DELETE CASCADE,
    excluded_by uuid NOT NULL REFERENCES outreach.users (id),
    excluded_at timestamptz NOT NULL DEFAULT now(),
    reason      text NULL,
    CONSTRAINT outreach_analytics_run_exclusion_reason_check
      CHECK (reason IS NULL OR char_length(reason) <= 500)
);

CREATE INDEX IF NOT EXISTS idx_outreach_analytics_run_exclusions_excluded_at
    ON outreach.analytics_run_exclusions (excluded_at DESC);

-- ── Campaign Tags ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS outreach.campaign_tags (
    campaign_id uuid NOT NULL REFERENCES outreach.campaigns (id) ON DELETE CASCADE,
    tag         text NOT NULL,
    color       text NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (campaign_id, tag)
);

ALTER TABLE outreach.campaign_tags ADD COLUMN IF NOT EXISTS color text NULL;

CREATE INDEX IF NOT EXISTS idx_campaign_tags_tag ON outreach.campaign_tags (tag);
CREATE INDEX IF NOT EXISTS idx_campaign_tags_campaign ON outreach.campaign_tags (campaign_id);
