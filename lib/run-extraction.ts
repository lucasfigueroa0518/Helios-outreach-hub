import { dbQuery } from '@/lib/db';
import { extractUpload, sha256, type ExtractionResult } from '@/lib/extraction';
import { downloadStoredObject } from '@/lib/storage';

type UploadRow = {
  id: string;
  file_name: string;
  storage_path: string;
  status: string;
};

async function isRunCancelled(runId: string) {
  const { rows } = await dbQuery<{ status: string }>(
    `SELECT status FROM outreach.runs WHERE id = $1`,
    [runId],
  );
  return rows[0]?.status === 'cancelled';
}

async function setProgress(uploadId: string, stage: string, percent: number, message: string) {
  await dbQuery(
    `UPDATE outreach.uploads
     SET extraction_summary = coalesce(extraction_summary, '{}'::jsonb)
       || jsonb_build_object('progress', jsonb_build_object(
         'stage', $2::text, 'percent', $3::int, 'message', $4::text, 'updated_at', now()
       ))
     WHERE id = $1`,
    [uploadId, stage, percent, message],
  );
}

export async function extractOneUpload(runId: string, uploadId: string) {
  if (await isRunCancelled(runId)) return;
  const { rows } = await dbQuery<UploadRow>(
    `SELECT id, file_name, storage_path, status FROM outreach.uploads WHERE id = $1 AND run_id = $2`,
    [uploadId, runId],
  );
  const upload = rows[0];
  if (!upload || ['extracted', 'failed', 'failed_quality'].includes(upload.status)) return;

  await dbQuery(`UPDATE outreach.uploads SET status = 'processing' WHERE id = $1`, [uploadId]);
  await setProgress(uploadId, 'downloading', 10, 'Downloading source file');
  try {
    const bytes = await downloadStoredObject(upload.storage_path);
    if (await isRunCancelled(runId)) return;
    await setProgress(uploadId, 'hashing', 25, 'Hashing and checking cache');
    const hash = sha256(bytes);
    await dbQuery(`UPDATE outreach.uploads SET content_hash = $2 WHERE id = $1`, [uploadId, hash]);

    const cached = await dbQuery<{ extraction_summary: { result?: ExtractionResult } }>(
      `SELECT extraction_summary FROM outreach.uploads
       WHERE content_hash = $1 AND id <> $2 AND status = 'extracted'
       ORDER BY created_at DESC LIMIT 1`,
      [hash, uploadId],
    );
    const cachedResult = cached.rows[0]?.extraction_summary?.result;
    await setProgress(
      uploadId,
      cachedResult ? 'cache_hit' : 'extracting',
      cachedResult ? 75 : 45,
      cachedResult ? 'Reusing a previous extraction' : 'Extracting people',
    );
    const result = cachedResult ?? await extractUpload(bytes, upload.file_name, upload.id);
    if (await isRunCancelled(runId)) return;
    const qualityFailed = result.warnings.some((warning) => warning.startsWith('image too low-resolution'));
    await dbQuery(
      `UPDATE outreach.uploads
       SET status = $2, extraction_summary = $3::jsonb
       WHERE id = $1`,
      [uploadId, qualityFailed ? 'failed_quality' : 'extracted', JSON.stringify({
        people_found: result.people.length,
        people_counted: true,
        people_count_provisional: false,
        warnings: result.warnings,
        cache_hit: Boolean(cachedResult),
        result,
        progress: {
          stage: qualityFailed ? 'failed_quality' : 'complete',
          percent: 100,
          message: qualityFailed ? 'Image needs a clearer source' : 'Extraction complete',
          updated_at: new Date().toISOString(),
        },
      })],
    );
  } catch (error) {
    await dbQuery(
      `UPDATE outreach.uploads
       SET status = 'failed', extraction_summary = jsonb_build_object(
         'warnings', ARRAY[$2],
         'progress', jsonb_build_object('stage', 'failed', 'percent', 100, 'message', $2::text, 'updated_at', now())
       )
       WHERE id = $1`,
      [uploadId, error instanceof Error ? error.message : 'Extraction failed'],
    );
  }
}
