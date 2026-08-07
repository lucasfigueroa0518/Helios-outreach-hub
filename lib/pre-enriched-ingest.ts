import { dbQuery } from '@/lib/db';
import { getCampaign } from '@/lib/campaigns';
import {
  assertCampaignUnderCostCap,
  CampaignCostCapError,
} from '@/lib/campaign-cost-cap';
import { extractUpload, sha256, type ExtractedPerson, type ExtractionResult } from '@/lib/extraction';
import { resolveExtractedPerson } from '@/lib/identity';
import {
  startDraftingWorkspace,
  syncCampaignLeadsIntoDraftingWorkspace,
} from '@/lib/drafting/repository';
import { lateSyncIdempotencyKey, preEnrichedIngestPlan } from '@/lib/drafting/late-sync';
import { campaignHasDraftingWorkspace } from '@/lib/campaign-review';
import { enqueueWorkBatch } from '@/lib/orchestration/repository';
import type { DispatchWork } from '@/lib/orchestration/types';
import { downloadStoredObject } from '@/lib/storage';
import { isSheetUploadKind, sniffUpload } from '@/lib/upload-types';

const STAGE_CHUNK = 40;

export class PreEnrichedIngestError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly fieldErrors?: Record<string, string>;

  constructor(
    message: string,
    status = 400,
    extras?: { code?: string; fieldErrors?: Record<string, string> },
  ) {
    super(message);
    this.name = 'PreEnrichedIngestError';
    this.status = status;
    this.code = extras?.code;
    this.fieldErrors = extras?.fieldErrors;
  }
}

export type PreEnrichedLaunchProgress = {
  status: 'accepted' | 'running' | 'ready' | 'failed';
  phase: 'queued' | 'extracting' | 'staging' | 'syncing' | 'ready' | 'failed';
  files_done: number;
  files_total: number;
  leads_staged: number;
  items_created: number;
  started_at: string;
  updated_at: string;
  error: string | null;
  href: string;
  transport_warning?: string | null;
  drafting_run_id?: string | null;
  workspace_id?: string | null;
};

type StagingUpload = {
  id: string;
  file_name: string;
  storage_path: string;
  status: string;
  mime_type: string | null;
};

function logLaunch(event: string, fields: Record<string, unknown>) {
  console.info('[pre_enriched_launch]', JSON.stringify({ event, ...fields, at: new Date().toISOString() }));
}

function assertSheetFile(fileName: string, header: Uint8Array) {
  const sniffed = sniffUpload(fileName, header);
  if (!sniffed || !isSheetUploadKind(sniffed.kind)) {
    throw new PreEnrichedIngestError(
      `“${fileName}” is not a sheet. Pre-enriched campaigns accept CSV, TSV, or Excel only.`,
    );
  }
  return sniffed;
}

async function loadStagingUploads(campaignId: string, ownerId: string): Promise<{
  runId: string;
  uploads: StagingUpload[];
} | null> {
  const { rows: runs } = await dbQuery<{ id: string }>(
    `SELECT id FROM outreach.runs
     WHERE campaign_id = $1 AND user_id = $2 AND status IN ('uploading', 'extracting')
     ORDER BY started_at DESC
     LIMIT 1`,
    [campaignId, ownerId],
  );
  const runId = runs[0]?.id;
  if (!runId) return null;

  const { rows: uploads } = await dbQuery<StagingUpload>(
    `SELECT id, file_name, storage_path, status, mime_type
     FROM outreach.uploads
     WHERE run_id = $1
     ORDER BY created_at ASC`,
    [runId],
  );

  if (!uploads.length) return null;
  if (uploads.some((upload) => upload.status === 'pending_upload')) {
    throw new PreEnrichedIngestError('Wait for all uploads to finish before going to Draft.');
  }

  const ready = uploads.filter((upload) => upload.status === 'uploaded' || upload.status === 'extracted');
  if (!ready.length) {
    throw new PreEnrichedIngestError('No successfully uploaded sheets are ready for Draft.');
  }

  return { runId, uploads: ready };
}

