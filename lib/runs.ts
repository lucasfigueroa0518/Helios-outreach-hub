import type { PoolClient } from 'pg';
import { dbQuery, dbTransaction } from '@/lib/db';
import { applyPriorEnrichmentDecision, type PriorEnrichmentDecision } from '@/lib/prior-enrichment';
import { cancelScope, enqueueWork } from '@/lib/orchestration/repository';

export type { PriorEnrichmentDecision };

type RunRow = { id: string; campaign_id: string; status: string };

async function assertCampaignOwner(client: PoolClient, campaignId: string, ownerId: string) {
  const campaign = await client.query<{ id: string }>(
    `SELECT id FROM outreach.campaigns WHERE id = $1 AND owner_id = $2`,
    [campaignId, ownerId],
  );
  if (!campaign.rows[0]) throw new Error('Campaign not found');
}

async function getActiveRun(client: PoolClient, campaignId: string, ownerId: string) {
  const { rows } = await client.query<RunRow>(
    `SELECT id, campaign_id, status
     FROM outreach.runs
     WHERE campaign_id = $1 AND user_id = $2 AND status IN ('queued', 'extracting', 'enriching', 'awaiting_prior_enrichment')
     ORDER BY started_at DESC
     LIMIT 1`,
    [campaignId, ownerId],
  );
  return rows[0] ?? null;
}

