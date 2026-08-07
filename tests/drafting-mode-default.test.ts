import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultDraftingMode, draftingMode } from '@/lib/drafting/mode';

test('production defaults to live when DRAFTING_MODE is unset', () => {
  assert.equal(defaultDraftingMode('production', undefined), 'live');
  assert.equal(defaultDraftingMode('development', 'production'), 'live');
  assert.equal(defaultDraftingMode('development', undefined), 'stub');
  assert.equal(defaultDraftingMode('test', 'preview'), 'stub');
});

test('explicit DRAFTING_MODE overrides the production default', () => {
  const previous = process.env.DRAFTING_MODE;
  try {
    process.env.DRAFTING_MODE = 'stub';
    assert.equal(draftingMode(), 'stub');
    process.env.DRAFTING_MODE = 'live';
    assert.equal(draftingMode(), 'live');
  } finally {
    if (previous === undefined) delete process.env.DRAFTING_MODE;
    else process.env.DRAFTING_MODE = previous;
  }
});
