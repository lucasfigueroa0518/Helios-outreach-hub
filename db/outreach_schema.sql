-- db/outreach_schema.sql — Outreach Hub app schema (idempotent).
-- Run after bootstrap.sql:
--   psql "<DIRECT_DATABASE_URL>?sslmode=require" -f db/outreach_schema.sql
\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE SCHEMA IF NOT EXISTS outreach;

-- Private Storage bucket. Browser clients receive short-lived signed upload
-- URLs only; they never receive the service-role key.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'outreach-uploads',
    'outreach-uploads',
    false,
    52428800,
    ARRAY[
      'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', 'text/csv', 'text/tab-separated-values',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain', 'text/markdown'
    ]
)
ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ── Users (passwordless auth) ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS outreach.users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         text NOT NULL UNIQUE,
    display_name  text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_login_at timestamptz
);

-- ── Campaigns ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS outreach.campaigns (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name            text NOT NULL,
    owner_id        uuid NOT NULL REFERENCES outreach.users (id),
    status          text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'archived')),
    merged_into_id  uuid REFERENCES outreach.campaigns (id),
    needs_enrichment boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE outreach.campaigns
    ADD COLUMN IF NOT EXISTS needs_enrichment boolean NOT NULL DEFAULT true;

ALTER TABLE outreach.campaigns
    ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'manual';
ALTER TABLE outreach.campaigns
    ADD COLUMN IF NOT EXISTS auto_status text;
ALTER TABLE outreach.campaigns
    ADD COLUMN IF NOT EXISTS auto_error text;
ALTER TABLE outreach.campaigns
    ADD COLUMN IF NOT EXISTS emails_per_day int;
ALTER TABLE outreach.campaigns
    ADD COLUMN IF NOT EXISTS follow_up_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE outreach.campaigns
    ADD COLUMN IF NOT EXISTS lead_attributes jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE outreach.campaigns
    ADD COLUMN IF NOT EXISTS expansion_step int NOT NULL DEFAULT 0;
ALTER TABLE outreach.campaigns
    ADD COLUMN IF NOT EXISTS queue_color text;
ALTER TABLE outreach.campaigns
    ADD COLUMN IF NOT EXISTS next_cycle_at timestamptz;
ALTER TABLE outreach.campaigns
    ADD COLUMN IF NOT EXISTS last_cycle_at timestamptz;
ALTER TABLE outreach.campaigns
    ADD COLUMN IF NOT EXISTS apollo_search_page int NOT NULL DEFAULT 1;
ALTER TABLE outreach.campaigns
    ADD COLUMN IF NOT EXISTS apollo_search_params jsonb;
ALTER TABLE outreach.campaigns
    ADD COLUMN IF NOT EXISTS thin_days int NOT NULL DEFAULT 0;
ALTER TABLE outreach.campaigns
    ADD COLUMN IF NOT EXISTS sender_identity_slug text;

