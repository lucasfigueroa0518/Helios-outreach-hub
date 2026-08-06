import { dbQuery } from '@/lib/db';

/**
 * Prior-relationship chips used to come from Embark Salesforce deals/calls.
 * Helios no longer reads that dump — write a cold/empty snapshot so the
 * campaign_leads column stays populated without SF lookups.
 */
export async function snapshotRelationshipsForRun(runId: string) {
  const { rows } = await dbQuery<{ campaign_id: string; lead_id: string }>(
    `SELECT cl.campaign_id, cl.lead_id
     FROM outreach.campaign_leads cl
     WHERE cl.run_id = $1`,
    [runId],
  );
  if (!rows.length) return;

  const emptySnapshot = JSON.stringify({
    past_work: '',
    prior_relationship_date: null,
    last_contacted: null,
    last_contacted_by: null,
    relationship_tier: 'cold',
  });

  for (const row of rows) {
    await dbQuery(
      `UPDATE outreach.campaign_leads SET relationship_snapshot = $3::jsonb
       WHERE campaign_id = $1 AND lead_id = $2`,
      [row.campaign_id, row.lead_id, emptySnapshot],
    );
  }
}
