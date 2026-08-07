-- db/drafting_schema.sql — Outreach Hub drafting tables (idempotent).
-- Run after outreach_schema.sql:
--   psql "<DIRECT_DATABASE_URL>?sslmode=require" -f db/drafting_schema.sql
\set ON_ERROR_STOP on

CREATE SCHEMA IF NOT EXISTS outreach;

-- ── Sender profiles ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS outreach.sender_profiles (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id               uuid NOT NULL REFERENCES outreach.users (id),
    display_name          text NOT NULL,
    work_email            text NOT NULL,
    title                 text NOT NULL,
    signature_mode        text NOT NULL DEFAULT 'name',
    timezone              text,
    voice_notes           text,
    professional_context  jsonb NOT NULL DEFAULT '{}'::jsonb,
    revision              bigint NOT NULL DEFAULT 1,
    is_default            boolean NOT NULL DEFAULT false,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE outreach.sender_profiles
    ADD COLUMN IF NOT EXISTS professional_context jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS company_name text NOT NULL DEFAULT 'Helios Group',
    ADD COLUMN IF NOT EXISTS headshot_storage_path text;

-- Prefer the full company name for signatures (idempotent for older defaults).
ALTER TABLE outreach.sender_profiles
    ALTER COLUMN company_name SET DEFAULT 'Helios Group';
UPDATE outreach.sender_profiles
   SET company_name = 'Helios Group'
 WHERE trim(company_name) = '' OR company_name = 'Helios';

DO $$
BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'sender_profiles_signature_mode_check'
        AND conrelid = 'outreach.sender_profiles'::regclass
    ) THEN
      ALTER TABLE outreach.sender_profiles
        ADD CONSTRAINT sender_profiles_signature_mode_check
        CHECK (signature_mode IN ('name', 'name_and_role')) NOT VALID;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'sender_profiles_display_name_nonempty_check'
        AND conrelid = 'outreach.sender_profiles'::regclass
    ) THEN
      ALTER TABLE outreach.sender_profiles
        ADD CONSTRAINT sender_profiles_display_name_nonempty_check
        CHECK (length(trim(display_name)) > 0) NOT VALID;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'sender_profiles_title_nonempty_check'
        AND conrelid = 'outreach.sender_profiles'::regclass
    ) THEN
      ALTER TABLE outreach.sender_profiles
        ADD CONSTRAINT sender_profiles_title_nonempty_check
        CHECK (length(trim(title)) > 0) NOT VALID;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'sender_profiles_work_email_nonempty_check'
        AND conrelid = 'outreach.sender_profiles'::regclass
    ) THEN
      ALTER TABLE outreach.sender_profiles
        ADD CONSTRAINT sender_profiles_work_email_nonempty_check
        CHECK (length(trim(work_email)) > 0) NOT VALID;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sender_profiles_work_email_lower
    ON outreach.sender_profiles (lower(work_email));
CREATE UNIQUE INDEX IF NOT EXISTS idx_sender_profiles_user_default
    ON outreach.sender_profiles (user_id)
    WHERE is_default;
CREATE INDEX IF NOT EXISTS idx_sender_profiles_user_updated
    ON outreach.sender_profiles (user_id, updated_at DESC);

