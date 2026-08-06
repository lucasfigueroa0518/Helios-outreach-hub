/**
 * Read-only preview of the legacy drafting opening-balance migration.
 *
 * Usage:
 *   npx tsx scripts/campaign_cost_opening_audit.ts "Campaign #13"
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

if (fs.existsSync('.env.local')) {
  for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  }
}

async function main() {
  const { dbQuery, closeDbPool } = await import('@/lib/db');
  const campaignName = process.argv.slice(2).find((value) => !value.startsWith('--'))
    ?? 'Campaign #13';
  try {
    const campaign = await dbQuery<{ id: string; name: string }>(
      `SELECT id::text, name
         FROM outreach.campaigns
        WHERE lower(name) = lower($1)
        ORDER BY created_at DESC
        LIMIT 1`,
      [campaignName],
    );
    const row = campaign.rows[0];
    if (!row) throw new Error(`Campaign not found: ${campaignName}`);

    const totals = await dbQuery<{
      durable_run_total_usd: string;
      legacy_job_total_usd: string;
      event_table_present: boolean;
    }>(
      `WITH campaign_runs AS (
         SELECT run.id, run.actual_cost_usd
           FROM outreach.drafting_runs run
           JOIN outreach.drafting_workspaces workspace ON workspace.id = run.workspace_id
          WHERE workspace.campaign_id = $1
       ),
       event_table AS (
         SELECT to_regclass('outreach.drafting_job_cost_events') IS NOT NULL AS present
       )
       SELECT
         coalesce((SELECT sum(actual_cost_usd) FROM campaign_runs), 0)::text
           AS durable_run_total_usd,
         coalesce((
           SELECT sum(job.actual_cost_usd)
             FROM outreach.drafting_jobs job
            WHERE job.drafting_run_id IN (SELECT id FROM campaign_runs)
         ), 0)::text AS legacy_job_total_usd,
         (SELECT present FROM event_table) AS event_table_present`,
      [row.id],
    );
    const audit = totals.rows[0];
    const durable = Number(audit.durable_run_total_usd);
    const eventTotal = audit.event_table_present
      ? await dbQuery<{ total_usd: string }>(
        `SELECT coalesce(sum(event.actual_cost_usd), 0)::text AS total_usd
           FROM outreach.drafting_job_cost_events event
           JOIN outreach.drafting_runs run ON run.id = event.drafting_run_id
           JOIN outreach.drafting_workspaces workspace ON workspace.id = run.workspace_id
          WHERE workspace.campaign_id = $1`,
        [row.id],
      ).then((result) => result.rows[0]?.total_usd ?? '0')
      : audit.legacy_job_total_usd;
    // With no event table, the hypothetical bootstrap first creates
    // attributable legacy-job events, so that known sum is the comparison base.
    const attributable = Number(eventTotal);
    const residual = Math.max(durable - attributable, 0);
    const preserved = attributable + residual;

    if (row.name.toLowerCase() === 'campaign #13') {
      assert.equal(durable.toFixed(4), '9.4559');
      assert.equal(attributable.toFixed(4), '8.5546');
      assert.equal(residual.toFixed(4), '0.9013');
      assert.equal(preserved.toFixed(4), '9.4559');
    }

    console.log(JSON.stringify({
      mode: 'read_only_hypothetical',
      applied: false,
      campaign: row,
      event_table_present: audit.event_table_present,
      durable_run_total_usd: durable.toFixed(4),
      attributable_provider_spend_usd: attributable.toFixed(4),
      legacy_unattributed_opening_balance_usd: residual.toFixed(4),
      hypothetical_preserved_total_usd: preserved.toFixed(4),
      per_lead_attribution: 'not_created_for_opening_balance',
    }, null, 2));
  } finally {
    await closeDbPool();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
