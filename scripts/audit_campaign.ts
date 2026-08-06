import fs from 'node:fs';
import { Client } from 'pg';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}
if (process.platform === 'win32') process.env.PGSSLMODE = 'disable';

const campaignId = process.argv[2] ?? '48b8a793-2bde-4f0d-bfd2-afaacbb762a6';

const client = new Client({ connectionString: process.env.DIRECT_DATABASE_URL, ssl: false });

async function main() {
  await client.connect();

  const runs = await client.query(
    `SELECT id, status, error, started_at, finished_at, stats
     FROM outreach.runs WHERE campaign_id = $1 ORDER BY started_at DESC`,
    [campaignId],
  );

  const dupes = await client.query(
    `SELECT lower(full_name) AS name, count(*)::int AS lead_rows,
            array_agg(l.id ORDER BY l.created_at) AS lead_ids,
            array_agg(l.email_status ORDER BY l.created_at) AS statuses,
            array_agg(l.email_primary ORDER BY l.created_at) AS emails,
            array_agg(l.source_run_id::text ORDER BY l.created_at) AS source_runs,
            array_agg(cl.run_id::text ORDER BY l.created_at) AS campaign_run_ids
     FROM outreach.leads l
     JOIN outreach.campaign_leads cl ON cl.lead_id = l.id
     WHERE cl.campaign_id = $1
     GROUP BY lower(full_name)
     HAVING count(*) > 1
     ORDER BY count(*) DESC, lower(full_name)`,
    [campaignId],
  );

  const targets = await client.query(
    `SELECT l.id, l.full_name, l.company_name, l.title, l.email_primary, l.email_status,
            l.email_source_note, l.source_run_id::text, cl.run_id::text AS campaign_run_id,
            cl.reused_from_prior_lead, l.created_at
     FROM outreach.leads l
     JOIN outreach.campaign_leads cl ON cl.lead_id = l.id
     WHERE cl.campaign_id = $1
       AND lower(l.full_name) IN ('mike crawford', 'andres rovirosa', 'gary smith')
     ORDER BY l.full_name, l.created_at`,
    [campaignId],
  );

  const campaignLeads = await client.query(
    `SELECT count(*)::int AS total FROM outreach.campaign_leads WHERE campaign_id = $1`,
    [campaignId],
  );

  const uploads = await client.query(
    `SELECT u.id, u.file_name, u.status, u.run_id::text, r.status AS run_status,
            (u.extraction_summary->>'people_found')::int AS people_found
     FROM outreach.uploads u
     JOIN outreach.runs r ON r.id = u.run_id
     WHERE r.campaign_id = $1
     ORDER BY u.created_at DESC`,
    [campaignId],
  );

  console.log(JSON.stringify({
    campaign_id: campaignId,
    campaign_leads_total: campaignLeads.rows[0]?.total,
    runs: runs.rows,
    uploads: uploads.rows,
    duplicate_names: dupes.rows,
    target_people: targets.rows,
  }, null, 2));

  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
