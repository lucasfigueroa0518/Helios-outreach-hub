import { createHash } from 'node:crypto';

/**
 * Text drafting assets are hashed after CRLF→LF normalization so Windows
 * checkouts cannot diverge from macOS/Linux / manifest pins (Campaign drafting
 * skill SHA scar — bald eagle).
 */
export function normalizeDraftingTextBytes(buffer: Buffer): Buffer {
  const text = buffer.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return Buffer.from(text, 'utf8');
}

export function sha256Buffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function hashDraftingTextAsset(buffer: Buffer): {
  sha256: string;
  bytes: number;
  text: string;
  normalized: Buffer;
} {
  const normalized = normalizeDraftingTextBytes(buffer);
  return {
    sha256: sha256Buffer(normalized),
    bytes: normalized.byteLength,
    text: normalized.toString('utf8'),
    normalized,
  };
}
