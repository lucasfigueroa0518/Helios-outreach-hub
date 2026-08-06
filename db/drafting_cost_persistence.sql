-- Canonical drafting cost persistence boundary.
-- Callers must provide psql identifiers:
--   drafting_data_schema     tables and stored function search_path
--   drafting_function_schema stored function namespace

CREATE TABLE IF NOT EXISTS :"drafting_data_schema".drafting_job_cost_events (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    drafting_job_id             uuid NOT NULL REFERENCES :"drafting_data_schema".drafting_jobs (id) ON DELETE CASCADE,
    drafting_run_id             uuid NOT NULL REFERENCES :"drafting_data_schema".drafting_runs (id),
    drafting_item_id            uuid NOT NULL REFERENCES :"drafting_data_schema".drafting_items (id),
    execution_epoch             int NOT NULL,
    attempt_count               int NOT NULL,
    event_key                   text NOT NULL,
    actual_cost_usd             numeric(10, 4) NOT NULL CHECK (actual_cost_usd >= 0),
    provider_request_id         text,
    usage                       jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at                  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (drafting_job_id, event_key)
);

CREATE INDEX IF NOT EXISTS idx_drafting_job_cost_events_item_created
    ON :"drafting_data_schema".drafting_job_cost_events (drafting_item_id, created_at);

