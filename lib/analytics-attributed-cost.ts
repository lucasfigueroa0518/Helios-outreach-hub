/**
 * Hub attributed Claude spend: UNION of existing work rows.
 * Do not read outreach.lead_cost_events (allocation table, not the bill).
 */

import { dbQuery } from '@/lib/db';

export type AttributedCostPhase =
  | 'enrichment'
  | 'drafting'
  | 'replies'
  | 'extraction'
  | 'dashboards';

export type AttributedCostRow = {
  campaign_id: string | null;
  user_id: string | null;
  phase: AttributedCostPhase;
  cost_usd: string;
  event_count: string;
  unattributed_cost_usd: string;
  source_id: string | null;
};

export type AttributedCostDailyRow = {
  day: string;
  enrichment_cost: string;
  drafting_cost: string;
  replies_cost: string;
  extraction_cost: string;
  dashboards_cost: string;
};

export type AttributedCostCampaignRow = {
  campaign_id: string;
  enrichment_cost: string;
  drafting_cost: string;
  replies_cost: string;
  extraction_cost: string;
  enrichment_jobs: string;
};

/**
 * Complete UTC calendar days inside an analytics window.
 * Today is excluded because Cost API daily buckets can lag ~5 minutes and
 * the current UTC day is incomplete.
 */
export function completeUtcDaysInWindow(
  window: { from: string; to: string },
  now: Date = new Date(),
): { fromDay: string; toDay: string } | null {
  const fromDay = window.from.slice(0, 10);
  const toDay = window.to.slice(0, 10);
  const todayUtc = now.toISOString().slice(0, 10);
  const lastComplete = toDay < todayUtc ? toDay : previousUtcDay(todayUtc);
  if (!lastComplete || lastComplete < fromDay) return null;
  return { fromDay, toDay: lastComplete };
}

