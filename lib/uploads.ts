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

const acceptedMimeTypes = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif', 'image/tiff', 'image/gif',
  'application/pdf', 'text/csv', 'text/tab-separated-values',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'text/markdown',
]);

function safeFileName(fileName: string) {
  return fileName.replace(/^.*[\\/]/, '').replace(/[^\w.() -]/g, '_').slice(0, 180) || 'upload';
}

async function assertCampaignOwnership(campaignId: string, ownerId: string) {
  const { rows } = await dbQuery<{ id: string }>(
    `SELECT id FROM outreach.campaigns WHERE id = $1 AND owner_id = $2`,
    [campaignId, ownerId],
  );
  if (!rows[0]) throw new Error('Campaign not found');
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
  return rows;
}

const sheetMimeTypes = new Set([
  'text/csv',
  'text/tab-separated-values',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
]);

export async function createUploadIntent(
  campaignId: string,
  ownerId: string,
  input: { fileName: string; mimeType: string; byteSize: number },
) {
  if (!acceptedMimeTypes.has(input.mimeType)) throw new Error('This file type is not supported');
  if (!Number.isFinite(input.byteSize) || input.byteSize <= 0 || input.byteSize > 52_428_800) {
    throw new Error('Files must be between 1 byte and 50 MB');
  }

  const upload = await dbTransaction(async (client) => {
    const campaign = await client.query<{ id: string; needs_enrichment: boolean }>(
      `SELECT id, needs_enrichment FROM outreach.campaigns WHERE id = $1 AND owner_id = $2 FOR UPDATE`,
      [campaignId, ownerId],
    );
    if (!campaign.rows[0]) throw new Error('Campaign not found');

    if (!campaign.rows[0].needs_enrichment) {
      const sniffed = sniffUpload(input.fileName, new Uint8Array());
      const sheetByMime = sheetMimeTypes.has(input.mimeType);
      const sheetByName = sniffed ? isSheetUploadKind(sniffed.kind) : false;
      if (!sheetByMime && !sheetByName) {
        throw new Error('Pre-enriched campaigns accept CSV, TSV, or Excel only');
      }
    }

    const runId = await ensureStagingRun(client, campaignId, ownerId);

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
    return result.rows[0];
  });

  try {
    const signed = await createSignedUpload(upload.storage_path);
    return { upload, ...signed };
  } catch (error) {
    await dbQuery(`UPDATE outreach.uploads SET status = 'failed' WHERE id = $1`, [upload.id]);
    throw error;
  }
}

export async function markUploadComplete(uploadId: string, ownerId: string, success: boolean) {
  const { rows } = await dbQuery<Upload>(
    `UPDATE outreach.uploads u
     SET status = $3
     FROM outreach.runs r
     JOIN outreach.campaigns c ON c.id = r.campaign_id
     WHERE u.id = $1 AND u.run_id = r.id AND c.owner_id = $2
     RETURNING u.id, u.run_id, u.file_name, u.mime_type, u.byte_size, u.storage_path,
               u.content_hash, u.status, u.extraction_summary, u.created_at,
               r.status AS run_status`,
    [uploadId, ownerId, success ? 'uploaded' : 'failed'],
  );
  if (!rows[0]) throw new Error('Upload not found');
  return rows[0];
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
