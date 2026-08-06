import fs from 'node:fs';
import { Client } from 'pg';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}
if (process.platform === 'win32') process.env.PGSSLMODE = 'disable';

const campaignId = process.argv[2] ?? '48b8a793-2bde-4f0d-bfd2-afaacbb762a6';
const runId = process.argv[3] ?? '93348178-4c52-4c8b-b661-266886981d11';

const client = new Client({ connectionString: process.env.DIRECT_DATABASE_URL, ssl: false });

function leadScore(row: {
  email_primary: string | null;
  email_status: string;
  source_run_status: string | null;
  created_at: string;
}) {
  let score = 0;
  if (row.email_primary) score += 10;
  if (row.email_status !== 'not_found') score += 5;
  if (row.source_run_status === 'complete') score += 20;
  return score;
}

async function main() {
  await client.connect();
  await client.query('BEGIN');

  const groups = await client.query<{
    name_key: string;
    lead_ids: string[];
  }>(
    `SELECT lower(l.full_name) AS name_key, array_agg(l.id ORDER BY l.created_at) AS lead_ids
     FROM outreach.campaign_leads cl
     JOIN outreach.leads l ON l.id = cl.lead_id
     WHERE cl.campaign_id = $1
     GROUP BY lower(l.full_name)
     HAVING count(*) > 1`,
    [campaignId],
  );

  const removed: string[] = [];
  const kept: string[] = [];

  for (const group of groups.rows) {
    const details = await client.query<{
      id: string;
      full_name: string;
      email_primary: string | null;
      email_status: string;
      source_run_status: string | null;
      created_at: string;
    }>(
      `SELECT l.id, l.full_name, l.email_primary, l.email_status, r.status AS source_run_status, l.created_at
       FROM outreach.leads l
       LEFT JOIN outreach.runs r ON r.id = l.source_run_id
       WHERE l.id = ANY($1::uuid[])`,
      [group.lead_ids],
    );

    const sorted = [...details.rows].sort((a, b) => leadScore(b) - leadScore(a) || +new Date(a.created_at) - +new Date(b.created_at));
    const winner = sorted[0];
    const losers = sorted.slice(1).map((row) => row.id);
    kept.push(winner.id);

    for (const leadId of losers) {
      await client.query(
        `DELETE FROM outreach.campaign_leads WHERE campaign_id = $1 AND lead_id = $2`,
        [campaignId, leadId],
      );
      removed.push(leadId);
      await client.query(
        `DELETE FROM outreach.leads
         WHERE id = $1
           AND source_run_id = $2
           AND NOT EXISTS (SELECT 1 FROM outreach.campaign_leads cl WHERE cl.lead_id = $1)`,
        [leadId, runId],
      );
    }

    await client.query(
      `INSERT INTO outreach.campaign_leads (campaign_id, lead_id, run_id, reused_from_prior_lead)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (campaign_id, lead_id) DO UPDATE SET
         run_id = EXCLUDED.run_id,
         reused_from_prior_lead = outreach.campaign_leads.reused_from_prior_lead OR EXCLUDED.reused_from_prior_lead`,
      [campaignId, winner.id, runId, winner.source_run_status === 'complete'],
    );
  }

  const count = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM outreach.campaign_leads WHERE campaign_id = $1`,
    [campaignId],
  );

  await client.query('COMMIT');
  console.log(JSON.stringify({
    campaign_id: campaignId,
    duplicate_groups: groups.rows.length,
    kept_lead_ids: kept,
    removed_lead_ids: removed,
    campaign_leads_after: count.rows[0]?.n,
  }, null, 2));
  await client.end();
}

main().catch(async (error) => {
  console.error(error);
  try { await client.query('ROLLBACK'); } catch { /* ignore */ }
  process.exit(1);
});
