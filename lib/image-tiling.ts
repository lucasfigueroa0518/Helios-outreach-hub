/**
 * Pure tiling geometry for vision extraction (08 §2.1). Kept separate from
 * preprocessing so tiling math stays testable without native image decoders.
 */

export const MAX_TILE_HEIGHT = 1500;
export const TILE_OVERLAP = 250;
export const MAX_IMAGE_WIDTH = 1568;
export const TILE_HEIGHT_THRESHOLD = 7500;
export const TILE_BYTES_THRESHOLD = 4.5 * 1024 * 1024;
export const MIN_IMAGE_DIMENSION = 200;
export const MIN_IMAGE_BYTES = 10_000;

export type TileSegment = { top: number; height: number };

export type VisionImageFormat = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export type ImageTile = {
  bytes: Buffer;
  mediaType: VisionImageFormat;
  index: number;
  total: number;
};

/** Slices a (post-downscale) image height into overlapping 1500px bands. */
export function computeTileLayout(height: number): TileSegment[] {
  if (height <= 0) return [];
  const stride = MAX_TILE_HEIGHT - TILE_OVERLAP;
  const tiles: TileSegment[] = [];
  let top = 0;
  while (top < height) {
    const bottom = Math.min(top + MAX_TILE_HEIGHT, height);
    tiles.push({ top, height: bottom - top });
    if (bottom >= height) break;
    top += stride;
  }
  return tiles;
}

/** Decision uses the ORIGINAL (pre-downscale) dimensions/byte size, per 08 §2.1 step 1. */
export function shouldTileImage(originalHeight: number, byteLength: number): boolean {
  return originalHeight > TILE_HEIGHT_THRESHOLD || byteLength > TILE_BYTES_THRESHOLD;
}

export function isTooSmallToTranscribe(width: number, height: number, byteLength: number): boolean {
  return width < MIN_IMAGE_DIMENSION || height < MIN_IMAGE_DIMENSION || byteLength < MIN_IMAGE_BYTES;
}

export const QUALITY_WARNING = 'image too low-resolution to transcribe reliably — re-screenshot at higher zoom';
export const DECODE_FAILURE_MESSAGE = "couldn't read this image format — re-save as PNG or JPEG.";
