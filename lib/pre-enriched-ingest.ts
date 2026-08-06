import { dbQuery } from '@/lib/db';
import { getCampaign } from '@/lib/campaigns';
import { extractUpload, sha256, type ExtractedPerson, type ExtractionResult } from '@/lib/extraction';
import { resolveExtractedPerson } from '@/lib/identity';
import { startDraftingWorkspace } from '@/lib/drafting/repository';
import { campaignHasDraftingWorkspace } from '@/lib/campaign-review';
import { downloadStoredObject } from '@/lib/storage';
import { isSheetUploadKind, sniffUpload } from '@/lib/upload-types';

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

type StagingUpload = {
  id: string;
  file_name: string;
  storage_path: string;
  status: string;
  mime_type: string | null;
};

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
}> {
  const { rows: runs } = await dbQuery<{ id: string }>(
    `SELECT id FROM outreach.runs
     WHERE campaign_id = $1 AND user_id = $2 AND status = 'uploading'
     ORDER BY started_at DESC
     LIMIT 1`,
    [campaignId, ownerId],
  );
  const runId = runs[0]?.id;
  if (!runId) {
    throw new PreEnrichedIngestError('Upload a lead sheet before going to Draft.');
  }

  const { rows: uploads } = await dbQuery<StagingUpload>(
    `SELECT id, file_name, storage_path, status, mime_type
     FROM outreach.uploads
     WHERE run_id = $1
     ORDER BY created_at ASC`,
    [runId],
  );

  if (!uploads.length) {
    throw new PreEnrichedIngestError('Upload a lead sheet before going to Draft.');
  }
  if (uploads.some((upload) => upload.status === 'pending_upload')) {
    throw new PreEnrichedIngestError('Wait for all uploads to finish before going to Draft.');
  }

  const ready = uploads.filter((upload) => upload.status === 'uploaded' || upload.status === 'extracted');
  if (!ready.length) {
    throw new PreEnrichedIngestError('No successfully uploaded sheets are ready for Draft.');
  }

  return { runId, uploads: ready };
}

async function extractStagingUpload(upload: StagingUpload): Promise<ExtractionResult> {
  if (upload.status === 'extracted') {
    const { rows } = await dbQuery<{ extraction_summary: { result?: ExtractionResult } }>(
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

async function stageTrustedPeople(
  campaignId: string,
  runId: string,
  people: ExtractedPerson[],
) {
  let matched = 0;
  let withEmail = 0;
  for (const person of people) {
    const result = await resolveExtractedPerson(person, runId, campaignId, {
      trustEmailAsValidated: true,
    });
    if (result.matched) matched += 1;
    if (person.email?.trim()) withEmail += 1;
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
 * Parse staged sheets for a pre-enriched campaign, trust present emails as valid,
 * mark the staging run complete, and start the drafting workspace.
 */
export async function ingestPreEnrichedCampaign(
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

  if (await campaignHasDraftingWorkspace(campaignId)) {
    return {
      href: `/campaigns/${campaignId}/draft`,
      already_started: true,
      created_items: 0,
      queued_items: 0,
    };
  }

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

  if (!(existingLeads.rows[0]?.count > 0 && hasCompleteRun.rows[0])) {
    const { runId, uploads } = await loadStagingUploads(campaignId, ownerId);

    try {
      // Reject non-sheet files that somehow landed on the staging run.
      for (const upload of uploads) {
        const bytes = await downloadStoredObject(upload.storage_path);
        assertSheetFile(upload.file_name, bytes.subarray(0, 32));
      }

      await dbQuery(
        `UPDATE outreach.runs
         SET status = 'extracting',
             stats = coalesce(stats, '{}'::jsonb) || jsonb_build_object('pre_enriched', true)
         WHERE id = $1`,
        [runId],
      );

      const allPeople: ExtractedPerson[] = [];
      for (const upload of uploads) {
        const result = await extractStagingUpload(upload);
        allPeople.push(...result.people);
      }

      if (!allPeople.length) {
        await dbQuery(
          `UPDATE outreach.runs SET status = 'uploading', error = NULL WHERE id = $1`,
          [runId],
        );
        throw new PreEnrichedIngestError('No people found in the uploaded sheet(s).');
      }

      const staged = await stageTrustedPeople(campaignId, runId, allPeople);
      await completePreEnrichedRun(runId, { ...staged, files: uploads.length });
    } catch (error) {
      if (!(error instanceof PreEnrichedIngestError && error.message.startsWith('No people found'))) {
        await dbQuery(
          `UPDATE outreach.runs SET status = 'uploading', error = NULL WHERE id = $1 AND status = 'extracting'`,
          [runId],
        ).catch(() => undefined);
      }
      throw error;
    }
  }

  const drafting = await startDraftingWorkspace(campaignId, ownerId, {
    senderProfileId: input.senderProfileId,
    idempotencyKey: input.idempotencyKey,
  });

  return {
    href: drafting.href,
    already_started: false,
    created_items: drafting.created_items,
    queued_items: drafting.queued_items,
    drafting_run_id: drafting.drafting_run_id,
    workspace_id: drafting.workspace_id,
    transport_warning: drafting.transport_warning,
  };
}
