-- Prior enrichment human gate — idempotent columns.
-- Run: psql "<DIRECT_DATABASE_URL>" -f db/prior_enrichment_decision.sql
\set ON_ERROR_STOP on

ALTER TABLE outreach.campaign_leads
  ADD COLUMN IF NOT EXISTS prior_enrichment_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS prior_enrichment_lead_id uuid REFERENCES outreach.leads (id);

CREATE INDEX IF NOT EXISTS idx_campaign_leads_prior_pending
  ON outreach.campaign_leads (run_id)
  WHERE prior_enrichment_pending;
