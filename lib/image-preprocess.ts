import { PASSTHROUGH_MIME_TYPES, sniffImageDimensions } from '@/lib/image-dimensions';
import {
  DECODE_FAILURE_MESSAGE,
  isTooSmallToTranscribe,
  MAX_IMAGE_WIDTH,
  MIN_IMAGE_BYTES,
  QUALITY_WARNING,
  shouldTileImage,
  type ImageTile,
  type VisionImageFormat,
} from '@/lib/image-tiling';

export type { ImageTile };

export type PreparedImage =
  | { ok: true; tiles: ImageTile[]; warnings: string[] }
  | { ok: false; reason: 'quality' | 'decode'; message: string };

function asVisionMimeType(mimeType: string): VisionImageFormat | null {
  if (mimeType === 'image/png' || mimeType === 'image/jpeg' || mimeType === 'image/webp' || mimeType === 'image/gif') {
    return mimeType;
  }
  return null;
}

function singleTile(bytes: Buffer, mediaType: VisionImageFormat): ImageTile[] {
  return [{ bytes, mediaType, index: 0, total: 1 }];
}

function unsupportedImageMessage(mimeType: string) {
  if (mimeType === 'image/heic' || mimeType === 'image/heif' || mimeType === 'image/tiff') {
    return `${DECODE_FAILURE_MESSAGE} (HEIC and TIFF are temporarily unsupported — save as PNG or JPEG.)`;
  }
  return `${DECODE_FAILURE_MESSAGE} (Save as PNG, JPEG, or WebP.)`;
}

export async function prepareImageForVision(bytes: Buffer, mimeType: string): Promise<PreparedImage> {
  if (bytes.byteLength < MIN_IMAGE_BYTES) {
    return { ok: false, reason: 'quality', message: QUALITY_WARNING };
  }
  if (!PASSTHROUGH_MIME_TYPES.has(mimeType)) {
    return { ok: false, reason: 'decode', message: unsupportedImageMessage(mimeType) };
  }
  const mediaType = asVisionMimeType(mimeType);
  if (!mediaType) {
    return { ok: false, reason: 'decode', message: DECODE_FAILURE_MESSAGE };
  }

  const dimensions = sniffImageDimensions(bytes, mimeType);
  if (!dimensions) {
    return { ok: false, reason: 'decode', message: DECODE_FAILURE_MESSAGE };
  }
  if (isTooSmallToTranscribe(dimensions.width, dimensions.height, bytes.byteLength)) {
    return { ok: false, reason: 'quality', message: QUALITY_WARNING };
  }
  if (shouldTileImage(dimensions.height, bytes.byteLength)) {
    return {
      ok: false,
      reason: 'decode',
      message: 'Image is too tall/large to process — crop or re-save as a shorter PNG or JPEG.',
    };
  }

  const warnings: string[] = [];
  if (dimensions.width > MAX_IMAGE_WIDTH) {
    warnings.push(`Image width ${dimensions.width}px exceeds ${MAX_IMAGE_WIDTH}px — proceeding without downscale.`);
  }
  return { ok: true, tiles: singleTile(bytes, mediaType), warnings };
}