async function mergeLaunchProgress(
  runId: string,
  patch: Partial<PreEnrichedLaunchProgress>,
): Promise<PreEnrichedLaunchProgress> {
  const { rows } = await dbQuery<{ stats: Record<string, unknown> | null }>(
    `SELECT stats FROM outreach.runs WHERE id = $1`,
    [runId],
  );
  const prev = (rows[0]?.stats?.pre_enriched_launch ?? {}) as Partial<PreEnrichedLaunchProgress>;
  const next: PreEnrichedLaunchProgress = {
    status: patch.status ?? prev.status ?? 'running',
    phase: patch.phase ?? prev.phase ?? 'queued',
    files_done: patch.files_done ?? prev.files_done ?? 0,
    files_total: patch.files_total ?? prev.files_total ?? 0,
    leads_staged: patch.leads_staged ?? prev.leads_staged ?? 0,
    items_created: patch.items_created ?? prev.items_created ?? 0,
    started_at: prev.started_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
    error: patch.error === undefined ? (prev.error ?? null) : patch.error,
    href: patch.href ?? prev.href ?? '',
    transport_warning: patch.transport_warning ?? prev.transport_warning ?? null,
    drafting_run_id: patch.drafting_run_id ?? prev.drafting_run_id ?? null,
    workspace_id: patch.workspace_id ?? prev.workspace_id ?? null,
  };
  await dbQuery(
    `UPDATE outreach.runs
        SET stats = coalesce(stats, '{}'::jsonb)
          || jsonb_build_object('pre_enriched', true, 'pre_enriched_launch', $2::jsonb)
      WHERE id = $1`,
    [runId, JSON.stringify(next)],
  );
  return next;
}

export async function getPreEnrichedLaunchProgress(
  campaignId: string,
  ownerId: string,
): Promise<PreEnrichedLaunchProgress | null> {
  const { rows } = await dbQuery<{ id: string; stats: Record<string, unknown> | null }>(
    `SELECT id, stats FROM outreach.runs
      WHERE campaign_id = $1 AND user_id = $2
        AND (
          coalesce((stats->>'pre_enriched')::boolean, false) = true
          OR status IN ('extracting', 'complete')
        )
      ORDER BY started_at DESC
      LIMIT 1`,
    [campaignId, ownerId],
  );
  const launch = rows[0]?.stats?.pre_enriched_launch as PreEnrichedLaunchProgress | undefined;
  return launch ?? null;
}

async function extractStagingUpload(upload: StagingUpload): Promise<ExtractionResult> {
  if (upload.status === 'extracted') {
    const { rows } = await dbQuery<{ extraction_summary: { result?: ExtractionResult; people_found?: number } }>(
      `SELECT extraction_summary FROM outreach.uploads WHERE id = $1`,
      [upload.id],
    );
    const cached = rows[0]?.extraction_summary?.result;
    if (cached) return cached;
  }

  const bytes = await downloadStoredObject(upload.storage_path);
  assertSheetFile(upload.file_name, bytes.subarray(0, 32));
  const hash = sha256(bytes);
  const result = await extractUpload(bytes, upload.file_name, upload.id);

  // Slim summary for list GETs — omit full people payloads from listable JSON.
  await dbQuery(
    `UPDATE outreach.uploads
     SET status = 'extracted',
         content_hash = $2,
         extraction_summary = $3::jsonb
     WHERE id = $1`,
    [
      upload.id,
      hash,
      JSON.stringify({
        people_found: result.people.length,
        warnings: result.warnings,
        cache_hit: false,
        // Keep result for assemble/re-read of this file only (not returned by slim list).
        result,
        progress: {
          stage: 'complete',
          percent: 100,
          message: 'Extraction complete',
          updated_at: new Date().toISOString(),
        },
      }),
    ],
  );

  return result;
}

/** Stage trusted people in chunks (parallel within each chunk). */
export async function stageTrustedPeopleChunked(
  campaignId: string,
  runId: string,
  people: ExtractedPerson[],
) {
  let matched = 0;
  let withEmail = 0;
  for (let i = 0; i < people.length; i += STAGE_CHUNK) {
    const slice = people.slice(i, i + STAGE_CHUNK);
    const results = await Promise.all(
      slice.map((person) => resolveExtractedPerson(person, runId, campaignId, {
        trustEmailAsValidated: true,
      })),
    );
    for (let j = 0; j < results.length; j += 1) {
      if (results[j].matched) matched += 1;
      if (slice[j].email?.trim()) withEmail += 1;
    }
  }
  return { people: people.length, matched, withEmail };
}

