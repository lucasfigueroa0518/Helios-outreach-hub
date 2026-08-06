import fs from 'node:fs';
import { Client } from 'pg';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}
if (process.platform === 'win32') process.env.PGSSLMODE = 'disable';

const client = new Client({ connectionString: process.env.DIRECT_DATABASE_URL, ssl: false });

async function main() {
  await client.connect();

  const campaigns = await client.query(`SELECT id, name, created_at FROM outreach.campaigns ORDER BY created_at`);
  const names = ['mike crawford', 'andres rovirosa', 'gary smith'];

  const globalLeads = await client.query(
    `SELECT l.id, l.full_name, l.company_name, l.title, l.location, l.email_primary, l.email_status,
            l.source_run_id::text, r.campaign_id::text, c.name AS campaign_name, l.created_at
     FROM outreach.leads l
     LEFT JOIN outreach.runs r ON r.id = l.source_run_id
     LEFT JOIN outreach.campaigns c ON c.id = r.campaign_id
     WHERE lower(l.full_name) = ANY($1::text[])
     ORDER BY l.full_name, l.created_at`,
    [names],
  );

  const campaign1 = await client.query(
    `SELECT l.full_name, l.email_primary, l.email_status, l.email_source_note, cl.campaign_id::text
     FROM outreach.campaign_leads cl
     JOIN outreach.leads l ON l.id = cl.lead_id
     JOIN outreach.runs r ON r.id = cl.run_id
     WHERE r.status = 'complete'
       AND lower(l.full_name) = ANY($1::text[])
     ORDER BY l.full_name`,
    [names],
  );

  console.log(JSON.stringify({ campaigns: campaigns.rows, global_leads: globalLeads.rows, complete_run_leads: campaign1.rows }, null, 2));
  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
