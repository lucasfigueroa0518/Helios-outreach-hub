/**
 * Dump Campaign enrichment + drafting pipeline insight for inefficiency analysis.
 *
 * Usage:
 *   npx tsx scripts/campaign_pipeline_insight.ts "Campaign #5"
 *   npx tsx scripts/campaign_pipeline_insight.ts 5
 */
import fs from 'node:fs';
import { dbQuery } from '@/lib/db';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}

async function resolveCampaign(arg: string) {
  const byName = await dbQuery<{ id: string; name: string }>(
    `SELECT id, name FROM outreach.campaigns
     WHERE name = $1 OR lower(name) = lower($1)
     ORDER BY created_at DESC LIMIT 1`,
    [arg],
  );
  if (byName.rows[0]) return byName.rows[0];

  if (/^\d+$/.test(arg)) {
    const byNumber = await dbQuery<{ id: string; name: string }>(
      `SELECT id, name FROM outreach.campaigns
       WHERE name ~* ('(^|\\D)#' || $1 || '(\\D|$)')
          OR name ~* ('campaign\\s*' || $1)
       ORDER BY created_at DESC LIMIT 1`,
      [arg],
    );
    if (byNumber.rows[0]) return byNumber.rows[0];
  }

  const listed = await dbQuery<{ id: string; name: string; created_at: string }>(
    `SELECT id, name, created_at FROM outreach.campaigns ORDER BY created_at DESC LIMIT 10`,
  );
  return { missing: true as const, arg, recent: listed.rows };
}

async function main() {
  const arg = process.argv.slice(2).find((value) => !value.startsWith('--')) ?? 'Campaign #5';
  const campaign = await resolveCampaign(arg);
  if ('missing' in campaign) {
    console.log(JSON.stringify(campaign, null, 2));
    return;
  }

  const runs = await dbQuery<{
    id: string;
    status: string;
    started_at: string;
    finished_at: string | null;
    stats: Record<string, unknown>;
  }>(
    `SELECT id, status, started_at, finished_at, stats
     FROM outreach.runs
     WHERE campaign_id = $1
     ORDER BY started_at DESC`,
    [campaign.id],
  );

  const latestRun = runs.rows[0] ?? null;
  const enrichment = (latestRun?.stats?.enrichment ?? null) as Record<string, unknown> | null;
  const insight = (enrichment?.insight ?? null) as Record<string, unknown> | null;

  const researchJobs = latestRun
    ? await dbQuery<{
      id: string;
      company_key: string;
      status: string;
      search_budget: number | null;
      searches_used: number | null;
      actual_cost_usd: string | null;
      usage: Record<string, unknown> | null;
      last_error: string | null;
      research_pass: string | null;
    }>(
      `SELECT id, company_key, status, search_budget, searches_used,
              actual_cost_usd::text, usage, last_error,
              disambiguation->>'research_pass' AS research_pass
       FROM outreach.company_research_jobs
       WHERE $1::uuid = ANY(requested_by_runs)
       ORDER BY created_at`,
      [latestRun.id],
    )
    : { rows: [] };

  const drafting = latestRun
    ? await dbQuery<{
      item_id: string;
      state: string;
      lead_name: string | null;
      company: string | null;
      research_path: string | null;
      sibling_skip: boolean | null;
      adversarial_mode: string | null;
      repair_class: string | null;
      research_cost: string | null;
      write_cost: string | null;
      insight: Record<string, unknown> | null;
    }>(
      `SELECT di.id AS item_id, di.state,
              di.input_snapshot->'lead'->>'fullName' AS lead_name,
              di.input_snapshot->'lead'->>'company' AS company,
              j.usage->>'researchPath' AS research_path,
              (j.usage->>'siblingSkip')::boolean AS sibling_skip,
              j.usage->'adversarial'->>'auditMode' AS adversarial_mode,
              coalesce(
                j.usage->'insight'->'write'->>'repairClass',
                j.usage->'stages'->>'repairClass'
              ) AS repair_class,
              j.usage->>'costUsd' AS research_cost,
              j.usage->'insight'->'costs'->>'writeUsd' AS write_cost,
              j.usage->'insight' AS insight
       FROM outreach.drafting_workspaces dw
       JOIN outreach.drafting_items di ON di.workspace_id = dw.id
       LEFT JOIN LATERAL (
         SELECT usage, kind, finished_at, created_at
         FROM outreach.drafting_jobs
         WHERE drafting_item_id = di.id
         ORDER BY finished_at DESC NULLS LAST, created_at DESC
         LIMIT 1
       ) j ON true
       WHERE dw.campaign_id = $1
       ORDER BY di.created_at`,
      [campaign.id],
    )
    : { rows: [] };

  const costEvents = latestRun
    ? await dbQuery<{
      phase: string;
      events: number;
      total_usd: string;
    }>(
      `SELECT phase, count(*)::int AS events, coalesce(sum(actual_cost_usd), 0)::text AS total_usd
       FROM outreach.lead_cost_events
       WHERE campaign_id = $1
       GROUP BY phase
       ORDER BY phase`,
      [campaign.id],
    )
    : { rows: [] };

  const jobInsights = researchJobs.rows.map((job) => ({
    id: job.id,
    company_key: job.company_key,
    status: job.status,
    research_pass: job.research_pass,
    search_budget: job.search_budget,
    searches_used: job.searches_used,
    actual_cost_usd: job.actual_cost_usd,
    last_error: job.last_error,
    insight: job.usage?.insight ?? null,
  }));

  console.log(JSON.stringify({
    campaign,
    run: latestRun
      ? {
        id: latestRun.id,
        status: latestRun.status,
        started_at: latestRun.started_at,
        finished_at: latestRun.finished_at,
        enrichment_insight: insight,
        enrichment_counters: enrichment
          ? Object.fromEntries(
            Object.entries(enrichment).filter(([key]) => key !== 'insight' && key !== 'rate_limit_events'),
          )
          : null,
      }
      : null,
    research_jobs: {
      count: jobInsights.length,
      with_insight: jobInsights.filter((job) => job.insight).length,
      jobs: jobInsights,
    },
    drafting_items: {
      count: drafting.rows.length,
      by_research_path: Object.fromEntries(
        [...new Set(drafting.rows.map((row) => row.research_path ?? 'unknown'))]
          .map((path) => [path, drafting.rows.filter((row) => (row.research_path ?? 'unknown') === path).length]),
      ),
      sibling_skips: drafting.rows.filter((row) => row.sibling_skip).length,
      items: drafting.rows,
    },
    cost_events: costEvents.rows,
    how_to_watch_live: [
      'Watch orchestrator / Next logs for [pipeline-insight:enrich|draft|write]',
      'After Enrich: runs.stats.enrichment.insight + company_research_jobs.usage.insight',
      'After Drafting: drafting_jobs.usage.insight (researchPath, adversarial, repairClass)',
      `Re-run: npx tsx scripts/campaign_pipeline_insight.ts "${campaign.name}"`,
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