async function completePreEnrichedRun(
  runId: string,
  stats: { people: number; matched: number; withEmail: number; files: number },
) {
  await dbQuery(
    `UPDATE outreach.runs
     SET status = 'complete',
         finished_at = now(),
         stats = coalesce(stats, '{}'::jsonb) || jsonb_build_object(
           'pre_enriched', true,
           'people_resolved', true,
           'matched_existing', $2::int,
           'emails_available_after_identity', $3::int,
           'emails_direct_after_identity', $3::int,
           'emails_inferred_reused', 0,
           'people_total', $4::int,
           'files_extracted', $5::int
         )
     WHERE id = $1`,
    [runId, stats.matched, stats.withEmail, stats.people, stats.files],
  );
}

/**
 * Accept pre-enriched ingest: validate, enqueue orchestration work, return immediately.
 */
export async function acceptPreEnrichedIngest(
  campaignId: string,
  ownerId: string,
  input: {
    senderProfileId?: string;
    idempotencyKey?: string;
  } = {},
) {
  const campaign = await getCampaign(ownerId, campaignId);
  if (!campaign) {
    throw new PreEnrichedIngestError('Campaign not found', 404);
  }
  if (campaign.status !== 'active') {
    throw new PreEnrichedIngestError('Campaign must be active', 400);
  }
  if (campaign.needs_enrichment) {
    throw new PreEnrichedIngestError(
      'This campaign needs enrichment. Use Enrich → Review → Go to Drafting instead.',
      400,
      { code: 'needs_enrichment' },
    );
  }

  try {
    await assertCampaignUnderCostCap({
      campaignId,
      needsEnrichment: false,
    });
  } catch (error) {
    if (error instanceof CampaignCostCapError) {
      throw new PreEnrichedIngestError(error.message, 402, { code: error.code });
    }
    throw error;
  }

  const existing = await getPreEnrichedLaunchProgress(campaignId, ownerId);
  if (existing && (existing.status === 'accepted' || existing.status === 'running')) {
    logLaunch('already_running', { campaignId, runStatus: existing.status, phase: existing.phase });
    return {
      status: existing.status,
      href: existing.href || `/campaigns/${campaignId}/draft`,
      progress: existing,
      already_started: true,
    };
  }
  if (existing?.status === 'ready') {
    return {
      status: 'ready' as const,
      href: existing.href || `/campaigns/${campaignId}/draft`,
      progress: existing,
      already_started: true,
    };
  }

  const workspaceExists = await campaignHasDraftingWorkspace(campaignId);
  const existingLeads = await dbQuery<{ count: number }>(
    `SELECT count(*)::int AS count FROM outreach.campaign_leads WHERE campaign_id = $1`,
    [campaignId],
  );
  const hasCompleteRun = await dbQuery<{ id: string }>(
    `SELECT id FROM outreach.runs
     WHERE campaign_id = $1 AND status = 'complete'
       AND coalesce((stats->>'pre_enriched')::boolean, false) = true
     ORDER BY finished_at DESC NULLS LAST
     LIMIT 1`,
    [campaignId],
  );

  const plan = preEnrichedIngestPlan({
    workspaceExists,
    hasExistingLeads: (existingLeads.rows[0]?.count ?? 0) > 0,
    hasCompletePreEnrichedRun: Boolean(hasCompleteRun.rows[0]),
  });

  const staging = await loadStagingUploads(campaignId, ownerId);
  if (!staging && plan.requireUploads) {
    throw new PreEnrichedIngestError('Upload a lead sheet before going to Draft.');
  }

  const href = `/campaigns/${campaignId}/draft`;

  // Fast path: no new staging files — sync/start immediately (still under cost cap).
  if (!staging) {
    logLaunch('sync_only', { campaignId, workspaceExists });
    if (plan.useSyncHelper) {
      const workspace = await dbQuery<{ id: string }>(
        `SELECT id FROM outreach.drafting_workspaces WHERE campaign_id = $1`,
        [campaignId],
      );
      const workspaceId = workspace.rows[0]?.id;
      if (!workspaceId) throw new PreEnrichedIngestError('Drafting workspace not found', 404);
      const synced = await syncCampaignLeadsIntoDraftingWorkspace(campaignId, ownerId, {
        trigger: 'retry',
        idempotencyKey:
          input.idempotencyKey
          ?? lateSyncIdempotencyKey(workspaceId, 'existing'),
        senderProfileId: input.senderProfileId,
      });
      return {
        status: 'ready' as const,
        href,
        already_started: true,
        created_items: synced.created_items,
        queued_items: synced.queued_items,
        drafting_run_id: synced.drafting_run_id,
        workspace_id: synced.workspace_id,
        transport_warning: synced.transport_warning,
      };
    }
    const drafting = await startDraftingWorkspace(campaignId, ownerId, {
      senderProfileId: input.senderProfileId,
      idempotencyKey: input.idempotencyKey,
    });
    return {
      status: 'ready' as const,
      href: drafting.href,
      already_started: false,
      created_items: drafting.created_items,
      queued_items: drafting.queued_items,
      drafting_run_id: drafting.drafting_run_id,
      workspace_id: drafting.workspace_id,
      transport_warning: drafting.transport_warning,
    };
  }

  const { runId, uploads } = staging;
  const startedAt = new Date().toISOString();
  await dbQuery(
    `UPDATE outreach.runs
        SET status = 'extracting',
            error = NULL,
            stats = coalesce(stats, '{}'::jsonb) || jsonb_build_object(
              'pre_enriched', true,
              'pre_enriched_launch', $2::jsonb
            )
      WHERE id = $1`,
    [
      runId,
      JSON.stringify({
        status: 'accepted',
        phase: 'queued',
        files_done: 0,
        files_total: uploads.length,
        leads_staged: 0,
        items_created: 0,
        started_at: startedAt,
        updated_at: startedAt,
        error: null,
        href,
      } satisfies PreEnrichedLaunchProgress),
    ],
  );

  const works: DispatchWork[] = [
    {
      kind: 'pre_enriched.ingest',
      payload: {
        campaignId,
        ownerId,
        runId,
        senderProfileId: input.senderProfileId,
        idempotencyKey: input.idempotencyKey,
      },
      dedupeKey: `${runId}:ingest`,
      scopeKey: campaignId,
      priority: 25,
      reviveTerminal: true,
    },
  ];
  await enqueueWorkBatch(works);
  logLaunch('accepted', {
    campaignId,
    runId,
    filesTotal: uploads.length,
    idempotencyKey: input.idempotencyKey ?? null,
  });

  const progress = await getPreEnrichedLaunchProgress(campaignId, ownerId);
  return {
    status: 'accepted' as const,
    href,
    progress,
    already_started: false,
  };
}