CREATE TABLE IF NOT EXISTS :"drafting_data_schema".drafting_run_cost_opening_balances (
    drafting_run_id             uuid PRIMARY KEY REFERENCES :"drafting_data_schema".drafting_runs (id) ON DELETE CASCADE,
    campaign_id                 uuid NOT NULL REFERENCES :"drafting_data_schema".campaigns (id) ON DELETE CASCADE,
    source_kind                 text NOT NULL DEFAULT 'legacy_unattributed'
      CHECK (source_kind = 'legacy_unattributed'),
    actual_cost_usd             numeric(10, 4) NOT NULL CHECK (actual_cost_usd > 0),
    occurred_at                 timestamptz NOT NULL,
    evidence                    jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_drafting_run_cost_opening_campaign_occurred
    ON :"drafting_data_schema".drafting_run_cost_opening_balances (campaign_id, occurred_at);

-- Preserve the attributable portion still present on legacy job rows. These
-- rows can be incomplete after historical retries, so they are never treated
-- as the complete run total.
INSERT INTO :"drafting_data_schema".drafting_job_cost_events (
    drafting_job_id, drafting_run_id, drafting_item_id,
    execution_epoch, attempt_count, event_key, actual_cost_usd,
    provider_request_id, usage, created_at
)
SELECT
    id, drafting_run_id, drafting_item_id,
    execution_epoch, attempt_count, 'legacy-job-total:' || id::text,
    actual_cost_usd, provider_request_id,
    jsonb_build_object('legacyAggregate', true, 'usage', usage),
    coalesce(finished_at, created_at)
FROM :"drafting_data_schema".drafting_jobs
WHERE actual_cost_usd > 0
  AND NOT EXISTS (
    SELECT 1
      FROM :"drafting_data_schema".drafting_job_cost_events existing_event
     WHERE existing_event.drafting_job_id = :"drafting_data_schema".drafting_jobs.id
  )
ON CONFLICT (drafting_job_id, event_key) DO NOTHING;

-- One immutable run-level opening balance preserves known historical spend
-- that cannot truthfully be assigned to a job, item, or lead. The residual is
-- measured once against the durable run total. Re-running this schema inserts
-- nothing and never redistributes the balance.
INSERT INTO :"drafting_data_schema".drafting_run_cost_opening_balances (
    drafting_run_id, campaign_id, actual_cost_usd, occurred_at, evidence
)
SELECT
    run.id,
    workspace.campaign_id,
    (
      run.actual_cost_usd
        - coalesce(sum(event.actual_cost_usd), 0)
    )::numeric(10, 4),
    run.started_at,
    jsonb_build_object(
      'openingRunTotalUsd', run.actual_cost_usd,
      'attributableEventTotalUsd', coalesce(sum(event.actual_cost_usd), 0),
      'attribution', 'unavailable'
    )
FROM :"drafting_data_schema".drafting_runs run
JOIN :"drafting_data_schema".drafting_workspaces workspace ON workspace.id = run.workspace_id
LEFT JOIN :"drafting_data_schema".drafting_job_cost_events event
  ON event.drafting_run_id = run.id
LEFT JOIN :"drafting_data_schema".drafting_run_cost_opening_balances existing
  ON existing.drafting_run_id = run.id
WHERE existing.drafting_run_id IS NULL
GROUP BY run.id, workspace.campaign_id
HAVING run.actual_cost_usd - coalesce(sum(event.actual_cost_usd), 0) > 0
ON CONFLICT (drafting_run_id) DO NOTHING;

CREATE OR REPLACE FUNCTION :"drafting_function_schema".record_drafting_job_cost_event(
    p_job_id uuid,
    p_actual_cost_usd numeric(10, 4),
    p_usage jsonb,
    p_provider_request_id text,
    p_cost_event_key text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = :"drafting_data_schema", public
AS $$
DECLARE
    v_job drafting_jobs%ROWTYPE;
    v_inserted integer := 0;
BEGIN
    IF p_actual_cost_usd IS NULL OR p_actual_cost_usd < 0 THEN
        RAISE EXCEPTION 'record_drafting_job_cost_event: cost must be non-negative';
    END IF;
    IF p_actual_cost_usd = 0 THEN
        RETURN false;
    END IF;
    IF p_provider_request_id IS NULL OR btrim(p_provider_request_id) = '' THEN
        RAISE EXCEPTION 'record_drafting_job_cost_event: provider request identity is required';
    END IF;
    IF p_cost_event_key IS NULL OR btrim(p_cost_event_key) = '' THEN
        RAISE EXCEPTION 'record_drafting_job_cost_event: event key is required';
    END IF;

    SELECT j.*
      INTO v_job
      FROM drafting_jobs AS j
     WHERE j.id = p_job_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'record_drafting_job_cost_event: job % not found', p_job_id;
    END IF;

    INSERT INTO drafting_job_cost_events (
        drafting_job_id, drafting_run_id, drafting_item_id,
        execution_epoch, attempt_count, event_key, actual_cost_usd,
        provider_request_id, usage
    ) VALUES (
        v_job.id, v_job.drafting_run_id, v_job.drafting_item_id,
        v_job.execution_epoch, v_job.attempt_count, p_cost_event_key,
        p_actual_cost_usd, p_provider_request_id, coalesce(p_usage, '{}'::jsonb)
    )
    ON CONFLICT (drafting_job_id, event_key) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    IF v_inserted = 1 THEN
        UPDATE drafting_jobs AS j
           SET actual_cost_usd = j.actual_cost_usd + p_actual_cost_usd,
               usage = jsonb_set(
                 j.usage,
                 '{costAttempts}',
                 coalesce(j.usage->'costAttempts', '[]'::jsonb) || jsonb_build_array(
                   jsonb_build_object(
                     'eventKey', p_cost_event_key,
                     'executionEpoch', j.execution_epoch,
                     'attemptCount', j.attempt_count,
                     'providerRequestId', p_provider_request_id,
                     'actualCostUsd', p_actual_cost_usd,
                     'usage', coalesce(p_usage, '{}'::jsonb),
                     'recordedAt', now()
                   )
                 ),
                 true
               ),
               provider_request_id = p_provider_request_id
         WHERE j.id = p_job_id;

        UPDATE drafting_runs AS r
           SET actual_cost_usd = r.actual_cost_usd + p_actual_cost_usd
         WHERE r.id = v_job.drafting_run_id;
    END IF;

    RETURN v_inserted = 1;
END;
$$;