DO $$
BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'campaigns_sender_identity_slug_check'
        AND conrelid = 'outreach.campaigns'::regclass
    ) THEN
      ALTER TABLE outreach.campaigns
        ADD CONSTRAINT campaigns_sender_identity_slug_check
        CHECK (
          sender_identity_slug IS NULL
          OR sender_identity_slug IN ('lucas', 'tommy')
        ) NOT VALID;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'campaigns_kind_check'
        AND conrelid = 'outreach.campaigns'::regclass
    ) THEN
      ALTER TABLE outreach.campaigns
        ADD CONSTRAINT campaigns_kind_check
        CHECK (kind IN ('manual', 'auto')) NOT VALID;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'campaigns_auto_status_check'
        AND conrelid = 'outreach.campaigns'::regclass
    ) THEN
      ALTER TABLE outreach.campaigns
        ADD CONSTRAINT campaigns_auto_status_check
        CHECK (
          auto_status IS NULL OR auto_status IN (
            'pending_sender', 'live', 'paused', 'exhausted', 'error'
          )
        ) NOT VALID;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'campaigns_expansion_step_check'
        AND conrelid = 'outreach.campaigns'::regclass
    ) THEN
      ALTER TABLE outreach.campaigns
        ADD CONSTRAINT campaigns_expansion_step_check
        CHECK (expansion_step >= 0 AND expansion_step <= 4) NOT VALID;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'campaigns_apollo_search_page_check'
        AND conrelid = 'outreach.campaigns'::regclass
    ) THEN
      ALTER TABLE outreach.campaigns
        ADD CONSTRAINT campaigns_apollo_search_page_check
        CHECK (apollo_search_page >= 1) NOT VALID;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_campaigns_owner ON outreach.campaigns (owner_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON outreach.campaigns (status);
CREATE INDEX IF NOT EXISTS idx_campaigns_auto_due
    ON outreach.campaigns (next_cycle_at)
    WHERE kind = 'auto' AND status = 'active' AND auto_status = 'live';

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

-- ── Runs ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS outreach.runs (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id  uuid NOT NULL REFERENCES outreach.campaigns (id),
    user_id      uuid NOT NULL REFERENCES outreach.users (id),
    status       text NOT NULL DEFAULT 'uploading',
    stats        jsonb NOT NULL DEFAULT '{}'::jsonb,
    error        text,
    started_at   timestamptz NOT NULL DEFAULT now(),
    finished_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_runs_campaign ON outreach.runs (campaign_id);
CREATE INDEX IF NOT EXISTS idx_runs_user ON outreach.runs (user_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON outreach.runs (status);

-- ── Uploads ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS outreach.uploads (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id              uuid NOT NULL REFERENCES outreach.runs (id),
    file_name           text NOT NULL,
    mime_type           text,
    byte_size           bigint,
    storage_path        text NOT NULL,
    content_hash        text,
    status              text NOT NULL DEFAULT 'uploaded',
    extraction_summary  jsonb,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_uploads_run ON outreach.uploads (run_id);
CREATE INDEX IF NOT EXISTS idx_uploads_content_hash ON outreach.uploads (content_hash);

-- ── Companies (domain-keyed cache) ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS outreach.companies (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    domain         text NOT NULL UNIQUE,
    email_formats  jsonb NOT NULL DEFAULT '[]'::jsonb,
    mx_status      text,
    verified_at    timestamptz,
    researched_at  timestamptz,
    scrape_paths   jsonb NOT NULL DEFAULT '[]'::jsonb,
    scrape_checked_at timestamptz,
    source         text
);

ALTER TABLE outreach.companies
    ADD COLUMN IF NOT EXISTS scrape_paths jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS scrape_checked_at timestamptz;

CREATE TABLE IF NOT EXISTS outreach.leads (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sf_contact_id         text,
    first_name            text,
    last_name             text,
    full_name             text NOT NULL,
    credentials           text,
    title                 text,
    company_name          text,
    company_id            text,
    outreach_company_id   uuid REFERENCES outreach.companies (id),
    location              text,
    email_primary         text,
    email_alt_1           text,
    email_alt_2           text,
    email_status          text NOT NULL DEFAULT 'not_found',
    email_source_note     text,
    email_verification    text,
    email_mx_status       text,
    email_verified_at     timestamptz,
    direct_email_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    linkedin_url          text,
    profile_enrichment    jsonb NOT NULL DEFAULT '{}'::jsonb,
    source_run_id         uuid REFERENCES outreach.runs (id),
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE outreach.leads
    ADD COLUMN IF NOT EXISTS profile_enrichment jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS direct_email_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS email_verified_at timestamptz,
    ADD COLUMN IF NOT EXISTS email_mx_status text;

ALTER TABLE outreach.leads
    ADD COLUMN IF NOT EXISTS apollo_person_id text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_apollo_person_id_unique
    ON outreach.leads (apollo_person_id)
    WHERE apollo_person_id IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'leads_email_status_check'
        AND conrelid = 'outreach.leads'::regclass
    ) THEN
      ALTER TABLE outreach.leads
        ADD CONSTRAINT leads_email_status_check
        CHECK (email_status IN (
          'direct', 'from_embark_db', 'inferred', 'format_guess', 'not_found'
        )) NOT VALID;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'leads_email_verification_check'
        AND conrelid = 'outreach.leads'::regclass
    ) THEN
      ALTER TABLE outreach.leads
        ADD CONSTRAINT leads_email_verification_check
        CHECK (
          email_verification IS NULL OR email_verification IN (
            'pending', 'valid', 'invalid', 'accept_all', 'risky', 'unknown', 'rate_limited'
          )
        ) NOT VALID;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'leads_email_mx_status_check'
        AND conrelid = 'outreach.leads'::regclass
    ) THEN
      ALTER TABLE outreach.leads
        ADD CONSTRAINT leads_email_mx_status_check
        CHECK (email_mx_status IS NULL OR email_mx_status IN ('ok', 'no_mx', 'unknown')) NOT VALID;
    END IF;
END $$;

-- Ensure rate_limited is allowed on existing databases that already had the check.
DO $$
BEGIN
    ALTER TABLE outreach.leads DROP CONSTRAINT IF EXISTS leads_email_verification_check;
    ALTER TABLE outreach.leads
      ADD CONSTRAINT leads_email_verification_check
      CHECK (
        email_verification IS NULL OR email_verification IN (
          'pending', 'valid', 'invalid', 'accept_all', 'risky', 'unknown', 'rate_limited'
        )
      ) NOT VALID;
END $$;

CREATE INDEX IF NOT EXISTS idx_leads_sf_contact ON outreach.leads (sf_contact_id);
CREATE INDEX IF NOT EXISTS idx_leads_full_name_trgm
    ON outreach.leads USING gin (full_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_leads_company_name_trgm
    ON outreach.leads USING gin (company_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_leads_email_lower
    ON outreach.leads (lower(email_primary));
CREATE INDEX IF NOT EXISTS idx_leads_source_run ON outreach.leads (source_run_id);

-- ── Company resolutions (name-in-context → domain) ──────────────────────────

CREATE TABLE IF NOT EXISTS outreach.company_resolutions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    normalized_name     text NOT NULL,
    disambiguation_hash text NOT NULL,
    resolved_domain     text,
    confidence          text NOT NULL,
    evidence            text,
    disambiguation      jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (normalized_name, disambiguation_hash)
);

ALTER TABLE outreach.company_resolutions
    ADD COLUMN IF NOT EXISTS disambiguation jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_company_resolutions_name
    ON outreach.company_resolutions (normalized_name);

-- ── Campaign leads (cumulative sheet) ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS outreach.campaign_leads (
    campaign_id            uuid NOT NULL REFERENCES outreach.campaigns (id),
    lead_id                uuid NOT NULL REFERENCES outreach.leads (id),
    run_id                 uuid NOT NULL REFERENCES outreach.runs (id),
    relationship_snapshot  jsonb,
    reused_from_prior_lead boolean NOT NULL DEFAULT false,
    PRIMARY KEY (campaign_id, lead_id)
);

ALTER TABLE outreach.campaign_leads
    ADD COLUMN IF NOT EXISTS reused_from_prior_lead boolean NOT NULL DEFAULT false;

ALTER TABLE outreach.campaign_leads
    ADD COLUMN IF NOT EXISTS prior_enrichment_pending boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS prior_enrichment_lead_id uuid REFERENCES outreach.leads (id);

-- Arbitrary non-canonical columns for this lead on this campaign's sheet, keyed by
-- display header (e.g. "LinkedIn Relationship", or any column a user adds via the
-- download → edit → Upload & Replace round-trip). Flows into the drafting input.
ALTER TABLE outreach.campaign_leads
    ADD COLUMN IF NOT EXISTS extra_fields jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE outreach.campaign_leads
    ADD COLUMN IF NOT EXISTS sourced_on date;
ALTER TABLE outreach.campaign_leads
    ADD COLUMN IF NOT EXISTS expansion_step int;

CREATE INDEX IF NOT EXISTS idx_campaign_leads_sourced_on
    ON outreach.campaign_leads (campaign_id, sourced_on);

CREATE INDEX IF NOT EXISTS idx_campaign_leads_prior_pending
    ON outreach.campaign_leads (run_id)
    WHERE prior_enrichment_pending;

CREATE INDEX IF NOT EXISTS idx_campaign_leads_campaign ON outreach.campaign_leads (campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_leads_run ON outreach.campaign_leads (run_id);
CREATE INDEX IF NOT EXISTS idx_campaign_leads_lead ON outreach.campaign_leads (lead_id);

-- ── Company research jobs (web enrichment queue) ────────────────────────────

CREATE TABLE IF NOT EXISTS outreach.company_research_jobs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_key         text NOT NULL UNIQUE,
    job_kind            text NOT NULL DEFAULT 'primary',
    disambiguation      jsonb NOT NULL DEFAULT '{}'::jsonb,
    status              text NOT NULL DEFAULT 'pending',
    attempt_count       int NOT NULL DEFAULT 0,
    search_budget       int NOT NULL DEFAULT 5,
    searches_used       int NOT NULL DEFAULT 0,
    claimed_at          timestamptz,
    resolved_domain     text,
    research_result     jsonb,
    grade               text,
    last_error          text,
    requested_by_runs   uuid[] NOT NULL DEFAULT '{}'::uuid[],
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE outreach.company_research_jobs
    ADD COLUMN IF NOT EXISTS research_result jsonb;
ALTER TABLE outreach.company_research_jobs
    ADD COLUMN IF NOT EXISTS search_budget int NOT NULL DEFAULT 5,
    ADD COLUMN IF NOT EXISTS searches_used int NOT NULL DEFAULT 0;
ALTER TABLE outreach.company_research_jobs
    ADD COLUMN IF NOT EXISTS grade text;
ALTER TABLE outreach.company_research_jobs
    ADD COLUMN IF NOT EXISTS job_kind text NOT NULL DEFAULT 'primary';

CREATE INDEX IF NOT EXISTS idx_research_jobs_status
    ON outreach.company_research_jobs (status);
CREATE INDEX IF NOT EXISTS idx_research_jobs_claimed
    ON outreach.company_research_jobs (claimed_at);
-- Identity resolution queries outreach.leads directly (Embark contacts retired).
DROP VIEW IF EXISTS outreach.all_people CASCADE;

-- ── RPC functions (public schema — callable via supabase.rpc) ───────────────

DROP FUNCTION IF EXISTS public.enqueue(text, jsonb, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.enqueue(text, jsonb, uuid, text);
DROP FUNCTION IF EXISTS public.enqueue(text, jsonb, uuid);

CREATE OR REPLACE FUNCTION public.enqueue(
    p_company_key text,
    p_disambiguation jsonb,
    p_run_id uuid,
    p_job_kind text DEFAULT 'primary'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = outreach, public
AS $$
DECLARE
    v_job_id uuid;
    v_target_count int;
    v_needs_profile boolean;
    v_budget int;
BEGIN
    SELECT count(*)::int
      INTO v_target_count
      FROM jsonb_array_elements(coalesce(p_disambiguation->'people', '[]'::jsonb)) AS person
     WHERE nullif(trim(person->>'email'), '') IS NULL
        OR coalesce(person->>'email_status', '') IN ('inferred', 'format_guess');
    SELECT coalesce(bool_or(jsonb_array_length(coalesce(person->'requested_fields', '[]'::jsonb)) > 0), false)
      INTO v_needs_profile
      FROM jsonb_array_elements(coalesce(p_disambiguation->'people', '[]'::jsonb)) AS person;
    v_budget := CASE
      WHEN p_job_kind = 'profile_rescue' THEN 2
      WHEN v_target_count <= 0 AND NOT v_needs_profile THEN 0
      WHEN v_target_count <= 2 THEN 5
      ELSE 10
    END;

    INSERT INTO outreach.company_research_jobs (
        company_key, disambiguation, requested_by_runs, job_kind, search_budget
    )
    VALUES (
        p_company_key, p_disambiguation, ARRAY[p_run_id], p_job_kind, v_budget
    )
    ON CONFLICT (company_key) DO UPDATE SET
        disambiguation = EXCLUDED.disambiguation,
        job_kind = EXCLUDED.job_kind,
        search_budget = CASE
            WHEN outreach.company_research_jobs.searches_used = 0 THEN EXCLUDED.search_budget
            ELSE outreach.company_research_jobs.search_budget
        END,
        requested_by_runs = CASE
            WHEN NOT outreach.company_research_jobs.requested_by_runs @> ARRAY[p_run_id]
            THEN array_append(outreach.company_research_jobs.requested_by_runs, p_run_id)
            ELSE outreach.company_research_jobs.requested_by_runs
        END,
        status = CASE
            WHEN outreach.company_research_jobs.status = 'failed'
                 AND outreach.company_research_jobs.attempt_count < 2
            THEN 'pending'
            ELSE outreach.company_research_jobs.status
        END,
        updated_at = now()
    RETURNING id INTO v_job_id;
    RETURN v_job_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_research_job(p_job_id uuid)
RETURNS SETOF outreach.company_research_jobs
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = outreach, public
AS $$
BEGIN
    -- Align with orchestration max_attempts (3+) so a killed worker mid-flight
    -- can be reclaimed. attempt_count < 2 left jobs permanently in_flight while
    -- research.company orch jobs marked themselves done on empty claim.
    RETURN QUERY
    UPDATE outreach.company_research_jobs AS j
    SET
        status = 'in_flight',
        claimed_at = now(),
        attempt_count = j.attempt_count + 1,
        updated_at = now()
    WHERE j.id = p_job_id
      AND j.attempt_count < 5
      AND (
        j.status = 'pending'
        OR (j.status = 'in_flight' AND j.claimed_at < now() - interval '10 minutes')
      )
    RETURNING j.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_research_jobs(p_batch_size int DEFAULT 1)
RETURNS SETOF outreach.company_research_jobs
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = outreach, public
AS $$
BEGIN
    RETURN QUERY
    UPDATE outreach.company_research_jobs AS j
    SET
        status = 'in_flight',
        claimed_at = now(),
        attempt_count = j.attempt_count + 1,
        updated_at = now()
    WHERE j.id IN (
        SELECT crj.id
        FROM outreach.company_research_jobs AS crj
        WHERE crj.attempt_count < 5
          AND (
            crj.status = 'pending'
            OR (crj.status = 'in_flight'
                AND crj.claimed_at < now() - interval '10 minutes')
          )
        ORDER BY crj.created_at
        FOR UPDATE SKIP LOCKED
        LIMIT GREATEST(p_batch_size, 1)
    )
    RETURNING j.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_research_job(
    p_job_id uuid,
    p_status text,
    p_resolved_domain text DEFAULT NULL,
    p_last_error text DEFAULT NULL
)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = outreach, public
AS $$
DECLARE
    v_runs uuid[];
    v_completed uuid[] := ARRAY[]::uuid[];
    v_run_id uuid;
BEGIN
    IF p_status NOT IN ('done', 'failed') THEN
        RAISE EXCEPTION 'finish_research_job: status must be done or failed, got %', p_status;
    END IF;

    SELECT requested_by_runs INTO v_runs
    FROM outreach.company_research_jobs
    WHERE id = p_job_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'finish_research_job: job % not found', p_job_id;
    END IF;

    UPDATE outreach.company_research_jobs
    SET
        status = p_status,
        resolved_domain = COALESCE(p_resolved_domain, resolved_domain),
        last_error = p_last_error,
        claimed_at = NULL,
        updated_at = now()
    WHERE id = p_job_id;

    IF v_runs IS NOT NULL THEN
        FOREACH v_run_id IN ARRAY v_runs LOOP
            IF NOT EXISTS (
                SELECT 1
                FROM outreach.company_research_jobs AS crj
                WHERE v_run_id = ANY (crj.requested_by_runs)
                  AND crj.status IN ('pending', 'in_flight')
            ) THEN
                v_completed := array_append(v_completed, v_run_id);
            END IF;
        END LOOP;
    END IF;

    RETURN v_completed;
END;
$$;

-- Grant execute to service role (supabaseAdmin uses service role)
GRANT USAGE ON SCHEMA outreach TO postgres, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA outreach TO postgres, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA outreach TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.enqueue(text, jsonb, uuid, text) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.claim_research_jobs(int) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.claim_research_job(uuid) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.finish_research_job(uuid, text, text, text) TO postgres, service_role;