/**
 * Synchronous helper for offline tests: accept + process extract/assemble inline.
 * Production path uses acceptPreEnrichedIngest + worker handlers.
 */
export async function ingestPreEnrichedCampaign(
  campaignId: string,
  ownerId: string,
  input: {
    senderProfileId?: string;
    idempotencyKey?: string;
  } = {},
) {
  const accepted = await acceptPreEnrichedIngest(campaignId, ownerId, input);
  if (accepted.status === 'ready') {
    return {
      href: accepted.href,
      already_started: Boolean(accepted.already_started),
      created_items: (accepted as { created_items?: number }).created_items ?? 0,
      queued_items: (accepted as { queued_items?: number }).queued_items ?? 0,
      drafting_run_id: (accepted as { drafting_run_id?: string }).drafting_run_id,
      workspace_id: (accepted as { workspace_id?: string }).workspace_id,
      transport_warning: (accepted as { transport_warning?: string }).transport_warning,
    };
  }

  const staging = await loadStagingUploads(campaignId, ownerId);
  if (!staging) {
    return {
      href: accepted.href,
      already_started: Boolean(accepted.already_started),
      status: accepted.status,
      progress: accepted.progress,
    };
  }

  const { children } = await runPreEnrichedIngestCoordinator({
    campaignId,
    ownerId,
    runId: staging.runId,
    senderProfileId: input.senderProfileId,
    idempotencyKey: input.idempotencyKey,
  });

  for (const work of children) {
    if (work.kind === 'pre_enriched.extract_file') {
      await runPreEnrichedExtractFile(work.payload as {
        campaignId: string;
        ownerId: string;
        runId: string;
        uploadId: string;
      });
    }
  }
  for (const work of children) {
    if (work.kind === 'pre_enriched.assemble') {
      let attempt = 0;
      while (attempt < 5) {
        const result = await runPreEnrichedAssemble(work.payload as {
          campaignId: string;
          ownerId: string;
          runId: string;
          senderProfileId?: string;
          idempotencyKey?: string;
          filesTotal: number;
        });
        if (!result.retry) break;
        attempt += 1;
      }
    }
  }

  const progress = await getPreEnrichedLaunchProgress(campaignId, ownerId);
  if (progress?.status === 'failed') {
    throw new PreEnrichedIngestError(progress.error ?? 'Pre-enriched ingest failed', 500);
  }
  return {
    href: progress?.href ?? accepted.href,
    already_started: false,
    created_items: progress?.items_created ?? 0,
    queued_items: progress?.items_created ?? 0,
    drafting_run_id: progress?.drafting_run_id ?? undefined,
    workspace_id: progress?.workspace_id ?? undefined,
    transport_warning: progress?.transport_warning ?? undefined,
  };
}

