// Hard-delete all Outreach campaigns, runs, and dependent pipeline data.
// Loads DIRECT_DATABASE_URL from .env.local. Does not touch outreach.users or sender_profiles.
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/\r$/, '');
  }
}

const url = process.env.DIRECT_DATABASE_URL;
if (!url) {
  console.error('DIRECT_DATABASE_URL is not set (check .env.local)');
  process.exit(1);
}

process.env.PGSSLMODE = process.platform === 'win32' ? 'disable' : (process.env.PGSSLMODE || 'require');

const COUNT_TABLES = [
  'outreach.campaigns',
  'outreach.runs',
  'outreach.uploads',
  'outreach.campaign_leads',
  'outreach.leads',
  'outreach.drafting_workspaces',
  'outreach.drafting_runs',
  'outreach.drafting_items',
  'outreach.drafting_jobs',
  'outreach.email_drafts',
  'outreach.draft_research_packets',
  'outreach.orchestration_jobs',
  'outreach.company_research_jobs',
  'outreach.lead_cost_events',
  'outreach.orchestration_mailbox_probes',
];

async function counts(client, label) {
  const rows = {};
  for (const table of COUNT_TABLES) {
    const { rows: [{ count }] } = await client.query(`SELECT count(*)::int AS count FROM ${table}`);
    rows[table] = count;
  }
  console.log(`\n── ${label} ──`);
  for (const [table, count] of Object.entries(rows)) {
    console.log(`${table}: ${count}`);
  }
  return rows;
}

async function main() {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await counts(client, 'Before purge');

    await client.query('BEGIN');
    await client.query('DELETE FROM outreach.orchestration_jobs');
    await client.query('DELETE FROM outreach.orchestration_mailbox_probes');
    await client.query('DELETE FROM outreach.drafting_jobs');
    await client.query('DELETE FROM outreach.draft_research_packets');
    await client.query('DELETE FROM outreach.email_drafts');
    await client.query('DELETE FROM outreach.drafting_run_items');
    await client.query('DELETE FROM outreach.drafting_runs');
    await client.query('DELETE FROM outreach.drafting_items');
    await client.query('DELETE FROM outreach.drafting_workspaces');
    await client.query('DELETE FROM outreach.lead_cost_events');
    await client.query('DELETE FROM outreach.company_research_jobs');
    await client.query('DELETE FROM outreach.campaign_leads');
    await client.query('DELETE FROM outreach.uploads');
    await client.query('DELETE FROM outreach.leads');
    await client.query('DELETE FROM outreach.runs');
    await client.query('UPDATE outreach.campaigns SET merged_into_id = NULL');
    await client.query('DELETE FROM outreach.campaigns');
    await client.query('COMMIT');

    // Workers may enqueue fresh jobs while the transaction runs; sweep twice.
    await client.query('DELETE FROM outreach.orchestration_jobs');
    await client.query('DELETE FROM outreach.orchestration_jobs');

    const after = await counts(client, 'After purge');
    const remaining = Object.values(after).reduce((sum, n) => sum + n, 0);
    if (remaining !== 0) {
      console.error('\nPurge incomplete — some outreach rows remain.');
      process.exit(1);
    }
    console.log('\nOutreach campaign/run data purged. Users, companies cache, and sender profiles were kept.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
