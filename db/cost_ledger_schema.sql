-- Per-lead enrichment + drafting cost ledger for trailing averages / campaign estimates.

CREATE TABLE IF NOT EXISTS outreach.lead_cost_events (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id          uuid NOT NULL REFERENCES outreach.leads (id) ON DELETE CASCADE,
    campaign_id      uuid REFERENCES outreach.campaigns (id) ON DELETE SET NULL,
    phase            text NOT NULL CHECK (phase IN ('enrichment', 'drafting')),
    actual_cost_usd  numeric(10, 4) NOT NULL CHECK (actual_cost_usd >= 0),
    usage            jsonb NOT NULL DEFAULT '{}'::jsonb,
    source_kind      text NOT NULL,
    source_id        text NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS lead_cost_events_source_uidx
    ON outreach.lead_cost_events (phase, source_kind, source_id, lead_id);

CREATE INDEX IF NOT EXISTS lead_cost_events_phase_created_idx
    ON outreach.lead_cost_events (phase, created_at DESC);

CREATE INDEX IF NOT EXISTS lead_cost_events_lead_idx
    ON outreach.lead_cost_events (lead_id, phase);

ALTER TABLE outreach.company_research_jobs
    ADD COLUMN IF NOT EXISTS actual_cost_usd numeric(10, 4),
    ADD COLUMN IF NOT EXISTS usage jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Historical drafting research rows initially priced the Haiku adversarial
-- pass with Sonnet rates. Reprice that nested pass at Haiku $1/$5 MTok while
-- preserving primary-research and web-search cost. This update is idempotent.
WITH repriced AS (
    SELECT
        j.id,
        greatest(
            0,
            j.actual_cost_usd
              - coalesce((j.usage #>> '{adversarial,usage,costUsd}')::numeric, 0)
              + (
                  coalesce((j.usage #>> '{adversarial,usage,inputTokens}')::numeric, 0)
                    / 1000000 * 1
                  + coalesce((j.usage #>> '{adversarial,usage,outputTokens}')::numeric, 0)
                    / 1000000 * 5
                  + coalesce((j.usage #>> '{adversarial,usage,searches}')::numeric, 0)
                    * 0.01
                )
        )::numeric(10, 4) AS corrected_total,
        (
            coalesce((j.usage #>> '{adversarial,usage,inputTokens}')::numeric, 0)
              / 1000000 * 1
            + coalesce((j.usage #>> '{adversarial,usage,outputTokens}')::numeric, 0)
              / 1000000 * 5
            + coalesce((j.usage #>> '{adversarial,usage,searches}')::numeric, 0)
              * 0.01
        )::numeric(10, 4) AS corrected_adversarial
    FROM outreach.drafting_jobs j
    WHERE j.kind = 'research'
      AND j.usage #>> '{adversarial,usage,costUsd}' IS NOT NULL
      AND NOT EXISTS (
          SELECT 1
          FROM outreach.drafting_job_cost_events event
          WHERE event.drafting_job_id = j.id
      )
)
UPDATE outreach.drafting_jobs j
   SET actual_cost_usd = repriced.corrected_total,
       usage = jsonb_set(
           jsonb_set(
               j.usage,
               '{adversarial,usage,costUsd}',
               to_jsonb(repriced.corrected_adversarial::text),
               false
           ),
           '{costUsd}',
           to_jsonb(repriced.corrected_total::text),
           false
       )
  FROM repriced
 WHERE j.id = repriced.id;

UPDATE outreach.drafting_runs run
   SET actual_cost_usd = greatest(run.actual_cost_usd, totals.actual_cost_usd)
  FROM (
      SELECT
          run_id,
          (
            coalesce(sum(event_cost), 0)
              + max(opening_cost)
          )::numeric(10, 4) AS actual_cost_usd
      FROM (
          SELECT drafting_run_id AS run_id, actual_cost_usd AS event_cost, 0::numeric AS opening_cost
          FROM outreach.drafting_job_cost_events
          UNION ALL
          SELECT drafting_run_id AS run_id, 0::numeric AS event_cost, actual_cost_usd AS opening_cost
          FROM outreach.drafting_run_cost_opening_balances
      ) durable_cost
      GROUP BY run_id
  ) totals
 WHERE run.id = totals.run_id;

UPDATE outreach.lead_cost_events event
   SET actual_cost_usd = greatest(event.actual_cost_usd, totals.actual_cost_usd)
  FROM (
      SELECT drafting_item_id, coalesce(sum(actual_cost_usd), 0)::numeric(10, 4) AS actual_cost_usd
      FROM outreach.drafting_job_cost_events
      GROUP BY drafting_item_id
  ) totals
 WHERE event.phase = 'drafting'
   AND event.source_kind = 'drafting_item'
   AND event.source_id = totals.drafting_item_id::text;

GRANT ALL ON TABLE outreach.lead_cost_events TO postgres, service_role;
