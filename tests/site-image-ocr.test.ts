import assert from 'node:assert/strict';
import test from 'node:test';
import { readImageText } from '@/lib/site-image-ocr';

test('readImageText returns empty string for non-image bytes without throwing', async () => {
  const text = await readImageText(Buffer.from('not-a-real-image'));
  assert.equal(text, '');
});

test('readImageText returns empty string for tiny buffers without throwing', async () => {
  const text = await readImageText(Buffer.alloc(8));
  assert.equal(text, '');
});