export async function runPreEnrichedIngestCoordinator(input: {
  campaignId: string;
  ownerId: string;
  runId: string;
  senderProfileId?: string;
  idempotencyKey?: string;
}): Promise<{ children: DispatchWork[] }> {
  const { rows: uploads } = await dbQuery<StagingUpload>(
    `SELECT id, file_name, storage_path, status, mime_type
       FROM outreach.uploads
      WHERE run_id = $1
        AND status IN ('uploaded', 'extracted')
      ORDER BY created_at ASC`,
    [input.runId],
  );

  await mergeLaunchProgress(input.runId, {
    status: 'running',
    phase: 'extracting',
    files_total: uploads.length,
    files_done: uploads.filter((u) => u.status === 'extracted').length,
    href: `/campaigns/${input.campaignId}/draft`,
  });

  const children: DispatchWork[] = uploads.map((upload) => ({
    kind: 'pre_enriched.extract_file' as const,
    payload: {
      campaignId: input.campaignId,
      ownerId: input.ownerId,
      runId: input.runId,
      uploadId: upload.id,
    },
    dedupeKey: `${input.runId}:${upload.id}`,
    scopeKey: input.campaignId,
    priority: 30,
    reviveTerminal: true,
  }));

  children.push({
    kind: 'pre_enriched.assemble',
    payload: {
      campaignId: input.campaignId,
      ownerId: input.ownerId,
      runId: input.runId,
      senderProfileId: input.senderProfileId,
      idempotencyKey: input.idempotencyKey,
      filesTotal: uploads.length,
    },
    dedupeKey: `${input.runId}:assemble`,
    scopeKey: input.campaignId,
    priority: 10,
    maxAttempts: 1_000,
    reviveTerminal: true,
  });

  logLaunch('coordinator_fanout', {
    campaignId: input.campaignId,
    runId: input.runId,
    filesTotal: uploads.length,
  });
  return { children };
}

export async function runPreEnrichedExtractFile(input: {
  campaignId: string;
  ownerId: string;
  runId: string;
  uploadId: string;
}): Promise<void> {
  const { rows } = await dbQuery<StagingUpload>(
    `SELECT id, file_name, storage_path, status, mime_type
       FROM outreach.uploads WHERE id = $1 AND run_id = $2`,
    [input.uploadId, input.runId],
  );
  const upload = rows[0];
  if (!upload) return;

  const started = Date.now();
  const result = await extractStagingUpload(upload);
  const staged = await stageTrustedPeopleChunked(input.campaignId, input.runId, result.people);

  const { rows: counts } = await dbQuery<{ files_done: number; leads_staged: number }>(
    `SELECT
       (SELECT count(*)::int FROM outreach.uploads
         WHERE run_id = $1 AND status = 'extracted') AS files_done,
       (SELECT count(*)::int FROM outreach.campaign_leads
         WHERE campaign_id = $2 AND run_id = $1) AS leads_staged`,
    [input.runId, input.campaignId],
  );

  await mergeLaunchProgress(input.runId, {
    status: 'running',
    phase: 'extracting',
    files_done: counts[0]?.files_done ?? 0,
    leads_staged: counts[0]?.leads_staged ?? staged.people,
  });

  logLaunch('extract_file_done', {
    campaignId: input.campaignId,
    runId: input.runId,
    uploadId: input.uploadId,
    people: result.people.length,
    duration_ms: Date.now() - started,
  });
}

