/**
 * Snapshot a campaign at the pre-drafting (Review) checkpoint, and/or wipe
 * drafting artifacts so the campaign returns to "zero drafting done".
 *
 * Usage:
 *   npx tsx scripts/checkpoint_campaign_pre_drafting.ts save "Campaign #1"
 *   npx tsx scripts/checkpoint_campaign_pre_drafting.ts reset "Campaign #1"
 *   npx tsx scripts/checkpoint_campaign_pre_drafting.ts save <campaign-uuid>
 *   npx tsx scripts/checkpoint_campaign_pre_drafting.ts reset <campaign-uuid>
 *
 * save  — writes fixtures/checkpoints/<slug>-pre-drafting.json (metadata + IDs)
 *         and hard-deletes any existing drafting rows for that campaign so the
 *         checkpoint is clean Review-phase state.
 * reset — hard-deletes all drafting rows for the campaign (workspace, runs,
 *         items, packets, drafts, jobs, resolutions, sender profile untouched).
 *         Campaign leads / enrichment are left intact.
 */
import fs from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getLiveDraftingReadiness } from '@/lib/drafting/live-readiness';
import { dbQuery, dbTransaction } from '@/lib/db';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}

async function resolveCampaign(target: string) {
  const byId = await dbQuery<{ id: string; name: string; status: string; created_at: string }>(
    `SELECT id, name, status, created_at::text
     FROM outreach.campaigns
     WHERE id::text = $1
     LIMIT 1`,
    [target],
  );
  if (byId.rows[0]) return byId.rows[0];

  const byName = await dbQuery<{ id: string; name: string; status: string; created_at: string }>(
    `SELECT id, name, status, created_at::text
     FROM outreach.campaigns
     WHERE lower(name) = lower($1)
     ORDER BY created_at ASC
     LIMIT 1`,
    [target],
  );
  if (byName.rows[0]) return byName.rows[0];

  throw new Error(`Campaign not found: ${target}`);
}

function slugify(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'campaign';
}

async function loadCheckpointPayload(campaignId: string) {
  const leads = await dbQuery<{
    lead_id: string;
    run_id: string;
    full_name: string | null;
    email_primary: string | null;
    email_status: string;
    email_verification: string | null;
    company_name: string | null;
    title: string | null;
  }>(
    `SELECT cl.lead_id, cl.run_id, l.full_name, l.email_primary, l.email_status,
            l.email_verification, l.company_name, l.title
     FROM outreach.campaign_leads cl
     JOIN outreach.leads l ON l.id = cl.lead_id
     WHERE cl.campaign_id = $1
     ORDER BY l.full_name NULLS LAST, cl.lead_id`,
    [campaignId],
  );

  const runs = await dbQuery<{ id: string; status: string; started_at: string }>(
    `SELECT id, status, started_at::text
     FROM outreach.runs
     WHERE campaign_id = $1
     ORDER BY started_at`,
    [campaignId],
  );

  const mailboxValid = leads.rows.filter((row) => row.email_verification === 'valid').length;

  return {
    saved_at: new Date().toISOString(),
    phase: 'pre_drafting_review',
    campaign_id: campaignId,
    lead_count: leads.rows.length,
    mailbox_valid_count: mailboxValid,
    runs: runs.rows,
    leads: leads.rows,
  };
}

