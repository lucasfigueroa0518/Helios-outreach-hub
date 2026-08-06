import fs from 'node:fs';
import { Client } from 'pg';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}
if (process.platform === 'win32') process.env.PGSSLMODE = 'disable';

const campaignId = '48b8a793-2bde-4f0d-bfd2-afaacbb762a6';
const runId = '93348178-4c52-4c8b-b661-266886981d11';

const swaps = [
  { name: 'andres rovirosa', keep: '46ded2ba-126f-4acd-97d1-fa150acfd264', drop: '5c90096d-1a4b-4de7-83c2-4e65b240a442' },
  { name: 'gary smith', keep: '0edb5cd9-25d3-475b-abf8-19e93f01a05c', drop: 'ed687db0-1690-4e4b-bd21-8c2eac353f2b' },
  { name: 'mike crawford', keep: '1b5b731f-d9f4-4f5b-a110-466ea274e9f5', drop: '0e266b6b-2256-45fa-9300-a8712df2fd9f' },
];

const client = new Client({ connectionString: process.env.DIRECT_DATABASE_URL, ssl: false });

async function main() {
  await client.connect();
  await client.query('BEGIN');

  for (const swap of swaps) {
    await client.query(
      `DELETE FROM outreach.campaign_leads WHERE campaign_id = $1 AND lead_id = $2`,
      [campaignId, swap.drop],
    );
    await client.query(
      `DELETE FROM outreach.leads
       WHERE id = $1
         AND NOT EXISTS (SELECT 1 FROM outreach.campaign_leads cl WHERE cl.lead_id = $1)`,
      [swap.drop],
    );
    await client.query(
      `INSERT INTO outreach.campaign_leads (campaign_id, lead_id, run_id, reused_from_prior_lead)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (campaign_id, lead_id) DO UPDATE SET
         run_id = EXCLUDED.run_id,
         reused_from_prior_lead = true`,
      [campaignId, swap.keep, runId],
    );
  }

  const rows = await client.query(
    `SELECT l.full_name, l.email_primary, l.email_status, cl.reused_from_prior_lead
     FROM outreach.campaign_leads cl
     JOIN outreach.leads l ON l.id = cl.lead_id
     WHERE cl.campaign_id = $1
       AND lower(l.full_name) IN ('mike crawford', 'andres rovirosa', 'gary smith')
     ORDER BY l.full_name`,
    [campaignId],
  );

  const count = await client.query(
    `SELECT count(*)::int AS n FROM outreach.campaign_leads WHERE campaign_id = $1`,
    [campaignId],
  );

  await client.query('COMMIT');
  console.log(JSON.stringify({ campaign_leads: count.rows[0], targets: rows.rows }, null, 2));
  await client.end();
}

main().catch(async (error) => {
  console.error(error);
  try { await client.query('ROLLBACK'); } catch { /* ignore */ }
  process.exit(1);
});