export function previousUtcDay(isoDay: string): string {
  const d = new Date(`${isoDay}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Work-row UNION. Enrichment is one row per (research job, intersecting campaign)
 * so Hub can show the job under every matching campaign while JS counts each
 * job once in the org total.
 *
 * $1 from, $2 to, $3 campaign ids, $4 excluded lead ids, $5 excluded run ids
 */
export const ATTRIBUTED_COST_UNION_SQL = `
  SELECT DISTINCT
    c.id::text AS campaign_id,
    c.owner_id::text AS user_id,
    'enrichment'::text AS phase,
    coalesce(job.actual_cost_usd, 0) AS cost_usd,
    job.id::text AS source_id,
    0::numeric AS unattributed_cost_usd,
    job.updated_at AS occurred_at
  FROM outreach.company_research_jobs job
  JOIN LATERAL unnest(job.requested_by_runs) AS run_id ON true
  JOIN outreach.runs r ON r.id = run_id
  JOIN outreach.campaigns c ON c.id = r.campaign_id
  WHERE job.updated_at >= $1::timestamptz
    AND job.updated_at <= $2::timestamptz
    AND job.actual_cost_usd > 0
    AND c.id = ANY($3::uuid[])
    AND ($5::uuid[] IS NULL OR cardinality($5::uuid[]) = 0 OR run_id <> ALL($5::uuid[]))
  UNION ALL
  SELECT
    c.id::text,
    c.owner_id::text,
    'drafting'::text,
    event.actual_cost_usd,
    event.id::text,
    0::numeric,
    event.created_at
  FROM outreach.drafting_job_cost_events event
  JOIN outreach.drafting_items item ON item.id = event.drafting_item_id
  JOIN outreach.drafting_workspaces workspace ON workspace.id = item.workspace_id
  JOIN outreach.campaigns c ON c.id = workspace.campaign_id
  WHERE event.created_at >= $1::timestamptz
    AND event.created_at <= $2::timestamptz
    AND c.id = ANY($3::uuid[])
    AND event.actual_cost_usd > 0
    AND ($4::uuid[] IS NULL OR cardinality($4::uuid[]) = 0 OR item.lead_id <> ALL($4::uuid[]))
  UNION ALL
  SELECT
    c.id::text,
    c.owner_id::text,
    'drafting'::text,
    opening.actual_cost_usd,
    opening.drafting_run_id::text,
    opening.actual_cost_usd,
    opening.occurred_at
  FROM outreach.drafting_run_cost_opening_balances opening
  JOIN outreach.campaigns c ON c.id = opening.campaign_id
  WHERE opening.occurred_at >= $1::timestamptz
    AND opening.occurred_at <= $2::timestamptz
    AND c.id = ANY($3::uuid[])
  UNION ALL
  SELECT
    c.id::text,
    c.owner_id::text,
    'replies'::text,
    coalesce(rs.actual_cost_usd, 0),
    rs.id::text,
    0::numeric,
    rs.created_at
  FROM outreach.reply_sends rs
  JOIN outreach.campaigns c ON c.id = rs.campaign_id
  LEFT JOIN outreach.drafting_items item ON item.id = rs.drafting_item_id
  WHERE rs.created_at >= $1::timestamptz
    AND rs.created_at <= $2::timestamptz
    AND c.id = ANY($3::uuid[])
    AND ($4::uuid[] IS NULL OR cardinality($4::uuid[]) = 0 OR item.lead_id IS NULL OR item.lead_id <> ALL($4::uuid[]))
  UNION ALL
  SELECT
    c.id::text,
    c.owner_id::text,
    'extraction'::text,
    coalesce(nullif(u.extraction_summary->>'actual_cost_usd', '')::numeric, 0),
    u.id::text,
    0::numeric,
    u.created_at
  FROM outreach.uploads u
  JOIN outreach.runs r ON r.id = u.run_id
  JOIN outreach.campaigns c ON c.id = r.campaign_id
  WHERE u.created_at >= $1::timestamptz
    AND u.created_at <= $2::timestamptz
    AND c.id = ANY($3::uuid[])
    AND ($5::uuid[] IS NULL OR cardinality($5::uuid[]) = 0 OR u.run_id <> ALL($5::uuid[]))
    AND u.extraction_summary ? 'actual_cost_usd'
  UNION ALL
  SELECT
    NULL::text,
    NULL::text,
    'dashboards'::text,
    coalesce(cu.actual_cost_usd, 0),
    cu.id::text,
    0::numeric,
    cu.generated_at
  FROM dashboards.context_updates cu
  WHERE cu.generated_at >= $1::timestamptz
    AND cu.generated_at <= $2::timestamptz
`;

export async function loadAttributedCostRows(input: {
  from: string;
  to: string;
  campaignIds: string[];
  excludedLeadIds: string[];
  excludedRunIds: string[];
}): Promise<AttributedCostRow[]> {
  const { rows } = await dbQuery<AttributedCostRow>(
    `WITH cost_rows AS (
       ${ATTRIBUTED_COST_UNION_SQL}
     )
     SELECT
       campaign_id,
       user_id,
       phase,
       coalesce(sum(cost_usd), 0)::text AS cost_usd,
       count(*)::text AS event_count,
       coalesce(sum(unattributed_cost_usd), 0)::text AS unattributed_cost_usd,
       CASE WHEN phase = 'enrichment' THEN source_id ELSE NULL END AS source_id
     FROM cost_rows
     GROUP BY campaign_id, user_id, phase,
              CASE WHEN phase = 'enrichment' THEN source_id ELSE NULL END`,
    [
      input.from,
      input.to,
      input.campaignIds,
      input.excludedLeadIds.length ? input.excludedLeadIds : null,
      input.excludedRunIds.length ? input.excludedRunIds : null,
    ],
  );
  return rows;
}

export async function loadAttributedCostDaily(input: {
  from: string;
  to: string;
  campaignIds: string[];
  excludedLeadIds: string[];
  excludedRunIds: string[];
}): Promise<AttributedCostDailyRow[]> {
  const { rows } = await dbQuery<AttributedCostDailyRow>(
    `WITH days AS (
       SELECT generate_series($1::timestamptz, $2::timestamptz, interval '1 day')::date AS day
     ),
     cost_rows AS (
       ${ATTRIBUTED_COST_UNION_SQL}
     ),
     unique_enrichment AS (
       SELECT date_trunc('day', occurred_at)::date AS day,
              source_id,
              max(cost_usd) AS cost_usd
         FROM cost_rows
        WHERE phase = 'enrichment'
        GROUP BY 1, 2
     ),
     other_cost AS (
       SELECT date_trunc('day', occurred_at)::date AS day,
              phase,
              sum(cost_usd) AS cost_usd
         FROM cost_rows
        WHERE phase <> 'enrichment'
        GROUP BY 1, 2
     )
     SELECT d.day::text AS day,
            coalesce((SELECT sum(cost_usd) FROM unique_enrichment e WHERE e.day = d.day), 0)::text AS enrichment_cost,
            coalesce((SELECT sum(cost_usd) FROM other_cost o WHERE o.day = d.day AND o.phase = 'drafting'), 0)::text AS drafting_cost,
            coalesce((SELECT sum(cost_usd) FROM other_cost o WHERE o.day = d.day AND o.phase = 'replies'), 0)::text AS replies_cost,
            coalesce((SELECT sum(cost_usd) FROM other_cost o WHERE o.day = d.day AND o.phase = 'extraction'), 0)::text AS extraction_cost,
            coalesce((SELECT sum(cost_usd) FROM other_cost o WHERE o.day = d.day AND o.phase = 'dashboards'), 0)::text AS dashboards_cost
       FROM days d
      ORDER BY d.day ASC`,
    [
      input.from,
      input.to,
      input.campaignIds,
      input.excludedLeadIds.length ? input.excludedLeadIds : null,
      input.excludedRunIds.length ? input.excludedRunIds : null,
    ],
  );
  return rows;
}

export async function loadAttributedCostByCampaign(input: {
  from: string;
  to: string;
  campaignIds: string[];
  excludedLeadIds: string[];
  excludedRunIds: string[];
}): Promise<AttributedCostCampaignRow[]> {
  const { rows } = await dbQuery<AttributedCostCampaignRow>(
    `WITH cost_rows AS (
       ${ATTRIBUTED_COST_UNION_SQL}
     )
     SELECT campaign_id,
            coalesce(sum(cost_usd) FILTER (WHERE phase = 'enrichment'), 0)::text AS enrichment_cost,
            coalesce(sum(cost_usd) FILTER (WHERE phase = 'drafting'), 0)::text AS drafting_cost,
            coalesce(sum(cost_usd) FILTER (WHERE phase = 'replies'), 0)::text AS replies_cost,
            coalesce(sum(cost_usd) FILTER (WHERE phase = 'extraction'), 0)::text AS extraction_cost,
            count(*) FILTER (WHERE phase = 'enrichment')::text AS enrichment_jobs
       FROM cost_rows
      WHERE campaign_id IS NOT NULL
      GROUP BY campaign_id`,
    [
      input.from,
      input.to,
      input.campaignIds,
      input.excludedLeadIds.length ? input.excludedLeadIds : null,
      input.excludedRunIds.length ? input.excludedRunIds : null,
    ],
  );
  return rows;
}

export type DraftingSpendDenominatorRow = {
  campaign_id: string;
  user_id: string;
  drafting_jobs: string;
  drafted_leads: string;
};

/** Distinct paid drafting jobs and leads in the window — not cost-event rows or roster size. */
export async function loadDraftingSpendDenominators(input: {
  from: string;
  to: string;
  campaignIds: string[];
  excludedLeadIds: string[];
}): Promise<DraftingSpendDenominatorRow[]> {
  const { rows } = await dbQuery<DraftingSpendDenominatorRow>(
    `SELECT c.id::text AS campaign_id,
            c.owner_id::text AS user_id,
            count(DISTINCT event.drafting_job_id)::text AS drafting_jobs,
            count(DISTINCT item.lead_id)::text AS drafted_leads
       FROM outreach.drafting_job_cost_events event
       JOIN outreach.drafting_items item ON item.id = event.drafting_item_id
       JOIN outreach.drafting_workspaces workspace ON workspace.id = item.workspace_id
       JOIN outreach.campaigns c ON c.id = workspace.campaign_id
      WHERE event.created_at >= $1::timestamptz
        AND event.created_at <= $2::timestamptz
        AND event.actual_cost_usd > 0
        AND c.id = ANY($3::uuid[])
        AND ($4::uuid[] IS NULL OR cardinality($4::uuid[]) = 0 OR item.lead_id <> ALL($4::uuid[]))
      GROUP BY c.id, c.owner_id`,
    [
      input.from,
      input.to,
      input.campaignIds,
      input.excludedLeadIds.length ? input.excludedLeadIds : null,
    ],
  );
  return rows;
}

export async function loadAnthropicBilledUsd(fromDay: string, toDay: string): Promise<number> {
  const { rows } = await dbQuery<{ billed: string }>(
    `SELECT coalesce(sum(amount_usd), 0)::text AS billed
       FROM outreach.anthropic_cost_report_days
      WHERE day_utc >= $1::date
        AND day_utc <= $2::date`,
    [fromDay, toDay],
  );
  return Number(rows[0]?.billed ?? 0);
}

export async function loadAnthropicBilledDaily(fromDay: string, toDay: string): Promise<{ day: string; billed: string }[]> {
  const { rows } = await dbQuery<{ day: string; billed: string }>(
    `SELECT day_utc::text AS day, coalesce(sum(amount_usd), 0)::text AS billed
       FROM outreach.anthropic_cost_report_days
      WHERE day_utc >= $1::date
        AND day_utc <= $2::date
      GROUP BY day_utc
      ORDER BY day_utc`,
    [fromDay, toDay],
  );
  return rows;
}

export async function loadAnthropicBilledBreakdown(fromDay: string, toDay: string): Promise<{
  day: string;
  model: string | null;
  token_type: string | null;
  cost_type: string | null;
  description: string | null;
  amount_usd: string;
}[]> {
  const { rows } = await dbQuery<{
    day: string;
    model: string | null;
    token_type: string | null;
    cost_type: string | null;
    description: string | null;
    amount_usd: string;
  }>(
    `SELECT day_utc::text AS day,
            model,
            token_type,
            cost_type,
            description,
            amount_usd::text
       FROM outreach.anthropic_cost_report_days
      WHERE day_utc >= $1::date
        AND day_utc <= $2::date
      ORDER BY day_utc DESC, amount_usd DESC
      LIMIT 200`,
    [fromDay, toDay],
  );
  return rows;
}

export async function loadAnthropicBilledByModel(fromDay: string, toDay: string): Promise<{
  model: string;
  amount_usd: string;
}[]> {
  const { rows } = await dbQuery<{ model: string; amount_usd: string }>(
    `SELECT coalesce(nullif(model, ''), '(unspecified model)') AS model,
            coalesce(sum(amount_usd), 0)::text AS amount_usd
       FROM outreach.anthropic_cost_report_days
      WHERE day_utc >= $1::date
        AND day_utc <= $2::date
      GROUP BY 1
      ORDER BY sum(amount_usd) DESC`,
    [fromDay, toDay],
  );
  return rows;
}