-- ── Drafting workspaces ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS outreach.drafting_workspaces (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id                 uuid NOT NULL UNIQUE REFERENCES outreach.campaigns (id),
    created_by                  uuid NOT NULL REFERENCES outreach.users (id),
    sender_profile_id           uuid REFERENCES outreach.sender_profiles (id),
    status                      text NOT NULL DEFAULT 'active',
    skill_version               text,
    skill_sha256                text,
    positioning_version         text,
    positioning_sha256          text,
    capability_catalog_version  text,
    capability_catalog_sha256   text,
    last_started_at             timestamptz,
    generation_completed_at     timestamptz,
    review_completed_at         timestamptz,
    created_at                  timestamptz NOT NULL DEFAULT now(),
    updated_at                  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE outreach.drafting_workspaces
    ADD COLUMN IF NOT EXISTS generation_completed_at timestamptz,
    ADD COLUMN IF NOT EXISTS review_completed_at timestamptz,
    ADD COLUMN IF NOT EXISTS paused_at timestamptz,
    ADD COLUMN IF NOT EXISTS paused_by uuid REFERENCES outreach.users (id);

ALTER TABLE outreach.drafting_workspaces
    DROP CONSTRAINT IF EXISTS drafting_workspaces_status_check;

ALTER TABLE outreach.drafting_workspaces
    ADD CONSTRAINT drafting_workspaces_status_check
    CHECK (status IN ('active', 'review_complete', 'cancelled', 'paused')) NOT VALID;

ALTER TABLE outreach.drafting_workspaces
    VALIDATE CONSTRAINT drafting_workspaces_status_check;

DO $$
BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'drafting_workspaces_status_check'
        AND conrelid = 'outreach.drafting_workspaces'::regclass
    ) THEN
      ALTER TABLE outreach.drafting_workspaces
        ADD CONSTRAINT drafting_workspaces_status_check
        CHECK (status IN ('active', 'review_complete', 'cancelled', 'paused')) NOT VALID;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'drafting_workspaces_skill_sha256_check'
        AND conrelid = 'outreach.drafting_workspaces'::regclass
    ) THEN
      ALTER TABLE outreach.drafting_workspaces
        ADD CONSTRAINT drafting_workspaces_skill_sha256_check
        CHECK (skill_sha256 IS NULL OR skill_sha256 ~ '^[0-9a-f]{64}$') NOT VALID;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'drafting_workspaces_positioning_sha256_check'
        AND conrelid = 'outreach.drafting_workspaces'::regclass
    ) THEN
      ALTER TABLE outreach.drafting_workspaces
        ADD CONSTRAINT drafting_workspaces_positioning_sha256_check
        CHECK (positioning_sha256 IS NULL OR positioning_sha256 ~ '^[0-9a-f]{64}$') NOT VALID;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'drafting_workspaces_capability_catalog_sha256_check'
        AND conrelid = 'outreach.drafting_workspaces'::regclass
    ) THEN
      ALTER TABLE outreach.drafting_workspaces
        ADD CONSTRAINT drafting_workspaces_capability_catalog_sha256_check
        CHECK (capability_catalog_sha256 IS NULL OR capability_catalog_sha256 ~ '^[0-9a-f]{64}$') NOT VALID;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_drafting_workspaces_campaign
    ON outreach.drafting_workspaces (campaign_id);
CREATE INDEX IF NOT EXISTS idx_drafting_workspaces_status
    ON outreach.drafting_workspaces (status);

-- ── Drafting runs ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS outreach.drafting_runs (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id             uuid NOT NULL REFERENCES outreach.drafting_workspaces (id),
    triggered_by             uuid NOT NULL REFERENCES outreach.users (id),
    trigger                  text NOT NULL,
    idempotency_key          text NOT NULL,
    status                   text NOT NULL DEFAULT 'active',
    target_count             int NOT NULL DEFAULT 0,
    projected_cost_low_usd   numeric(10, 4) NOT NULL DEFAULT 0,
    projected_cost_high_usd  numeric(10, 4) NOT NULL DEFAULT 0,
    budget_limit_usd         numeric(10, 4) NOT NULL DEFAULT 0,
    reserved_cost_usd        numeric(10, 4) NOT NULL DEFAULT 0,
    actual_cost_usd          numeric(10, 4) NOT NULL DEFAULT 0,
    usage                    jsonb NOT NULL DEFAULT '{}'::jsonb,
    started_at               timestamptz NOT NULL DEFAULT now(),
    finished_at              timestamptz
);

