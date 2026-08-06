import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  hashDraftingTextAsset,
  normalizeDraftingTextBytes,
  sha256Buffer,
} from '@/lib/drafting/asset-hash';

describe('drafting asset hash (CRLF bald eagle)', () => {
  it('normalizes CRLF and bare CR to LF before hashing', () => {
    const lf = Buffer.from('hello\nworld\n', 'utf8');
    const crlf = Buffer.from('hello\r\nworld\r\n', 'utf8');
    const mixed = Buffer.from('hello\rworld\r\n', 'utf8');

    assert.equal(hashDraftingTextAsset(lf).sha256, hashDraftingTextAsset(crlf).sha256);
    assert.equal(hashDraftingTextAsset(lf).sha256, hashDraftingTextAsset(mixed).sha256);
    assert.deepEqual(normalizeDraftingTextBytes(crlf), lf);
  });

  it('keeps binary hashing raw (no normalize)', () => {
    const raw = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x0d, 0x0a]);
    assert.equal(sha256Buffer(raw).length, 64);
    assert.notEqual(sha256Buffer(raw), hashDraftingTextAsset(raw).sha256);
  });
});
