import { Client } from 'pg';
import fs from 'node:fs';
import path from 'node:path';

function loadEnv() {
  const envPath = path.join(process.cwd(), '.env.local');
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  }
}

async function main() {
  loadEnv();
  if (process.platform === 'win32') process.env.PGSSLMODE = 'disable';
  const connectionString = process.env.DIRECT_DATABASE_URL;
  if (!connectionString) throw new Error('DIRECT_DATABASE_URL missing');
  const client = new Client({
    connectionString,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  });
  await client.connect();

  const statements = [
    'DROP TABLE IF EXISTS outreach.email_feedback CASCADE',
    'DROP TABLE IF EXISTS outreach.email_candidate_checks CASCADE',
    'DROP TABLE IF EXISTS outreach.company_email_evidence_observations CASCADE',
    'DROP TABLE IF EXISTS outreach.company_email_evidence CASCADE',
    'DROP TABLE IF EXISTS outreach.email_research_cohorts CASCADE',
    'ALTER TABLE outreach.company_research_jobs DROP COLUMN IF EXISTS cohort_id',
    'ALTER TABLE outreach.companies DROP COLUMN IF EXISTS email_domains',
    'ALTER TABLE outreach.companies DROP COLUMN IF EXISTS evidence_version',
    'ALTER TABLE outreach.companies DROP COLUMN IF EXISTS email_summary_updated_at',
    'ALTER TABLE outreach.leads DROP COLUMN IF EXISTS email_provenance',
    'DROP FUNCTION IF EXISTS public.enqueue(text, jsonb, uuid, uuid, text)',
  ];

  for (const sql of statements) {
    await client.query(sql);
    console.log('OK:', sql);
  }

  await client.end();
  console.log('Email intelligence schema rollback complete. Re-apply db/outreach_schema.sql for updated RPC functions.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