async function wipeDrafting(campaignId: string) {
  return dbTransaction(async (client) => {
    const workspace = await client.query<{ id: string }>(
      `SELECT id FROM outreach.drafting_workspaces WHERE campaign_id = $1`,
      [campaignId],
    );
    if (!workspace.rows[0]) {
      return {
        workspace_id: null as string | null,
        deleted: {
          resolutions: 0,
          jobs: 0,
          drafts: 0,
          packets: 0,
          run_items: 0,
          items: 0,
          runs: 0,
          workspaces: 0,
        },
      };
    }

    const workspaceId = workspace.rows[0].id;

    const runIds = await client.query<{ id: string }>(
      `SELECT id FROM outreach.drafting_runs WHERE workspace_id = $1`,
      [workspaceId],
    );
    const draftingRunIds = runIds.rows.map((row) => row.id);
    if (draftingRunIds.length > 0) {
      await client.query(
        `UPDATE outreach.orchestration_jobs
            SET status = 'cancelled',
                finished_at = coalesce(finished_at, now()),
                lease_owner = NULL,
                lease_expires_at = NULL,
                last_error_code = coalesce(last_error_code, 'drafting_reset'),
                last_error_message = coalesce(last_error_message, 'Drafting workspace hard-reset'),
                updated_at = now()
          WHERE status IN ('pending', 'in_flight')
            AND (
              scope_key = ANY($1::text[])
              OR (
                kind LIKE 'drafting.job.%'
                AND (payload->>'jobId')::uuid IN (
                  SELECT id FROM outreach.drafting_jobs
                   WHERE drafting_run_id = ANY($1::uuid[])
                )
              )
              OR (kind = 'drafting.run.start' AND dedupe_key = ANY($1::text[]))
            )`,
        [draftingRunIds],
      );
    }

    const jobs = await client.query(
      `DELETE FROM outreach.drafting_jobs
       WHERE drafting_run_id IN (
         SELECT id FROM outreach.drafting_runs WHERE workspace_id = $1
       )
          OR drafting_item_id IN (
         SELECT id FROM outreach.drafting_items WHERE workspace_id = $1
       )`,
      [workspaceId],
    );
    const drafts = await client.query(
      `DELETE FROM outreach.email_drafts
       WHERE drafting_item_id IN (
         SELECT id FROM outreach.drafting_items WHERE workspace_id = $1
       )`,
      [workspaceId],
    );
    const packets = await client.query(
      `DELETE FROM outreach.draft_research_packets
       WHERE drafting_item_id IN (
         SELECT id FROM outreach.drafting_items WHERE workspace_id = $1
       )`,
      [workspaceId],
    );
    const runItems = await client.query(
      `DELETE FROM outreach.drafting_run_items
       WHERE drafting_run_id IN (
         SELECT id FROM outreach.drafting_runs WHERE workspace_id = $1
       )`,
      [workspaceId],
    );
    const items = await client.query(
      `DELETE FROM outreach.drafting_items WHERE workspace_id = $1`,
      [workspaceId],
    );
    const runs = await client.query(
      `DELETE FROM outreach.drafting_runs WHERE workspace_id = $1`,
      [workspaceId],
    );
    const workspaces = await client.query(
      `DELETE FROM outreach.drafting_workspaces WHERE id = $1`,
      [workspaceId],
    );

    return {
      workspace_id: workspaceId,
      deleted: {
        jobs: jobs.rowCount ?? 0,
        drafts: drafts.rowCount ?? 0,
        packets: packets.rowCount ?? 0,
        run_items: runItems.rowCount ?? 0,
        items: items.rowCount ?? 0,
        runs: runs.rowCount ?? 0,
        workspaces: workspaces.rowCount ?? 0,
      },
    };
  });
}

async function main() {
  const [action, target] = process.argv.slice(2);
  if (!action || !target || !['save', 'reset'].includes(action)) {
    throw new Error(
      'Usage: npx tsx scripts/checkpoint_campaign_pre_drafting.ts <save|reset> <campaign-id-or-name>',
    );
  }

  const campaign = await resolveCampaign(target);
  const payload = await loadCheckpointPayload(campaign.id);

  const liveProviders = await getLiveDraftingReadiness();

  if (action === 'save') {
    const wipe = await wipeDrafting(campaign.id);
    const dir = path.join(process.cwd(), 'fixtures', 'checkpoints');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${slugify(campaign.name)}-pre-drafting.json`);
    const body = {
      ...payload,
      campaign_name: campaign.name,
      campaign_status: campaign.status,
      drafting_wiped_on_save: wipe,
      live_drafting_providers: liveProviders,
      note:
        'Review-phase checkpoint with live drafting providers wired. Use `reset` with this campaign name/id to hard-delete drafting again without touching enrichment.',
    };
    await writeFile(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      action: 'save',
      campaign: { id: campaign.id, name: campaign.name },
      checkpoint_file: file,
      lead_count: payload.lead_count,
      mailbox_valid_count: payload.mailbox_valid_count,
      drafting_wiped: wipe,
      live_drafting_providers: liveProviders,
    }, null, 2));
    return;
  }

  const wipe = await wipeDrafting(campaign.id);
  console.log(JSON.stringify({
    action: 'reset',
    campaign: { id: campaign.id, name: campaign.name },
    lead_count: payload.lead_count,
    mailbox_valid_count: payload.mailbox_valid_count,
    drafting_wiped: wipe,
    live_drafting_providers: liveProviders,
    note: 'Campaign is back at Review phase with zero drafting rows.',
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
