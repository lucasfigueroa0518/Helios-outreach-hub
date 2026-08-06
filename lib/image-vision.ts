import { prepareImageForVision } from '@/lib/image-preprocess';
import type { ExtractionResult } from '@/lib/extraction';
import { createLiveVisionCaller, extractPeopleFromTiles, type VisionCaller } from '@/lib/vision-extraction';

/**
 * Composition root for the image path: lightweight preprocessing
 * (`lib/image-preprocess.ts`) + the two-pass vision protocol
 * (`lib/vision-extraction.ts`).
 */
export async function extractPeopleFromImageBytes(
  bytes: Buffer,
  mimeType: string,
  uploadId: string,
  caller?: VisionCaller,
): Promise<ExtractionResult> {
  const prepared = await prepareImageForVision(bytes, mimeType);
  if (!prepared.ok) {
    return { people: [], counted: null, warnings: [prepared.message] };
  }
  const resolvedCaller = caller ?? createLiveVisionCaller();
  const result = await extractPeopleFromTiles(prepared.tiles, uploadId, resolvedCaller);
  if (prepared.warnings.length) {
    result.warnings.unshift(...prepared.warnings);
  }
  return result;
}
