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
  const rows = await client.query(
    `SELECT l.id, l.full_name, l.email_status, l.email_primary, l.source_run_id::text,
            cl.reused_from_prior_lead, r.status AS source_run_status
     FROM outreach.campaign_leads cl
     JOIN outreach.leads l ON l.id = cl.lead_id
     LEFT JOIN outreach.runs r ON r.id = l.source_run_id
     WHERE cl.campaign_id = $1
     ORDER BY l.full_name`,
    [campaignId],
  );
  const reused = rows.rows.filter((r) => r.reused_from_prior_lead).length;
  const withEmail = rows.rows.filter((r) => r.email_primary).length;
  const notFound = rows.rows.filter((r) => r.email_status === 'not_found').length;
  console.log(JSON.stringify({
    total: rows.rows.length,
    reused_from_prior: reused,
    with_email: withEmail,
    not_found: notFound,
    rows: rows.rows,
  }, null, 2));
  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
