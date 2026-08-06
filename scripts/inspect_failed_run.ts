import fs from 'node:fs';
import { Client } from 'pg';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}

if (process.platform === 'win32') process.env.PGSSLMODE = 'disable';
const client = new Client({
  connectionString: process.env.DIRECT_DATABASE_URL,
  ssl: false,
});

async function main() {
  await client.connect();
  const runs = await client.query(
    `SELECT r.id, c.name AS campaign, r.status, r.started_at, r.finished_at,
            r.stats->'enrichment' AS enrichment,
            u.file_name, u.status AS upload_status
     FROM outreach.runs r
     JOIN outreach.campaigns c ON c.id = r.campaign_id
     LEFT JOIN outreach.uploads u ON u.run_id = r.id
     ORDER BY r.started_at DESC
     LIMIT 5`,
  );
  const jobs = await client.query(
    `SELECT id, company_key, status, job_kind, last_error, attempt_count
     FROM outreach.company_research_jobs
     ORDER BY updated_at DESC
     LIMIT 10`,
  );
  console.log(JSON.stringify({ runs: runs.rows, jobs: jobs.rows }, null, 2));
  await client.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