export async function ensureStagingRun(client: PoolClient, campaignId: string, ownerId: string) {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM outreach.runs
     WHERE campaign_id = $1 AND user_id = $2 AND status = 'uploading'
     ORDER BY started_at DESC
     LIMIT 1
     FOR UPDATE`,
    [campaignId, ownerId],
  );
  let stagingRunId = existing.rows[0]?.id;
  if (!stagingRunId) {
    const created = await client.query<{ id: string }>(
      `INSERT INTO outreach.runs (campaign_id, user_id, status)
       VALUES ($1, $2, 'uploading')
       RETURNING id`,
      [campaignId, ownerId],
    );
    stagingRunId = created.rows[0].id;
  }

  // Collapse duplicate empty staging runs created by concurrent upload/restage requests.
  await client.query(
    `UPDATE outreach.uploads u
     SET run_id = $3
     FROM outreach.runs r
     WHERE u.run_id = r.id
       AND r.campaign_id = $1
       AND r.user_id = $2
       AND r.status = 'uploading'
       AND r.id <> $3`,
    [campaignId, ownerId, stagingRunId],
  );
  await client.query(
    `DELETE FROM outreach.runs r
     WHERE r.campaign_id = $1
       AND r.user_id = $2
       AND r.status = 'uploading'
       AND r.id <> $3
       AND NOT EXISTS (SELECT 1 FROM outreach.uploads u WHERE u.run_id = r.id)`,
    [campaignId, ownerId, stagingRunId],
  );
  return stagingRunId;
}

async function purgeRunEnrichmentArtifacts(client: PoolClient, runId: string, campaignId: string) {
  await client.query(
    `DELETE FROM outreach.company_research_jobs
     WHERE requested_by_runs @> ARRAY[$1::uuid]`,
    [runId],
  );
  const removed = await client.query<{ lead_id: string }>(
    `DELETE FROM outreach.campaign_leads
     WHERE campaign_id = $1 AND run_id = $2
     RETURNING lead_id`,
    [campaignId, runId],
  );
  const leadIds = [...new Set(removed.rows.map((row) => row.lead_id))];
  if (leadIds.length) {
    await client.query(
      `DELETE FROM outreach.leads l
       WHERE l.id = ANY($1::uuid[])
         AND NOT EXISTS (SELECT 1 FROM outreach.campaign_leads cl WHERE cl.lead_id = l.id)`,
      [leadIds],
    );
  }
}

export async function restageIncompleteUploads(
  client: PoolClient,
  campaignId: string,
  ownerId: string,
) {
  const stagingRunId = await ensureStagingRun(client, campaignId, ownerId);
  await client.query(
    `UPDATE outreach.uploads u
     SET run_id = $3,
         status = 'uploaded',
         content_hash = NULL,
         extraction_summary = NULL
     FROM outreach.runs r
     WHERE u.run_id = r.id
       AND r.campaign_id = $1
       AND r.user_id = $2
       AND r.status IN ('cancelled', 'failed')
       AND u.status IN ('uploaded', 'processing', 'extracted', 'failed', 'failed_quality')`,
    [campaignId, ownerId, stagingRunId],
  );
  return stagingRunId;
}

export async function getCampaignRunState(campaignId: string, ownerId: string, restage = false) {
  await dbQuery(`SELECT 1 FROM outreach.campaigns WHERE id = $1 AND owner_id = $2`, [campaignId, ownerId]);

  if (restage) {
    await dbTransaction(async (client) => {
      await assertCampaignOwner(client, campaignId, ownerId);
      const active = await getActiveRun(client, campaignId, ownerId);
      if (!active) await restageIncompleteUploads(client, campaignId, ownerId);
    });
  }

  const active = await dbQuery<{ id: string; status: string; stats: Record<string, unknown> }>(
    `SELECT id, status, stats FROM outreach.runs
     WHERE campaign_id = $1 AND user_id = $2 AND status IN ('queued', 'extracting', 'enriching', 'awaiting_prior_enrichment')
     ORDER BY started_at DESC LIMIT 1`,
    [campaignId, ownerId],
  );
  const staged = await dbQuery<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM outreach.uploads u
     JOIN outreach.runs r ON r.id = u.run_id
     WHERE r.campaign_id = $1
       AND r.user_id = $2
       AND r.status = 'uploading'
       AND u.status IN ('uploaded', 'extracted')`,
    [campaignId, ownerId],
  );
  const retryable = await dbQuery<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM outreach.uploads u
     JOIN outreach.runs r ON r.id = u.run_id
     WHERE r.campaign_id = $1
       AND r.user_id = $2
       AND r.status IN ('cancelled', 'failed')
       AND u.status IN ('uploaded', 'processing', 'extracted')`,
    [campaignId, ownerId],
  );
  return {
    active_run_id: active.rows[0]?.id ?? null,
    active_run: active.rows[0] ?? null,
    staged_count: staged.rows[0]?.count ?? 0,
    retryable_count: retryable.rows[0]?.count ?? 0,
    can_enrich: !active.rows[0] && ((staged.rows[0]?.count ?? 0) > 0 || (retryable.rows[0]?.count ?? 0) > 0),
  };
}

export async function cancelEnrichmentRun(runId: string, ownerId: string) {
  const cancelled = await dbTransaction(async (client) => {
    const run = await client.query<RunRow>(
      `SELECT r.id, r.campaign_id, r.status
       FROM outreach.runs r
       JOIN outreach.campaigns c ON c.id = r.campaign_id
       WHERE r.id = $1 AND c.owner_id = $2 AND r.user_id = $2
         AND r.status IN ('queued', 'extracting', 'enriching', 'awaiting_prior_enrichment')
       FOR UPDATE`,
      [runId, ownerId],
    );
    if (!run.rows[0]) throw new Error('Run cannot be cancelled');

    await client.query(
      `UPDATE outreach.runs
       SET status = 'cancelled', error = 'Cancelled by user', finished_at = now()
       WHERE id = $1`,
      [runId],
    );
    await purgeRunEnrichmentArtifacts(client, runId, run.rows[0].campaign_id);
    await restageIncompleteUploads(client, run.rows[0].campaign_id, ownerId);
    return run.rows[0];
  });
  await cancelScope(runId);
  return cancelled;
}

export async function submitPriorEnrichmentDecision(
  runId: string,
  ownerId: string,
  decision: PriorEnrichmentDecision,
) {
  await applyPriorEnrichmentDecision(runId, ownerId, decision);
  return { run_id: runId, status: 'enriching' as const, decision };
}

export async function queueEnrichmentRun(campaignId: string, ownerId: string) {
  const runId = await dbTransaction(async (client) => {
    await assertCampaignOwner(client, campaignId, ownerId);
    const active = await getActiveRun(client, campaignId, ownerId);
    if (active) throw new Error('A run is already in progress. Cancel it before starting a new one.');

    await restageIncompleteUploads(client, campaignId, ownerId);
    const staging = await client.query<{ id: string }>(
      `SELECT r.id
       FROM outreach.runs r
       WHERE r.campaign_id = $1 AND r.user_id = $2 AND r.status = 'uploading'
         AND EXISTS (SELECT 1 FROM outreach.uploads u WHERE u.run_id = r.id AND u.status IN ('uploaded', 'extracted'))
       ORDER BY r.started_at DESC
       LIMIT 1
       FOR UPDATE`,
      [campaignId, ownerId],
    );
    if (!staging.rows[0]) throw new Error('Upload at least one file before enriching.');
    await client.query(`UPDATE outreach.runs SET status = 'queued' WHERE id = $1`, [staging.rows[0].id]);
    return staging.rows[0].id;
  });

  try {
    await enqueueWork({
      kind: 'run.process',
      payload: { runId },
      dedupeKey: runId,
      scopeKey: runId,
      reviveTerminal: true,
    });
  } catch (error) {
    await dbQuery(
      `UPDATE outreach.runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
      [runId, error instanceof Error ? error.message : 'Could not queue extraction'],
    );
    throw error;
  }

  return { run_id: runId, status: 'queued' as const };
}
