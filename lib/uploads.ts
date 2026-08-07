import { randomUUID } from 'node:crypto';
import { dbQuery, dbTransaction } from '@/lib/db';
import { ensureStagingRun } from '@/lib/runs';
import { createSignedUpload, removeStoredObject } from '@/lib/storage';
import { isSheetUploadKind, sniffUpload } from '@/lib/upload-types';

export type Upload = {
  id: string;
  run_id: string;
  run_status: string;
  file_name: string;
  mime_type: string | null;
  byte_size: number | null;
  storage_path: string;
  content_hash: string | null;
  status: string;
  extraction_summary: Record<string, unknown> | null;
  created_at: string;
};

export type UploadIntentInput = {
  fileName: string;
  mimeType: string;
  byteSize: number;
};

export type UploadIntent = {
  upload: Upload;
  uploadUrl: string;
  token: string;
};

/** Max files prepared in a single staging transaction (client chunks above this). */
export const UPLOAD_INTENT_BATCH_LIMIT = 50;

const acceptedMimeTypes = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif', 'image/tiff', 'image/gif',
  'application/pdf', 'text/csv', 'text/tab-separated-values',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'text/markdown',
]);

function safeFileName(fileName: string) {
  return fileName.replace(/^.*[\\/]/, '').replace(/[^\w.() -]+/g, '_').slice(0, 180) || 'upload';
}

async function assertCampaignOwnership(campaignId: string, ownerId: string) {
  const { rows } = await dbQuery<{ id: string }>(
    `SELECT id FROM outreach.campaigns WHERE id = $1 AND owner_id = $2`,
    [campaignId, ownerId],
  );
  if (!rows[0]) throw new Error('Campaign not found');
}

function slimExtractionSummary(summary: Upload['extraction_summary']): Upload['extraction_summary'] {
  if (!summary || typeof summary !== 'object') return summary;
  const record = summary as Record<string, unknown>;
  return {
    people_found: record.people_found,
    warnings: record.warnings,
    cache_hit: record.cache_hit,
    progress: record.progress,
  } as Upload['extraction_summary'];
}

export async function listCampaignUploads(campaignId: string, ownerId: string): Promise<Upload[]> {
  await assertCampaignOwnership(campaignId, ownerId);
  const { rows } = await dbQuery<Upload>(
    `SELECT u.id, u.run_id, r.status AS run_status, u.file_name, u.mime_type, u.byte_size, u.storage_path,
            u.content_hash, u.status, u.extraction_summary, u.created_at
     FROM outreach.uploads u
     JOIN outreach.runs r ON r.id = u.run_id
     WHERE r.campaign_id = $1 AND r.user_id = $2
     ORDER BY r.started_at DESC, u.created_at ASC`,
    [campaignId, ownerId],
  );
  return rows.map((row) => ({
    ...row,
    extraction_summary: slimExtractionSummary(row.extraction_summary),
  }));
}

const sheetMimeTypes = new Set([
  'text/csv',
  'text/tab-separated-values',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
]);

function validateUploadInput(
  input: UploadIntentInput,
  needsEnrichment: boolean,
) {
  if (!acceptedMimeTypes.has(input.mimeType)) {
    throw new Error(`“${input.fileName}” is not a supported file type`);
  }
  if (!Number.isFinite(input.byteSize) || input.byteSize <= 0 || input.byteSize > 52_428_800) {
    throw new Error(`“${input.fileName}” must be between 1 byte and 50 MB`);
  }
  if (!needsEnrichment) {
    const sniffed = sniffUpload(input.fileName, new Uint8Array());
    const sheetByMime = sheetMimeTypes.has(input.mimeType);
    const sheetByName = sniffed ? isSheetUploadKind(sniffed.kind) : false;
    if (!sheetByMime && !sheetByName) {
      throw new Error('Pre-enriched campaigns accept CSV, TSV, or Excel only');
    }
  }
}

export async function createUploadIntent(
  campaignId: string,
  ownerId: string,
  input: UploadIntentInput,
): Promise<UploadIntent> {
  const intents = await createUploadIntents(campaignId, ownerId, [input]);
  if (!intents[0]) throw new Error('Unable to prepare upload');
  return intents[0];
}

/**
 * Prepare many uploads in one staging transaction, then sign URLs in parallel.
 * Keeps bulk drops efficient: one campaign lock + one staging run for the batch.
 */
