import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  runProviderCallWithCostPersistence,
  sumUniqueDraftingCostEvents,
  type DraftingCostStage,
} from '../lib/drafting/cost-events';
import { recordDraftingJobCostEvent } from '../lib/drafting/repository';

function fakeCostEventRepository() {
  const events = new Map<string, string>();
  const query = async (_text: string, params: unknown[]) => {
    const eventKey = String(params[4]);
    const inserted = !events.has(eventKey);
    if (inserted) events.set(eventKey, String(params[1]));
    return { rows: [{ inserted }] };
  };
  return { events, query };
}

test('repository persistence replays one provider result without double counting', async () => {
  const fake = fakeCostEventRepository();
  const input = {
    jobId: 'job-1',
    stage: 'write' as const,
    providerRequestId: 'msg-write-1',
    actualCostUsd: '0.0234',
    usage: { costUsd: '0.0234' },
  };

  assert.equal(await recordDraftingJobCostEvent(input, fake.query), true);
  assert.equal(await recordDraftingJobCostEvent(input, fake.query), false);
  assert.equal(sumUniqueDraftingCostEvents(
    [...fake.events].map(([eventKey, costUsd]) => ({ eventKey, costUsd })),
  ), '0.0234');
});

test('repository persistence sums distinct successful provider calls', async () => {
  const fake = fakeCostEventRepository();
  await recordDraftingJobCostEvent({
    jobId: 'job-1',
    stage: 'write',
    providerRequestId: 'msg-write-1',
    actualCostUsd: '0.0234',
    usage: { costUsd: '0.0234' },
  }, fake.query);
  await recordDraftingJobCostEvent({
    jobId: 'job-2',
    stage: 'repair',
    providerRequestId: 'msg-repair-1',
    actualCostUsd: '0.0101',
    usage: { costUsd: '0.0101' },
  }, fake.query);

  assert.equal(sumUniqueDraftingCostEvents(
    [...fake.events].map(([eventKey, costUsd]) => ({ eventKey, costUsd })),
  ), '0.0335');
});

test('initial write is durable when the later repair provider throws', async () => {
  const fake = fakeCostEventRepository();
  const persist = async (event: {
    stage: DraftingCostStage;
    providerRequestId: string;
    costUsd: string;
    usage: Record<string, unknown>;
  }) => {
    await recordDraftingJobCostEvent({
      jobId: event.stage === 'write' ? 'job-write' : 'job-repair',
      stage: event.stage,
      providerRequestId: event.providerRequestId,
      actualCostUsd: event.costUsd,
      usage: event.usage,
    }, fake.query);
  };

  await runProviderCallWithCostPersistence({
    stage: 'write',
    call: async () => ({
      providerRequestId: 'msg-write-survives',
      usage: { costUsd: '0.0400' },
    }),
    persist,
  });
  await assert.rejects(
    runProviderCallWithCostPersistence({
      stage: 'repair',
      call: async () => {
        throw new Error('repair failed');
      },
      persist,
    }),
    /repair failed/,
  );

  assert.deepEqual([...fake.events], [['write:msg-write-survives', '0.0400']]);
});

test('opening-balance persistence is idempotent, monotonic, and unattributed', () => {
  const store = {
    runTotal: 9.4559,
    attributableEvents: 8.5546,
    openingBalances: new Map<string, number>(),
    leadAttributions: new Map<string, number>(),
  };
  const bootstrap = () => {
    if (!store.openingBalances.has('run-13')) {
      const residual = Math.max(store.runTotal - store.attributableEvents, 0);
      if (residual > 0) store.openingBalances.set('run-13', residual);
    }
    const durableTotal = store.attributableEvents
      + (store.openingBalances.get('run-13') ?? 0);
    store.runTotal = Math.max(store.runTotal, durableTotal);
  };

  bootstrap();
  bootstrap();

  assert.equal(store.runTotal.toFixed(4), '9.4559');
  assert.equal(store.openingBalances.size, 1);
  assert.equal(store.openingBalances.get('run-13')?.toFixed(4), '0.9013');
  assert.equal(store.leadAttributions.size, 0);
});

test('schema rerun does not add a legacy baseline to a modern event-backed job', () => {
  const events = new Map<string, Array<{ key: string; cost: number }>>([
    ['modern-job', [{ key: 'write:msg-modern', cost: 0.04 }]],
  ]);
  const legacyJobTotals = new Map([['modern-job', 0.04]]);
  const bootstrapLegacyJobs = () => {
    for (const [jobId, cost] of legacyJobTotals) {
      const existing = events.get(jobId) ?? [];
      if (existing.length > 0) continue;
      events.set(jobId, [{ key: `legacy-job-total:${jobId}`, cost }]);
    }
  };

  bootstrapLegacyJobs();
  bootstrapLegacyJobs();

  assert.deepEqual(events.get('modern-job'), [{ key: 'write:msg-modern', cost: 0.04 }]);
});
