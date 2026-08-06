import fs from 'node:fs';
import { dbQuery, dbTransaction } from '@/lib/db';
import { removeStoredObject } from '@/lib/storage';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}

async function main() {
  const campaigns = await dbQuery<{ id: string; name: string }>(
    `SELECT id, name FROM outreach.campaigns ORDER BY created_at, name`,
  );
  if (!campaigns.rows.length) {
    console.log('No campaigns to delete.');
    return;
  }

  const campaignIds = campaigns.rows.map((row) => row.id);
  const runs = await dbQuery<{ id: string; campaign_id: string }>(
    `SELECT id, campaign_id FROM outreach.runs WHERE campaign_id = ANY($1::uuid[])`,
    [campaignIds],
  );
  const runIds = runs.rows.map((row) => row.id);

  const uploads = runIds.length
    ? await dbQuery<{ storage_path: string }>(
      `SELECT storage_path FROM outreach.uploads WHERE run_id = ANY($1::uuid[])`,
      [runIds],
    )
    : { rows: [] as { storage_path: string }[] };

  const leads = await dbQuery<{ id: string }>(
    `SELECT DISTINCT lead_id AS id
     FROM outreach.campaign_leads
     WHERE campaign_id = ANY($1::uuid[])`,
    [campaignIds],
  );
  const leadIds = leads.rows.map((row) => row.id);

  console.log('Planned hard delete:');
  console.log(`  campaigns: ${campaigns.rows.map((row) => row.name).join(', ')}`);
  console.log(`  runs: ${runIds.length}`);
  console.log(`  uploads/storage objects: ${uploads.rows.length}`);
  console.log(`  leads: ${leadIds.length}`);

  for (const { storage_path: path } of uploads.rows) {
    try {
      await removeStoredObject(path);
      console.log(`  removed storage: ${path}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`  storage delete skipped (${path}): ${message}`);
    }
  }

  await dbTransaction(async (client) => {
    if (runIds.length) {
      await client.query(
        `DELETE FROM outreach.company_research_jobs
         WHERE requested_by_runs && $1::uuid[]`,
        [runIds],
      );
    }

    await client.query(
      `DELETE FROM outreach.campaign_leads WHERE campaign_id = ANY($1::uuid[])`,
      [campaignIds],
    );

    if (leadIds.length) {
      await client.query(`DELETE FROM outreach.leads WHERE id = ANY($1::uuid[])`, [leadIds]);
    }

    if (runIds.length) {
      await client.query(`DELETE FROM outreach.uploads WHERE run_id = ANY($1::uuid[])`, [runIds]);
      await client.query(`DELETE FROM outreach.runs WHERE id = ANY($1::uuid[])`, [runIds]);
    }

    await client.query(`DELETE FROM outreach.campaigns WHERE id = ANY($1::uuid[])`, [campaignIds]);
    await client.query(`DELETE FROM outreach.company_resolutions`);
    // Also clear the domain-level research cache (email formats, MX status,
    // scrape paths) so a re-run of the same upload does a genuine fresh pass
    // instead of instantly cache-hitting prior research.
    await client.query(`DELETE FROM outreach.companies`);
  });

  const remaining = await dbQuery<{ campaigns: number; runs: number; leads: number; companies: number }>(
    `SELECT
       (SELECT count(*)::int FROM outreach.campaigns) AS campaigns,
       (SELECT count(*)::int FROM outreach.runs) AS runs,
       (SELECT count(*)::int FROM outreach.leads) AS leads,
       (SELECT count(*)::int FROM outreach.companies) AS companies`,
  );
  console.log('Delete complete.');
  console.log(`Remaining campaigns: ${remaining.rows[0]?.campaigns ?? 0}`);
  console.log(`Remaining runs: ${remaining.rows[0]?.runs ?? 0}`);
  console.log(`Remaining leads: ${remaining.rows[0]?.leads ?? 0}`);
  console.log(`Remaining companies (research cache): ${remaining.rows[0]?.companies ?? 0}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