export async function runPreEnrichedAssemble(input: {
  campaignId: string;
  ownerId: string;
  runId: string;
  senderProfileId?: string;
  idempotencyKey?: string;
  filesTotal: number;
}): Promise<{ retry?: boolean }> {
  const { rows: pending } = await dbQuery<{ count: number }>(
    `SELECT count(*)::int AS count FROM outreach.uploads
      WHERE run_id = $1 AND status <> 'extracted'`,
    [input.runId],
  );
  if ((pending[0]?.count ?? 0) > 0) {
    return { retry: true };
  }

  const { rows: peopleRows } = await dbQuery<{ people: number; with_email: number }>(
    `SELECT count(*)::int AS people,
            count(*) FILTER (WHERE l.email_primary IS NOT NULL AND length(trim(l.email_primary)) > 0)::int AS with_email
       FROM outreach.campaign_leads cl
       JOIN outreach.leads l ON l.id = cl.lead_id
      WHERE cl.campaign_id = $1 AND cl.run_id = $2`,
    [input.campaignId, input.runId],
  );
  const people = peopleRows[0]?.people ?? 0;
  const withEmail = peopleRows[0]?.with_email ?? 0;

  if (people === 0) {
    await dbQuery(
      `UPDATE outreach.runs SET status = 'uploading', error = NULL WHERE id = $1`,
      [input.runId],
    );
    await mergeLaunchProgress(input.runId, {
      status: 'failed',
      phase: 'failed',
      error: 'No people found in the uploaded sheet(s).',
    });
    throw new PreEnrichedIngestError('No people found in the uploaded sheet(s).');
  }

  await mergeLaunchProgress(input.runId, {
    status: 'running',
    phase: 'staging',
    leads_staged: people,
    files_done: input.filesTotal,
  });

  await completePreEnrichedRun(input.runId, {
    people,
    matched: people,
    withEmail,
    files: input.filesTotal,
  });

  await mergeLaunchProgress(input.runId, {
    status: 'running',
    phase: 'syncing',
    leads_staged: people,
  });

  try {
    await assertCampaignUnderCostCap({
      campaignId: input.campaignId,
      needsEnrichment: false,
      fallbackLeadCount: people,
    });
  } catch (error) {
    if (error instanceof CampaignCostCapError) {
      await mergeLaunchProgress(input.runId, {
        status: 'failed',
        phase: 'failed',
        error: error.message,
      });
      throw new PreEnrichedIngestError(error.message, 402, { code: error.code });
    }
    throw error;
  }

  const syncStarted = Date.now();
  const workspaceExists = await campaignHasDraftingWorkspace(input.campaignId);
  try {
    if (workspaceExists) {
      const workspace = await dbQuery<{ id: string }>(
        `SELECT id FROM outreach.drafting_workspaces WHERE campaign_id = $1`,
        [input.campaignId],
      );
      const workspaceId = workspace.rows[0]?.id;
      if (!workspaceId) throw new PreEnrichedIngestError('Drafting workspace not found', 404);
      const synced = await syncCampaignLeadsIntoDraftingWorkspace(input.campaignId, input.ownerId, {
        trigger: 'retry',
        idempotencyKey:
          input.idempotencyKey
          ?? lateSyncIdempotencyKey(workspaceId, input.runId),
        senderProfileId: input.senderProfileId,
      });
      await mergeLaunchProgress(input.runId, {
        status: 'ready',
        phase: 'ready',
        items_created: synced.created_items,
        drafting_run_id: synced.drafting_run_id,
        workspace_id: synced.workspace_id,
        transport_warning: synced.transport_warning ?? null,
        error: null,
        href: `/campaigns/${input.campaignId}/draft`,
      });
      logLaunch('assemble_ready', {
        campaignId: input.campaignId,
        runId: input.runId,
        items: synced.created_items,
        duration_ms: Date.now() - syncStarted,
        mode: 'sync',
      });
    } else {
      const drafting = await startDraftingWorkspace(input.campaignId, input.ownerId, {
        senderProfileId: input.senderProfileId,
        idempotencyKey: input.idempotencyKey,
      });
      await mergeLaunchProgress(input.runId, {
        status: 'ready',
        phase: 'ready',
        items_created: drafting.created_items,
        drafting_run_id: drafting.drafting_run_id,
        workspace_id: drafting.workspace_id,
        transport_warning: drafting.transport_warning ?? null,
        error: null,
        href: drafting.href,
      });
      logLaunch('assemble_ready', {
        campaignId: input.campaignId,
        runId: input.runId,
        items: drafting.created_items,
        duration_ms: Date.now() - syncStarted,
        mode: 'start',
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Drafting sync failed';
    await mergeLaunchProgress(input.runId, {
      status: 'failed',
      phase: 'failed',
      error: message,
    });
    logLaunch('assemble_failed', {
      campaignId: input.campaignId,
      runId: input.runId,
      error: message,
      duration_ms: Date.now() - syncStarted,
    });
    throw error;
  }

  return {};
}
