import fs from 'node:fs';
import { dbQuery, dbTransaction } from '@/lib/db';
import { removeStoredObject } from '@/lib/storage';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}

async function main() {
  const target = process.argv[2];
  if (!target) throw new Error('Usage: npx tsx scripts/hard_delete_campaign.ts <campaign-id-or-name>');

  const campaigns = await dbQuery<{ id: string; name: string }>(
    `SELECT id, name FROM outreach.campaigns
     WHERE id::text = $1 OR lower(name) = lower($1)
     ORDER BY created_at`,
    [target],
  );
  if (!campaigns.rows.length) throw new Error(`Campaign not found: ${target}`);

  const campaignIds = campaigns.rows.map((row) => row.id);
  const runs = await dbQuery<{ id: string }>(
    `SELECT id FROM outreach.runs WHERE campaign_id = ANY($1::uuid[])`,
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

  const workspaces = await dbQuery<{ id: string }>(
    `SELECT id FROM outreach.drafting_workspaces WHERE campaign_id = ANY($1::uuid[])`,
    [campaignIds],
  );
  const workspaceIds = workspaces.rows.map((row) => row.id);

  console.log('Planned hard delete:');
  console.log(`  campaigns: ${campaigns.rows.map((row) => row.name).join(', ')}`);
  console.log(`  runs: ${runIds.length}`);
  console.log(`  uploads/storage objects: ${uploads.rows.length}`);
  console.log(`  leads: ${leadIds.length}`);
  console.log(`  drafting workspaces: ${workspaceIds.length}`);

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
    if (workspaceIds.length) {
      await client.query(
        `DELETE FROM outreach.email_drafts
         WHERE drafting_item_id IN (
           SELECT id FROM outreach.drafting_items WHERE workspace_id = ANY($1::uuid[])
         )`,
        [workspaceIds],
      ).catch(() => undefined);
      await client.query(
        `DELETE FROM outreach.drafting_jobs
         WHERE drafting_item_id IN (
           SELECT id FROM outreach.drafting_items WHERE workspace_id = ANY($1::uuid[])
         )`,
        [workspaceIds],
      ).catch(() => undefined);
      await client.query(
        `DELETE FROM outreach.drafting_research_packets
         WHERE drafting_item_id IN (
           SELECT id FROM outreach.drafting_items WHERE workspace_id = ANY($1::uuid[])
         )`,
        [workspaceIds],
      ).catch(() => undefined);
      await client.query(
        `DELETE FROM outreach.drafting_items WHERE workspace_id = ANY($1::uuid[])`,
        [workspaceIds],
      );
      await client.query(
        `DELETE FROM outreach.drafting_workspaces WHERE id = ANY($1::uuid[])`,
        [workspaceIds],
      );
    }

    if (runIds.length) {
      await client.query(
        `DELETE FROM outreach.company_research_jobs
         WHERE requested_by_runs && $1::uuid[]`,
        [runIds],
      );
      await client.query(
        `DELETE FROM outreach.orchestration_mailbox_probes
         WHERE run_id = ANY($1::uuid[])`,
        [runIds],
      );
      await client.query(
        `DELETE FROM outreach.analytics_run_exclusions
         WHERE run_id = ANY($1::uuid[])`,
        [runIds],
      );
      await client.query(
        `UPDATE outreach.drafting_items
         SET source_campaign_lead_run_id = NULL
         WHERE source_campaign_lead_run_id = ANY($1::uuid[])`,
        [runIds],
      ).catch(() => undefined);
      await client.query(
        `UPDATE outreach.drafting_run_items
         SET source_enrichment_run_id = NULL
         WHERE source_enrichment_run_id = ANY($1::uuid[])`,
        [runIds],
      ).catch(() => undefined);
    }

    if (leadIds.length) {
      await client.query(
        `DELETE FROM outreach.orchestration_mailbox_probes
         WHERE lead_id = ANY($1::uuid[])`,
        [leadIds],
      );
      await client.query(
        `DELETE FROM outreach.lead_cost_events
         WHERE lead_id = ANY($1::uuid[])`,
        [leadIds],
      );
      await client.query(
        `UPDATE outreach.campaign_leads
         SET prior_enrichment_lead_id = NULL
         WHERE prior_enrichment_lead_id = ANY($1::uuid[])`,
        [leadIds],
      );
    }

    await client.query(
      `DELETE FROM outreach.lead_cost_events WHERE campaign_id = ANY($1::uuid[])`,
      [campaignIds],
    );

    await client.query(
      `DELETE FROM outreach.campaign_leads WHERE campaign_id = ANY($1::uuid[])`,
      [campaignIds],
    );

    if (leadIds.length) {
      await client.query(
        `DELETE FROM outreach.leads l
         WHERE l.id = ANY($1::uuid[])
           AND NOT EXISTS (SELECT 1 FROM outreach.campaign_leads cl WHERE cl.lead_id = l.id)`,
        [leadIds],
      );
    }

    if (runIds.length) {
      await client.query(`DELETE FROM outreach.uploads WHERE run_id = ANY($1::uuid[])`, [runIds]);
      await client.query(
        `UPDATE outreach.leads SET source_run_id = NULL WHERE source_run_id = ANY($1::uuid[])`,
        [runIds],
      );
      await client.query(`DELETE FROM outreach.runs WHERE id = ANY($1::uuid[])`, [runIds]);
    }

    await client.query(
      `UPDATE outreach.campaigns SET merged_into_id = NULL WHERE merged_into_id = ANY($1::uuid[])`,
      [campaignIds],
    );
    await client.query(`DELETE FROM outreach.campaigns WHERE id = ANY($1::uuid[])`, [campaignIds]);
    // Do not wipe global company_resolutions / companies — shared across campaigns.
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
