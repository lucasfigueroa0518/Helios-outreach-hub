import fs from 'node:fs';
import { Client } from 'pg';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}

if (process.platform === 'win32') process.env.PGSSLMODE = 'disable';
const runId = process.argv[2] ?? 'a754a14a-8f02-4767-aefa-370226eedb74';
const campaignId = process.argv[3] ?? '48b8a793-2bde-4f0d-bfd2-afaacbb762a6';

const client = new Client({
  connectionString: process.env.DIRECT_DATABASE_URL,
  ssl: false,
});

async function main() {
  await client.connect();
  const run = await client.query(
    `SELECT id, status, error, stats, started_at, finished_at
     FROM outreach.runs WHERE id = $1`,
    [runId],
  );
  const uploads = await client.query(
    `SELECT id, status, run_id, file_name, extraction_summary
     FROM outreach.uploads WHERE run_id = $1`,
    [runId],
  );
  const leads = await client.query(
    `SELECT count(*)::int AS n FROM outreach.campaign_leads WHERE campaign_id = $1`,
    [campaignId],
  );
  console.log(JSON.stringify({ run: run.rows[0], uploads: uploads.rows, campaign_leads: leads.rows[0] }, null, 2));
  await client.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
