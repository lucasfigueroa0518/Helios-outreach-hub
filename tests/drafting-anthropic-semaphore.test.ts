import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  draftingAnthropicSnapshot,
  resetDraftingAnthropicStateForTests,
  restoreDraftingAnthropicLimit,
  shrinkDraftingAnthropicLimit,
  withDraftingAnthropicSlot,
} from '@/lib/drafting/anthropic-semaphore';

describe('drafting Anthropic adaptive semaphore', () => {
  it('admits eight independent drafting calls before applying backpressure', async () => {
    const prior = process.env.DRAFTING_ANTHROPIC_MAX_INFLIGHT;
    process.env.DRAFTING_ANTHROPIC_MAX_INFLIGHT = '8';
    try {
      resetDraftingAnthropicStateForTests(8);
      const releases: Array<() => void> = [];
      const work = Array.from({ length: 10 }, () =>
        withDraftingAnthropicSlot(
          () => new Promise<void>((resolve) => releases.push(resolve)),
        ));
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(draftingAnthropicSnapshot().inFlight, 8);
      assert.equal(draftingAnthropicSnapshot().waiters, 2);
      for (const release of releases.splice(0)) release();
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const release of releases.splice(0)) release();
      await Promise.all(work);
    } finally {
      if (prior === undefined) delete process.env.DRAFTING_ANTHROPIC_MAX_INFLIGHT;
      else process.env.DRAFTING_ANTHROPIC_MAX_INFLIGHT = prior;
      resetDraftingAnthropicStateForTests();
    }
  });

  it('caps active operations and admits waiters in FIFO order', async () => {
    const prior = process.env.DRAFTING_ANTHROPIC_MAX_INFLIGHT;
    process.env.DRAFTING_ANTHROPIC_MAX_INFLIGHT = '2';
    try {
      resetDraftingAnthropicStateForTests(2);
      const releases: Array<() => void> = [];
      const started: number[] = [];
      const operations = [0, 1, 2, 3].map((index) =>
        withDraftingAnthropicSlot(async () => {
          started.push(index);
          await new Promise<void>((resolve) => releases.push(resolve));
        }));

      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(started, [0, 1]);
      assert.equal(draftingAnthropicSnapshot().inFlight, 2);
      assert.equal(draftingAnthropicSnapshot().waiters, 2);

      releases.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(started, [0, 1, 2]);
      releases.shift()?.();
      releases.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      releases.shift()?.();
      await Promise.all(operations);
      assert.equal(draftingAnthropicSnapshot().inFlight, 0);
      assert.equal(draftingAnthropicSnapshot().waiters, 0);
    } finally {
      if (prior === undefined) delete process.env.DRAFTING_ANTHROPIC_MAX_INFLIGHT;
      else process.env.DRAFTING_ANTHROPIC_MAX_INFLIGHT = prior;
      resetDraftingAnthropicStateForTests();
    }
  });

  it('halves once under pressure and restores only after quiet intervals', () => {
    const prior = process.env.DRAFTING_ANTHROPIC_MAX_INFLIGHT;
    process.env.DRAFTING_ANTHROPIC_MAX_INFLIGHT = '8';
    try {
      resetDraftingAnthropicStateForTests(8);
      shrinkDraftingAnthropicLimit(1_000, 'http_429');
      assert.equal(draftingAnthropicSnapshot().effectiveLimit, 4);
      shrinkDraftingAnthropicLimit(1_001, 'concurrent_429');
      shrinkDraftingAnthropicLimit(29_999, 'concurrent_429');
      assert.deepEqual(
        {
          effectiveLimit: draftingAnthropicSnapshot().effectiveLimit,
          lastShrinkAt: draftingAnthropicSnapshot().lastShrinkAt,
          lastShrinkReason: draftingAnthropicSnapshot().lastShrinkReason,
          shrinkCount: draftingAnthropicSnapshot().shrinkCount,
        },
        {
          effectiveLimit: 4,
          lastShrinkAt: 1_000,
          lastShrinkReason: 'concurrent_429',
          shrinkCount: 1,
        },
      );
      restoreDraftingAnthropicLimit(59_998);
      assert.equal(draftingAnthropicSnapshot().effectiveLimit, 4);
      restoreDraftingAnthropicLimit(59_999);
      assert.equal(draftingAnthropicSnapshot().effectiveLimit, 5);
      assert.equal(draftingAnthropicSnapshot().restoreCount, 1);
      restoreDraftingAnthropicLimit(64_998);
      assert.equal(draftingAnthropicSnapshot().effectiveLimit, 5);
      restoreDraftingAnthropicLimit(64_999);
      assert.equal(draftingAnthropicSnapshot().effectiveLimit, 6);
    } finally {
      if (prior === undefined) delete process.env.DRAFTING_ANTHROPIC_MAX_INFLIGHT;
      else process.env.DRAFTING_ANTHROPIC_MAX_INFLIGHT = prior;
      resetDraftingAnthropicStateForTests();
    }
  });

  it('removes an aborted queued waiter without consuming or leaking a slot', async () => {
    resetDraftingAnthropicStateForTests(1);
    let releaseActive: (() => void) | undefined;
    const active = withDraftingAnthropicSlot(
      () => new Promise<void>((resolve) => { releaseActive = resolve; }),
    );
    await Promise.resolve();

    const controller = new AbortController();
    let abortedRan = false;
    const aborted = withDraftingAnthropicSlot(async () => {
      abortedRan = true;
    }, { signal: controller.signal });
    const nextStarted = new Promise<void>((resolve) => {
      void withDraftingAnthropicSlot(async () => resolve());
    });
    await Promise.resolve();
    assert.equal(draftingAnthropicSnapshot().waiters, 2);

    controller.abort();
    await assert.rejects(aborted, { name: 'AbortError' });
    assert.equal(abortedRan, false);
    assert.equal(draftingAnthropicSnapshot().waiters, 1);
    assert.equal(draftingAnthropicSnapshot().inFlight, 1);

    releaseActive?.();
    await active;
    await nextStarted;
    await Promise.resolve();
    assert.deepEqual(
      {
        inFlight: draftingAnthropicSnapshot().inFlight,
        waiters: draftingAnthropicSnapshot().waiters,
      },
      { inFlight: 0, waiters: 0 },
    );
    resetDraftingAnthropicStateForTests();
  });
});
