-- Durable Postgres orchestration queue for Outreach Hub.
-- Postgres is the source of truth; workers are stateless and horizontally scalable.
\set ON_ERROR_STOP on

CREATE SCHEMA IF NOT EXISTS outreach;

CREATE TABLE IF NOT EXISTS outreach.orchestration_jobs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind                text NOT NULL,
    lane                text NOT NULL,
    payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
    dedupe_key          text NOT NULL,
    scope_key           text NOT NULL,
    status              text NOT NULL DEFAULT 'pending',
    priority            smallint NOT NULL DEFAULT 0,
    attempt_count       int NOT NULL DEFAULT 0,
    max_attempts        int NOT NULL DEFAULT 3,
    available_at        timestamptz NOT NULL DEFAULT now(),
    lease_owner         text,
    lease_expires_at    timestamptz,
    heartbeat_at        timestamptz,
    started_at          timestamptz,
    finished_at         timestamptz,
    result              jsonb NOT NULL DEFAULT '{}'::jsonb,
    last_error_code     text,
    last_error_message  text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (kind, dedupe_key),
    CHECK (status IN ('pending', 'in_flight', 'done', 'failed', 'cancelled')),
    CHECK (attempt_count >= 0),
    CHECK (max_attempts > 0)
);

CREATE INDEX IF NOT EXISTS orchestration_jobs_pending_lane_idx
    ON outreach.orchestration_jobs (
        lane, priority DESC, available_at, created_at
    )
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS orchestration_jobs_in_flight_lane_idx
    ON outreach.orchestration_jobs (lane, lease_expires_at)
    WHERE status = 'in_flight';

CREATE INDEX IF NOT EXISTS orchestration_jobs_scope_idx
    ON outreach.orchestration_jobs (scope_key, status, created_at);

