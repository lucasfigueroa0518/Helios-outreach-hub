import fs from 'node:fs';
import { Client } from 'pg';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}

if (process.platform === 'win32') process.env.PGSSLMODE = 'disable';
const client = new Client({
  connectionString: process.env.DIRECT_DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
});

async function main() {
  await client.connect();
  const tables = await client.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'outreach'
       AND table_name IN (
         'email_research_cohorts',
         'company_email_evidence',
         'email_candidate_checks',
         'email_feedback'
       )
     ORDER BY table_name`,
  );
  const enqueue = await client.query<{ proname: string; args: string }>(
    `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'enqueue'`,
  );
  const cohortCol = await client.query<{ column_name: string }>(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'outreach'
       AND table_name = 'company_research_jobs'
       AND column_name = 'cohort_id'`,
  );
  console.log(JSON.stringify({
    intelligence_tables_remaining: tables.rows.map((row) => row.table_name),
    enqueue_functions: enqueue.rows,
    cohort_id_column_exists: cohortCol.rows.length > 0,
  }, null, 2));
  await client.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
