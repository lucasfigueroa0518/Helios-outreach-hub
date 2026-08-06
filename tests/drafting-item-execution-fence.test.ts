import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { withDraftingItemExecutionFence } from '@/lib/drafting/jobs';

describe('cross-worker drafting item execution fence', () => {
  it('admits only one concurrent provider execution per item and releases ownership', async () => {
    let owner: string | null = null;
    let releaseProvider: (() => void) | undefined;
    let providerStarts = 0;
    let releases = 0;
    const dependencies = {
      claim: async () => {
        if (owner) return null;
        owner = 'worker-a';
        return owner;
      },
      heartbeat: async () => undefined,
      release: async (_itemId: string, expectedOwner: string) => {
        if (owner === expectedOwner) owner = null;
        releases += 1;
      },
    };

    const first = withDraftingItemExecutionFence(
      'item-1',
      async () => {
        providerStarts += 1;
        await new Promise<void>((resolve) => { releaseProvider = resolve; });
        return 'done';
      },
      dependencies,
    );
    await Promise.resolve();
    const duplicate = await withDraftingItemExecutionFence(
      'item-1',
      async () => {
        providerStarts += 1;
        return 'duplicate';
      },
      dependencies,
    );

    assert.deepEqual(duplicate, { acquired: false });
    assert.equal(providerStarts, 1);
    releaseProvider?.();
    assert.deepEqual(await first, { acquired: true, result: 'done' });
    assert.equal(owner, null);
    assert.equal(releases, 1);
  });
});