CREATE TABLE IF NOT EXISTS outreach.orchestration_lane_controls (
    lane        text PRIMARY KEY,
    paused      boolean NOT NULL DEFAULT false,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outreach.orchestration_workers (
    worker_id       text PRIMARY KEY,
    started_at      timestamptz NOT NULL DEFAULT now(),
    heartbeat_at    timestamptz NOT NULL DEFAULT now(),
    version         text,
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Durable send intent prevents a worker crash from sending the same mailbox
-- probe twice. An uncertain send is not retried automatically.
CREATE TABLE IF NOT EXISTS outreach.orchestration_mailbox_probes (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id                  uuid REFERENCES outreach.runs (id),
    scope_key               text NOT NULL,
    lead_id                 uuid NOT NULL REFERENCES outreach.leads (id),
    email                   text NOT NULL,
    status                  text NOT NULL DEFAULT 'sending',
    provider_message_id     text,
    provider_thread_id      text,
    send_started_at         timestamptz NOT NULL DEFAULT now(),
    sent_at                 timestamptz,
    updated_at              timestamptz NOT NULL DEFAULT now(),
    CHECK (status IN ('sending', 'sent'))
);

ALTER TABLE outreach.orchestration_mailbox_probes
    ADD COLUMN IF NOT EXISTS scope_key text;
UPDATE outreach.orchestration_mailbox_probes
   SET scope_key = run_id::text
 WHERE scope_key IS NULL;
ALTER TABLE outreach.orchestration_mailbox_probes
    ALTER COLUMN scope_key SET NOT NULL,
    ALTER COLUMN run_id DROP NOT NULL;
ALTER TABLE outreach.orchestration_mailbox_probes
    DROP CONSTRAINT IF EXISTS orchestration_mailbox_probes_run_id_lead_id_email_key;
CREATE UNIQUE INDEX IF NOT EXISTS orchestration_mailbox_probes_scope_key
    ON outreach.orchestration_mailbox_probes (scope_key, lead_id, email);

-- Claims at most one job while enforcing a global lane limit. The transaction
-- advisory lock serializes the short count+claim critical section per lane.
-- Scope active-count ordering provides fair sharing between campaigns/runs.
CREATE OR REPLACE FUNCTION public.claim_orchestration_job(
    p_lane text,
    p_worker_id text,
    p_lane_limit int,
    p_lease_seconds int DEFAULT 600
)
RETURNS SETOF outreach.orchestration_jobs
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = outreach, public
AS $$
DECLARE
    v_job_id uuid;
    v_active int;
    v_paused boolean;
BEGIN
    IF p_lane_limit < 1 THEN
        RAISE EXCEPTION 'claim_orchestration_job: lane limit must be positive';
    END IF;
    IF p_lease_seconds < 15 THEN
        RAISE EXCEPTION 'claim_orchestration_job: lease must be at least 15 seconds';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('outreach-orchestration:' || p_lane, 0));

    SELECT coalesce(paused, false)
      INTO v_paused
      FROM outreach.orchestration_lane_controls
     WHERE lane = p_lane;
    IF coalesce(v_paused, false) THEN
        RETURN;
    END IF;

    -- Exhausted dead leases become terminal instead of looping forever.
    UPDATE outreach.orchestration_jobs
       SET status = 'failed',
           lease_owner = NULL,
           lease_expires_at = NULL,
           heartbeat_at = NULL,
           finished_at = now(),
           last_error_code = coalesce(last_error_code, 'lease_expired'),
           last_error_message = coalesce(
             last_error_message,
             'Worker lease expired and maximum attempts were exhausted'
           ),
           updated_at = now()
     WHERE lane = p_lane
       AND status = 'in_flight'
       AND (
         lease_expires_at <= now()
         OR lease_owner IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM outreach.orchestration_workers worker
            WHERE worker.worker_id = outreach.orchestration_jobs.lease_owner
              AND worker.heartbeat_at > now() - interval '45 seconds'
         )
       )
       AND attempt_count >= max_attempts;

    SELECT count(*)::int
      INTO v_active
      FROM outreach.orchestration_jobs
     WHERE lane = p_lane
       AND status = 'in_flight'
       AND lease_expires_at > now()
       AND lease_owner IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM outreach.orchestration_workers worker
          WHERE worker.worker_id = outreach.orchestration_jobs.lease_owner
            AND worker.heartbeat_at > now() - interval '45 seconds'
       );
    IF v_active >= p_lane_limit THEN
        RETURN;
    END IF;

    SELECT candidate.id
      INTO v_job_id
      FROM outreach.orchestration_jobs AS candidate
     WHERE candidate.lane = p_lane
       AND candidate.attempt_count < candidate.max_attempts
       AND candidate.available_at <= now()
       AND (
         candidate.status = 'pending'
         OR (
           candidate.status = 'in_flight'
           AND (
             candidate.lease_expires_at <= now()
             OR candidate.lease_owner IS NULL
             OR NOT EXISTS (
               SELECT 1 FROM outreach.orchestration_workers worker
                WHERE worker.worker_id = candidate.lease_owner
                  AND worker.heartbeat_at > now() - interval '45 seconds'
             )
           )
         )
       )
     ORDER BY
       candidate.priority DESC,
       (
         SELECT count(*)
           FROM outreach.orchestration_jobs AS active
          WHERE active.lane = candidate.lane
            AND active.scope_key = candidate.scope_key
            AND active.status = 'in_flight'
            AND active.lease_expires_at > now()
            AND active.lease_owner IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM outreach.orchestration_workers worker
               WHERE worker.worker_id = active.lease_owner
                 AND worker.heartbeat_at > now() - interval '45 seconds'
            )
       ) ASC,
       candidate.available_at,
       candidate.created_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1;

    IF v_job_id IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    UPDATE outreach.orchestration_jobs AS job
       SET status = 'in_flight',
           attempt_count = job.attempt_count + 1,
           lease_owner = p_worker_id,
           lease_expires_at = now() + make_interval(secs => p_lease_seconds),
           heartbeat_at = now(),
           started_at = coalesce(job.started_at, now()),
           updated_at = now()
     WHERE job.id = v_job_id
     RETURNING job.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.heartbeat_orchestration_job(
    p_job_id uuid,
    p_worker_id text,
    p_lease_seconds int DEFAULT 600
)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = outreach, public
AS $$
    WITH refreshed AS (
      UPDATE outreach.orchestration_jobs
         SET heartbeat_at = now(),
             lease_expires_at = now() + make_interval(secs => p_lease_seconds),
             updated_at = now()
       WHERE id = p_job_id
         AND status = 'in_flight'
         AND lease_owner = p_worker_id
       RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM refreshed);
$$;

GRANT USAGE ON SCHEMA outreach TO postgres, service_role;
GRANT ALL ON TABLE outreach.orchestration_jobs TO postgres, service_role;
GRANT ALL ON TABLE outreach.orchestration_lane_controls TO postgres, service_role;
GRANT ALL ON TABLE outreach.orchestration_workers TO postgres, service_role;
GRANT ALL ON TABLE outreach.orchestration_mailbox_probes TO postgres, service_role;
REVOKE ALL ON FUNCTION public.claim_orchestration_job(text, text, int, int)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.heartbeat_orchestration_job(uuid, text, int)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_orchestration_job(text, text, int, int)
    TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.heartbeat_orchestration_job(uuid, text, int)
    TO postgres, service_role;