export async function createUploadIntents(
  campaignId: string,
  ownerId: string,
  inputs: UploadIntentInput[],
): Promise<UploadIntent[]> {
  if (!inputs.length) throw new Error('At least one file is required');
  if (inputs.length > UPLOAD_INTENT_BATCH_LIMIT) {
    throw new Error(`At most ${UPLOAD_INTENT_BATCH_LIMIT} files can be prepared at once`);
  }

  const uploads = await dbTransaction(async (client) => {
    const campaign = await client.query<{ id: string; needs_enrichment: boolean }>(
      `SELECT id, needs_enrichment FROM outreach.campaigns WHERE id = $1 AND owner_id = $2 FOR UPDATE`,
      [campaignId, ownerId],
    );
    if (!campaign.rows[0]) throw new Error('Campaign not found');
    const needsEnrichment = campaign.rows[0].needs_enrichment;

    for (const input of inputs) {
      validateUploadInput(input, needsEnrichment);
    }

    const runId = await ensureStagingRun(client, campaignId, ownerId);
    const rows: Upload[] = [];

    for (const input of inputs) {
      const id = randomUUID();
      const storagePath = `${campaignId}/${runId}/${id}-${safeFileName(input.fileName)}`;
      const result = await client.query<Upload>(
        `INSERT INTO outreach.uploads (
          id, run_id, file_name, mime_type, byte_size, storage_path, status
        ) VALUES ($1, $2, $3, $4, $5, $6, 'pending_upload')
        RETURNING id, run_id, file_name, mime_type, byte_size, storage_path,
                  content_hash, status, extraction_summary, created_at,
                  'uploading'::text AS run_status`,
        [id, runId, safeFileName(input.fileName), input.mimeType, input.byteSize, storagePath],
      );
      rows.push(result.rows[0]);
    }
    return rows;
  });

  const signedById = new Map<string, UploadIntent>();
  const failures: string[] = [];

  await Promise.all(uploads.map(async (upload) => {
    try {
      const signed = await createSignedUpload(upload.storage_path);
      signedById.set(upload.id, { upload, ...signed });
    } catch {
      failures.push(upload.id);
    }
  }));

  if (failures.length) {
    await dbQuery(
      `UPDATE outreach.uploads SET status = 'failed' WHERE id = ANY($1::uuid[])`,
      [failures],
    );
  }
  if (!signedById.size) {
    throw new Error('Unable to prepare upload URLs');
  }
  // Preserve input order for clients that zip file ↔ intent by index.
  return uploads
    .map((upload) => signedById.get(upload.id))
    .filter((intent): intent is UploadIntent => Boolean(intent));
}

export async function markUploadComplete(uploadId: string, ownerId: string, success: boolean) {
  const uploads = await markUploadsComplete(ownerId, [{ uploadId, success }]);
  if (!uploads[0]) throw new Error('Upload not found');
  return uploads[0];
}

export async function markUploadsComplete(
  ownerId: string,
  items: Array<{ uploadId: string; success: boolean }>,
): Promise<Upload[]> {
  if (!items.length) return [];
  const ids = items.map((item) => item.uploadId);
  const statuses = items.map((item) => (item.success ? 'uploaded' : 'failed'));
  const { rows } = await dbQuery<Upload>(
    `UPDATE outreach.uploads u
     SET status = v.status
     FROM unnest($1::uuid[], $2::text[]) AS v(id, status),
          outreach.runs r,
          outreach.campaigns c
     WHERE u.id = v.id
       AND u.run_id = r.id
       AND r.campaign_id = c.id
       AND c.owner_id = $3
     RETURNING u.id, u.run_id, u.file_name, u.mime_type, u.byte_size, u.storage_path,
               u.content_hash, u.status, u.extraction_summary, u.created_at,
               r.status AS run_status`,
    [ids, statuses, ownerId],
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter((row): row is Upload => Boolean(row));
}

export async function removeUpload(uploadId: string, campaignId: string, ownerId: string) {
  const { rows } = await dbQuery<Pick<Upload, 'storage_path'>>(
    `DELETE FROM outreach.uploads u
     USING outreach.runs r, outreach.campaigns c
     WHERE u.id = $1 AND u.run_id = r.id AND r.campaign_id = c.id
       AND c.id = $2 AND c.owner_id = $3 AND r.status = 'uploading'
     RETURNING u.storage_path`,
    [uploadId, campaignId, ownerId],
  );
  if (!rows[0]) throw new Error('Upload not found');
  try {
    await removeStoredObject(rows[0].storage_path);
  } catch {
    // The DB record is already gone. The private object is unreachable and can
    // be cleaned up later without blocking the user’s staging flow.
  }
}
