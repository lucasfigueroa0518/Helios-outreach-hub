import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { drainActiveJobs } from '@/lib/orchestration/worker';

describe('orchestration worker shutdown drain', () => {
  it('waits for active jobs and reports none after they settle', async () => {
    let finish: (() => void) | undefined;
    const active = new Map<string, Promise<void>>([
      ['job-a', new Promise<void>((resolve) => { finish = resolve; })],
    ]);
    const tracked = active.get('job-a')?.finally(() => active.delete('job-a'));
    if (!tracked) throw new Error('Expected tracked job');
    active.set('job-a', tracked);

    const draining = drainActiveJobs(active, 1_000);
    finish?.();
    assert.deepEqual(await draining, []);
  });

  it('returns safe remaining job IDs when the deadline expires', async () => {
    const active = new Map<string, Promise<void>>([
      ['job-a', new Promise<void>(() => undefined)],
      ['job-b', new Promise<void>(() => undefined)],
    ]);

    assert.deepEqual(await drainActiveJobs(active, 0), ['job-a', 'job-b']);
  });
});