DO $$
BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'drafting_runs_trigger_check'
        AND conrelid = 'outreach.drafting_runs'::regclass
    ) THEN
      ALTER TABLE outreach.drafting_runs
        ADD CONSTRAINT drafting_runs_trigger_check
        CHECK (trigger IN (
          'go_to_drafting', 'lead_approval', 'verification_promoted',
          'retry', 'rewrite', 'budget_continue'
        )) NOT VALID;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'drafting_runs_status_check'
        AND conrelid = 'outreach.drafting_runs'::regclass
    ) THEN
      ALTER TABLE outreach.drafting_runs
        ADD CONSTRAINT drafting_runs_status_check
        CHECK (status IN ('active', 'complete', 'partial', 'cancelled')) NOT VALID;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'drafting_runs_target_count_check'
        AND conrelid = 'outreach.drafting_runs'::regclass
    ) THEN
      ALTER TABLE outreach.drafting_runs
        ADD CONSTRAINT drafting_runs_target_count_check
        CHECK (target_count >= 0) NOT VALID;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_drafting_runs_triggered_by_idempotency
    ON outreach.drafting_runs (triggered_by, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_drafting_runs_workspace_started
    ON outreach.drafting_runs (workspace_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_drafting_runs_workspace_active
    ON outreach.drafting_runs (workspace_id)
    WHERE status = 'active';

-- ── Drafting items ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS outreach.drafting_items (
    id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id                  uuid NOT NULL REFERENCES outreach.drafting_workspaces (id),
    lead_id                       uuid NOT NULL REFERENCES outreach.leads (id),
    source_campaign_lead_run_id   uuid REFERENCES outreach.runs (id),
    ordinal                       bigint NOT NULL DEFAULT 0,
    state                         text NOT NULL DEFAULT 'waiting_for_enrichment',
    input_snapshot                jsonb NOT NULL DEFAULT '{}'::jsonb,
    input_overrides               jsonb NOT NULL DEFAULT '{}'::jsonb,
    missing_fields                text[] NOT NULL DEFAULT '{}'::text[],
    input_fingerprint             text,
    input_revision                bigint NOT NULL DEFAULT 0,
    delivery_snapshot             jsonb NOT NULL DEFAULT '{}'::jsonb,
    research_revision             int NOT NULL DEFAULT 0,
    draft_revision                int NOT NULL DEFAULT 0,
    review_status                 text NOT NULL DEFAULT 'unreviewed',
    reviewed_by                   uuid REFERENCES outreach.users (id),
    reviewed_at                   timestamptz,
    removed_at                    timestamptz,
    removed_by                    uuid REFERENCES outreach.users (id),
    human_attention_code          text,
    last_error_code               text,
    last_error_message            text,
    empty_brief_attempts           int NOT NULL DEFAULT 0,
    empty_brief_input_fingerprint text,
    empty_brief_last_at            timestamptz,
    drafting_execution_owner       text,
    drafting_execution_expires_at  timestamptz,
    retry_audit                    jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at                    timestamptz NOT NULL DEFAULT now(),
    updated_at                    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, lead_id)
);

ALTER TABLE outreach.drafting_items
    ADD COLUMN IF NOT EXISTS delivery_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS removed_at timestamptz,
    ADD COLUMN IF NOT EXISTS removed_by uuid REFERENCES outreach.users (id),
    ADD COLUMN IF NOT EXISTS last_error_code text,
    ADD COLUMN IF NOT EXISTS empty_brief_attempts int NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS empty_brief_input_fingerprint text,
    ADD COLUMN IF NOT EXISTS empty_brief_last_at timestamptz,
    ADD COLUMN IF NOT EXISTS drafting_execution_owner text,
    ADD COLUMN IF NOT EXISTS drafting_execution_expires_at timestamptz,
    ADD COLUMN IF NOT EXISTS retry_audit jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'drafting_items_state_check'
        AND conrelid = 'outreach.drafting_items'::regclass
    ) THEN
      ALTER TABLE outreach.drafting_items
        ADD CONSTRAINT drafting_items_state_check
        CHECK (state IN (
          'waiting_for_enrichment',
          'needs_lead_review',
          'verifying_mailbox',
          'removed',
          'budget_paused',
          'queued_research',
          'waiting_company_research',
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
    END IF;
    -- Upgrade existing DBs that already have drafting_items_state_check without
    -- waiting_company_research (ADD CONSTRAINT IF NOT EXISTS is a no-op there).
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'drafting_items_state_check'
        AND conrelid = 'outreach.drafting_items'::regclass
        AND pg_get_constraintdef(oid) NOT LIKE '%waiting_company_research%'
    ) THEN
      ALTER TABLE outreach.drafting_items DROP CONSTRAINT drafting_items_state_check;
      ALTER TABLE outreach.drafting_items
        ADD CONSTRAINT drafting_items_state_check
        CHECK (state IN (
          'waiting_for_enrichment',
          'needs_lead_review',
          'verifying_mailbox',
          'removed',
          'budget_paused',
          'queued_research',
          'waiting_company_research',
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
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'drafting_items_review_status_check'
        AND conrelid = 'outreach.drafting_items'::regclass
    ) THEN
      ALTER TABLE outreach.drafting_items
        ADD CONSTRAINT drafting_items_review_status_check
        CHECK (review_status IN ('unreviewed', 'approved')) NOT VALID;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'drafting_items_empty_brief_attempts_check'
        AND conrelid = 'outreach.drafting_items'::regclass
    ) THEN
      ALTER TABLE outreach.drafting_items
        ADD CONSTRAINT drafting_items_empty_brief_attempts_check
        CHECK (empty_brief_attempts >= 0) NOT VALID;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'drafting_items_review_state_invariant_check'
        AND conrelid = 'outreach.drafting_items'::regclass
    ) THEN
      ALTER TABLE outreach.drafting_items
        ADD CONSTRAINT drafting_items_review_state_invariant_check
        CHECK (
          (state = 'approved' AND review_status = 'approved')
          OR (state <> 'approved' AND review_status = 'unreviewed')
        ) NOT VALID;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_drafting_items_workspace_ordinal
    ON outreach.drafting_items (workspace_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_drafting_items_workspace_state_ordinal
    ON outreach.drafting_items (workspace_id, state, ordinal);
CREATE INDEX IF NOT EXISTS idx_drafting_items_workspace_unreviewed_ordinal
    ON outreach.drafting_items (workspace_id, review_status, ordinal)
    WHERE review_status = 'unreviewed';
DROP INDEX IF EXISTS outreach.idx_drafting_items_workspace_active_state;
CREATE INDEX idx_drafting_items_workspace_active_state
    ON outreach.drafting_items (workspace_id, state)
    WHERE state IN (
      'waiting_for_enrichment',
      'needs_lead_review',
      'verifying_mailbox',
      'budget_paused',
      'queued_research',
      'waiting_company_research',
      'researching',
      'queued_write',
      'writing',
      'repairing',
      'ready_for_review',
      'queued_rewrite',
      'rewriting'
    );
CREATE INDEX IF NOT EXISTS idx_drafting_items_lead
    ON outreach.drafting_items (lead_id);

-- ── Company research singleflight leases ───────────────────────────────────
-- One lead researches a company at a time per workspace. Sibling leads wait
-- for the packet, then reuse its company evidence instead of duplicating it.

CREATE TABLE IF NOT EXISTS outreach.drafting_company_research_leases (
    workspace_id       uuid NOT NULL REFERENCES outreach.drafting_workspaces (id) ON DELETE CASCADE,
    company_key        text NOT NULL,
    owner_item_id      uuid NOT NULL REFERENCES outreach.drafting_items (id) ON DELETE CASCADE,
    status             text NOT NULL DEFAULT 'researching',
    lease_expires_at   timestamptz NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, company_key),
    CONSTRAINT drafting_company_research_leases_company_key_check
      CHECK (length(company_key) BETWEEN 1 AND 500),
    CONSTRAINT drafting_company_research_leases_status_check
      CHECK (status IN ('researching', 'ready', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_drafting_company_research_leases_expiry
    ON outreach.drafting_company_research_leases (lease_expires_at)
    WHERE status = 'researching';

-- ── Drafting run items (authorization cohort) ───────────────────────────────

CREATE TABLE IF NOT EXISTS outreach.drafting_run_items (
    drafting_run_id           uuid NOT NULL REFERENCES outreach.drafting_runs (id),
    drafting_item_id        uuid NOT NULL REFERENCES outreach.drafting_items (id),
    source_enrichment_run_id uuid REFERENCES outreach.runs (id),
    authorization_state     text NOT NULL DEFAULT 'waiting',
    projected_cost_usd      numeric(10, 4) NOT NULL DEFAULT 0,
    reserved_cost_usd       numeric(10, 4) NOT NULL DEFAULT 0,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (drafting_run_id, drafting_item_id)
);

DO $$
BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'drafting_run_items_authorization_state_check'
        AND conrelid = 'outreach.drafting_run_items'::regclass
    ) THEN
      ALTER TABLE outreach.drafting_run_items
        ADD CONSTRAINT drafting_run_items_authorization_state_check
        CHECK (authorization_state IN (
          'waiting', 'queued', 'budget_paused', 'terminal', 'cancelled'
        )) NOT VALID;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_drafting_run_items_source_enrichment_state
    ON outreach.drafting_run_items (source_enrichment_run_id, authorization_state);
CREATE INDEX IF NOT EXISTS idx_drafting_run_items_item_created
    ON outreach.drafting_run_items (drafting_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_drafting_run_items_run_state
    ON outreach.drafting_run_items (drafting_run_id, authorization_state);

-- ── Draft research packets ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS outreach.draft_research_packets (
    drafting_item_id        uuid PRIMARY KEY REFERENCES outreach.drafting_items (id),
    input_fingerprint       text NOT NULL,
    research_revision       int NOT NULL,
    schema_version          text NOT NULL,
    status                  text NOT NULL,
    identity_classification text,
    resolution_level        text,
    packet                  jsonb NOT NULL DEFAULT '{}'::jsonb,
    source_count            int NOT NULL DEFAULT 0,
    fresh_source_count      int NOT NULL DEFAULT 0,
    packet_sha256           text NOT NULL,
    model_id                text,
    prompt_version          text,
    provider_request_id     text,
    usage                   jsonb NOT NULL DEFAULT '{}'::jsonb,
    temporal_status         text NOT NULL DEFAULT 'blocked',
    temporal_audit          jsonb NOT NULL DEFAULT '{}'::jsonb,
    researched_at           timestamptz,
    valid_until             timestamptz,
    updated_at              timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'draft_research_packets_status_check'
        AND conrelid = 'outreach.draft_research_packets'::regclass
    ) THEN
      ALTER TABLE outreach.draft_research_packets
        ADD CONSTRAINT draft_research_packets_status_check
        CHECK (status IN ('valid', 'invalid', 'stale')) NOT VALID;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_draft_research_packets_status_valid_until
    ON outreach.draft_research_packets (status, valid_until)
    WHERE status = 'valid';
CREATE INDEX IF NOT EXISTS idx_draft_research_packets_identity_classification
    ON outreach.draft_research_packets (identity_classification);

-- ── Email drafts ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS outreach.email_drafts (
    drafting_item_id         uuid PRIMARY KEY REFERENCES outreach.drafting_items (id),
    input_fingerprint        text NOT NULL,
    research_packet_sha256   text NOT NULL,
    generation_number        int NOT NULL DEFAULT 1,
    content_revision         bigint NOT NULL DEFAULT 1,
    subject                  text NOT NULL DEFAULT '',
    body_text                text NOT NULL DEFAULT '',
    resolution_used          text,
    used_fact_ids            text[] NOT NULL DEFAULT '{}'::text[],
    claim_ledger             jsonb NOT NULL DEFAULT '{}'::jsonb,
    ask_form                 text,
    lint_result              jsonb NOT NULL DEFAULT '{}'::jsonb,
    grounding_status         text NOT NULL DEFAULT 'model_validated',
    model_id                 text,
    prompt_version           text,
    provider_request_id      text,
    usage                    jsonb NOT NULL DEFAULT '{}'::jsonb,
    generation_mode          text NOT NULL DEFAULT 'legacy',
    temporal_status          text NOT NULL DEFAULT 'blocked',
    temporal_audit           jsonb NOT NULL DEFAULT '{}'::jsonb,
    draft_grounding          jsonb NOT NULL DEFAULT '{}'::jsonb,
    manually_edited          boolean NOT NULL DEFAULT false,
    edited_by                uuid REFERENCES outreach.users (id),
    edited_at                timestamptz,
    generated_at             timestamptz,
    updated_at               timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE outreach.email_drafts
    ADD COLUMN IF NOT EXISTS generation_mode text NOT NULL DEFAULT 'legacy';

DO $$
BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'email_drafts_grounding_status_check'
        AND conrelid = 'outreach.email_drafts'::regclass
    ) THEN
      ALTER TABLE outreach.email_drafts
        ADD CONSTRAINT email_drafts_grounding_status_check
        CHECK (grounding_status IN ('model_validated', 'manual_override')) NOT VALID;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'email_drafts_generation_mode_check'
        AND conrelid = 'outreach.email_drafts'::regclass
    ) THEN
      ALTER TABLE outreach.email_drafts
        ADD CONSTRAINT email_drafts_generation_mode_check
        CHECK (generation_mode IN ('live', 'stub', 'legacy')) NOT VALID;
    END IF;
END $$;

-- ── Outbound email sends (Resend) ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS outreach.email_sends (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    drafting_item_id      uuid NOT NULL REFERENCES outreach.drafting_items (id) ON DELETE CASCADE,
    provider              text NOT NULL DEFAULT 'resend',
    provider_message_id   text,
    status                text NOT NULL,
    from_email            text NOT NULL,
    to_email              text NOT NULL,
    subject               text NOT NULL,
    error_message         text,
    sent_at               timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Engagement tracking (Resend webhooks) — widen in place; no new tables.
ALTER TABLE outreach.email_sends
  ADD COLUMN IF NOT EXISTS provider_rfc_message_id text,
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS opened_at timestamptz,
  ADD COLUMN IF NOT EXISTS clicked_at timestamptz,
  ADD COLUMN IF NOT EXISTS bounced_at timestamptz,
  ADD COLUMN IF NOT EXISTS complained_at timestamptz,
  ADD COLUMN IF NOT EXISTS replied_at timestamptz,
  ADD COLUMN IF NOT EXISTS open_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS click_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_event_at timestamptz,
  ADD COLUMN IF NOT EXISTS bounce_type text,
  ADD COLUMN IF NOT EXISTS reply_provider_email_id text,
  ADD COLUMN IF NOT EXISTS processed_webhook_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'email_sends_status_check'
        AND conrelid = 'outreach.email_sends'::regclass
    ) THEN
      ALTER TABLE outreach.email_sends
        ADD CONSTRAINT email_sends_status_check
        CHECK (status IN ('sent', 'failed')) NOT VALID;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_sends_item_sent
    ON outreach.email_sends (drafting_item_id)
    WHERE status = 'sent';
CREATE INDEX IF NOT EXISTS idx_email_sends_item_updated
    ON outreach.email_sends (drafting_item_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_sends_provider_message_id
    ON outreach.email_sends (provider_message_id)
    WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_sends_provider_rfc_message_id
    ON outreach.email_sends (provider_rfc_message_id)
    WHERE provider_rfc_message_id IS NOT NULL;

-- ── Drafting jobs ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS outreach.drafting_jobs (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    drafting_run_id             uuid NOT NULL REFERENCES outreach.drafting_runs (id),
    drafting_item_id            uuid NOT NULL REFERENCES outreach.drafting_items (id),
    kind                        text NOT NULL,
    status                      text NOT NULL DEFAULT 'pending',
    idempotency_key             text NOT NULL UNIQUE,
    expected_input_fingerprint  text,
    expected_research_revision  int,
    expected_draft_revision     int,
    attempt_count               int NOT NULL DEFAULT 0,
    execution_epoch             int NOT NULL DEFAULT 0,
    max_attempts                int NOT NULL DEFAULT 3,
    claimed_at                  timestamptz,
    heartbeat_at                timestamptz,
    next_attempt_at             timestamptz NOT NULL DEFAULT now(),
    priority                    smallint NOT NULL DEFAULT 0,
    reserved_cost_usd           numeric(10, 4) NOT NULL DEFAULT 0,
    actual_cost_usd             numeric(10, 4) NOT NULL DEFAULT 0,
    provider_request_id         text,
    usage                       jsonb NOT NULL DEFAULT '{}'::jsonb,
    last_error_code             text,
    last_error_message          text,
    created_at                  timestamptz NOT NULL DEFAULT now(),
    finished_at                 timestamptz
);

ALTER TABLE outreach.drafting_jobs
    ADD COLUMN IF NOT EXISTS execution_epoch int NOT NULL DEFAULT 0;

\set drafting_data_schema outreach
\set drafting_function_schema public
\ir drafting_cost_persistence.sql
\unset drafting_data_schema
\unset drafting_function_schema

DO $$
BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'drafting_jobs_kind_check'
        AND conrelid = 'outreach.drafting_jobs'::regclass
    ) THEN
      ALTER TABLE outreach.drafting_jobs
        ADD CONSTRAINT drafting_jobs_kind_check
        CHECK (kind IN (
          'verify_mailbox', 'research', 'write', 'repair', 'rewrite'
        )) NOT VALID;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'drafting_jobs_status_check'
        AND conrelid = 'outreach.drafting_jobs'::regclass
    ) THEN
      ALTER TABLE outreach.drafting_jobs
        ADD CONSTRAINT drafting_jobs_status_check
        CHECK (status IN (
          'pending', 'in_flight', 'done', 'failed', 'superseded', 'cancelled'
        )) NOT VALID;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_drafting_jobs_pending_claim
    ON outreach.drafting_jobs (status, next_attempt_at, priority DESC, created_at)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_drafting_jobs_item_created
    ON outreach.drafting_jobs (drafting_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_drafting_jobs_run_status
    ON outreach.drafting_jobs (drafting_run_id, status);
CREATE INDEX IF NOT EXISTS idx_drafting_jobs_in_flight_claimed
    ON outreach.drafting_jobs (claimed_at)
    WHERE status = 'in_flight';

-- drafting_resolutions was never wired (no insert/read path) — retire it.
DROP TABLE IF EXISTS outreach.drafting_resolutions CASCADE;

-- ── RPC helpers (public schema — callable via direct pg / supabase.rpc) ─────

CREATE OR REPLACE FUNCTION public.claim_drafting_job(p_job_id uuid DEFAULT NULL)
RETURNS SETOF outreach.drafting_jobs
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = outreach, public
AS $$
DECLARE
    v_job outreach.drafting_jobs%ROWTYPE;
    v_item outreach.drafting_items%ROWTYPE;
    v_run outreach.drafting_runs%ROWTYPE;
    v_workspace outreach.drafting_workspaces%ROWTYPE;
    v_stale boolean;
BEGIN
    IF p_job_id IS NOT NULL THEN
        SELECT j.*
          INTO v_job
          FROM outreach.drafting_jobs AS j
         WHERE j.id = p_job_id
           AND (
             j.status = 'pending'
             OR (
               j.status = 'in_flight'
               AND coalesce(j.heartbeat_at, j.claimed_at) < now() - interval '10 minutes'
             )
           )
         FOR UPDATE SKIP LOCKED;
    ELSE
        SELECT j.*
          INTO v_job
          FROM outreach.drafting_jobs AS j
         WHERE (
             j.status = 'pending'
             AND j.next_attempt_at <= now()
           )
            OR (
             j.status = 'in_flight'
             AND coalesce(j.heartbeat_at, j.claimed_at) < now() - interval '10 minutes'
           )
         ORDER BY j.priority DESC, j.next_attempt_at, j.created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1;
    END IF;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    SELECT i.* INTO v_item
      FROM outreach.drafting_items AS i
     WHERE i.id = v_job.drafting_item_id
     FOR UPDATE;

    SELECT r.* INTO v_run
      FROM outreach.drafting_runs AS r
     WHERE r.id = v_job.drafting_run_id
     FOR UPDATE;

    SELECT w.* INTO v_workspace
      FROM outreach.drafting_workspaces AS w
     WHERE w.id = v_run.workspace_id
     FOR UPDATE;

    IF v_workspace.status <> 'active' OR v_run.status <> 'active' THEN
        UPDATE outreach.drafting_jobs
           SET status = 'cancelled',
               finished_at = now()
         WHERE id = v_job.id;
        RETURN;
    END IF;

    -- Null expected_* means "no expectation" (match lib/drafting/jobs.ts isStaleJob).
    -- Research jobs set expected_input_fingerprint only; revisions stay NULL until write/repair.
    -- Using coalesce(NULL, -1) vs item revision 0 incorrectly marked every research job superseded.
    v_stale :=
        (
          v_job.expected_input_fingerprint IS NOT NULL
          AND coalesce(v_job.expected_input_fingerprint, '')
              <> coalesce(v_item.input_fingerprint, '')
        )
        OR (
          v_job.expected_research_revision IS NOT NULL
          AND v_job.expected_research_revision
              <> coalesce(v_item.research_revision, -1)
        )
        OR (
          v_job.expected_draft_revision IS NOT NULL
          AND v_job.expected_draft_revision
              <> coalesce(v_item.draft_revision, -1)
        );

    IF v_stale THEN
        UPDATE outreach.drafting_jobs
           SET status = 'superseded',
               finished_at = now(),
               claimed_at = NULL,
               heartbeat_at = NULL
         WHERE id = v_job.id;
        RETURN;
    END IF;

    IF v_job.attempt_count >= v_job.max_attempts THEN
        UPDATE outreach.drafting_jobs
           SET status = 'failed',
               finished_at = now(),
               claimed_at = NULL,
               heartbeat_at = NULL,
               last_error_code = coalesce(last_error_code, 'max_attempts_exceeded'),
               last_error_message = coalesce(
                 last_error_message,
                 'Job exceeded max_attempts before claim'
               )
         WHERE id = v_job.id;
        RETURN;
    END IF;

    RETURN QUERY
    UPDATE outreach.drafting_jobs AS j
       SET status = 'in_flight',
           attempt_count = j.attempt_count + 1,
           claimed_at = now(),
           heartbeat_at = now()
     WHERE j.id = v_job.id
     RETURNING j.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_drafting_job(
    p_job_id uuid,
    p_status text,
    p_actual_cost_usd numeric(10, 4) DEFAULT NULL,
    p_usage jsonb DEFAULT NULL,
    p_provider_request_id text DEFAULT NULL,
    p_last_error_code text DEFAULT NULL,
    p_last_error_message text DEFAULT NULL,
    p_cost_event_key text DEFAULT NULL
)
RETURNS outreach.drafting_jobs
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = outreach, public
AS $$
DECLARE
    v_job outreach.drafting_jobs%ROWTYPE;
    v_item outreach.drafting_items%ROWTYPE;
    v_final_status text;
BEGIN
    IF p_status NOT IN ('done', 'failed', 'superseded', 'cancelled') THEN
        RAISE EXCEPTION 'finish_drafting_job: status must be done, failed, superseded, or cancelled, got %', p_status;
    END IF;

    SELECT j.*
      INTO v_job
      FROM outreach.drafting_jobs AS j
     WHERE j.id = p_job_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'finish_drafting_job: job % not found', p_job_id;
    END IF;

    IF v_job.status NOT IN ('in_flight', 'pending') THEN
        RETURN v_job;
    END IF;

    SELECT i.*
      INTO v_item
      FROM outreach.drafting_items AS i
     WHERE i.id = v_job.drafting_item_id
     FOR UPDATE;

    -- Null expected_* means "no expectation" (same rule as claim_drafting_job).
    -- Research jobs omit expected_*_revision; saveResearchPacket then bumps
    -- research_revision, which must not rewrite a successful done → superseded.
    v_final_status := p_status;
    IF p_status = 'done'
       AND (
         (
           v_job.expected_input_fingerprint IS NOT NULL
           AND coalesce(v_job.expected_input_fingerprint, '')
               <> coalesce(v_item.input_fingerprint, '')
         )
         OR (
           v_job.expected_research_revision IS NOT NULL
           AND v_job.expected_research_revision
               <> coalesce(v_item.research_revision, -1)
         )
         OR (
           v_job.expected_draft_revision IS NOT NULL
           AND v_job.expected_draft_revision
               <> coalesce(v_item.draft_revision, -1)
         )
       ) THEN
        v_final_status := 'superseded';
    END IF;

    IF p_actual_cost_usd IS NOT NULL AND p_actual_cost_usd <> 0 THEN
        IF p_cost_event_key IS NULL OR btrim(p_cost_event_key) = '' THEN
            RAISE EXCEPTION 'finish_drafting_job: non-zero spend requires p_cost_event_key';
        END IF;
        PERFORM public.record_drafting_job_cost_event(
          p_job_id,
          p_actual_cost_usd,
          p_usage,
          p_provider_request_id,
          p_cost_event_key
        );
    END IF;

    UPDATE outreach.drafting_jobs AS j
       SET status = v_final_status,
           usage = CASE
             WHEN (p_actual_cost_usd IS NULL OR p_actual_cost_usd = 0)
               AND p_usage IS NOT NULL THEN j.usage || p_usage
             ELSE j.usage
           END,
           provider_request_id = coalesce(p_provider_request_id, j.provider_request_id),
           last_error_code = p_last_error_code,
           last_error_message = p_last_error_message,
           claimed_at = NULL,
           heartbeat_at = NULL,
           finished_at = now()
     WHERE j.id = p_job_id
     RETURNING j.* INTO v_job;

    RETURN v_job;
END;
$$;

-- ── Outbound email send queue (daily cap / backlog) ─────────────────────────

CREATE TABLE IF NOT EXISTS outreach.email_send_queue (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id              uuid NOT NULL REFERENCES outreach.users (id),
    drafting_item_id      uuid NOT NULL REFERENCES outreach.drafting_items (id) ON DELETE CASCADE,
    campaign_id           uuid NOT NULL REFERENCES outreach.campaigns (id) ON DELETE CASCADE,
    scheduled_for         timestamptz NOT NULL,
    schedule_date         date NOT NULL,
    status                text NOT NULL DEFAULT 'queued',
    to_email              text NOT NULL,
    subject               text NOT NULL,
    recipient_name        text,
    orchestration_job_id  uuid,
    error_message         text,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'email_send_queue_status_check'
        AND conrelid = 'outreach.email_send_queue'::regclass
    ) THEN
      ALTER TABLE outreach.email_send_queue
        ADD CONSTRAINT email_send_queue_status_check
        CHECK (status IN ('queued', 'sending', 'sent', 'cancelled', 'failed')) NOT VALID;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_email_send_queue_owner_date
    ON outreach.email_send_queue (owner_id, schedule_date);
CREATE INDEX IF NOT EXISTS idx_email_send_queue_owner_scheduled
    ON outreach.email_send_queue (owner_id, scheduled_for)
    WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_email_send_queue_owner_campaign_date
    ON outreach.email_send_queue (owner_id, campaign_id, schedule_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_send_queue_item_active
    ON outreach.email_send_queue (drafting_item_id)
    WHERE status IN ('queued', 'sending');

-- ── Cloud worker billing guard (fail-closed when GCP spend > $0) ─────────────

CREATE TABLE IF NOT EXISTS outreach.billing_guard (
    id              text PRIMARY KEY DEFAULT 'cloud_worker',
    tripped         boolean NOT NULL DEFAULT false,
    cost_amount     numeric(20, 6),
    currency_code   text,
    alert_title     text,
    detail          text,
    source          text,
    console_url     text,
    raw_payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
    tripped_at      timestamptz,
    cleared_at      timestamptz,
    acknowledged_at timestamptz,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO outreach.billing_guard (id)
VALUES ('cloud_worker')
ON CONFLICT (id) DO NOTHING;

GRANT USAGE ON SCHEMA outreach TO postgres, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA outreach TO postgres, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA outreach TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.claim_drafting_job(uuid) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.record_drafting_job_cost_event(
    uuid, numeric, jsonb, text, text
) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.finish_drafting_job(
    uuid, text, numeric, jsonb, text, text, text, text
) TO postgres, service_role;
